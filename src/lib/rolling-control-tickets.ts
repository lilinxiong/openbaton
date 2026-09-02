import { SpawnTicket } from "./spawn.js";
import { listSpawns } from "./spawn-store.js";
import { record } from "./rolling-run-store.js";
import {
  ROLLING_EXECUTION_DOCUMENT_KIND,
  RollingControlContext
} from "./rolling-control.js";
import {
  RollingExecutionRun,
  appendRollingFact,
  readRollingExecutionRun
} from "./rolling-run.js";
import {
  RollingExecutionFact,
  normalizeRollingExecutionFact
} from "./rolling-acceptance.js";
/**
 * Spawn-ticket projection into rolling execution facts. Split from
 * rolling-control.ts.
 */

export function ticketsForRun(cwd: string, runId: string, env?: NodeJS.ProcessEnv): SpawnTicket[] {
  return listSpawns(cwd, env)
    .filter((ticket) => ticket.rolling_unit_lineage?.run_id === runId)
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || left.id.localeCompare(right.id));
}

export function ticketAttemptOrdinals(tickets: readonly SpawnTicket[]): Map<string, number> {
  const counts = new Map<string, number>();
  const result = new Map<string, number>();
  for (const ticket of tickets) {
    const lineage = ticket.rolling_unit_lineage;
    if (!lineage) continue;
    const ref = `${lineage.unit_key}@${lineage.unit_version}`;
    const next = (counts.get(ref) || 0) + 1;
    counts.set(ref, next);
    result.set(ticket.id, next);
  }
  return result;
}

export function executionBase(ticket: SpawnTicket, attempt: number, recordedAt: string): Record<string, unknown> {
  const lineage = ticket.rolling_unit_lineage!;
  const unitRef = `${lineage.unit_key}@${lineage.unit_version}`;
  return {
    schema_version: 1,
    unit_key: lineage.unit_key,
    unit_version: lineage.unit_version,
    unit_fingerprint: lineage.unit_fingerprint,
    owner_type: "attempt",
    owner_key: `${unitRef}:attempt-${attempt}`,
    attempt,
    recorded_at: recordedAt,
  };
}

export function unitBase(ticket: SpawnTicket, recordedAt: string): Record<string, unknown> {
  const lineage = ticket.rolling_unit_lineage!;
  return {
    schema_version: 1,
    unit_key: lineage.unit_key,
    unit_version: lineage.unit_version,
    unit_fingerprint: lineage.unit_fingerprint,
    owner_type: "unit_version",
    owner_key: `${lineage.unit_key}@${lineage.unit_version}`,
    recorded_at: recordedAt,
  };
}

type ProjectedExecution = { idempotency_key: string; fact: RollingExecutionFact };

