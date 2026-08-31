import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnsDir } from "./paths.js";
import { matchModelCard, requireCardId } from "./cards.js";
import {
  buildReadOnlyReceipt,
  normalizeCompiledApplyLineage,
  validateCompiledApplyLineage,
  writeReceipt,
  type CompiledApplyLineage,
  type DelegationReceipt,
  type ExecutionMode,
} from "./receipt.js";
import type { CodedError, ModelCard, ModelSelectionApproval, UnknownRecord } from "../types.js";
import type { NativeExecutionHandleKind } from "../adapters/contract.js";
import {
  assertSessionScope,
  sessionScope,
  sessionUidFromEnv,
  SessionScopeError,
  type SessionScope,
  type SessionUid,
} from "./session-scope.js";
export {
  assertSessionScope,
  sessionScope,
  sessionUidFromEnv,
  SessionScopeError,
  type SessionScope,
  type SessionUid,
} from "./session-scope.js";
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

export type ExecutionHandleSource = "native-return" | "manual";

/** Host-neutral native child handle. */
export interface NativeExecutionHandle {
  kind: NativeExecutionHandleKind;
  value: string;
  source: ExecutionHandleSource;
}

/** Host-observed liveness is separate from business progress and terminal state. */
export interface TicketLiveness {
  sequence: number;
  execution_handle: NativeExecutionHandle;
  /** Host-reported lifecycle state for the bound opaque handle. */
  state: AgentProbeState;
  activity: AgentProbeActivity;
  observed_at: string;
}

export interface SpawnTicket extends UnknownRecord {
  schema_version: number;
  id: string;
  session_uid: string;
  session_ordinal: number;
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
  successor_from_ticket_id?: string;
  successor_reason?: string;
  successor_id?: string;
  quota_diagnostic?: UnknownRecord;
  /** Routing constraints captured by selection when available; successors may not relax them. */
  routing_requirements?: {
    required_reasoning_effort?: string | null;
    estimated_context_tokens?: number | null;
  };
  /** Omitted by legacy/manual tickets; compiled tickets carry this immutable identity. */
  compiled_apply_lineage?: CompiledApplyLineage;
}

export function listSpawns(cwd: string, env?: NodeJS.ProcessEnv): SpawnTicket[] {
  const dir = spawnsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as unknown)
    .filter(isCurrentSpawnRecord)
    .map((value) => normalizeSpawnTicket(value))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function isHandleKind(value: unknown): value is NativeExecutionHandleKind {
  return typeof value === "string" && /^[a-z][a-z0-9._-]*$/.test(value);
}

function normalizeExecutionHandle(value: unknown): NativeExecutionHandle | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const handle = stringValue(item.value);
  if (!handle || !isHandleKind(item.kind)) return null;
  const source = item.source === "native-return" || item.source === "manual"
    ? item.source
    : null;
  if (!source) return null;
  return { kind: item.kind, value: handle, source };
}

/**
 * Normalize a current ticket without writing it. Historical records are not
 * migrated and execution handles are accepted only from native/manual APIs.
 */
export function normalizeSpawnTicket(value: unknown): SpawnTicket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("spawn ticket must be an object");
  }
  const ticket = structuredClone(value) as SpawnTicket & Record<string, unknown>;
  const unitRecord = ticket.work_unit as unknown as Record<string, unknown>;
  if (unitRecord && unitRecord.schema_version === 2 && ticket.compiled_apply_lineage === undefined) {
    throw new Error("compiled work unit requires compiled apply lineage");
  }
  if (ticket.compiled_apply_lineage !== undefined) {
    const normalized = normalizeCompiledApplyLineage(ticket.compiled_apply_lineage);
    if (JSON.stringify(normalized) !== JSON.stringify(ticket.compiled_apply_lineage)) {
      throw new Error("compiled apply lineage is not normalized");
    }
    ticket.compiled_apply_lineage = normalized;
    const unit = unitRecord;
    if (unit.schema_version !== 2) throw new Error("compiled apply lineage requires a compiled work unit");
    for (const field of ["run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "mode"] as const) {
      if (JSON.stringify(normalized[field]) !== JSON.stringify(unit[field])) throw new Error(`compiled work unit lineage mismatch: ${field}`);
    }
    if (normalized.mode === "verification-only" && (ticket.mode !== "read-only" || ticket.read_only !== true)) throw new Error("verification-only ticket must be read-only");
    if (normalized.mode === "patch-only" && ticket.mode === "read-only" && ticket.read_only !== true) throw new Error("patch-only ticket read_only mismatch");
  }
  const existing = normalizeExecutionHandle(ticket.execution_handle);
  ticket.execution_handle = existing;
  if (ticket.liveness && typeof ticket.liveness === "object" && !Array.isArray(ticket.liveness)) {
    const live = ticket.liveness as unknown as Record<string, unknown>;
    const liveHandle = normalizeExecutionHandle(live.execution_handle);
    if (liveHandle) {
      ticket.liveness = {
        ...ticket.liveness,
        execution_handle: liveHandle,
      } as SpawnTicket["liveness"];
    }
  }
  return ticket;
}

