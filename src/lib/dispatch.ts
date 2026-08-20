import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeConclusion, sanitizeProgress } from "./hygiene.js";
import { listSpawns, readSpawn, writeSpawn } from "./spawn.js";
import type { SpawnTicket, TicketError, TicketProgressPhase, TicketStatus } from "./spawn.js";
import type { UnknownRecord } from "../types.js";
import { dispatchLockPath, dispatchStatePath } from "./paths.js";
import { readReceipt, type DelegationReceipt } from "./receipt.js";
import { auditWorktree, type SafetyOperation } from "./safety.js";
import { writeTaskConclusionByNumber } from "./openspec.js";
import { recordRouteHealth } from "./route-health.js";
import { buildWorkerPrompt, compileWorkUnit, coordinationFor } from "./work-unit.js";
import { readHostCapabilitySnapshot } from "./host-capabilities.js";
import { readRouteSnapshot } from "./routes.js";
import { subagentModelPolicy } from "./model-policy.js";

export const TERMINAL_TICKET_STATUSES = new Set<TicketStatus>(["completed", "errored", "timed_out", "closed"]);

function normalizeTicketContract(ticket: SpawnTicket): SpawnTicket {
  const needsContract = !ticket.work_unit;
  if (needsContract) ticket.work_unit = compileWorkUnit(ticket.description || ticket.prompt);
  if (!ticket.coordination) ticket.coordination = coordinationFor(ticket.work_unit);
  if (needsContract && !ticket.prompt.includes("[Baton work unit]")) {
    ticket.prompt = buildWorkerPrompt(ticket.prompt, ticket.work_unit, ticket.coordination);
  }
  if (ticket.progress === undefined) ticket.progress = null;
  if (ticket.selection === undefined) ticket.selection = null;
  if (Number(ticket.schema_version || 1) < 4) ticket.schema_version = 4;
  return ticket;
}

/** A bound agent keeps consuming a host thread until close_agent is confirmed. */
function holdsHostSlot(ticket: SpawnTicket): boolean {
  if (ticket.status === "dispatching") return true;
  if (!ticket.agent_id) return false;
  if (ticket.status === "running") return true;
  return Number(ticket.schema_version || 1) >= 3
    && TERMINAL_TICKET_STATUSES.has(ticket.status)
    && !ticket.slot_released_at;
}

interface DispatchErrorExtras extends UnknownRecord {
  ticketId?: string;
  currentStatus?: TicketStatus;
  nextStatus?: TicketStatus;
}

export class DispatchError extends Error {
  readonly code: string;
  readonly ticketId?: string;
  readonly currentStatus?: TicketStatus;
  readonly nextStatus?: TicketStatus;

  constructor(message: string, code = "DISPATCH_ERROR", extras: DispatchErrorExtras = {}) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    Object.assign(this, extras);
  }
}

/** Host-reported terminal failure, kept as structured evidence when the safety gate overrides it. */
type TerminalDispatchStatus = "completed" | "errored" | "timed_out" | "closed";

interface HostTerminalError {
  status: Exclude<TerminalDispatchStatus, "completed">;
  code: string;
  message: string;
}

interface WriteScopeRejection extends TicketError {
  host_error?: HostTerminalError;
}

function updateRouteHealth(cwd: string, ticket: SpawnTicket, status: TerminalDispatchStatus, error: HostTerminalError | null, at: string): void {
  if (!ticket.route_id) return;
  recordRouteHealth(cwd, {
    routeId: ticket.route_id,
    profile: ticket.reasoning_effort,
    host: ticket.host || ticket.dispatch_host || "codex",
    taskText: ticket.prompt,
    terminalStatus: status,
    errorCode: error?.code || null,
    message: error?.message || null,
    now: new Date(at),
  });
}

type TimeInput = Date | string | number | (() => Date | string | number) | undefined;

function instant(now?: TimeInput): Date {
  const value = typeof now === "function" ? now() : now;
  const date = value == null ? new Date() : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new DispatchError("invalid dispatch timestamp", "INVALID_TIME");
  return date;
}

