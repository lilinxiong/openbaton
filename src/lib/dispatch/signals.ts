import {
  readSpawn,
  sessionUid,
  writeSpawn
} from "../spawn/store.js";
import { requireHost } from "./core.js";
import { withLock } from "./lock.js";
import { validateRollingDispatchArtifacts } from "./guard.js";
import { UnknownRecord } from "../../types.js";
import { markRouteAvailable } from "../model-availability.js";
import { availabilityOutcome } from "./successor.js";
import { sanitizeProgress } from "../hygiene.js";
import {
  requireExactRootAdapter,
  transitionExactRootRecord,
  verifyExactExecutionRoot
} from "./exact-root.js";
import {
  isCompiledApplyTicket,
  rejectCompiledTicketValidation,
  validateCompiledTicket
} from "./compiled.js";
import {
  AgentProbeActivity,
  AgentProbeState,
  NativeExecutionHandle,
  SpawnTicket,
  TicketProgressPhase
} from "../spawn.js";
import {
  DispatchError,
  TimeInput,
  instant,
  requireSessionTicket,
  ticketTargetHost,
  transition
} from "./core.js";
import {
  ExactExecutionRootIdentity,
  extractExactExecutionRootIdentity,
  sameExactExecutionRootIdentity
} from "../../adapters/contract.js";
import { getCliAdapter } from "../../adapters/index.js";
import { history } from "./core.js";
/**
 * Agent bind/defer/probe/progress signals. Split from dispatch.ts.
 */

export interface BindOptions {
  /** Native execution handle returned by the serving host. */
  executionHandle?: NativeExecutionHandle;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
}

export const AGENT_PROBE_STATES = new Set<AgentProbeState>(["pending_init", "running", "interrupted", "shutdown", "not_found"]);
export const AGENT_PROBE_ACTIVITIES = new Set<AgentProbeActivity>(["status", "output", "heartbeat"]);
export const LIVE_AGENT_PROBE_STATES = new Set<AgentProbeState>(["pending_init", "running"]);

export function updateTicketLiveness(
  ticket: SpawnTicket,
  handle: NativeExecutionHandle,
  state: AgentProbeState,
  activity: AgentProbeActivity,
  at: string,
): void {
  ticket.liveness = {
    sequence: Number(ticket.liveness?.sequence || 0) + 1,
    execution_handle: handle,
    state,
    activity,
    observed_at: at,
  };
}

export function currentHandleForTicket(ticket: SpawnTicket): NativeExecutionHandle | null {
  return ticket.execution_handle;
}

/**
 * Probe/release callers may rely on the complete handle persisted at bind.
 * When they repeat any exact-root field, however, the repetition must remain
 * complete and identical so a partial or rewritten lineage cannot be hidden.
 */
export function assertOptionalExactRootAcknowledgement(
  ticketId: string,
  operation: "probe" | "release",
  requested: NativeExecutionHandle,
  bound: NativeExecutionHandle,
): void {
  let repeated: ExactExecutionRootIdentity | undefined;
  try { repeated = extractExactExecutionRootIdentity(requested); }
  catch {
    throw new DispatchError(
      `ticket ${ticketId} ${operation} handle has a partial exact-root acknowledgement`,
      "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH",
      { ticketId },
    );
  }
  if (repeated && !sameExactExecutionRootIdentity(repeated, bound)) {
    throw new DispatchError(
      `ticket ${ticketId} ${operation} handle exact-root acknowledgement does not match`,
      "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH",
      { ticketId },
    );
  }
}

