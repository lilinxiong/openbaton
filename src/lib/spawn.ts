import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnsDir } from "./paths.js";
import { matchModelCard, requireCardId } from "./cards.js";
import { buildReadOnlyReceipt, writeReceipt, type DelegationReceipt, type ExecutionMode } from "./receipt.js";
import type { CodedError, ModelCard, ModelSelectionApproval, UnknownRecord } from "../types.js";
import type { NativeExecutionHandleKind } from "../adapters/contract.js";
import {
  buildWorkerPrompt,
  compileWorkUnit,
  coordinationFor,
  type CoordinationPolicy,
  type WorkUnitContract,
  type WorkUnitKind,
} from "./work-unit.js";

export type TicketStatus = "queued" | "dispatching" | "running" | "completed" | "errored" | "timed_out" | "closed" | "done";

export interface TicketError {
  code: string;
  message: string;
}

export interface TicketHistoryEntry extends UnknownRecord {
  event: string;
  at: string;
}

export type TicketProgressPhase = "starting" | "working" | "waiting" | "blocked" | "checkpoint";

export interface TicketProgress {
  sequence: number;
  phase: TicketProgressPhase;
  summary: string;
  next_step: string | null;
  blocker: string | null;
  needs_director: boolean;
  reported_at: string;
}

export type AgentProbeState = "pending_init" | "running" | "interrupted" | "shutdown" | "not_found";
export type AgentProbeActivity = "status" | "output" | "heartbeat";

export type ExecutionHandleSource = "native-return" | "legacy" | "manual";

/** Host-neutral native child handle. It is not a hook identity. */
export interface NativeExecutionHandle {
  kind: NativeExecutionHandleKind;
  value: string;
  source: ExecutionHandleSource;
}

/** Host-observed liveness is separate from business progress and terminal state. */
export interface TicketLiveness {
  sequence: number;
  execution_handle: NativeExecutionHandle;
  /** Optional diagnostic retained for hosts that expose an agent id. */
  agent_id?: string | null;
  state: AgentProbeState;
  activity: AgentProbeActivity;
  observed_at: string;
}

export interface SpawnTicket extends UnknownRecord {
  schema_version: number;
  id: string;
  description: string;
  prompt: string;
  work_unit: WorkUnitContract;
  coordination: CoordinationPolicy;
  progress: TicketProgress | null;
  liveness: TicketLiveness | null;
  model_id: string;
  route_id: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  fork_context: false;
  mode: ExecutionMode;
  read_only: boolean;
  source: string;
  openspec: UnknownRecord | null;
  queue: string;
  status: TicketStatus;
  attempt: number;
  max_attempts: number;
  /** Opaque identity for one dispatch attempt. It is unrelated to the ticket id format. */
  reservation_id?: string;
  /** Optional host diagnostic. Dispatch lifecycle is keyed by execution_handle. */
  agent_id?: string | null;
  execution_handle: NativeExecutionHandle | null;
  host: string | null;
  /** Requested runtime host captured before dispatch; unlike `host`, this is
   * present before a worker binds and is immutable across queue transitions. */
  target_host?: string;
  error: TicketError | null;
  conclusion: string | null;
  receipt_id: string | null;
  selection: ModelSelectionApproval | null;
  created_at: string;
  updated_at: string;
  history: TicketHistoryEntry[];
  dispatch_host?: string;
  dispatch_requested_at?: string;
  started_at?: string;
  finished_at?: string;
  slot_released_at?: string;
  safety_verdict?: UnknownRecord;
  fallback_from_ticket_id?: string;
  fallback_reason?: string;
  fallback_successor_id?: string;
  quota_diagnostic?: UnknownRecord;
  /** Routing constraints captured by selection when available; successors may not relax them. */
  routing_requirements?: {
    required_reasoning_effort?: string | null;
    estimated_context_tokens?: number | null;
  };
}

