import {
  DispatchError,
  TimeInput,
  fifoTickets,
  holdsHostSlot,
  instant,
  requireCurrentTicket,
  requiredCapacity,
  resolvedCapacity,
  ticketTargetHost,
  transition
} from "./dispatch-core.js";
import { AsyncSafetyOptions } from "./safety.js";
import { SpawnTicket } from "./spawn.js";
import { HostId } from "./hosts.js";
import {
  sessionUid,
  writeSpawn
} from "./spawn-store.js";
import { requireHost } from "./dispatch-core.js";
import { dispatchCompatibilityBlockers } from "./dispatch-compat.js";
import { withActivationLockAsync } from "./activation.js";
import {
  DispatchSpec,
  dispatchSnapshot,
  publicDispatchSpec
} from "./dispatch.js";
import {
  DelegationReceipt,
  readReceipt
} from "./receipt.js";
import { acceptCompiledTerminal } from "./dispatch-finish.js";
import { workspaceId } from "./paths.js";
import { verifyExactExecutionRoot } from "./dispatch-exact-root.js";
import {
  availabilityForRoute,
  claimRouteProbe
} from "./model-availability.js";
import {
  createQuotaSuccessor,
  isSessionUncallable
} from "./dispatch-successor.js";
import {
  CompiledApplyContext,
  compiledUnitReady,
  isCompiledApplyTicket,
  validateCompiledTicket
} from "./dispatch-compiled.js";
import {
  rejectUndispatchable,
  validateRollingDispatchArtifacts
} from "./dispatch-guard.js";
import {
  DispatchLockOptions,
  ReserveActivationLockOptions,
  withDispatchLockAsync
} from "./dispatch-lock.js";
/**
 * FIFO reservation of queued tickets against capacity. Split from
 * dispatch.ts.
 */

export interface ReserveOptions {
  capacity?: number;
  limit?: number;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
  /** Internal await-safety injection surface; not part of CLI syntax. */
  safety?: AsyncSafetyOptions;
  activationLock?: ReserveActivationLockOptions;
  dispatchLock?: DispatchLockOptions;
}


export function ticketMatchesHost(ticket: SpawnTicket, host: HostId, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return ticketTargetHost(ticket, env) === host;
  } catch {
    return false;
  }
}

/**
 * Return only tickets owned by this root tree and targeting this host.
 *
 * Capacity is a property of the pair (host, session_uid), not of every
 * ticket in the workspace.  Keep the session check here next to the host
 * check so active-slot callers cannot accidentally widen their accounting by
 * reusing a workspace-wide ticket list.
 */
export function ticketsInDispatchScope(tickets: SpawnTicket[], host: HostId, env: NodeJS.ProcessEnv = process.env): SpawnTicket[] {
  const uid = sessionUid(env);
  return tickets.filter((ticket) => ticket.session_uid === uid && ticketMatchesHost(ticket, host, env));
}

/**
 * A dispatching ticket reserves a slot before binding; a bound running ticket
 * keeps it; and every terminal ticket keeps it until release is confirmed.
 */
export function activeTicketsInDispatchScope(tickets: SpawnTicket[], host: HostId, env: NodeJS.ProcessEnv = process.env): SpawnTicket[] {
  return ticketsInDispatchScope(tickets, host, env).filter(holdsHostSlot);
}

/** A synthetic route has no durable callability evidence yet. Keep one native
 * launch in flight so a cold route cannot fan out before its first result. */
export function hasPendingSyntheticRouteProbe(tickets: SpawnTicket[], host: HostId, routeId: string, env: NodeJS.ProcessEnv): boolean {
  return ticketsInDispatchScope(tickets, host, env).some((ticket) =>
    ticket.route_id === routeId && ticket.status === "dispatching" && !ticket.execution_handle);
}