export function projectedTicketFacts(ticket: SpawnTicket, attempt: number): ProjectedExecution[] {
  const out: ProjectedExecution[] = [];
  const created = String(ticket.created_at || new Date(0).toISOString());
  const updated = String(ticket.updated_at || created);
  const started = String(ticket.started_at || updated);
  const finished = String(ticket.finished_at || updated);
  const released = String(ticket.slot_released_at || finished);
  const base = executionBase(ticket, attempt, created);
  const add = (suffix: string, value: Record<string, unknown>) => {
    out.push({
      idempotency_key: `ticket:${ticket.id}:${suffix}`,
      fact: normalizeRollingExecutionFact(value),
    });
  };
  add("native:queued", { ...base, kind: "native-attempt", state: "queued" });
  if (["dispatching", "running", "completed", "errored", "timed_out", "closed"].includes(ticket.status)) {
    const reservationId = String(ticket.reservation_id || `recovered-${ticket.id}`);
    add("reservation:reserved", { ...executionBase(ticket, attempt, String(ticket.dispatch_requested_at || updated)), kind: "reservation", reservation_id: reservationId, state: "reserved" });
    add("native:reserved", { ...executionBase(ticket, attempt, String(ticket.dispatch_requested_at || updated)), kind: "native-attempt", state: "reserved" });
  }
  if (["running", "completed", "errored", "timed_out", "closed"].includes(ticket.status) && ticket.execution_handle) {
    add("native:running", { ...executionBase(ticket, attempt, started), kind: "native-attempt", state: "running" });
  }
  if (["completed", "errored", "timed_out", "closed"].includes(ticket.status)) {
    const success = ticket.status === "completed";
    const terminalStatus = success ? "completed" : ticket.status === "timed_out" ? "timed-out" : ticket.status === "closed" ? "cancelled" : "errored";
    add("terminal", {
      ...executionBase(ticket, attempt, finished),
      kind: "terminal-result",
      status: terminalStatus,
      result: success ? ticket.conclusion || "completed" : ticket.error || ticket.conclusion || terminalStatus,
      result_id: `ticket:${ticket.id}`,
    });
    add("native:terminal", { ...executionBase(ticket, attempt, finished), kind: "native-attempt", state: success ? "completed" : ticket.status === "closed" ? "cancelled" : "failed" });
    if (record(ticket.safety_verdict)) {
      add("safety", {
        ...unitBase(ticket, finished),
        kind: "safety-verdict",
        accepted: ticket.safety_verdict.accepted === true,
        violations: Array.isArray(ticket.safety_verdict.violations) ? ticket.safety_verdict.violations : [],
      });
    } else if (ticket.mode === "read-only") {
      add("safety", { ...unitBase(ticket, finished), kind: "safety-verdict", accepted: success, violations: [] });
    }
    if (success && !ticket.plan_insufficient_evidence && (ticket.mode === "read-only" || ticket.safety_verdict?.accepted === true)) {
      add("parent-acceptance", { ...unitBase(ticket, finished), kind: "parent-acceptance", accepted: true, evidence: String(ticket.conclusion || `accepted ticket ${ticket.id}`) });
    }
    if (record(ticket.plan_insufficient_evidence)) {
      add("plan-insufficient", {
        ...unitBase(ticket, finished),
        kind: "plan-insufficient",
        file: String(ticket.plan_insufficient_evidence.file || "unknown"),
        symbol: String(ticket.plan_insufficient_evidence.symbol || "unknown"),
        missing_decision: String(ticket.plan_insufficient_evidence.missing_decision || "successor plan required"),
      });
    }
  }
  if (ticket.successor_from_ticket_id) {
    add("retry", { ...executionBase(ticket, attempt, created), kind: "retry", retry_kind: "route", retry_of: `${ticket.rolling_unit_lineage!.unit_key}@${ticket.rolling_unit_lineage!.unit_version}`, reason: String(ticket.successor_reason || "route retry") });
  }
  if (ticket.slot_released_at) {
    add("release", { ...executionBase(ticket, attempt, released), kind: "release", released: true, released_at: released });
  }
  return out;
}

/**
 * Persist every ticket-observable rolling fact that is not yet in the log.
 * Identical calls are no-ops; a crash after either store is repaired by the
 * next status, append, refill, gate, seal, or reconcile operation.
 */

export function synchronizeRollingTicketFacts(context: RollingControlContext & { run_id: string }): { run: RollingExecutionRun; appended: number; tickets: SpawnTicket[] } {
  let run = readRollingExecutionRun(context.cwd, context.run_id, { env: context.env });
  const tickets = ticketsForRun(context.cwd, context.run_id, context.env);
  const attempts = ticketAttemptOrdinals(tickets);
  let appended = 0;
  for (const ticket of tickets) {
    for (const projected of projectedTicketFacts(ticket, attempts.get(ticket.id) || 1)) {
      const before = run.append_sequence;
      run = appendRollingFact({
        cwd: context.cwd,
        env: context.env,
        runId: context.run_id,
        kind: ROLLING_EXECUTION_DOCUMENT_KIND,
        idempotency_key: projected.idempotency_key,
        fact_id: `execution:${projected.fact.fact_id}`,
        document_id: `execution-${projected.fact.fact_id}`,
        payload: projected.fact,
        document: projected.fact,
        now: context.now,
      });
      if (run.append_sequence !== before) appended += 1;
    }
  }
  return { run, appended, tickets };
}
