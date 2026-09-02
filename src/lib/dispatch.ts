import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sanitizeConclusion, sanitizeProgress } from "./hygiene.js";
import { listSpawns, readSpawn, writeSpawn, sessionTicketId, sessionUid, validateSpawnSessionScope } from "./spawn.js";
import type {
  AgentProbeActivity,
  AgentProbeState,
  SpawnTicket,
  TicketError,
  TicketProgressPhase,
  TicketStatus,
  NativeExecutionHandle,
} from "./spawn.js";
import { normalizeSpawnTicket } from "./spawn.js";
import {
  extractExactExecutionRootIdentity,
  sameExactExecutionRootIdentity,
  type ExactExecutionRootIdentity,
  type NativeExecutionHandleKind,
} from "../adapters/contract.js";
import { getCliAdapter } from "../adapters/index.js";
import type { UnknownRecord } from "../types.js";
import { dispatchLockPath, spawnsDir, workspaceId, WORKTREE_RECORD_NAME } from "./paths.js";
import { resolveOwningRepository, resolveWorktreeTopology } from "./worktree/topology.js";
import {
  parseWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type WorktreeRecord,
} from "./worktree-execution.js";
import {
  assertValidTicketReceiptLineage,
  normalizeCompiledApplyLineage,
  normalizeRollingUnitLineage,
  readReceipt,
  writeReceipt,
  type CompiledApplyLineage,
  type DelegationReceipt,
  type ExecutionMode,
  type RollingUnitLineage,
} from "./receipt.js";
import { auditCommitOutcomeAsync, auditPreparedCommitAsync, auditWorktreeAsync, type AsyncSafetyOptions, type SafetyOperation } from "./safety.js";
import { canonicalizeJson, readJsonFile } from "./json-utils.js";
import { writeTaskConclusionByNumber } from "./openspec.js";
import { recordRouteHealth } from "./route-health.js";
import { readRouteSnapshot, type ExecutableRoute } from "./routes.js";
import { deriveMinimumModelRequirements } from "./selection.js";
import { cliProfileForHost, configuredCodingModelsForHost, loadConfig } from "./config.js";
import { parseHostId, type HostId } from "./hosts.js";
import {
  BATON_DISPATCH_RESERVATION_SCHEMA,
  withDispatchReservationEnvelope,
  type DispatchReservationIdentity,
} from "./dispatch/reservation.js";
import { withActivationLockAsync, type ActivationLockOptions } from "./activation.js";
import {
  availabilityForRoute,
  claimRouteProbe,
  isExplicitRateLimit,
  isConfirmedQuotaExhaustion,
  markRouteAvailable,
  markRouteExhausted,
} from "./model-availability.js";
import { withOwnedLock, withOwnedLockAsync, type OwnedLock, type OwnedLockOptions } from "./owned-lock.js";
import { resolveAgentTreeCapacity, type EffectiveAgentTreeCapacity } from "./agent-tree-capacity.js";
import {
  readApplyRun,
  readApplyRunPlanBody,
  type ApplyRunState,
  type ApplyRunTicketFact,
} from "./apply/run.js";
import { acceptApplyUnit, type ApplyAcceptanceResult } from "./apply/reconcile.js";
import type { ApplyExecutionPlan, ApplyPlanUnit } from "./apply-plan.js";
import { withLock } from "./dispatch/lock.js";
import { requireHost } from "./dispatch/core.js";
import {
  activeTicketsInDispatchScope,
  ticketMatchesHost,
  ticketsInDispatchScope
} from "./dispatch/reserve.js";
import { dispatchCompatibilityBlockers } from "./dispatch/compat.js";
import { LIVE_AGENT_PROBE_STATES } from "./dispatch/signals.js";
import {
  DEFAULT_AGENT_PROBE_INTERVAL_MS,
  DispatchError,
  TERMINAL_TICKET_STATUSES,
  TimeInput,
  fifoTickets,
  holdsHostSlot,
  instant,
  requiredCapacity,
  resolvedCapacity,
  ticketTargetHost,
  transition
} from "./dispatch/core.js";

