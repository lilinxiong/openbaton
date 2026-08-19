import fs from "node:fs";
import path from "node:path";
import { sanitizeConclusion } from "./hygiene.js";
import { listSpawns, readSpawn, writeSpawn } from "./spawn.js";

export const ACTIVE_TICKET_STATUSES = new Set(["dispatching", "running"]);
export const TERMINAL_TICKET_STATUSES = new Set(["completed", "errored", "timed_out", "closed"]);

export class DispatchError extends Error {
  constructor(message, code = "DISPATCH_ERROR", extras = {}) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    Object.assign(this, extras);
  }
}

function instant(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value == null ? new Date() : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new DispatchError("invalid dispatch timestamp", "INVALID_TIME");
  return date;
}

function history(ticket, event, at, detail = {}) {
  if (!Array.isArray(ticket.history)) ticket.history = [];
  ticket.history.push({ event, at, ...detail });
  ticket.updated_at = at;
}

function transition(ticket, expected, next, { at, event = next, detail = {} } = {}) {
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

function fifoTickets(cwd) {
  return listSpawns(cwd).sort((a, b) => {
    const time = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    return time || String(a.id).localeCompare(String(b.id));
  });
}

function lockPath(cwd) {
  return path.join(cwd, ".baton", "tmp", "dispatch.lock");
}

function withLock(cwd, fn) {
  const file = lockPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") throw new DispatchError("another dispatcher holds the project lock", "DISPATCH_LOCKED");
    throw error;
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(file); } catch {}
  }
}

function capacityValue(capacity) {
  const value = Number(capacity);
  if (!Number.isInteger(value) || value < 1) throw new DispatchError("capacity must be a positive integer", "INVALID_CAPACITY");
  return value;
}

function publicDispatchSpec(ticket) {
  return {
    ticket_id: ticket.id,
    route_id: ticket.route_id,
    model: ticket.route_id,
    reasoning_effort: ticket.reasoning_effort || null,
    fork_context: false,
    read_only: true,
    prompt: ticket.prompt,
    attempt: ticket.attempt,
    max_attempts: ticket.max_attempts,
  };
}

function rejectUndispatchable(cwd, ticket, at) {
  let code = null;
  let message = null;
  if (!ticket.route_id) {
    code = "NO_EXECUTABLE_ROUTE";
    message = `ticket ${ticket.id} has no executable route for this host`;
  } else if (ticket.read_only !== true || ticket.mode !== "read-only") {
    code = "WRITE_MODE_NOT_ENABLED";
    message = `ticket ${ticket.id} is not read-only`;
  } else if (ticket.fork_context !== false) {
    code = "FULL_CONTEXT_NOT_ALLOWED";
    message = `ticket ${ticket.id} must use fork_context=false`;
  } else if (Number(ticket.attempt || 0) >= Number(ticket.max_attempts || 1)) {
    code = "ATTEMPT_BUDGET_EXHAUSTED";
    message = `ticket ${ticket.id} exhausted its attempt budget`;
  }
  if (!code) return null;
  transition(ticket, "queued", "errored", { at, event: "dispatch_blocked", detail: { error_code: code } });
  ticket.error = { code, message };
  ticket.finished_at = at;
  writeSpawn(cwd, ticket);
  return { ticket_id: ticket.id, code, message };
}

export function reserveNext(cwd, { capacity, limit = Number.MAX_SAFE_INTEGER, host = "codex", now } = {}) {
  const max = capacityValue(capacity);
  const maxTake = Math.max(0, Math.floor(Number(limit) || 0));
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const tickets = fifoTickets(cwd);
    const active = tickets.filter((ticket) => ACTIVE_TICKET_STATUSES.has(ticket.status)).length;
    let available = Math.max(0, max - active);
    const reserved = [];
    const blocked = [];
    for (const ticket of tickets) {
      if (ticket.status !== "queued" || available <= 0 || reserved.length >= maxTake) continue;
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
      reserved.push(publicDispatchSpec(ticket));
      available -= 1;
    }
    return { reserved, blocked, snapshot: dispatchSnapshot(cwd, { capacity: max }) };
  });
}

