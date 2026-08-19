import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DispatchError,
  bindAgent,
  dispatchSnapshot,
  finishAgent,
  persistedCapacity,
  recoverDispatches,
  reserveNext,
} from "../src/lib/dispatch.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { dispatchStatePath, spawnsDir } from "../src/lib/paths.js";
import { isolatedHome } from "./home.js";

isolatedHome("baton-dispatch-home-");

const T0 = Date.parse("2026-08-19T00:00:00.000Z");

function at(offsetMs) {
  return new Date(T0 + offsetMs).toISOString();
}

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-"));
  return cwd;
}

function makeTicket(id, overrides = {}) {
  return {
    schema_version: 2,
    id,
    description: "task " + id,
    prompt: "do " + id,
    model_id: "example-coder",
    route_id: "codex/default",
    reasoning_effort: null,
    fork_context: false,
    mode: "read-only",
    read_only: true,
    source: "test",
    openspec: null,
    queue: "enqueue",
    status: "queued",
    attempt: 0,
    max_attempts: 3,
    agent_id: null,
    host: null,
    error: null,
    conclusion: null,
    created_at: at(0),
    updated_at: at(0),
    history: [{ event: "ticket_queued", at: at(0) }],
    ...overrides,
  };
}

function writeTicket(cwd, ticket) {
  if (!ticket.receipt_id) {
    const receipt = buildReadOnlyReceipt({
      ticketId: ticket.id,
      card: { id: ticket.model_id, strengths: "", route_id: ticket.route_id || undefined, reasoning_effort: ticket.reasoning_effort || undefined },
      issuedAt: ticket.created_at,
      maxAttempts: ticket.max_attempts,
    });
    ticket.receipt_id = receipt.receipt_id;
    writeReceipt(cwd, receipt);
  }
  const dir = spawnsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ticket.id + ".json");
  fs.writeFileSync(file, JSON.stringify(ticket, null, 2) + "\n", "utf8");
  return ticket;
}