export interface DispatchSpec extends Partial<ExactExecutionRootIdentity> {
  ticket_id: string;
  reservation: DispatchReservationIdentity;
  target_host: string;
  route_id: string;
  model: string;
  reasoning_effort: string | null;
  service_tier: string | null;
  fork_context: false;
  read_only: boolean;
  mode: ExecutionMode;
  receipt_id: string;
  write_allowlist: string[];
  allowed_operations: string[];
  commit_authorization: {
    expected_head: string;
    expected_tree: string;
    staged_paths: string[];
  } | null;
  description: string;
  prompt: string;
  work_unit: SpawnTicket["work_unit"];
  rolling_unit_lineage?: RollingUnitLineage;
  coordination: SpawnTicket["coordination"];
  attempt: number;
  max_attempts: number;
  selection: NonNullable<SpawnTicket["selection"]>;
}

export function publicDispatchSpec(
  ticket: SpawnTicket & { route_id: string; receipt_id: string; reservation_id: string },
  receipt: DelegationReceipt,
  env: NodeJS.ProcessEnv = process.env,
): DispatchSpec {
  const exactRoot = extractExactExecutionRootIdentity(ticket);
  const reservation: DispatchReservationIdentity = {
    schema: BATON_DISPATCH_RESERVATION_SCHEMA,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: ticketTargetHost(ticket, env),
    ...(exactRoot || {}),
  };
  return {
    ticket_id: ticket.id,
    reservation,
    target_host: ticketTargetHost(ticket, env),
    route_id: ticket.route_id,
    model: ticket.route_id,
    reasoning_effort: ticket.reasoning_effort || null,
    service_tier: ticket.service_tier || null,
    fork_context: false,
    read_only: ticket.read_only,
    mode: ticket.mode,
    receipt_id: ticket.receipt_id,
    write_allowlist: receipt.scope.write_allowlist,
    allowed_operations: receipt.scope.allowed_operations,
    commit_authorization: receipt.commit_baseline ? {
      expected_head: receipt.commit_baseline.head,
      expected_tree: receipt.commit_baseline.staged_tree,
      staged_paths: receipt.commit_baseline.staged_paths,
    } : null,
    description: withDispatchReservationEnvelope(ticket.description, reservation),
    prompt: withDispatchReservationEnvelope(ticket.prompt, reservation),
    work_unit: ticket.work_unit,
    ...(ticket.rolling_unit_lineage ? { rolling_unit_lineage: ticket.rolling_unit_lineage } : {}),
    coordination: ticket.coordination,
    attempt: ticket.attempt,
    max_attempts: ticket.max_attempts,
    selection: ticket.selection!,
    ...(exactRoot || {}),
  };
}

interface RecoverOptions { staleMs?: number; host?: string; now?: TimeInput; env?: NodeJS.ProcessEnv }

export function recoverDispatches(cwd: string, { staleMs = 60_000, host, now, env = process.env }: RecoverOptions = {}) {
  sessionUid(env);
  const threshold = Number(staleMs);
  if (!Number.isFinite(threshold) || threshold < 0) throw new DispatchError("staleMs must be non-negative", "INVALID_STALE_MS");
  return withLock(cwd, () => {
    const current = instant(now);
    const at = current.toISOString();
    const expired: string[] = [];
    const resumable: Array<{ ticket_id: string; execution_handle: NativeExecutionHandle; host: string | null }> = [];
    const needs_close: Array<{ ticket_id: string; execution_handle: NativeExecutionHandle; host: string | null }> = [];
    const targetHost = host ? requireHost(host, env) : undefined;
    for (const ticket of fifoTickets(cwd, env)) {
      if (targetHost && !ticketMatchesHost(ticket, targetHost, env)) continue;
      if (ticket.status === "running" && ticket.execution_handle) {
        resumable.push({ ticket_id: ticket.id, execution_handle: ticket.execution_handle, host: ticket.host || ticket.dispatch_host || null });
        continue;
      }
      if (TERMINAL_TICKET_STATUSES.has(ticket.status) && holdsHostSlot(ticket) && ticket.execution_handle) {
        needs_close.push({ ticket_id: ticket.id, execution_handle: ticket.execution_handle, host: ticket.host || ticket.dispatch_host || null });
        continue;
      }
      if (ticket.status !== "dispatching" || ticket.execution_handle) continue;
      const requested = Date.parse(ticket.dispatch_requested_at || ticket.updated_at || ticket.created_at || "");
      if (!Number.isFinite(requested) || current.getTime() - requested < threshold) continue;
      transition(ticket, "dispatching", "errored", { at, event: "dispatch_lease_expired", detail: { error_code: "DISPATCH_LEASE_EXPIRED" } });
      ticket.error = { code: "DISPATCH_LEASE_EXPIRED", message: "host did not bind an agent before the dispatch lease expired" };
      ticket.finished_at = at;
      writeSpawn(cwd, ticket, env);
      expired.push(ticket.id);
    }
    return { expired, resumable, needs_close };
  }, env);
}