/** Pure ticket-side lineage validator; legacy tickets intentionally return null. */
export function validateSpawnTicketLineage(value: unknown): string | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "COMPILED_LINEAGE_MALFORMED";
    const ticket = value as SpawnTicket & Record<string, unknown>;
    if (ticket.compiled_apply_lineage === undefined) {
      const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
      return unit?.schema_version === 2 ? "COMPILED_LINEAGE_PARTIAL" : null;
    }
    normalizeSpawnTicket(ticket);
    return null;
  } catch (error) {
    return error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : "COMPILED_LINEAGE_MISMATCH";
  }
}

export function assertValidSpawnTicketLineage(ticket: unknown): void {
  const error = validateSpawnTicketLineage(ticket);
  if (error) throw new Error(`spawn ticket lineage is invalid: ${error}`);
}

function isCurrentSpawnRecord(value: unknown): value is SpawnTicket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const validHandle = (handle: unknown): boolean => {
    if (handle === null || handle === undefined) return true;
    if (typeof handle !== "object" || Array.isArray(handle)) return false;
    const h = handle as Record<string, unknown>;
    return isHandleKind(h.kind) && typeof h.value === "string" && Boolean(h.value.trim())
      && (h.source === "native-return" || h.source === "manual");
  };
  const liveness = v.liveness;
  return v.schema_version === 8 && typeof v.id === "string"
    && typeof v.session_uid === "string" && Number.isInteger(v.session_ordinal)
    && v.work_unit !== null && typeof v.work_unit === "object"
    && v.coordination !== null && typeof v.coordination === "object"
    && Object.hasOwn(v, "progress") && Object.hasOwn(v, "liveness")
    && Object.hasOwn(v, "selection") && Object.hasOwn(v, "service_tier")
    && validHandle(v.execution_handle)
    && (v.compiled_apply_lineage === undefined || validateCompiledApplyLineage(v.compiled_apply_lineage) === null)
    && (liveness === null || (typeof liveness === "object" && !Array.isArray(liveness)
      && validHandle((liveness as Record<string, unknown>).execution_handle)));
}

export function readSpawn(cwd: string, id: string, env?: NodeJS.ProcessEnv): SpawnTicket {
  const file = path.join(spawnsDir(cwd, env), `${id}.json`);
  if (!fs.existsSync(file)) {
    const err = new Error(`spawn not found: ${id}`) as CodedError;
    err.code = "SPAWN_NOT_FOUND";
    throw err;
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isCurrentSpawnRecord(raw)) {
    const err = new Error(`spawn is not a current-format ticket: ${id}`) as CodedError;
    err.code = "TICKET_FORMAT_UNSUPPORTED";
    throw err;
  }
  return normalizeSpawnTicket(raw);
}