function history(ticket: SpawnTicket, event: string, at: string, detail: UnknownRecord = {}): void {
  if (!Array.isArray(ticket.history)) ticket.history = [];
  ticket.history.push({ event, at, ...detail });
  ticket.updated_at = at;
}

interface TransitionOptions {
  at: string;
  event?: string;
  detail?: UnknownRecord;
}

function transition(ticket: SpawnTicket, expected: TicketStatus | TicketStatus[], next: TicketStatus, { at, event = next, detail = {} }: TransitionOptions): SpawnTicket {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(ticket.status)) {
    throw new DispatchError(
      `invalid ticket transition ${ticket.id}: ${ticket.status} -> ${next}`,
      "INVALID_TICKET_TRANSITION",
      { ticketId: ticket.id, currentStatus: ticket.status, nextStatus: next },
    );
  }
  ticket.status = next;
  history(ticket, event, at, detail);
  return ticket;
}

function fifoTickets(cwd: string): SpawnTicket[] {
  return listSpawns(cwd).sort((a, b) => {
    const time = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    return time || String(a.id).localeCompare(String(b.id));
  });
}

function lockPath(cwd: string): string {
  return dispatchLockPath(cwd);
}

function withLock<T>(cwd: string, fn: () => T): T {
  const file = lockPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new DispatchError("another dispatcher holds the project lock", "DISPATCH_LOCKED");
    throw error;
  }
  try {
    return fn();
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch {}
    }
    try { fs.unlinkSync(file); } catch {}
  }
}

function capacityValue(capacity: unknown): number {
  const value = Number(capacity);
  if (!Number.isInteger(value) || value < 1) throw new DispatchError("capacity must be a positive integer", "INVALID_CAPACITY");
  return value;
}

function readDispatchState(cwd: string): UnknownRecord {
  try {
    return JSON.parse(fs.readFileSync(dispatchStatePath(cwd), "utf8")) as UnknownRecord;
  } catch {
    return {};
  }
}