function readTicket(cwd, id) {
  const file = path.join(spawnsDir(cwd), id + ".json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** n queued tickets with strictly increasing created_at (FIFO order t-0001..t-000n). */
function seedQueued(cwd, n, overrides = {}) {
  const tickets = [];
  for (let i = 1; i <= n; i += 1) {
    const id = "t-" + String(i).padStart(4, "0");
    tickets.push(writeTicket(cwd, makeTicket(id, { created_at: at(i), updated_at: at(i), ...overrides })));
  }
  return tickets;
}

function expectDispatchError(fn, code) {
  return assert.throws(fn, (err) => {
    assert.ok(err instanceof DispatchError, "expected DispatchError, got " + err);
    assert.equal(err.code, code);
    return true;
  });
}

describe("reserveNext", () => {
  it("reserves up to capacity: 8 tickets, capacity 6 -> 6 dispatching + 2 queued", () => {
    const cwd = makeProject();
    seedQueued(cwd, 8);

    const result = reserveNext(cwd, { capacity: 6, host: "codex", now: at(100) });

    assert.deepEqual(
      result.reserved.map((r) => r.ticket_id),
      ["t-0001", "t-0002", "t-0003", "t-0004", "t-0005", "t-0006"],
    );
    assert.deepEqual(result.blocked, []);

    const snap = dispatchSnapshot(cwd, { capacity: 6 });
    assert.equal(snap.counts.dispatching, 6);
    assert.equal(snap.counts.queued, 2);
    assert.equal(snap.active, 6);
    assert.equal(snap.available, 0);
    assert.deepEqual(snap.queued, ["t-0007", "t-0008"]);

    for (const reserved of result.reserved) {
      assert.equal(reserved.read_only, true);
      assert.equal(reserved.fork_context, false);
      assert.equal(reserved.route_id, "codex/default");
      const ticket = readTicket(cwd, reserved.ticket_id);
      assert.equal(ticket.status, "dispatching");
      assert.equal(ticket.dispatch_host, "codex");
      assert.equal(ticket.attempt, 1);
    }
  });

  it("never lets a newer ticket jump the FIFO queue", () => {
    const cwd = makeProject();
    seedQueued(cwd, 2);
    // One active slot occupied by an older running ticket: only 1 slot free.
    writeTicket(cwd, makeTicket("t-0000", {
      created_at: at(0), updated_at: at(0),
      status: "running", agent_id: "agent-old", host: "codex", started_at: at(5),
    }));

    const first = reserveNext(cwd, { capacity: 2, host: "codex", now: at(10) });
    assert.deepEqual(first.reserved.map((r) => r.ticket_id), ["t-0001"]);

    // A brand-new ticket arrives later; it must not cut in front of t-0002.
    writeTicket(cwd, makeTicket("t-0003", { created_at: at(20), updated_at: at(20) }));

    finishAgent(cwd, "t-0000", { status: "completed", conclusion: "done", now: at(30) });
    const second = reserveNext(cwd, { capacity: 2, host: "codex", now: at(40) });
    assert.deepEqual(second.reserved.map((r) => r.ticket_id), ["t-0002"]);

    const snap = dispatchSnapshot(cwd, { capacity: 2 });
    assert.deepEqual(snap.queued, ["t-0003"]);
  });

  it("after one finishes, the earliest queued ticket is the next one selected", () => {
    const cwd = makeProject();
    seedQueued(cwd, 3);

    const first = reserveNext(cwd, { capacity: 2, host: "codex", now: at(10) });
    assert.deepEqual(first.reserved.map((r) => r.ticket_id), ["t-0001", "t-0002"]);
    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(20) });
    finishAgent(cwd, "t-0001", { status: "completed", conclusion: "shipped", now: at(30) });

    const second = reserveNext(cwd, { capacity: 2, host: "codex", now: at(40) });
    assert.deepEqual(second.reserved.map((r) => r.ticket_id), ["t-0003"]);
  });

  it("blocks a queued ticket without route_id and never falls back to another route", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    writeTicket(cwd, makeTicket("t-no-route", { created_at: at(2), updated_at: at(2), route_id: null }));

    const result = reserveNext(cwd, { capacity: 2, host: "codex", now: at(10) });

    assert.deepEqual(result.reserved.map((r) => r.ticket_id), ["t-0001"]);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].ticket_id, "t-no-route");
    assert.equal(result.blocked[0].code, "NO_EXECUTABLE_ROUTE");

    const ticket = readTicket(cwd, "t-no-route");
    assert.equal(ticket.status, "errored");
    assert.equal(ticket.error.code, "NO_EXECUTABLE_ROUTE");
    // Fail closed: no route was invented and the ticket is not dispatching.
    assert.equal(ticket.route_id, null);
    assert.equal(ticket.agent_id, null);
  });

  it("blocks a ticket whose mode mismatches its Receipt or uses fork_context=true", () => {
    const cwd = makeProject();
    writeTicket(cwd, makeTicket("t-writer", { read_only: false, mode: "write" }));
    writeTicket(cwd, makeTicket("t-forker", { created_at: at(2), updated_at: at(2), fork_context: true }));

    const result = reserveNext(cwd, { capacity: 4, host: "codex", now: at(10) });

    assert.deepEqual(result.reserved, []);
    const codes = result.blocked.map((b) => [b.ticket_id, b.code]);
    assert.deepEqual(codes, [["t-writer", "RECEIPT_MISMATCH"], ["t-forker", "FULL_CONTEXT_NOT_ALLOWED"]]);
  });
});

describe("bindAgent", () => {
  it("binds a real agent id: dispatching -> running with started_at and host", () => {
    const cwd = makeProject();
    seedQueued(cwd, 2);
    reserveNext(cwd, { capacity: 2, host: "codex", now: at(10) });

    const bound = bindAgent(cwd, "t-0001", { agentId: "subagent-abc123", host: "codex", now: at(20) });
    assert.equal(bound.status, "running");
    assert.equal(bound.agent_id, "subagent-abc123");
    assert.equal(bound.host, "codex");
    assert.equal(bound.started_at, at(20));

    const snap = dispatchSnapshot(cwd, { capacity: 2 });
    assert.deepEqual(snap.running, [{ ticket_id: "t-0001", agent_id: "subagent-abc123", host: "codex" }]);
  });

  it("fails closed on illegal transitions: queued/running/terminal states", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);

    // queued -> running is not allowed.
    expectDispatchError(
      () => bindAgent(cwd, "t-0001", { agentId: "agent-x", host: "codex", now: at(10) }),
      "INVALID_TICKET_TRANSITION",
    );
    assert.equal(readTicket(cwd, "t-0001").status, "queued");

    reserveNext(cwd, { capacity: 1, host: "codex", now: at(20) });
    bindAgent(cwd, "t-0001", { agentId: "agent-x", host: "codex", now: at(30) });

    // running -> running is not allowed.
    expectDispatchError(
      () => bindAgent(cwd, "t-0001", { agentId: "agent-y", host: "codex", now: at(40) }),
      "INVALID_TICKET_TRANSITION",
    );
    const ticket = readTicket(cwd, "t-0001");
    assert.equal(ticket.status, "running");
    assert.equal(ticket.agent_id, "agent-x");
  });

  it("requires an agent id and the reserving host", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });

    expectDispatchError(
      () => bindAgent(cwd, "t-0001", { agentId: "", host: "codex", now: at(20) }),
      "AGENT_ID_REQUIRED",
    );
    expectDispatchError(
      () => bindAgent(cwd, "t-0001", { agentId: "agent-x", host: "kimi", now: at(20) }),
      "HOST_MISMATCH",
    );
    assert.equal(readTicket(cwd, "t-0001").status, "dispatching");
  });
});