export function listSpawns(cwd: string, env?: NodeJS.ProcessEnv): SpawnTicket[] {
  const dir = spawnsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => normalizeSpawnTicket(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function isHandleKind(value: unknown): value is NativeExecutionHandleKind {
  return value === "task_name" || value === "agent_id" || value === "session_id"
    || value === "task_id" || value === "opaque";
}

function legacyTaskName(value: Record<string, unknown>): string | null {
  const direct = stringValue(value.task_name) || stringValue(value.taskName);
  if (direct) return direct;
  const history = Array.isArray(value.history) ? value.history : [];
  for (const item of [...history].reverse()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const taskName = stringValue(entry.task_name) || stringValue(entry.taskName);
    if (taskName) return taskName;
  }
  return null;
}

function normalizeExecutionHandle(value: unknown): NativeExecutionHandle | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const handle = stringValue(item.value);
  if (!handle || !isHandleKind(item.kind)) return null;
  const source = item.source === "native-return" || item.source === "legacy" || item.source === "manual"
    ? item.source
    : "legacy";
  return { kind: item.kind, value: handle, source };
}

/**
 * Normalize a current or schema-7 ticket without writing it. Schema-7
 * `agent_id` and historical Codex `task_name` metadata are conservative
 * fallback handles; no guessed handle is created from a ticket id.
 */
export function normalizeSpawnTicket(value: unknown): SpawnTicket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("spawn ticket must be an object");
  }
  const ticket = structuredClone(value) as SpawnTicket & Record<string, unknown>;
  const existing = normalizeExecutionHandle(ticket.execution_handle);
  const agentId = stringValue(ticket.agent_id);
  const taskName = legacyTaskName(ticket);
  const host = stringValue(ticket.target_host) || stringValue(ticket.dispatch_host) || stringValue(ticket.host);
  const fallback = existing
    || (host === "codex" && taskName ? { kind: "task_name" as const, value: taskName, source: "legacy" as const } : null)
    || (agentId ? { kind: "agent_id" as const, value: agentId, source: "legacy" as const } : null);
  const schema = Number(ticket.schema_version);
  ticket.schema_version = schema === 8 || schema === 7 ? 8 : schema;
  ticket.execution_handle = fallback;
  if (!Object.hasOwn(ticket, "agent_id")) ticket.agent_id = null;
  if (ticket.liveness && typeof ticket.liveness === "object" && !Array.isArray(ticket.liveness)) {
    const live = ticket.liveness as unknown as Record<string, unknown>;
    const liveHandle = normalizeExecutionHandle(live.execution_handle)
      || fallback
      || (stringValue(live.agent_id) ? { kind: "agent_id" as const, value: stringValue(live.agent_id)!, source: "legacy" as const } : null);
    if (liveHandle) {
      ticket.liveness = {
        ...ticket.liveness,
        execution_handle: liveHandle,
      } as SpawnTicket["liveness"];
    }
  }
  return ticket;
}