function writeDispatchState(cwd: string, state: UnknownRecord): void {
  const file = dispatchStatePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid + "-" + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/** Capacity persisted by `dispatch next`, or null when no dispatch session has run yet. */
export function persistedCapacity(cwd: string): number | null {
  const value = Number(readDispatchState(cwd).capacity);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** Remember the capacity used by `dispatch next` so later bind/complete/status/recover calls inherit it. */
export function rememberDispatchCapacity(cwd: string, capacity: number): number {
  const max = capacityValue(capacity);
  const state = readDispatchState(cwd);
  state.capacity = max;
  writeDispatchState(cwd, state);
  return max;
}

export interface DispatchSpec {
  ticket_id: string;
  route_id: string;
  model: string;
  reasoning_effort: string | null;
  fork_context: false;
  read_only: boolean;
  mode: "read-only" | "write";
  receipt_id: string;
  write_allowlist: string[];
  allowed_operations: string[];
  prompt: string;
  work_unit: SpawnTicket["work_unit"];
  coordination: SpawnTicket["coordination"];
  attempt: number;
  max_attempts: number;
  selection: NonNullable<SpawnTicket["selection"]>;
}

function publicDispatchSpec(ticket: SpawnTicket & { route_id: string; receipt_id: string }, receipt: DelegationReceipt): DispatchSpec {
  return {
    ticket_id: ticket.id,
    route_id: ticket.route_id,
    model: ticket.route_id,
    reasoning_effort: ticket.reasoning_effort || null,
    fork_context: false,
    read_only: ticket.read_only,
    mode: ticket.mode,
    receipt_id: ticket.receipt_id,
    write_allowlist: receipt.scope.write_allowlist,
    allowed_operations: receipt.scope.allowed_operations,
    prompt: ticket.prompt,
    work_unit: ticket.work_unit,
    coordination: ticket.coordination,
    attempt: ticket.attempt,
    max_attempts: ticket.max_attempts,
    selection: ticket.selection!,
  };
}

function rejectUndispatchable(cwd: string, ticket: SpawnTicket, at: string): { ticket_id: string; code: string; message: string } | null {
  let code = null;
  let message = null;
  if (!ticket.route_id) {
    code = "NO_EXECUTABLE_ROUTE";
    message = `ticket ${ticket.id} has no executable route for this host`;
  } else if (!subagentModelPolicy(ticket.route_id, ticket.model_id).allowed) {
    const policy = subagentModelPolicy(ticket.route_id, ticket.model_id);
    code = policy.code;
    message = `ticket ${ticket.id}: ${policy.reason}`;
  } else if (ticket.fork_context !== false) {
    code = "FULL_CONTEXT_NOT_ALLOWED";
    message = `ticket ${ticket.id} must use fork_context=false`;
  } else if (ticket.work_unit.kind === "deliberative" && ticket.coordination.mode !== "checkpointed") {
    code = "COORDINATION_REQUIRED";
    message = `ticket ${ticket.id} is deliberative and requires checkpointed coordination`;
  } else if (Number(ticket.attempt || 0) >= Number(ticket.max_attempts || 1)) {
    code = "ATTEMPT_BUDGET_EXHAUSTED";
    message = `ticket ${ticket.id} exhausted its attempt budget`;
  } else if (!ticket.selection || ticket.selection.confirmed_by !== "user" || ticket.selection.selected_model_id !== ticket.model_id) {
    code = "MODEL_SELECTION_NOT_CONFIRMED";
    message = `ticket ${ticket.id} has no valid user-confirmed model selection`;
  } else {
    const host = readHostCapabilitySnapshot(cwd);
    const catalog = readRouteSnapshot(cwd);
    if (!host || host.id !== ticket.selection.host_snapshot_id || !catalog || catalog.fingerprint !== host.catalog_fingerprint) {
      code = "HOST_CAPABILITIES_STALE";
      message = `ticket ${ticket.id} was not approved against the current Codex host snapshot`;
    } else if (!host.advertised_models.includes(ticket.route_id)) {
      code = "HOST_ROUTE_UNAVAILABLE";
      message = `ticket ${ticket.id} route ${ticket.route_id} is absent from the current Codex spawn surface`;
    } else if (ticket.reasoning_effort && !(host.advertised_profiles[ticket.route_id] || []).includes(ticket.reasoning_effort)) {
      code = "HOST_PROFILE_UNAVAILABLE";
      message = `ticket ${ticket.id} profile ${ticket.reasoning_effort} is absent from the current Codex spawn surface`;
    }
  }
  if (!code && !ticket.receipt_id) {
    code = "RECEIPT_REQUIRED";
    message = `ticket ${ticket.id} has no Delegation Receipt`;
  } else if (!code) {
    try {
      const receipt = readReceipt(cwd, ticket.receipt_id);
      if (receipt.ticket_id !== ticket.id
        || receipt.route.route_id !== ticket.route_id
        || receipt.execution.mode !== ticket.mode
        || !receipt.selection
        || receipt.selection.approval_id !== ticket.selection!.approval_id
        || receipt.selection.selected_model_id !== ticket.model_id) {
        code = "RECEIPT_MISMATCH";
        message = `ticket ${ticket.id} does not match its Delegation Receipt`;
      }
    } catch (error) {
      code = "RECEIPT_INVALID";
      message = error instanceof Error ? error.message : String(error);
    }
  }
  if (!code) return null;
  transition(ticket, "queued", "errored", { at, event: "dispatch_blocked", detail: { error_code: code } });
  ticket.error = { code, message };
  ticket.finished_at = at;
  writeSpawn(cwd, ticket);
  return { ticket_id: ticket.id, code, message };
}

interface ReserveOptions {
  capacity: number;
  limit?: number;
  host?: string;
  now?: TimeInput;
}

export function reserveNext(cwd: string, { capacity, limit = Number.MAX_SAFE_INTEGER, host = "codex", now }: ReserveOptions) {
  const max = capacityValue(capacity);
  const maxTake = Math.max(0, Math.floor(Number(limit) || 0));
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const tickets = fifoTickets(cwd);
    const active = tickets.filter(holdsHostSlot).length;
    let available = Math.max(0, max - active);
    const reserved: DispatchSpec[] = [];
    const blocked: Array<{ ticket_id: string; code: string; message: string }> = [];
    for (const ticket of tickets) {
      if (ticket.status !== "queued" || available <= 0 || reserved.length >= maxTake) continue;
      normalizeTicketContract(ticket);
      const rejected = rejectUndispatchable(cwd, ticket, at);
      if (rejected) {
        blocked.push(rejected);
        continue;
      }
      transition(ticket, "queued", "dispatching", { at, event: "dispatch_reserved", detail: { host } });
      ticket.dispatch_host = host;
      ticket.dispatch_requested_at = at;
      ticket.attempt = Number(ticket.attempt || 0) + 1;
      ticket.error = null;
      writeSpawn(cwd, ticket);
      const receipt = readReceipt(cwd, ticket.receipt_id!);
      reserved.push(publicDispatchSpec(ticket as SpawnTicket & { route_id: string; receipt_id: string }, receipt));
      available -= 1;
    }
    rememberDispatchCapacity(cwd, max);
    return { reserved, blocked, snapshot: dispatchSnapshot(cwd, { capacity: max }) };
  });
}