export async function reserveNext(cwd: string, { capacity, limit = Number.MAX_SAFE_INTEGER, host, now, env = process.env, safety, activationLock = {}, dispatchLock = {} }: ReserveOptions) {
  // Establish the root-agent-tree scope before acquiring either mutation
  // lock.  A missing BATON_SESSION_ID must not create a reservation or a
  // lifecycle lock as a side effect of a failed capacity-sensitive call.
  sessionUid(env);
  if (!host) throw new DispatchError("host is required", "HOST_REQUIRED");
  const targetHost = requireHost(host, env);
  const compatibilityBlockers = dispatchCompatibilityBlockers(cwd, env);
  if (compatibilityBlockers.length) {
    throw new DispatchError(
      "cannot reserve dispatches while unattributed active records require reconciliation",
      "COMPATIBILITY_BLOCKED",
      { compatibility_blockers: compatibilityBlockers },
    );
  }
  const capacityResolution = resolvedCapacity(cwd, targetHost, env, capacity);
  const max = requiredCapacity(capacityResolution);
  const safetyOptions = safety || {};
  return withActivationLockAsync(cwd, env, async () => {
    const maxTake = Math.max(0, Math.floor(Number(limit) || 0));
    return withDispatchLockAsync(cwd, async () => {
    const at = instant(now).toISOString();
    const tickets = fifoTickets(cwd, env);
    const activeTickets = activeTicketsInDispatchScope(tickets, targetHost, env);
    const active = activeTickets.length;
    let available = Math.max(0, max - active);
    const reserved: DispatchSpec[] = [];
    const blocked: Array<{ ticket_id: string; code: string; message: string }> = [];
    for (const ticket of tickets) {
      if (ticket.status !== "queued" || available <= 0 || reserved.length >= maxTake) continue;
      requireCurrentTicket(ticket);
      let ticketHost: HostId;
      try {
        ticketHost = ticketTargetHost(ticket, env);
      } catch (error) {
        blocked.push({
          ticket_id: ticket.id,
          code: error instanceof DispatchError ? error.code : "HOST_REQUIRED",
          message: error instanceof Error ? error.message : `ticket ${ticket.id} has no captured host`,
        });
        continue;
      }
      if (ticketHost !== targetHost) {
        blocked.push({ ticket_id: ticket.id, code: "HOST_MISMATCH", message: `ticket ${ticket.id} targets ${ticketHost}, not ${targetHost}` });
        continue;
      }
      // A rolling ticket must be authorized from its immutable artifact edge
      // before any reservation fields or status are changed.
      let rollingReceipt: DelegationReceipt | null = null;
      try {
        rollingReceipt = validateRollingDispatchArtifacts(cwd, ticket, targetHost, env);
      } catch (error) {
        const rejected = await rejectUndispatchable(cwd, ticket, at, targetHost, env, safetyOptions, error);
        if (rejected) blocked.push(rejected);
        continue;
      }
      let compiledContext: CompiledApplyContext | null = null;
      // Dependency/gate backpressure is not a terminal ticket failure. Keep
      // the compiled unit queued so an independent frontier can continue and
      // a later acceptance can make it eligible without changing its scope.
      if (isCompiledApplyTicket(ticket)) {
        try {
          compiledContext = validateCompiledTicket(cwd, ticket, targetHost, env);
          if (compiledContext) {
            const readiness = compiledUnitReady(compiledContext);
            if (!readiness.ready) {
              blocked.push({
                ticket_id: ticket.id,
                code: readiness.code || "COMPILED_DEPENDENCY_BLOCKED",
                message: readiness.message || `ticket ${ticket.id} is not ready in its compiled ApplyRun`,
              });
              continue;
            }
          }
        } catch {
          // The full contract error is persisted by rejectUndispatchable
          // below; only dependency/gate backpressure is deliberately kept in
          // the queue here.
        }
      }
      const rejected = await rejectUndispatchable(cwd, ticket, at, targetHost, env, safetyOptions);
      if (rejected) {
        blocked.push(rejected);
        let successorId: string | null = null;
        if (rejected.code === "MODEL_QUOTA_EXHAUSTED" || rejected.code === "MODEL_RATE_LIMITED"
          || isSessionUncallable({ errorCode: ticket.error?.code, message: ticket.error?.message })) {
          successorId = await createQuotaSuccessor(cwd, ticket, at, env, safetyOptions, compiledContext);
        }
        if (compiledContext) {
          ticket.compiled_acceptance = successorId
            ? { accepted: false, code: "SUCCESSOR_CREATED", evidence: `successor ${successorId}` }
            : acceptCompiledTerminal(cwd, ticket, compiledContext, at, ticket.error?.message || rejected.message, env);
        }
        writeSpawn(cwd, ticket, env);
        continue;
      }
      const availability = availabilityForRoute(cwd, { host: targetHost, routeId: ticket.route_id! }, at, env);
      if (!availability.evidence_present && hasPendingSyntheticRouteProbe(tickets, targetHost, ticket.route_id!, env)) {
        const probePending = {
          ticket_id: ticket.id,
          code: "ROUTE_PROBE_PENDING",
          message: `ticket ${ticket.id} route ${ticket.route_id} is awaiting the first native probe result`,
        };
        blocked.push(probePending);
        continue;
      }
      if ((availability.status === "exhausted" || availability.status === "probe_due") && availability.probe_available) {
        const nextAttempt = Number(ticket.attempt || 0) + 1;
        const probe = claimRouteProbe(cwd, { host: targetHost, routeId: ticket.route_id! }, {
          owner: `${workspaceId(cwd)}:${ticket.id}:attempt-${nextAttempt}`,
          now: at,
          env,
        });
        if (!probe.claimed) {
          const probeRejected = {
            ticket_id: ticket.id,
            code: "MODEL_QUOTA_EXHAUSTED",
            message: `ticket ${ticket.id} route ${ticket.route_id} probe lease is owned by another dispatcher`,
          };
          blocked.push(probeRejected);
          transition(ticket, "queued", "errored", { at, event: "dispatch_blocked", detail: { error_code: probeRejected.code } });
          ticket.error = { code: probeRejected.code, message: probeRejected.message };
          ticket.finished_at = at;
          await createQuotaSuccessor(cwd, ticket, at, env, safetyOptions);
          writeSpawn(cwd, ticket, env);
          continue;
        }
      }
      try {
        if (rollingReceipt) verifyExactExecutionRoot(cwd, ticket, rollingReceipt, targetHost, env, true);
      } catch (error) {
        const rejected = await rejectUndispatchable(cwd, ticket, at, targetHost, env, safetyOptions, error);
        if (rejected) blocked.push(rejected);
        continue;
      }
      ticket.dispatch_host = targetHost;
      ticket.dispatch_requested_at = at;
      ticket.attempt = Number(ticket.attempt || 0) + 1;
      ticket.reservation_id = crypto.randomUUID();
      transition(ticket, "queued", "dispatching", {
        at,
        event: "dispatch_reserved",
        detail: { host: targetHost, reservation_id: ticket.reservation_id, attempt: ticket.attempt },
      });
      ticket.error = null;
      writeSpawn(cwd, ticket, env);
      const receipt = readReceipt(cwd, ticket.receipt_id!, env);
      reserved.push(publicDispatchSpec(ticket as SpawnTicket & { route_id: string; receipt_id: string; reservation_id: string }, receipt, env));
      available -= 1;
    }
      return { reserved, blocked, snapshot: dispatchSnapshot(cwd, { host: targetHost, env, capacityResolution }) };
    }, { ...dispatchLock, env });
  }, { ...activationLock, host: targetHost, scope: "both", operation: "dispatch-reservation" });
}