export function writeSpawn(cwd: string, ticket: SpawnTicket, env?: NodeJS.ProcessEnv): SpawnTicket {
  ticket = normalizeSpawnTicket(ticket);
  if (!isCurrentSpawnRecord(ticket)) {
    throw new Error("spawn ticket must be current and include session identity");
  }
  // Persisting a lifecycle change is ticket-targeted: a later environment
  // value must not be able to rewrite another root tree's immutable identity.
  validateSpawnSessionScope(ticket, env);
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

/** Validate the current caller before a ticket-targeted lifecycle mutation. */
export function validateSpawnSessionScope(ticket: Pick<SpawnTicket, "session_uid">, env?: NodeJS.ProcessEnv): SessionScope {
  return assertSessionScope(ticket.session_uid, env);
}

export function sessionUid(env?: NodeJS.ProcessEnv): string {
  return sessionUidFromEnv(env);
}

export function sessionTicketId(prefix: string, uid: string, ordinal: number): string {
  if (!/^(?:spn|os)$/.test(prefix) || !/^[0-9a-f]{64}$/.test(uid) || !Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error("invalid session ticket identity");
  }
  return `${prefix}-${uid}-${String(ordinal).padStart(4, "0")}`;
}

export function nextSpawnId(cwd: string, prefix = "spn", env?: NodeJS.ProcessEnv): string {
  if (!/^(?:spn|os)$/.test(prefix)) throw new Error("invalid session ticket prefix");
  const uid = sessionUid(env);
  const existing = listSpawns(cwd, env);
  let max = 0;
  for (const s of existing) {
    // Standalone and OpenSpec tickets share one session ordinal namespace.
    // Scope discovery to the exact current session uid so another session's
    // history can never consume an ordinal for this invocation.
    const m = String(s.id).match(/^(spn|os)-([0-9a-f]{64})-(\d+)$/);
    if (!m || m[2] !== uid || s.session_uid !== uid) continue;
    max = Math.max(max, Number(m[3]));
  }
  return sessionTicketId(prefix, uid, max + 1);
}

/** Reserve a deterministic contiguous id range before a multi-unit wave is persisted. */
export function nextSpawnIds(cwd: string, prefix = "spn", count = 1, env?: NodeJS.ProcessEnv): string[] {
  const first = nextSpawnId(cwd, prefix, env);
  const match = first.match(/^(.*-)(\d+)$/);
  if (!match) return Array.from({ length: count }, (_, index) => `${first}-${index + 1}`);
  const start = Number(match[2]);
  return Array.from({ length: count }, (_, index) => `${match[1]}${String(start + index).padStart(match[2].length, "0")}`);
}

interface BuildSpawnTicketOptions {
  id?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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
  /** A director-compiled apply identity. Snake/camel aliases are accepted at the boundary. */
  compiledApplyLineage?: unknown;
  compiled_apply_lineage?: unknown;
  compiledLineage?: unknown;
  compiled_lineage?: unknown;
  mode?: "patch-only" | "verification-only";
  executionMode?: "patch-only" | "verification-only";
  execution_mode?: "patch-only" | "verification-only";
  runId?: string;
  run_id?: string;
  planRevision?: string | number;
  plan_revision?: string | number;
  planFingerprint?: string;
  plan_fingerprint?: string;
  unitId?: string;
  unit_id?: string;
  taskRefs?: readonly string[];
  task_refs?: readonly string[];
  satisfiedDependencies?: readonly string[];
  satisfied_dependencies?: readonly string[];
  readContext?: readonly string[];
  read_context?: readonly string[];
  writePaths?: readonly string[];
  write_paths?: readonly string[];
  allowedOperations?: readonly ("write" | "create" | "delete" | "rename" | "chmod")[];
  allowed_operations?: readonly ("write" | "create" | "delete" | "rename" | "chmod")[];
  patchRecipe?: string;
  patch_recipe?: string;
  completionCriteria?: readonly string[];
  completion_criteria?: readonly string[];
  permittedValidation?: readonly string[];
  permitted_validation?: readonly string[];
  compiledWorkUnit?: unknown;
  compiled_work_unit?: unknown;
}

export function buildSpawnTicket({
  id: requestedId,
  cwd,
  env,
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
  compiledApplyLineage,
  compiled_apply_lineage,
  compiledLineage,
  compiled_lineage,
  mode: compiledMode,
  executionMode,
  execution_mode,
  runId,
  run_id,
  planRevision,
  plan_revision,
  planFingerprint,
  plan_fingerprint,
  unitId,
  unit_id,
  taskRefs,
  task_refs,
  satisfiedDependencies,
  satisfied_dependencies,
  readContext,
  read_context,
  writePaths,
  write_paths,
  allowedOperations,
  allowed_operations,
  patchRecipe,
  patch_recipe,
  completionCriteria,
  completion_criteria,
  permittedValidation,
  permitted_validation,
  compiledWorkUnit,
  compiled_work_unit,
}: BuildSpawnTicketOptions): SpawnTicket {
  const scope = sessionScope(env);
  const uid = scope.session_uid;
  const id = requestedId || (cwd ? nextSpawnId(cwd, "spn", env) : "");
  const idMatch = id.match(/^(spn|os)-([0-9a-f]{64})-(\d+)$/);
  const sessionOrdinal = idMatch && idMatch[2] === uid ? Number(idMatch[3]) : 0;
  const canonicalId = idMatch && sessionOrdinal > 0 ? sessionTicketId(idMatch[1], idMatch[2], sessionOrdinal) : null;
  if (!sessionOrdinal || canonicalId !== id) throw new Error("ticket id must use the current session uid and padded ordinal");
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const suppliedWorkUnit = compiledWorkUnit ?? compiled_work_unit;
  const suppliedLineage = compiledApplyLineage ?? compiled_apply_lineage ?? compiledLineage ?? compiled_lineage
    ?? (suppliedWorkUnit && typeof suppliedWorkUnit === "object" ? {
      run_id: (suppliedWorkUnit as Record<string, unknown>).run_id,
      plan_revision: (suppliedWorkUnit as Record<string, unknown>).plan_revision,
      plan_fingerprint: (suppliedWorkUnit as Record<string, unknown>).plan_fingerprint,
      unit_id: (suppliedWorkUnit as Record<string, unknown>).unit_id,
      task_refs: (suppliedWorkUnit as Record<string, unknown>).task_refs,
      mode: (suppliedWorkUnit as Record<string, unknown>).mode,
    } : undefined);
  const inferredMode = compiledMode ?? executionMode ?? execution_mode;
  const lineage = suppliedLineage === undefined && inferredMode === undefined
    ? undefined
    : normalizeCompiledApplyLineage(suppliedLineage ?? {
      run_id: run_id ?? runId,
      plan_revision: plan_revision ?? planRevision,
      plan_fingerprint: plan_fingerprint ?? planFingerprint,
      unit_id: unit_id ?? unitId,
      task_refs: task_refs ?? taskRefs,
      mode: inferredMode,
    });
  const workUnit = suppliedWorkUnit
    ? compileWorkUnit(suppliedWorkUnit)
    : lineage
    ? compileWorkUnit(description, {
      kind: "concrete",
      deliverable: deliverable || description,
      doneWhen: doneWhen || description,
      mode: lineage.mode,
      run_id: lineage.run_id,
      plan_revision: lineage.plan_revision,
      plan_fingerprint: lineage.plan_fingerprint,
      unit_id: lineage.unit_id,
      task_refs: lineage.task_refs,
      satisfied_dependencies: satisfied_dependencies ?? satisfiedDependencies ?? [],
      read_context: read_context ?? readContext ?? [],
      write_paths: write_paths ?? writePaths ?? [],
      allowed_operations: allowed_operations ?? allowedOperations ?? [],
      patch_recipe: patch_recipe ?? patchRecipe ?? description,
      completion_criteria: completion_criteria ?? completionCriteria ?? [description],
      permitted_validation: permitted_validation ?? permittedValidation ?? ["read"],
    })
    : compileWorkUnit(description, { kind: taskKind, deliverable, doneWhen });
  if (lineage && workUnit.schema_version === 2) {
    for (const field of ["run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "mode"] as const) {
      if (JSON.stringify(lineage[field]) !== JSON.stringify(workUnit[field])) throw new Error(`compiled work unit lineage mismatch: ${field}`);
    }
  }
  const coordination = coordinationFor(workUnit);
  return {
    schema_version: 8,
    id,
    session_uid: uid,
    session_ordinal: sessionOrdinal,
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
    ...(lineage ? { compiled_apply_lineage: lineage } : {}),
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
  id?: string;
}

export type StandalonePlan =
  | { director_local: true; reason: string; description: string }
  | { director_local: false; ticket: SpawnTicket; receipt: DelegationReceipt; queue: { running: number; queued: number } };

export function planStandaloneSpawn({ description, prompt = null, cards, explicitModel, queue, cwd, taskKind, deliverable, doneWhen, selectionApproval = null, host = null, forceDelegate: _forceDelegate = false, env, id: requestedId }: PlanStandaloneOptions): StandalonePlan {
  void queue;
  const card = explicitModel
    ? requireCardId(explicitModel, cards)
    : matchModelCard(description, cards).card;
  const id = requestedId || nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    id,
    cwd,
    env,
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
  // Validate before writing the Receipt so a cross-session caller leaves no
  // partial lifecycle artifact behind.
  validateSpawnSessionScope(planned.ticket, env);
  writeReceipt(cwd, planned.receipt, env);
  return writeSpawn(cwd, planned.ticket, env);
}