interface BindOptions { agentId: string; host?: string; now?: TimeInput }

export function bindAgent(cwd: string, id: string, { agentId, host = "codex", now }: BindOptions): SpawnTicket {
  const workerId = String(agentId || "").trim();
  if (!workerId) throw new DispatchError("agentId is required", "AGENT_ID_REQUIRED", { ticketId: id });
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = normalizeTicketContract(readSpawn(cwd, id));
    if (ticket.dispatch_host && ticket.dispatch_host !== host) {
      throw new DispatchError(`ticket ${id} was reserved for ${ticket.dispatch_host}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    transition(ticket, "dispatching", "running", { at, event: "agent_bound", detail: { host, agent_id: workerId } });
    ticket.agent_id = workerId;
    ticket.host = host;
    ticket.started_at = at;
    writeSpawn(cwd, ticket);
    return ticket;
  });
}

interface DeferOptions {
  code?: string;
  message?: string;
  observedCapacity?: number | null;
  now?: TimeInput;
}

/**
 * Host concurrency rejection is backpressure, not a worker/route failure.
 * Return the same ticket to FIFO without consuming an attempt.
 */
export function deferDispatch(cwd: string, id: string, {
  code = "AGENT_LIMIT_REACHED",
  message = "host has no free subagent thread",
  observedCapacity = null,
  now,
}: DeferOptions = {}): SpawnTicket {
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = normalizeTicketContract(readSpawn(cwd, id));
    if (ticket.agent_id) throw new DispatchError(`ticket ${id} is already bound`, "AGENT_ALREADY_BOUND", { ticketId: id });
    transition(ticket, "dispatching", "queued", {
      at,
      event: "dispatch_deferred",
      detail: { error_code: String(code), message: String(message) },
    });
    ticket.attempt = Math.max(0, Number(ticket.attempt || 0) - 1);
    ticket.error = null;
    delete ticket.dispatch_host;
    delete ticket.dispatch_requested_at;
    writeSpawn(cwd, ticket);
    if (observedCapacity != null) rememberDispatchCapacity(cwd, observedCapacity);
    return ticket;
  });
}

const PROGRESS_PHASES = new Set<TicketProgressPhase>(["starting", "working", "waiting", "blocked", "checkpoint"]);

interface ProgressOptions {
  phase: TicketProgressPhase;
  summary: string;
  nextStep?: string | null;
  blocker?: string | null;
  needsDirector?: boolean;
  now?: TimeInput;
}

export function reportAgentProgress(cwd: string, id: string, {
  phase,
  summary,
  nextStep = null,
  blocker = null,
  needsDirector = false,
  now,
}: ProgressOptions): SpawnTicket {
  if (!PROGRESS_PHASES.has(phase)) throw new DispatchError(`invalid progress phase: ${phase}`, "INVALID_PROGRESS_PHASE", { ticketId: id });
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = normalizeTicketContract(readSpawn(cwd, id));
    if (ticket.status !== "running") {
      throw new DispatchError(`ticket ${id} is not running`, "PROGRESS_REQUIRES_RUNNING", { ticketId: id, currentStatus: ticket.status });
    }
    const clean = sanitizeProgress(summary);
    if (!clean.ok) throw new DispatchError("error" in clean ? clean.error : "invalid progress", "HYGIENE", { ticketId: id });
    const cleanOptional = (value: string | null): string | null => {
      if (!value) return null;
      const result = sanitizeProgress(value);
      if (!result.ok) throw new DispatchError("error" in result ? result.error : "invalid progress", "HYGIENE", { ticketId: id });
      return result.conclusion;
    };
    ticket.progress = {
      sequence: Number(ticket.progress?.sequence || 0) + 1,
      phase,
      summary: clean.conclusion,
      next_step: cleanOptional(nextStep),
      blocker: cleanOptional(blocker),
      needs_director: Boolean(needsDirector),
      reported_at: at,
    };
    history(ticket, "agent_progress", at, {
      sequence: ticket.progress.sequence,
      phase,
      needs_director: ticket.progress.needs_director,
    });
    writeSpawn(cwd, ticket);
    return ticket;
  });
}

interface FinishOptions {
  status: "completed" | "errored" | "timed_out" | "closed";
  conclusion?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: TimeInput;
}

export function finishAgent(cwd: string, id: string, { status, conclusion = null, errorCode = null, errorMessage = null, now }: FinishOptions): SpawnTicket {
  const terminal = String(status || "").trim();
  if (!TERMINAL_TICKET_STATUSES.has(terminal as TicketStatus)) throw new DispatchError(`invalid terminal status: ${terminal}`, "INVALID_TERMINAL_STATUS", { ticketId: id });
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = normalizeTicketContract(readSpawn(cwd, id));
    if (TERMINAL_TICKET_STATUSES.has(ticket.status)) {
      throw new DispatchError(`ticket ${id} is already terminal: ${ticket.status}`, "TICKET_ALREADY_TERMINAL", { ticketId: id });
    }
    const expected: TicketStatus | TicketStatus[] = terminal === "completed" ? "running" : ["dispatching", "running"];
    if (terminal === "completed" && !ticket.agent_id) throw new DispatchError(`ticket ${id} has no bound agent`, "AGENT_NOT_BOUND", { ticketId: id });
    let hostError: HostTerminalError | null = null;
    if (terminal !== "completed") {
      const code = String(errorCode || (terminal === "timed_out" ? "AGENT_TIMEOUT" : terminal === "closed" ? "AGENT_CLOSED" : "AGENT_ERROR"));
      hostError = { status: terminal as HostTerminalError["status"], code, message: String(errorMessage || code) };
    }
    // Every terminal path of a write ticket runs the parent Git safety audit before the slot is released.
    if (ticket.mode === "write") {
      if (!ticket.receipt_id) throw new DispatchError(`ticket ${id} has no Receipt`, "RECEIPT_REQUIRED", { ticketId: id });
      const receipt = readReceipt(cwd, ticket.receipt_id);
      if (!receipt.baseline) throw new DispatchError(`ticket ${id} has no Git baseline`, "BASELINE_REQUIRED", { ticketId: id });
      const allowedOperations = receipt.scope.allowed_operations.filter((item): item is SafetyOperation => item !== "read");
      const verdict = auditWorktree(cwd, receipt.baseline, { write_allowlist: receipt.scope.write_allowlist, allowed_operations: allowedOperations });
      ticket.safety_verdict = verdict as unknown as UnknownRecord;
      if (!verdict.accepted) {
        transition(ticket, expected, "errored", {
          at,
          event: "safety_gate_rejected",
          detail: {
            error_code: "WRITE_SCOPE_VIOLATION",
            ...(hostError ? { host_status: hostError.status, host_error_code: hostError.code } : {}),
          },
        });
        const rejection: WriteScopeRejection = {
          code: "WRITE_SCOPE_VIOLATION",
          message: verdict.violations.map((item) => item.code + ":" + (item.path || "repository")).join(", "),
        };
        if (hostError) rejection.host_error = hostError;
        ticket.error = rejection;
        ticket.conclusion = null;
        ticket.finished_at = at;
        writeSpawn(cwd, ticket);
        if (hostError) updateRouteHealth(cwd, ticket, hostError.status, hostError, at);
        return ticket;
      }
    }
    if (terminal === "completed") {
      const clean = sanitizeConclusion(conclusion);
      if (!clean.ok) throw new DispatchError("error" in clean ? clean.error : "invalid conclusion", "HYGIENE", { ticketId: id });
      if (ticket.openspec && typeof ticket.openspec.tasks_path === "string" && typeof ticket.openspec.number === "string") {
        const current = fs.readFileSync(ticket.openspec.tasks_path, "utf8");
        const updated = writeTaskConclusionByNumber(current, ticket.openspec.number, clean.conclusion);
        fs.writeFileSync(ticket.openspec.tasks_path, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
      }
      transition(ticket, expected, terminal as TicketStatus, { at, event: "agent_completed" });
      ticket.conclusion = clean.conclusion;
      ticket.error = null;
    } else {
      if (!hostError) throw new DispatchError("invalid terminal status: " + terminal, "INVALID_TERMINAL_STATUS", { ticketId: id });
      transition(ticket, expected, terminal as TicketStatus, { at, event: "agent_" + terminal, detail: { error_code: hostError.code } });
      ticket.error = { code: hostError.code, message: hostError.message };
      if (conclusion) {
        const clean = sanitizeConclusion(conclusion);
        if (clean.ok) ticket.conclusion = clean.conclusion;
      }
    }
    ticket.finished_at = at;
    writeSpawn(cwd, ticket);
    updateRouteHealth(cwd, ticket, terminal as TerminalDispatchStatus, hostError, at);
    return ticket;
  });
}

interface ReleaseOptions { agentId?: string | null; now?: TimeInput }

/** Confirm that the host has closed the bound agent thread and released its slot. */
export function releaseAgent(cwd: string, id: string, { agentId = null, now }: ReleaseOptions = {}): SpawnTicket {
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = readSpawn(cwd, id);
    if (!TERMINAL_TICKET_STATUSES.has(ticket.status)) {
      throw new DispatchError(`ticket ${id} is not terminal`, "RELEASE_REQUIRES_TERMINAL", { ticketId: id, currentStatus: ticket.status });
    }
    if (!ticket.agent_id) {
      throw new DispatchError(`ticket ${id} has no bound agent`, "AGENT_NOT_BOUND", { ticketId: id });
    }
    if (agentId && ticket.agent_id !== agentId) {
      throw new DispatchError(`ticket ${id} is bound to ${ticket.agent_id}, not ${agentId}`, "AGENT_ID_MISMATCH", { ticketId: id });
    }
    if (ticket.slot_released_at) {
      throw new DispatchError(`ticket ${id} slot is already released`, "SLOT_ALREADY_RELEASED", { ticketId: id });
    }
    ticket.slot_released_at = at;
    history(ticket, "agent_slot_released", at, { agent_id: ticket.agent_id });
    writeSpawn(cwd, ticket);
    return ticket;
  });
}

interface RecoverOptions { staleMs?: number; now?: TimeInput }

export function recoverDispatches(cwd: string, { staleMs = 60_000, now }: RecoverOptions = {}) {
  const threshold = Number(staleMs);
  if (!Number.isFinite(threshold) || threshold < 0) throw new DispatchError("staleMs must be non-negative", "INVALID_STALE_MS");
  return withLock(cwd, () => {
    const current = instant(now);
    const at = current.toISOString();
    const expired: string[] = [];
    const resumable: Array<{ ticket_id: string; agent_id: string; host: string | null }> = [];
    const needs_close: Array<{ ticket_id: string; agent_id: string; host: string | null }> = [];
    for (const ticket of fifoTickets(cwd)) {
      if (ticket.status === "running" && ticket.agent_id) {
        resumable.push({ ticket_id: ticket.id, agent_id: ticket.agent_id, host: ticket.host || ticket.dispatch_host || null });
        continue;
      }
      if (TERMINAL_TICKET_STATUSES.has(ticket.status) && holdsHostSlot(ticket) && ticket.agent_id) {
        needs_close.push({ ticket_id: ticket.id, agent_id: ticket.agent_id, host: ticket.host || ticket.dispatch_host || null });
        continue;
      }
      if (ticket.status !== "dispatching" || ticket.agent_id) continue;
      const requested = Date.parse(ticket.dispatch_requested_at || ticket.updated_at || ticket.created_at || "");
      if (!Number.isFinite(requested) || current.getTime() - requested < threshold) continue;
      transition(ticket, "dispatching", "errored", { at, event: "dispatch_lease_expired", detail: { error_code: "DISPATCH_LEASE_EXPIRED" } });
      ticket.error = { code: "DISPATCH_LEASE_EXPIRED", message: "host did not bind an agent before the dispatch lease expired" };
      ticket.finished_at = at;
      writeSpawn(cwd, ticket);
      expired.push(ticket.id);
    }
    return { expired, resumable, needs_close };
  });
}

export function dispatchSnapshot(cwd: string, { capacity, now }: { capacity?: number; now?: TimeInput } = {}) {
  const max = capacity == null ? (persistedCapacity(cwd) ?? 1) : capacityValue(capacity);
  const tickets = fifoTickets(cwd);
  const counts: Partial<Record<TicketStatus, number>> = {};
  for (const ticket of tickets) counts[ticket.status] = (counts[ticket.status] || 0) + 1;
  const active = tickets.filter(holdsHostSlot);
  const currentMs = instant(now).getTime();
  const progressDue = tickets.filter((ticket) => {
    if (ticket.status !== "running" || ticket.coordination?.mode !== "checkpointed") return false;
    const interval = Number(ticket.coordination.progress_interval_ms || 0);
    if (interval <= 0) return false;
    const last = Date.parse(ticket.progress?.reported_at || ticket.started_at || ticket.updated_at || ticket.created_at || "");
    return Number.isFinite(last) && currentMs - last >= interval;
  }).map((ticket) => ticket.id);
  return {
    capacity: max,
    active: active.length,
    available: Math.max(0, max - active.length),
    counts,
    queued: tickets.filter((ticket) => ticket.status === "queued").map((ticket) => ticket.id),
    dispatching: tickets.filter((ticket) => ticket.status === "dispatching").map((ticket) => ticket.id),
    running: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({ ticket_id: ticket.id, agent_id: ticket.agent_id, host: ticket.host || ticket.dispatch_host || null })),
    running_progress: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({
      ticket_id: ticket.id,
      task_kind: ticket.work_unit?.kind || null,
      coordination: ticket.coordination?.mode || null,
      progress: ticket.progress || null,
    })),
    progress_due: progressDue,
    awaiting_release: tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status) && holdsHostSlot(ticket))
      .map((ticket) => ({ ticket_id: ticket.id, agent_id: ticket.agent_id, status: ticket.status })),
    terminal: tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status)).map((ticket) => ({ ticket_id: ticket.id, status: ticket.status, error: ticket.error || null })),
  };
}
