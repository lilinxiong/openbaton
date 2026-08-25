import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnsDir } from "./paths.js";
import { matchModelCard, requireCardId } from "./cards.js";
import { directorMayRun } from "./hygiene.js";
import { buildReadOnlyReceipt, writeReceipt, type DelegationReceipt, type ExecutionMode } from "./receipt.js";
import type { CodedError, ModelCard, ModelSelectionApproval, UnknownRecord } from "../types.js";
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

/** Host-observed liveness is separate from business progress and terminal state. */
export interface TicketLiveness {
  sequence: number;
  agent_id: string;
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
  agent_id: string | null;
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
}

export function listSpawns(cwd: string): SpawnTicket[] {
  const dir = spawnsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SpawnTicket)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function readSpawn(cwd: string, id: string): SpawnTicket {
  const file = path.join(spawnsDir(cwd), `${id}.json`);
  if (!fs.existsSync(file)) {
    const err = new Error(`spawn not found: ${id}`) as CodedError;
    err.code = "SPAWN_NOT_FOUND";
    throw err;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as SpawnTicket;
}

export function writeSpawn(cwd: string, ticket: SpawnTicket): SpawnTicket {
  const dir = spawnsDir(cwd);
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

export function nextSpawnId(cwd: string, prefix = "spn"): string {
  const existing = listSpawns(cwd);
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
    schema_version: 7,
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
}

export type StandalonePlan =
  | { director_local: true; reason: string; description: string }
  | { director_local: false; ticket: SpawnTicket; receipt: DelegationReceipt; queue: { running: number; queued: number } };

export function planStandaloneSpawn({ description, prompt = null, cards, explicitModel, queue, cwd, taskKind, deliverable, doneWhen, selectionApproval = null, host = null, forceDelegate = false }: PlanStandaloneOptions): StandalonePlan {
  if (!forceDelegate && directorMayRun(description)) {
    return {
      director_local: true,
      reason: "tiny unit; director can do it without polluting context",
      description,
    };
  }
  void queue;
  const card = explicitModel
    ? requireCardId(explicitModel, cards)
    : matchModelCard(description, cards).card;
  const id = nextSpawnId(cwd);
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

export function persistStandalonePlan(cwd: string, planned: StandalonePlan): SpawnTicket {
  if (planned.director_local === true) throw new Error("ops dispatch unexpectedly stayed on the director");
  writeReceipt(cwd, planned.receipt);
  return writeSpawn(cwd, planned.ticket);
}