export function readSpawn(cwd: string, id: string, env?: NodeJS.ProcessEnv): SpawnTicket {
  const file = path.join(spawnsDir(cwd, env), `${id}.json`);
  if (!fs.existsSync(file)) {
    const err = new Error(`spawn not found: ${id}`) as CodedError;
    err.code = "SPAWN_NOT_FOUND";
    throw err;
  }
  return normalizeSpawnTicket(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writeSpawn(cwd: string, ticket: SpawnTicket, env?: NodeJS.ProcessEnv): SpawnTicket {
  ticket = normalizeSpawnTicket(ticket);
  const dir = spawnsDir(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ticket.id}.json`);
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(ticket, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return ticket;
}

export function nextSpawnId(cwd: string, prefix = "spn", env?: NodeJS.ProcessEnv): string {
  const existing = listSpawns(cwd, env);
  let max = 0;
  for (const s of existing) {
    const m = String(s.id).match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

interface BuildSpawnTicketOptions {
  id: string;
  description: string;
  prompt: string;
  modelId: string;
  routeId?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  source?: string;
  openspec?: UnknownRecord | null;
  taskKind: WorkUnitKind;
  deliverable?: string | null;
  doneWhen?: string | null;
  selection?: ModelSelectionApproval | null;
  targetHost?: string | null;
  now?: Date | string | number;
}

export function buildSpawnTicket({
  id,
  description,
  prompt,
  modelId,
  routeId = null,
  reasoningEffort = null,
  serviceTier = null,
  source = "standalone",
  openspec = null,
  taskKind,
  deliverable = null,
  doneWhen = null,
  selection = null,
  targetHost = selection?.host || null,
  now = new Date(),
}: BuildSpawnTicketOptions): SpawnTicket {
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const workUnit = compileWorkUnit(description, { kind: taskKind, deliverable, doneWhen });
  const coordination = coordinationFor(workUnit);
  return {
    schema_version: 8,
    id,
    description,
    prompt: buildWorkerPrompt(prompt, workUnit, coordination),
    work_unit: workUnit,
    coordination,
    progress: null,
    liveness: null,
    model_id: modelId,
    route_id: routeId,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    fork_context: false,
    mode: "read-only",
    read_only: true,
    source,
    openspec,
    queue: "enqueue",
    status: "queued",
    attempt: 0,
    max_attempts: 1,
    agent_id: null,
    execution_handle: null,
    host: null,
    ...(targetHost ? { target_host: targetHost } : {}),
    error: null,
    conclusion: null,
    receipt_id: null,
    selection: selection ? structuredClone(selection) : null,
    created_at: createdAt,
    updated_at: createdAt,
    history: [{ event: "ticket_queued", at: createdAt }],
  };
}

/**
 * Card-route one standalone unit. Queue instead of refusing.
 */
interface PlanStandaloneOptions {
  description: string;
  prompt?: string | null;
  cards: ModelCard[];
  explicitModel?: string | null;
  queue?: unknown;
  cwd: string;
  taskKind: WorkUnitKind;
  deliverable?: string | null;
  doneWhen?: string | null;
  selectionApproval?: ModelSelectionApproval | null;
  host?: string | null;
  forceDelegate?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type StandalonePlan =
  | { director_local: true; reason: string; description: string }
  | { director_local: false; ticket: SpawnTicket; receipt: DelegationReceipt; queue: { running: number; queued: number } };

export function planStandaloneSpawn({ description, prompt = null, cards, explicitModel, queue, cwd, taskKind, deliverable, doneWhen, selectionApproval = null, host = null, forceDelegate: _forceDelegate = false, env }: PlanStandaloneOptions): StandalonePlan {
  void queue;
  const card = explicitModel
    ? requireCardId(explicitModel, cards)
    : matchModelCard(description, cards).card;
  const id = nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    id,
    description,
    prompt: prompt || description,
    modelId: card.id,
    routeId: card.route_id || null,
    reasoningEffort: card.reasoning_effort || null,
    serviceTier: selectionApproval?.service_tier || null,
    source: "standalone",
    taskKind,
    deliverable,
    doneWhen,
    selection: selectionApproval,
    targetHost: host || selectionApproval?.host || null,
  });
  const resolvedHost = host || selectionApproval?.host || null;
  const receipt = buildReadOnlyReceipt({ ticketId: id, card, maxAttempts: ticket.max_attempts, issuedAt: ticket.created_at, selection: selectionApproval, host: resolvedHost });
  ticket.receipt_id = receipt.receipt_id;
  return { director_local: false, ticket, receipt, queue: { running: 0, queued: 1 } };
}

export function persistStandalonePlan(cwd: string, planned: StandalonePlan, env?: NodeJS.ProcessEnv): SpawnTicket {
  if (planned.director_local === true) throw new Error("ops dispatch unexpectedly stayed on the director");
  writeReceipt(cwd, planned.receipt, env);
  return writeSpawn(cwd, planned.ticket, env);
}