export function bindAgent(cwd: string, id: string, {
  executionHandle,
  host,
  now,
  env = process.env,
}: BindOptions): SpawnTicket {
  sessionUid(env);
  host = requireHost(host, env);
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    const targetHost = ticketTargetHost(ticket, env);
    if (targetHost !== host || (ticket.dispatch_host && ticket.dispatch_host !== host)) {
      throw new DispatchError(`ticket ${id} targets ${targetHost}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (ticket.status !== "dispatching") {
      throw new DispatchError(
        `invalid ticket transition ${ticket.id}: ${ticket.status} -> running`,
        "INVALID_TICKET_TRANSITION",
        { ticketId: id, currentStatus: ticket.status, nextStatus: "running" },
      );
    }
    // Re-read the immutable rolling authorization after reservation and
    // before attaching a native handle or changing lifecycle state.
    const rollingReceipt = validateRollingDispatchArtifacts(cwd, ticket, targetHost, env);
    if (isCompiledApplyTicket(ticket)) {
      try { validateCompiledTicket(cwd, ticket, targetHost, env); }
      catch (error) { rejectCompiledTicketValidation(cwd, ticket, error, at, env); }
    }
    const handle = executionHandle || null;
    if (!handle || !handle.value.trim()) throw new DispatchError(`ticket ${id} has no native execution handle`, "EXECUTION_HANDLE_REQUIRED", { ticketId: id });
    const expectedKind = getCliAdapter(host, env).host.executionHandleKind;
    if (handle.kind !== expectedKind) throw new DispatchError(`ticket ${id} requires handle kind ${expectedKind}`, "EXECUTION_HANDLE_KIND_MISMATCH", { ticketId: id });
    const exactRoot = requireExactRootAdapter(ticket, host, env);
    let acknowledgedRoot: ExactExecutionRootIdentity | undefined;
    try { acknowledgedRoot = extractExactExecutionRootIdentity(handle); }
    catch { throw new DispatchError(`ticket ${id} native handle has a partial exact-root acknowledgement`, "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH", { ticketId: id }); }
    if (exactRoot && (!acknowledgedRoot || !sameExactExecutionRootIdentity(exactRoot, acknowledgedRoot))) {
      throw new DispatchError(`ticket ${id} native handle did not acknowledge the identical execution root`, "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH", { ticketId: id });
    }
    if (!exactRoot && acknowledgedRoot) {
      throw new DispatchError(`ticket ${id} shared execution cannot bind an isolated-root handle`, "ISOLATED_EXECUTION_IDENTITY_FORBIDDEN", { ticketId: id });
    }
    if (rollingReceipt) verifyExactExecutionRoot(cwd, ticket, rollingReceipt, host, env, false);
    const detail: UnknownRecord = { host, execution_handle: handle };
    transition(ticket, "dispatching", "running", { at, event: "agent_bound", detail });
    ticket.execution_handle = handle;
    ticket.host = host;
    ticket.started_at = at;
    updateTicketLiveness(ticket, handle, "running", "status", at);
    if (ticket.route_id) {
      try {
        markRouteAvailable(cwd, { host, routeId: ticket.route_id }, { now: at, env });
      } catch (error) {
        throw new DispatchError(
          `model availability persistence failed: ${error instanceof Error ? error.message : String(error)}`,
          "MODEL_AVAILABILITY_WRITE_FAILED",
          { ticketId: id },
        );
      }
    }
    transitionExactRootRecord(cwd, ticket, `native-bind-${ticket.reservation_id || ticket.attempt}`, "worker_active", at, `${handle.kind}:${handle.value}`, ["live_native_handle"], env);
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}

export interface DeferOptions {
  code?: string;
  message?: string;
  observedCapacity?: number | null;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
}

/**
 * Host concurrency rejection is backpressure, not a worker/route failure.
 * Return the same ticket to FIFO without consuming an attempt.
 */
export function deferDispatch(cwd: string, id: string, {
  code = "AGENT_LIMIT_REACHED",
  message = "host has no free subagent thread",
  observedCapacity = null,
  host,
  now,
  env = process.env,
}: DeferOptions = {}): SpawnTicket {
  sessionUid(env);
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    // Resolve the captured host before clearing reservation metadata.  A
    // legacy/current ticket may carry only dispatch_host while dispatching;
    // clearing it first would make observed-capacity bookkeeping fail after
    // the ticket had already been persisted back to the queue.
    const targetHost = ticketTargetHost(ticket, env);
    if (host && targetHost !== requireHost(host, env)) {
      throw new DispatchError(`ticket ${id} targets ${targetHost}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (ticket.execution_handle) throw new DispatchError(`ticket ${id} is already bound`, "EXECUTION_HANDLE_ALREADY_BOUND", { ticketId: id });
    transition(ticket, "dispatching", "queued", {
      at,
      event: "dispatch_deferred",
      detail: { error_code: String(code), message: String(message) },
    });
    ticket.attempt = Math.max(0, Number(ticket.attempt || 0) - 1);
    ticket.error = null;
    delete ticket.reservation_id;
    delete ticket.dispatch_host;
    delete ticket.dispatch_requested_at;
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}

export const PROGRESS_PHASES = new Set<TicketProgressPhase>(["starting", "working", "waiting", "blocked", "checkpoint"]);

export interface ProbeOptions {
  executionHandle?: NativeExecutionHandle;
  state: AgentProbeState;
  activity?: AgentProbeActivity;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
}

/**
 * Persist the host runtime's current view of a bound agent. This is a liveness
 * signal only: it never changes business progress or ticket terminal state.
 */
export function reportAgentProbe(cwd: string, id: string, {
  executionHandle,
  state,
  activity = "status",
  host,
  now,
  env = process.env,
}: ProbeOptions): SpawnTicket {
  sessionUid(env);
  if (!AGENT_PROBE_STATES.has(state)) throw new DispatchError(`invalid agent probe state: ${state}`, "INVALID_AGENT_PROBE_STATE", { ticketId: id });
  if (!AGENT_PROBE_ACTIVITIES.has(activity)) throw new DispatchError(`invalid agent probe activity: ${activity}`, "INVALID_AGENT_PROBE_ACTIVITY", { ticketId: id });
  if (!LIVE_AGENT_PROBE_STATES.has(state) && activity !== "status") {
    throw new DispatchError(`agent probe state ${state} cannot report ${activity} activity`, "INVALID_AGENT_PROBE_ACTIVITY", { ticketId: id });
  }
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    if (host && ticketTargetHost(ticket, env) !== requireHost(host, env)) {
      throw new DispatchError(`ticket ${id} targets ${ticketTargetHost(ticket, env)}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (ticket.status !== "running") {
      throw new DispatchError(`ticket ${id} is not running`, "PROBE_REQUIRES_RUNNING", { ticketId: id, currentStatus: ticket.status });
    }
    const requested = executionHandle || null;
    const bound = currentHandleForTicket(ticket);
    if (!requested) throw new DispatchError("execution handle is required", "EXECUTION_HANDLE_REQUIRED", { ticketId: id });
    if (requested.kind !== getCliAdapter(requireHost(host || ticketTargetHost(ticket, env), env), env).host.executionHandleKind) {
      throw new DispatchError("execution handle kind does not match adapter", "EXECUTION_HANDLE_KIND_MISMATCH", { ticketId: id });
    }
    if (!bound || bound.kind !== requested.kind || bound.value !== requested.value) {
      throw new DispatchError(`ticket ${id} is bound to ${bound?.value || "no handle"}, not ${requested.value}`, "EXECUTION_HANDLE_MISMATCH", { ticketId: id });
    }
    assertOptionalExactRootAcknowledgement(id, "probe", requested, bound);
    updateTicketLiveness(ticket, bound, state, activity, at);
    if (state === "running") {
      const availability = availabilityOutcome(cwd, ticket, at, { success: true, env });
      if (availability) ticket.quota_diagnostic = availability;
    }
    history(ticket, "agent_probe", at, {
      sequence: ticket.liveness!.sequence,
      execution_handle: bound,
      state,
      activity,
    });
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}

export interface ProgressOptions {
  phase: TicketProgressPhase;
  summary: string;
  nextStep?: string | null;
  blocker?: string | null;
  needsDirector?: boolean;
  now?: TimeInput;
  host?: string;
  env?: NodeJS.ProcessEnv;
}

export function reportAgentProgress(cwd: string, id: string, {
  phase,
  summary,
  nextStep = null,
  blocker = null,
  needsDirector = false,
  host,
  now,
  env = process.env,
}: ProgressOptions): SpawnTicket {
  sessionUid(env);
  if (!PROGRESS_PHASES.has(phase)) throw new DispatchError(`invalid progress phase: ${phase}`, "INVALID_PROGRESS_PHASE", { ticketId: id });
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    if (host && ticketTargetHost(ticket, env) !== requireHost(host, env)) {
      throw new DispatchError(`ticket ${id} targets ${ticketTargetHost(ticket, env)}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
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
    const handle = currentHandleForTicket(ticket);
    if (handle) updateTicketLiveness(ticket, handle, "running", "output", at);
    history(ticket, "agent_progress", at, {
      sequence: ticket.progress.sequence,
      phase,
      needs_director: ticket.progress.needs_director,
      liveness_sequence: ticket.liveness?.sequence || null,
    });
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}