export function dispatchSnapshot(cwd: string, { capacity, host, now, env = process.env, capacityResolution }: { capacity?: number; host?: string; now?: TimeInput; env?: NodeJS.ProcessEnv; capacityResolution?: EffectiveAgentTreeCapacity } = {}) {
  sessionUid(env);
  const targetHost = host ? requireHost(host, env) : undefined;
  // Legacy dispatch-<host>.json files remain rollback residue only. Capacity
  // is resolved by the current caller and is never remembered here.
  const resolved = capacityResolution || resolvedCapacity(cwd, targetHost, env, capacity);
  const compatibilityBlockers = dispatchCompatibilityBlockers(cwd, env);
  const max = requiredCapacity(resolved);
  const allTickets = fifoTickets(cwd, env);
  const tickets = targetHost ? ticketsInDispatchScope(allTickets, targetHost, env) : allTickets;
  const counts: Partial<Record<TicketStatus, number>> = {};
  for (const ticket of tickets) counts[ticket.status] = (counts[ticket.status] || 0) + 1;
  const active = targetHost
    ? activeTicketsInDispatchScope(allTickets, targetHost, env)
    : tickets.filter(holdsHostSlot);
  const currentMs = instant(now).getTime();
  const progressDue = tickets.filter((ticket) => {
    if (ticket.status !== "running" || ticket.coordination?.mode !== "checkpointed") return false;
    const interval = Number(ticket.coordination.progress_interval_ms || 0);
    if (interval <= 0) return false;
    const last = Date.parse(ticket.progress?.reported_at || ticket.started_at || ticket.updated_at || ticket.created_at || "");
    return Number.isFinite(last) && currentMs - last >= interval;
  }).map((ticket) => ticket.id);
  const probeDue = tickets.filter((ticket) => {
    if (ticket.status !== "running") return false;
    if (ticket.liveness && !LIVE_AGENT_PROBE_STATES.has(ticket.liveness.state)) return false;
    const last = Date.parse(ticket.liveness?.observed_at || ticket.started_at || ticket.updated_at || ticket.created_at || "");
    return !Number.isFinite(last) || currentMs - last >= DEFAULT_AGENT_PROBE_INTERVAL_MS;
  }).map((ticket) => ticket.id);
  return {
    host: targetHost || null,
    session_uid: resolved.session_uid,
    capacity: max,
    capacity_sources: resolved.capacity_sources,
    active: active.length,
    available: Math.max(0, max - active.length),
    compatibility_blockers: compatibilityBlockers,
    counts,
    queued: tickets.filter((ticket) => ticket.status === "queued").map((ticket) => ticket.id),
    dispatching: tickets.filter((ticket) => ticket.status === "dispatching").map((ticket) => ticket.id),
    running: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({
      ticket_id: ticket.id,
      execution_handle: ticket.execution_handle,
      host: ticket.host || ticket.dispatch_host || null,
    })),
    running_progress: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({
      ticket_id: ticket.id,
      task_kind: ticket.work_unit?.kind || null,
      coordination: ticket.coordination?.mode || null,
      progress: ticket.progress || null,
    })),
    progress_due: progressDue,
    running_liveness: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({
      ticket_id: ticket.id,
      liveness: ticket.liveness || null,
    })),
    probe_due: probeDue,
    awaiting_release: tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status) && holdsHostSlot(ticket))
      .map((ticket) => ({
        ticket_id: ticket.id,
        execution_handle: ticket.execution_handle,
        status: ticket.status,
      })),
    terminal: tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status)).map((ticket) => ({ ticket_id: ticket.id, status: ticket.status, error: ticket.error || null })),
  };
}