describe("finishAgent", () => {
  it("completes only from running and stores a short conclusion", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });

    // completed from dispatching (no bound agent) is illegal.
    expectDispatchError(
      () => finishAgent(cwd, "t-0001", { status: "completed", conclusion: "early", now: at(20) }),
      "AGENT_NOT_BOUND",
    );

    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(30) });
    const done = finishAgent(cwd, "t-0001", { status: "completed", conclusion: "implemented and tested", now: at(40) });
    assert.equal(done.status, "completed");
    assert.equal(done.conclusion, "implemented and tested");
    assert.equal(done.finished_at, at(40));
    assert.equal(dispatchSnapshot(cwd, { capacity: 1 }).available, 1);
  });

  it("rejects tool-dump conclusions so the director context stays clean", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(20) });

    const dump = "tool_call: read_file\ntool_result: {\"role\": \"tool\", \"content\": \"...\"}";
    expectDispatchError(
      () => finishAgent(cwd, "t-0001", { status: "completed", conclusion: dump, now: at(30) }),
      "HYGIENE",
    );
    // Failed hygiene check does not move the ticket.
    assert.equal(readTicket(cwd, "t-0001").status, "running");

    const done = finishAgent(cwd, "t-0001", { status: "completed", conclusion: "done in two files", now: at(40) });
    assert.equal(done.status, "completed");
    assert.ok(done.conclusion.length <= 800);
  });

  it("errored/timed_out/closed free dispatching or running slots and keep structured errors", () => {
    const cwd = makeProject();
    seedQueued(cwd, 3);
    reserveNext(cwd, { capacity: 3, host: "codex", now: at(10) });
    bindAgent(cwd, "t-0002", { agentId: "agent-2", host: "codex", now: at(20) });

    // Spawn/bind failure: still dispatching, no agent ever bound.
    const spawnFailed = finishAgent(cwd, "t-0001", {
      status: "errored", errorCode: "SPAWN_FAILED", errorMessage: "host refused the spawn", now: at(30),
    });
    assert.equal(spawnFailed.status, "errored");
    assert.deepEqual(spawnFailed.error, { code: "SPAWN_FAILED", message: "host refused the spawn" });

    // Timeout from running.
    const timedOut = finishAgent(cwd, "t-0002", { status: "timed_out", errorMessage: "no events for 10m", now: at(40) });
    assert.equal(timedOut.status, "timed_out");
    assert.equal(timedOut.error.code, "AGENT_TIMEOUT");

    // Closed from dispatching with a default structured code.
    const closed = finishAgent(cwd, "t-0003", { status: "closed", now: at(50) });
    assert.equal(closed.status, "closed");
    assert.equal(closed.error.code, "AGENT_CLOSED");

    const snap = dispatchSnapshot(cwd, { capacity: 3 });
    assert.equal(snap.active, 0);
    assert.equal(snap.available, 3);
  });

  it("terminal tickets can never transition again", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(20) });
    finishAgent(cwd, "t-0001", { status: "completed", conclusion: "done", now: at(30) });

    expectDispatchError(
      () => finishAgent(cwd, "t-0001", { status: "errored", errorCode: "LATE_FAILURE", now: at(40) }),
      "TICKET_ALREADY_TERMINAL",
    );
    expectDispatchError(
      () => finishAgent(cwd, "t-0001", { status: "completed", conclusion: "again", now: at(40) }),
      "TICKET_ALREADY_TERMINAL",
    );
    expectDispatchError(
      () => bindAgent(cwd, "t-0001", { agentId: "agent-z", host: "codex", now: at(40) }),
      "INVALID_TICKET_TRANSITION",
    );

    const ticket = readTicket(cwd, "t-0001");
    assert.equal(ticket.status, "completed");
    assert.equal(ticket.conclusion, "done");
    assert.equal(ticket.error, null);
  });
});

