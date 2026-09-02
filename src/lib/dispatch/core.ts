import { normalizeSpawnTicket } from "../spawn/normalize.js";
import {
  sessionUid,
  validateSpawnSessionScope
} from "../spawn/store.js";
import { UnknownRecord } from "../../types.js";
import {
  EffectiveAgentTreeCapacity,
  resolveAgentTreeCapacity
} from "../agent-tree-capacity.js";
import { loadConfig } from "../config.js";
import {
  HostId,
  parseHostId
} from "../hosts.js";
/**
 * Core ticket guards, transition machinery and capacity/host resolution for
 * dispatch. Split from dispatch.ts (leaf module; hosts DispatchError).
 */
import {
  SpawnTicket,
  TicketStatus,
  listSpawns
} from "../spawn.js";
import { getCliAdapter } from "../../adapters/index.js";

export const TERMINAL_TICKET_STATUS_LIST = ["completed", "errored", "timed_out", "closed"] as const;
export type TerminalDispatchStatus = (typeof TERMINAL_TICKET_STATUS_LIST)[number];
export const TERMINAL_TICKET_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>(TERMINAL_TICKET_STATUS_LIST);
export const DEFAULT_AGENT_PROBE_INTERVAL_MS = 60_000;

export function requireCurrentTicket(ticket: SpawnTicket): SpawnTicket {
  ticket = normalizeSpawnTicket(ticket);
  const objectValue = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const current = ticket.schema_version === 8
    && objectValue(ticket.work_unit)
    && objectValue(ticket.coordination)
    && Object.hasOwn(ticket, "progress")
    && Object.hasOwn(ticket, "liveness")
    && Object.hasOwn(ticket, "service_tier")
    && Object.hasOwn(ticket, "selection");
  if (!current) {
    throw new DispatchError(
      `ticket ${ticket.id || "<unknown>"} is not a current-format spawn ticket`,
      "TICKET_FORMAT_UNSUPPORTED",
      { ticketId: ticket.id },
    );
  }
  return ticket;
}

export function requireSessionTicket(ticket: SpawnTicket, env: NodeJS.ProcessEnv): SpawnTicket {
  ticket = requireCurrentTicket(ticket);
  validateSpawnSessionScope(ticket, env);
  return ticket;
}

/** A bound agent keeps consuming a host thread until close_agent is confirmed. */
export function holdsHostSlot(ticket: SpawnTicket): boolean {
  if (ticket.status === "dispatching") return true;
  if (!ticket.execution_handle) return false;
  if (ticket.status === "running") return true;
  return TERMINAL_TICKET_STATUSES.has(ticket.status)
    && !ticket.slot_released_at;
}

export interface DispatchErrorExtras extends UnknownRecord {
  ticketId?: string;
  currentStatus?: TicketStatus;
  nextStatus?: TicketStatus;
}

export class DispatchError extends Error {
  readonly code: string;
  readonly ticketId?: string;
  readonly currentStatus?: TicketStatus;
  readonly nextStatus?: TicketStatus;
  readonly compatibility_blockers?: CompatibilityBlocker[];

  constructor(message: string, code = "DISPATCH_ERROR", extras: DispatchErrorExtras = {}) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    Object.assign(this, extras);
  }
}

export interface CompatibilityBlocker {
  readonly code: "UNATTRIBUTED_ACTIVE_RECORD";
  readonly file: string;
  readonly ticket_id: string | null;
  readonly status: string | null;
  readonly host: string | null;
  readonly reason: string;
}

export const SESSION_UID_PATTERN = /^[0-9a-f]{64}$/;

export function rawRecordHoldsSlot(value: Record<string, unknown>): boolean {
  const status = value.status;
  if (status === "dispatching" || status === "running") return true;
  return (status === "completed" || status === "errored" || status === "timed_out" || status === "closed")
    && value.execution_handle != null
    && !value.slot_released_at;
}


export type TimeInput = Date | string | number | (() => Date | string | number) | undefined;

export function instant(now?: TimeInput): Date {
  const value = typeof now === "function" ? now() : now;
  const date = value == null ? new Date() : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new DispatchError("invalid dispatch timestamp", "INVALID_TIME");
  return date;
}

export function history(ticket: SpawnTicket, event: string, at: string, detail: UnknownRecord = {}): void {
  if (!Array.isArray(ticket.history)) ticket.history = [];
  ticket.history.push({ event, at, ...detail });
  ticket.updated_at = at;
}

export interface TransitionOptions {
  at: string;
  event?: string;
  detail?: UnknownRecord;
}

export function transition(ticket: SpawnTicket, expected: TicketStatus | TicketStatus[], next: TicketStatus, { at, event = next, detail = {} }: TransitionOptions): SpawnTicket {
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

export function fifoTickets(cwd: string, env?: NodeJS.ProcessEnv): SpawnTicket[] {
  const uid = sessionUid(env);
  // Filter the immutable tree key before validating the remaining lifecycle
  // shape.  A malformed record belonging to another root must not prevent
  // this tree from selecting/refilling its own queue; workspace-wide safety
  // scans deliberately use their own unfiltered inventory.
  return listSpawns(cwd, env).filter((ticket) => ticket.session_uid === uid).map(requireCurrentTicket).sort((a, b) => {
    const time = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    // Descendants can be materialized in the same timestamp.  Their
    // session-local ordinal is the durable enqueue order; ticket ids are only
    // an opaque final tie-breaker (their prefix is not queue priority).
    return time || (Number(a.session_ordinal) - Number(b.session_ordinal)) || String(a.id).localeCompare(String(b.id));
  });
}


export function capacityValue(capacity: unknown): number {
  const value = Number(capacity);
  if (!Number.isInteger(value) || value < 1) throw new DispatchError("capacity must be a positive integer", "INVALID_CAPACITY");
  return value;
}


export function requireHost(host: string, env: NodeJS.ProcessEnv = process.env): HostId {
  try {
    return parseHostId(host, env);
  } catch (error) {
    throw new DispatchError(error instanceof Error ? error.message : String(error), "INVALID_HOST");
  }
}

export function resolvedCapacity(cwd: string, host: HostId | undefined, env: NodeJS.ProcessEnv, operationLimit?: number): EffectiveAgentTreeCapacity {
  const adapter = host ? getCliAdapter(host, env) : undefined;
  let config;
  try {
    config = loadConfig(cwd, { env });
  } catch {
    // Direct library callers and pre-init diagnostics may provide an explicit
    // operation limit; the host resolver remains authoritative when config is
    // unavailable.
  }
  return resolveAgentTreeCapacity({
    host: adapter?.host,
    config,
    currentOperationLimit: operationLimit,
    session: sessionUid(env),
    env,
  });
}

export function requiredCapacity(value: EffectiveAgentTreeCapacity): number {
  if (value.capacity == null) throw new DispatchError("capacity is unknown", "CAPACITY_UNKNOWN");
  return value.capacity;
}

/** Resolve the host captured by a ticket. Hostless tickets are not attributed. */
export function ticketTargetHost(ticket: SpawnTicket, env: NodeJS.ProcessEnv = process.env): HostId {
  const captured = ticket.target_host || ticket.dispatch_host || ticket.host || ticket.selection?.host;
  if (captured) return requireHost(String(captured), env);
  throw new DispatchError(`ticket ${ticket.id} has no captured host`, "HOST_REQUIRED", { ticketId: ticket.id });
}