/**
 * Build capacity diagnostics for every valid root tree in the workspace.
 *
 * This is intentionally separate from dispatchSnapshot: general `baton
 * status` is a workspace inventory command, while reservation and dispatch
 * status are current-tree operations.  The inventory is grouped by the
 * complete (host, session_uid) key and never computes a workspace-wide
 * availability value.
 */
export function dispatchWorkspaceCapacitySnapshots(
  cwd: string,
  { host, now, env = process.env }: { host?: string; now?: TimeInput; env?: NodeJS.ProcessEnv } = {},
) {
  sessionUid(env);
  const targetHost = host ? requireHost(host, env) : undefined;
  const allTickets = listSpawns(cwd, env).map(normalizeSpawnTicket);
  let config;
  try {
    config = loadConfig(cwd, { env });
  } catch {
    // A status inventory can still report adapter-derived capacity before
    // project configuration is available.
  }
  const groups = new Map<string, { host: HostId; session_uid: string; tickets: SpawnTicket[] }>();
  for (const ticket of allTickets) {
    if (!/^[0-9a-f]{64}$/.test(ticket.session_uid)) continue;
    let ticketHost: HostId;
    try {
      ticketHost = ticketTargetHost(ticket, env);
    } catch {
      continue;
    }
    if (targetHost && ticketHost !== targetHost) continue;
    const key = `${ticketHost}\u0000${ticket.session_uid}`;
    const group = groups.get(key) || { host: ticketHost, session_uid: ticket.session_uid, tickets: [] };
    group.tickets.push(ticket);
    groups.set(key, group);
  }
  const currentMs = instant(now).getTime();
  return [...groups.values()].sort((a, b) => a.host.localeCompare(b.host) || a.session_uid.localeCompare(b.session_uid)).map((group) => {
    const adapter = getCliAdapter(group.host, env);
    const resolved = resolveAgentTreeCapacity({
      host: adapter?.host,
      config,
      session: group.session_uid,
      env,
    });
    const active = group.tickets.filter(holdsHostSlot);
    const counts: Partial<Record<TicketStatus, number>> = {};
    for (const ticket of group.tickets) counts[ticket.status] = (counts[ticket.status] || 0) + 1;
    const progressDue = group.tickets.filter((ticket) => {
      if (ticket.status !== "running" || ticket.coordination?.mode !== "checkpointed") return false;
      const interval = Number(ticket.coordination.progress_interval_ms || 0);
      const last = Date.parse(ticket.progress?.reported_at || ticket.started_at || ticket.updated_at || ticket.created_at || "");
      return interval > 0 && Number.isFinite(last) && currentMs - last >= interval;
    }).map((ticket) => ticket.id);
    return {
      host: group.host,
      session_uid: group.session_uid,
      capacity: resolved.capacity,
      capacity_sources: resolved.capacity_sources,
      active: active.length,
      available: resolved.capacity == null ? null : Math.max(0, resolved.capacity - active.length),
      counts,
      tickets: group.tickets.map((ticket) => ticket.id),
      queued: group.tickets.filter((ticket) => ticket.status === "queued").map((ticket) => ticket.id),
      dispatching: group.tickets.filter((ticket) => ticket.status === "dispatching").map((ticket) => ticket.id),
      running: group.tickets.filter((ticket) => ticket.status === "running").map((ticket) => ticket.id),
      awaiting_release: group.tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status) && holdsHostSlot(ticket)).map((ticket) => ticket.id),
      progress_due: progressDue,
    };
  });
}

export { TERMINAL_TICKET_STATUSES, DEFAULT_AGENT_PROBE_INTERVAL_MS, DispatchError } from "./dispatch/core.js";
export { dispatchCompatibilityBlockers, type CompatibilityBlocker } from "./dispatch/compat.js";
export { withDispatchLock, withDispatchLockAsync, type DispatchLockOptions } from "./dispatch/lock.js";
export { reserveNext } from "./dispatch/reserve.js";
export { bindAgent, deferDispatch, reportAgentProbe, reportAgentProgress } from "./dispatch/signals.js";
export { finishAgent, releaseAgent } from "./dispatch/finish.js";