describe("recoverDispatches", () => {
  it("expires stale dispatching tickets without agent_id and keeps resumable running agents", () => {
    const cwd = makeProject();
    writeTicket(cwd, makeTicket("t-stale", {
      status: "dispatching", dispatch_host: "codex",
      created_at: at(0), updated_at: at(10), dispatch_requested_at: at(10),
    }));
    writeTicket(cwd, makeTicket("t-fresh", {
      created_at: at(1), updated_at: at(1), status: "dispatching", dispatch_host: "codex",
      dispatch_requested_at: at(90_000),
    }));
    writeTicket(cwd, makeTicket("t-runner", {
      created_at: at(2), updated_at: at(2), status: "running",
      agent_id: "agent-live", host: "codex", started_at: at(5), dispatch_requested_at: at(4),
    }));

    const recovered = recoverDispatches(cwd, { staleMs: 60_000, now: at(120_000) });

    assert.deepEqual(recovered.expired, ["t-stale"]);
    assert.deepEqual(recovered.resumable, [{ ticket_id: "t-runner", agent_id: "agent-live", host: "codex" }]);

    const stale = readTicket(cwd, "t-stale");
    assert.equal(stale.status, "errored");
    assert.equal(stale.error.code, "DISPATCH_LEASE_EXPIRED");

    // Fresh lease and running ticket survive recovery untouched.
    assert.equal(readTicket(cwd, "t-fresh").status, "dispatching");
    assert.equal(readTicket(cwd, "t-runner").status, "running");
  });
});

describe("restart: state reloads from disk", () => {
  it("a fresh call sequence after restart sees the same persisted lifecycle", () => {
    const cwd = makeProject();
    seedQueued(cwd, 3);
    reserveNext(cwd, { capacity: 2, host: "codex", now: at(10) });
    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(20) });

    // Simulate a dispatcher restart: all knowledge comes from the global workspace spawns directory.
    const snap = dispatchSnapshot(cwd, { capacity: 2 });
    assert.equal(snap.counts.running, 1);
    assert.equal(snap.counts.dispatching, 1);
    assert.equal(snap.counts.queued, 1);
    assert.equal(snap.available, 0);
    assert.deepEqual(snap.queued, ["t-0003"]);
    assert.deepEqual(snap.running, [{ ticket_id: "t-0001", agent_id: "agent-1", host: "codex" }]);

    // Recovery after restart still resumes the bound agent and can finish it.
    const recovered = recoverDispatches(cwd, { staleMs: 60_000, now: at(30) });
    assert.deepEqual(recovered.expired, []);
    assert.deepEqual(recovered.resumable, [{ ticket_id: "t-0001", agent_id: "agent-1", host: "codex" }]);

    finishAgent(cwd, "t-0001", { status: "completed", conclusion: "resumed and done", now: at(40) });
    const next = reserveNext(cwd, { capacity: 2, host: "codex", now: at(50) });
    assert.deepEqual(next.reserved.map((r) => r.ticket_id), ["t-0003"]);
  });
});

describe("dispatch capacity persistence", () => {
  it("remembers the capacity passed to reserveNext across a dispatcher restart", () => {
    const cwd = makeProject();
    seedQueued(cwd, 3);
    reserveNext(cwd, { capacity: 2, host: "codex", now: at(10) });

    // Capacity is persisted under the user-global workspace runtime state.
    const stateFile = dispatchStatePath(cwd);
    assert.ok(fs.existsSync(stateFile));
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).capacity, 2);
    assert.equal(persistedCapacity(cwd), 2);

    // Simulate a restart: a fresh call resolves capacity from disk, not from flags.
    const snap = dispatchSnapshot(cwd);
    assert.equal(snap.capacity, 2);
    assert.equal(snap.active, 2);
    assert.equal(snap.available, 0);

    // An explicit capacity still wins over the remembered one.
    assert.equal(dispatchSnapshot(cwd, { capacity: 5 }).capacity, 5);

    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(20) });
    finishAgent(cwd, "t-0001", { status: "completed", conclusion: "done", now: at(30) });
    const after = dispatchSnapshot(cwd);
    assert.equal(after.capacity, 2);
    assert.equal(after.available, 1);
  });
});