export function bindAgent(cwd, id, { agentId, host = "codex", now } = {}) {
  const workerId = String(agentId || "").trim();
  if (!workerId) throw new DispatchError("agentId is required", "AGENT_ID_REQUIRED", { ticketId: id });
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = readSpawn(cwd, id);
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

export function finishAgent(cwd, id, { status, conclusion = null, errorCode = null, errorMessage = null, now } = {}) {
  const terminal = String(status || "").trim();
  if (!TERMINAL_TICKET_STATUSES.has(terminal)) throw new DispatchError(`invalid terminal status: ${terminal}`, "INVALID_TERMINAL_STATUS", { ticketId: id });
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = readSpawn(cwd, id);
    if (TERMINAL_TICKET_STATUSES.has(ticket.status)) {
      throw new DispatchError(`ticket ${id} is already terminal: ${ticket.status}`, "TICKET_ALREADY_TERMINAL", { ticketId: id });
    }
    const expected = terminal === "completed" ? "running" : ["dispatching", "running"];
    if (terminal === "completed") {
      if (!ticket.agent_id) throw new DispatchError(`ticket ${id} has no bound agent`, "AGENT_NOT_BOUND", { ticketId: id });
      const clean = sanitizeConclusion(conclusion);
      if (!clean.ok) throw new DispatchError(clean.error, "HYGIENE", { ticketId: id });
      transition(ticket, expected, terminal, { at, event: "agent_completed" });
      ticket.conclusion = clean.conclusion;
      ticket.error = null;
    } else {
      const code = String(errorCode || (terminal === "timed_out" ? "AGENT_TIMEOUT" : terminal === "closed" ? "AGENT_CLOSED" : "AGENT_ERROR"));
      const message = String(errorMessage || code);
      transition(ticket, expected, terminal, { at, event: `agent_${terminal}`, detail: { error_code: code } });
      ticket.error = { code, message };
      if (conclusion) {
        const clean = sanitizeConclusion(conclusion);
        if (clean.ok) ticket.conclusion = clean.conclusion;
      }
    }
    ticket.finished_at = at;
    writeSpawn(cwd, ticket);
    return ticket;
  });
}

export function recoverDispatches(cwd, { staleMs = 60_000, now } = {}) {
  const threshold = Number(staleMs);
  if (!Number.isFinite(threshold) || threshold < 0) throw new DispatchError("staleMs must be non-negative", "INVALID_STALE_MS");
  return withLock(cwd, () => {
    const current = instant(now);
    const at = current.toISOString();
    const expired = [];
    const resumable = [];
    for (const ticket of fifoTickets(cwd)) {
      if (ticket.status === "running" && ticket.agent_id) {
        resumable.push({ ticket_id: ticket.id, agent_id: ticket.agent_id, host: ticket.host || ticket.dispatch_host || null });
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
    return { expired, resumable };
  });
}

export function dispatchSnapshot(cwd, { capacity = 1 } = {}) {
  const max = capacityValue(capacity);
  const tickets = fifoTickets(cwd);
  const counts = {};
  for (const ticket of tickets) counts[ticket.status] = (counts[ticket.status] || 0) + 1;
  const active = tickets.filter((ticket) => ACTIVE_TICKET_STATUSES.has(ticket.status));
  return {
    capacity: max,
    active: active.length,
    available: Math.max(0, max - active.length),
    counts,
    queued: tickets.filter((ticket) => ticket.status === "queued").map((ticket) => ticket.id),
    dispatching: tickets.filter((ticket) => ticket.status === "dispatching").map((ticket) => ticket.id),
    running: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({ ticket_id: ticket.id, agent_id: ticket.agent_id, host: ticket.host || ticket.dispatch_host || null })),
    terminal: tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status)).map((ticket) => ({ ticket_id: ticket.id, status: ticket.status, error: ticket.error || null })),
  };
}
