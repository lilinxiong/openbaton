import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DispatchError,
  bindAgent,
  deferDispatch,
  dispatchSnapshot,
  finishAgent,
  persistedCapacity,
  recoverDispatches,
  releaseAgent,
  reportAgentProbe,
  reportAgentProgress,
  reserveNext,
} from "../src/lib/dispatch.js";
import { emptyConfig, saveConfig } from "../src/lib/config.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { hostDispatchStatePath, runsDir, spawnsDir, workspaceId } from "../src/lib/paths.js";
import { readRouteHealth } from "../src/lib/route-health.js";
import { publishRouteSnapshot, readRouteSnapshot } from "../src/lib/routes.js";
import { isolatedHome } from "./home.js";
import { parseDispatchReservationEnvelope } from "../src/lib/dispatch-reservation.js";
import {
  nativeHookIdentity,
  nativeToolReturnIdentity,
  recordNativeIdentity,
  recordPendingReservation,
  resolveNativeWorkerIdentity,
} from "../src/lib/host-identity.js";
import { buildWorkerPrompt, compileWorkUnit, coordinationFor } from "../src/lib/work-unit.js";

const TEST_HOME = isolatedHome("baton-dispatch-home-");

const T0 = Date.parse("2026-08-19T00:00:00.000Z");

function at(offsetMs) {
  return new Date(T0 + offsetMs).toISOString();
}

function ensureTestHome() {
  process.env.HOME = TEST_HOME;
}

function makeProject(models = [{ id: "codex/default", namespaced: "codex/default", provider: "codex" }]) {
  ensureTestHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-"));
  const config = emptyConfig();
  const routeIds = [...new Set(models.map((model) => model.namespaced || model.id).filter(Boolean))];
  config.cli.codex = {
    enabled: true,
    runner: "",
    longctx: "",
    subagent_models: routeIds,
  };
  saveConfig(cwd, config);
  publishRouteSnapshot(cwd, { models }, new Date(), { cli: "codex", host: "codex" });
  return cwd;
}

function makeTicket(id, overrides = {}) {
  const description = overrides.description || "task " + id;
  const rawPrompt = overrides.prompt || "do " + id;
  const workUnit = overrides.work_unit || compileWorkUnit(description, { kind: "concrete" });
  const coordination = overrides.coordination || coordinationFor(workUnit);
  const ticket = {
    schema_version: 7,
    id,
    description,
    prompt: buildWorkerPrompt(rawPrompt, workUnit, coordination),
    work_unit: workUnit,
    coordination,
    model_id: "example-coder",
    route_id: "codex/default",
    reasoning_effort: null,
    service_tier: null,
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
    target_host: "codex",
    error: null,
    conclusion: null,
    progress: null,
    liveness: null,
    created_at: at(0),
    updated_at: at(0),
    history: [{ event: "ticket_queued", at: at(0) }],
    ...overrides,
  };
  ticket.prompt = buildWorkerPrompt(ticket.prompt, ticket.work_unit, ticket.coordination);
  return ticket;
}

function writeTicket(cwd, ticket) {
  ensureTestHome();
  const capturedHost = ticket.target_host || ticket.dispatch_host || ticket.host || ticket.selection?.host || null;
  if (ticket.selection === undefined) {
    ticket.selection = {
      proposal_id: "sel-test",
      approval_id: `approval-${ticket.id}`,
      approved_at: ticket.created_at,
      confirmed_by: "baton-recommendation",
      catalog_fingerprint: readRouteSnapshot(cwd, { host: capturedHost || undefined })?.fingerprint
        || readRouteSnapshot(cwd).fingerprint,
      recommended_model_id: ticket.model_id,
      selected_model_id: ticket.model_id,
      changed_by_user: false,
      ...(capturedHost ? { host: capturedHost } : {}),
    };
  }
  if (!ticket.receipt_id) {
    const receipt = buildReadOnlyReceipt({
      ticketId: ticket.id,
      card: { id: ticket.model_id, strengths: "", route_id: ticket.route_id || undefined, reasoning_effort: ticket.reasoning_effort || undefined },
      issuedAt: ticket.created_at,
      maxAttempts: ticket.max_attempts,
      selection: ticket.selection,
      host: capturedHost,
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

function readBindings(cwd) {
  const file = path.join(runsDir(cwd), "host-guard-bindings.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function observeCodexReservation(cwd, id, hookAgentId, now = new Date()) {
  const ticket = readTicket(cwd, id);
  const pending = recordPendingReservation(cwd, {
    schema: 1,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: ticket.dispatch_host || ticket.host || ticket.target_host || "codex",
  }, { now });
  recordNativeIdentity(cwd, pending, hookAgentId, "hook", { now });
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
  it("rejects a non-current ticket without upgrading or rewriting it", () => {
    const cwd = makeProject();
    const legacy = makeTicket("t-old");
    legacy.schema_version = 5;
    delete legacy.work_unit;
    delete legacy.coordination;
    delete legacy.progress;
    const written = writeTicket(cwd, legacy);
    const before = fs.readFileSync(path.join(spawnsDir(cwd), "t-old.json"), "utf8");

    expectDispatchError(
      () => reserveNext(cwd, { capacity: 1, host: "codex", now: at(1) }),
      "TICKET_FORMAT_UNSUPPORTED",
    );
    assert.equal(fs.readFileSync(path.join(spawnsDir(cwd), "t-old.json"), "utf8"), before);
    assert.equal(written.schema_version, 5);
  });

  it("ignores unversioned workspace tickets and accepts current schema independent of id prefix", () => {
    const cwd = makeProject();
    const legacyFile = path.join(
      process.env.HOME!,
      ".baton",
      "workspaces",
      workspaceId(cwd),
      "spawns",
      "spn-0001.json",
    );
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify(makeTicket("spn-0001"), null, 2) + "\n", "utf8");

    writeTicket(cwd, makeTicket("os-0001", { created_at: at(1), updated_at: at(1) }));
    const result = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });

    assert.deepEqual(result.reserved.map((item) => item.ticket_id), ["os-0001"]);
    assert.equal(JSON.parse(fs.readFileSync(legacyFile, "utf8")).status, "queued");
  });

  it("reserves up to capacity: 8 tickets, capacity 6 -> 6 dispatching + 2 queued", () => {
    const cwd = makeProject();
    seedQueued(cwd, 8);

    const result = reserveNext(cwd, { capacity: 6, host: "codex", now: at(100) });

    assert.deepEqual(
      result.reserved.map((r) => r.ticket_id),
      ["t-0001", "t-0002", "t-0003", "t-0004", "t-0005", "t-0006"],
    );
    assert.deepEqual(result.blocked, []);
    assert.equal(new Set(result.reserved.map((item) => item.reservation.reservation_id)).size, 6);

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
      assert.deepEqual(parseDispatchReservationEnvelope(reserved.prompt), reserved.reservation);
      assert.deepEqual(parseDispatchReservationEnvelope(reserved.description), reserved.reservation);
      assert.equal(reserved.reservation.ticket_id, reserved.ticket_id);
      assert.equal(reserved.reservation.host, "codex");
      assert.equal(reserved.reservation.attempt, 1);
      const ticket = readTicket(cwd, reserved.ticket_id);
      assert.equal(ticket.status, "dispatching");
      assert.equal(ticket.dispatch_host, "codex");
      assert.equal(ticket.attempt, 1);
      assert.equal(ticket.reservation_id, reserved.reservation.reservation_id);
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
    releaseAgent(cwd, "t-0000", { agentId: "agent-old", now: at(35) });
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
    observeCodexReservation(cwd, "t-0001", "agent-1", at(15));
    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(20) });
    finishAgent(cwd, "t-0001", { status: "completed", conclusion: "shipped", now: at(30) });
    releaseAgent(cwd, "t-0001", { agentId: "agent-1", now: at(35) });

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

  it("never dispatches a ticket without automatic or configured selection evidence", () => {
    const cwd = makeProject();
    writeTicket(cwd, makeTicket("t-unconfirmed", { selection: null }));

    const result = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });

    assert.deepEqual(result.reserved, []);
    assert.equal(result.blocked[0].code, "MODEL_SELECTION_NOT_CONFIRMED");
    assert.equal(readTicket(cwd, "t-unconfirmed").status, "errored");
  });

  it("fails closed when an approved reasoning effort disappears from the CLI snapshot", () => {
    const models = [{
      id: "codex/default", namespaced: "codex/default", provider: "codex", reasoningEfforts: ["high"],
    }];
    const cwd = makeProject(models);
    writeTicket(cwd, makeTicket("t-profile", {
      model_id: "codex/default@high",
      reasoning_effort: "high",
    }));

    publishRouteSnapshot(cwd, { models: [{
      id: "codex/default", namespaced: "codex/default", provider: "codex", reasoningEfforts: [],
    }] }, new Date(), { cli: "codex", host: "codex" });

    const result = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    assert.deepEqual(result.reserved, []);
    assert.equal(result.blocked[0].code, "CLI_REASONING_EFFORT_UNAVAILABLE");
    assert.equal(readTicket(cwd, "t-profile").route_id, "codex/default");
  });

  it("fails closed when an automatically selected service tier disappears", () => {
    const models = [{
      id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", reasoningEfforts: ["high"], serviceTiers: [{ id: "priority" }],
    }];
    const cwd = makeProject(models);
    const ticket = makeTicket("t-tier", {
      model_id: "gpt-5.6-sol@high",
      route_id: "gpt-5.6-sol",
      reasoning_effort: "high",
      service_tier: "priority",
      selection: {
        proposal_id: "sel-test",
        approval_id: "approval-t-tier",
        approved_at: at(0),
        confirmed_by: "baton-recommendation",
        catalog_fingerprint: readRouteSnapshot(cwd, { host: "codex" }).fingerprint,
        recommended_model_id: "gpt-5.6-sol@high",
        selected_model_id: "gpt-5.6-sol@high",
        service_tier: "priority",
        changed_by_user: false,
        host: "codex",
      },
    });
    writeTicket(cwd, ticket);
    publishRouteSnapshot(cwd, { models: [{ id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", reasoningEfforts: ["high"] }] }, new Date(), { cli: "codex", host: "codex" });

    const result = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    assert.deepEqual(result.reserved, []);
    assert.equal(result.blocked[0].code, "CLI_SERVICE_TIER_UNAVAILABLE");
  });

  it("does not hard-code family bans for CLI-returned models", () => {
    for (const [index, route] of ["gpt-5.5-extra", "gpt-5.6-sol", "cursor/gpt-5.6-terra"].entries()) {
      const models = [{
        id: route.split("/").at(-1), namespaced: route,
        provider: route.includes("/") ? "cursor" : "openai",
        reasoningEfforts: ["high"],
      }];
      const cwd = makeProject(models);
      writeTicket(cwd, makeTicket(`t-forbidden-${index}`, { model_id: `${route}@high`, route_id: route, reasoning_effort: "high" }));
      const result = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
      assert.deepEqual(result.blocked, []);
      assert.equal(result.reserved[0].route_id, route);
      assert.equal(readTicket(cwd, `t-forbidden-${index}`).status, "dispatching");
    }
  });

  it("keeps a captured-host ticket queued on mismatch and rejects unknown hosts", () => {
    const cwd = makeProject();
    const selection = {
      proposal_id: "sel-test",
      approval_id: "approval-t-0001",
      approved_at: at(0),
      confirmed_by: "baton-recommendation",
      catalog_fingerprint: readRouteSnapshot(cwd).fingerprint,
      recommended_model_id: "example-coder",
      selected_model_id: "example-coder",
      changed_by_user: false,
      host: "codex",
    };
    const ticket = makeTicket("t-0001", { target_host: "codex", selection });
    const receipt = buildReadOnlyReceipt({
      ticketId: ticket.id,
      card: { id: ticket.model_id, strengths: "", route_id: ticket.route_id || undefined },
      issuedAt: ticket.created_at,
      maxAttempts: ticket.max_attempts,
      selection,
      host: "codex",
    });
    ticket.receipt_id = receipt.receipt_id;
    writeReceipt(cwd, receipt);
    writeTicket(cwd, ticket);

    const reserved = reserveNext(cwd, { capacity: 1, host: "grok", now: at(10) });
    assert.equal(reserved.reserved.length, 0);
    assert.equal(reserved.blocked[0]?.code, "HOST_MISMATCH");
    assert.equal(readTicket(cwd, "t-0001").status, "queued");
    expectDispatchError(
      () => reserveNext(cwd, { capacity: 1, host: "not-a-registered-host", now: at(20) }),
      "INVALID_HOST",
    );
  });

  it("does not attribute hostless tickets or unkeyed dispatch state to a default CLI", () => {
    const cwd = makeProject();
    writeTicket(cwd, makeTicket("t-hostless", { target_host: null }));

    const reserved = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    assert.deepEqual(reserved.reserved, []);
    assert.equal(reserved.blocked[0]?.ticket_id, "t-hostless");
    assert.equal(reserved.blocked[0]?.code, "HOST_REQUIRED");
    assert.equal(readTicket(cwd, "t-hostless").status, "queued");
    assert.equal(readTicket(cwd, "t-hostless").dispatch_host, undefined);

    const stateFile = path.join(runsDir(cwd), "dispatch.json");
    for (const file of [stateFile, hostDispatchStatePath(cwd, "codex"), hostDispatchStatePath(cwd, "grok")]) {
      try { fs.unlinkSync(file); } catch { /* optional */ }
    }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ capacity: 7 }, null, 2) + "\n");
    assert.equal(persistedCapacity(cwd, "codex"), null);
    assert.equal(persistedCapacity(cwd, "grok"), null);
  });
});

describe("bindAgent", () => {
  it("binds a real agent id: dispatching -> running with started_at and host", () => {
    const cwd = makeProject();
    seedQueued(cwd, 2);
    reserveNext(cwd, { capacity: 2, host: "codex", now: at(10) });
    observeCodexReservation(cwd, "t-0001", "subagent-abc123", at(15));

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
    observeCodexReservation(cwd, "t-0001", "agent-x", at(25));
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
      () => bindAgent(cwd, "t-0001", { agentId: "agent-x", host: "grok", now: at(20) }),
      "HOST_MISMATCH",
    );
    assert.equal(readTicket(cwd, "t-0001").status, "dispatching");
  });

  it("uses the Codex hook agent_id and rejects the native task_name caller token", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    const reserved = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    const reservation = reserved.reserved[0].reservation;
    const pending = recordPendingReservation(cwd, reservation, { now: at(11) });
    recordNativeIdentity(cwd, pending, "hook-agent-123", "hook", { now: at(12) });

    expectDispatchError(
      () => bindAgent(cwd, "t-0001", { agentId: "task_name-from-codex", host: "codex", now: at(20) }),
      "AGENT_IDENTITY_MISMATCH",
    );
    assert.equal(readTicket(cwd, "t-0001").status, "dispatching");

    const bound = bindAgent(cwd, "t-0001", { host: "codex", now: at(21) });
    assert.equal(bound.status, "running");
    assert.equal(bound.agent_id, "hook-agent-123");
  });

  it("accepts Codex --task-name metadata but still binds the hook UUID", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    const reserved = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    const reservation = reserved.reserved[0].reservation;
    const pending = recordPendingReservation(cwd, reservation, { now: at(11) });
    recordNativeIdentity(cwd, pending, "hook-agent-456", "hook", { now: at(12) });

    const bound = bindAgent(cwd, "t-0001", {
      taskName: "codex-task-name",
      host: "codex",
      now: at(20),
    });
    assert.equal(bound.status, "running");
    assert.equal(bound.agent_id, "hook-agent-456");
    assert.equal(bound.history.at(-1).task_name, "codex-task-name");
  });

  it("rejects Codex --task-name when the identity ledger has no authoritative observation", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });

    expectDispatchError(
      () => bindAgent(cwd, "t-0001", {
        taskName: "codex-task-name",
        host: "codex",
        now: at(20),
      }),
      "AGENT_IDENTITY_REQUIRED",
    );
    assert.equal(readTicket(cwd, "t-0001").status, "dispatching");
  });

  it("keeps host identity sources distinct across Codex, Grok, and Cursor", () => {
    assert.equal(nativeToolReturnIdentity("codex", { task_name: "codex-task" }), null);
    assert.equal(nativeHookIdentity("codex", { agent_id: "codex-hook" }), "codex-hook");
    assert.equal(nativeHookIdentity("codex", { native_agent_id: "copied-hook" }), null);
    assert.equal(nativeHookIdentity("grok", { subagentId: "grok-child", sessionId: "grok-session" }), "grok-child");
    assert.equal(nativeHookIdentity("grok", { sessionId: "grok-session" }), null);
    assert.equal(nativeToolReturnIdentity("grok", { agent_id: "copied-agent" }), null);
    assert.equal(nativeToolReturnIdentity("cursor", { task_name: "cursor-task" }), "cursor-task");
    assert.equal(nativeHookIdentity("cursor", { agent_id: "should-not-be-used" }), null);
    assert.equal(resolveNativeWorkerIdentity("codex", {
      callerIdentity: "codex-task",
      observedIdentity: "codex-hook",
    }).code, "AGENT_IDENTITY_MISMATCH");
    assert.equal(resolveNativeWorkerIdentity("cursor", {
      callerIdentity: "cursor-task",
    }).identity, "cursor-task");
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

    observeCodexReservation(cwd, "t-0001", "agent-1", at(25));
    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(30) });
    const done = finishAgent(cwd, "t-0001", { status: "completed", conclusion: "implemented and tested", now: at(40) });
    assert.equal(done.status, "completed");
    assert.equal(done.conclusion, "implemented and tested");
    assert.equal(done.finished_at, at(40));
    assert.equal(dispatchSnapshot(cwd, { capacity: 1, now: at(41) }).available, 0);
    assert.deepEqual(dispatchSnapshot(cwd, { capacity: 1, now: at(41) }).awaiting_release, [
      { ticket_id: "t-0001", agent_id: "agent-1", status: "completed" },
    ]);
    assert.deepEqual(readBindings(cwd), []);
    releaseAgent(cwd, "t-0001", { agentId: "agent-1", now: at(50) });
    assert.equal(dispatchSnapshot(cwd, { capacity: 1 }).available, 1);
  });

  it("rejects tool-dump conclusions so the director context stays clean", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    observeCodexReservation(cwd, "t-0001", "agent-1", at(15));
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
    fs.mkdirSync(runsDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(runsDir(cwd), "host-guard-bindings.json"), JSON.stringify([{
      ticket_id: "t-0001",
      agent_id: "stale-dispatch-binding",
      reservation_id: readTicket(cwd, "t-0001").reservation_id,
      attempt: 1,
      host: "codex",
      turn_id: "turn-dispatching",
      session_id: "session-dispatching",
      agent_type: "worker",
      state: "pending",
      observed_at: at(11),
    }], null, 2));
    observeCodexReservation(cwd, "t-0002", "agent-2", at(15));
    bindAgent(cwd, "t-0002", { agentId: "agent-2", host: "codex", now: at(20) });

    // Spawn/bind failure: still dispatching, no agent ever bound.
    const spawnFailed = finishAgent(cwd, "t-0001", {
      status: "errored", errorCode: "SPAWN_FAILED", errorMessage: "host refused the spawn", now: at(30),
    });
    assert.equal(spawnFailed.status, "errored");
    assert.deepEqual(spawnFailed.error, { code: "SPAWN_FAILED", message: "host refused the spawn" });
    assert.deepEqual(readBindings(cwd), []);

    // Elapsed time alone cannot time out a running agent. The host must first
    // report that this exact bound agent is no longer present.
    expectDispatchError(
      () => finishAgent(cwd, "t-0002", { status: "timed_out", probeSequence: 1, now: at(40) }),
      "TIMEOUT_REQUIRES_NOT_FOUND_PROBE",
    );
    const runningProbe = reportAgentProbe(cwd, "t-0002", {
      agentId: "agent-2", state: "running", now: at(40),
    });
    expectDispatchError(
      () => finishAgent(cwd, "t-0002", { status: "timed_out", probeSequence: runningProbe.liveness?.sequence, now: at(41) }),
      "TIMEOUT_REQUIRES_NOT_FOUND_PROBE",
    );
    const missingProbe = reportAgentProbe(cwd, "t-0002", {
      agentId: "agent-2", state: "not_found", now: at(42),
    });
    const timedOut = finishAgent(cwd, "t-0002", {
      status: "timed_out",
      probeSequence: missingProbe.liveness?.sequence,
      now: at(43),
    });
    assert.equal(timedOut.status, "timed_out");
    assert.equal(timedOut.error.code, "AGENT_TIMEOUT");
    assert.match(timedOut.error.message, /host probe .* not_found/);
    const timeoutHealth = readRouteHealth(cwd).records.find((record) => record.error_code === "AGENT_TIMEOUT");
    assert.equal(timeoutHealth?.route_id, "codex/default");
    assert.equal(timeoutHealth?.status, "degraded");
    releaseAgent(cwd, "t-0002", { agentId: "agent-2", now: at(45) });

    // Closed from dispatching with a default structured code.
    const closed = finishAgent(cwd, "t-0003", { status: "closed", now: at(50) });
    assert.equal(closed.status, "closed");
    assert.equal(closed.error.code, "AGENT_CLOSED");

    const snap = dispatchSnapshot(cwd, { capacity: 3 });
    assert.equal(snap.active, 0);
    assert.equal(snap.available, 3);
  });

  it("clears only exact current-format binding rows for a terminal dispatching ticket and recovers a stale lock", () => {
    const cwd = makeProject();
    writeTicket(cwd, makeTicket("t-0001", {
      status: "dispatching",
      reservation_id: "reservation-1",
      attempt: 1,
      dispatch_host: "codex",
      dispatch_requested_at: at(10),
      updated_at: at(10),
    }));
    fs.mkdirSync(runsDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(runsDir(cwd), "host-guard-bindings.json"), JSON.stringify([
      {
        ticket_id: "t-0001",
        agent_id: "agent-a",
        reservation_id: "reservation-1",
        attempt: 1,
        host: "codex",
        turn_id: "turn-a",
        session_id: "session-a",
        agent_type: "worker",
        state: "pending",
        observed_at: at(11),
      },
      {
        ticket_id: "t-0001",
        agent_id: "agent-b",
        reservation_id: "reservation-1",
        attempt: 1,
        host: "codex",
        turn_id: "turn-b",
        session_id: "session-b",
        agent_type: "worker",
        state: "pending",
        observed_at: at(12),
      },
      {
        ticket_id: "t-0001",
        agent_id: "agent-c",
        reservation_id: "reservation-other",
        attempt: 1,
        host: "codex",
        turn_id: "turn-c",
        session_id: "session-c",
        agent_type: "worker",
        state: "pending",
        observed_at: at(13),
      },
      {
        ticket_id: "t-0001",
        agent_id: "agent-d",
        reservation_id: "reservation-1",
        attempt: 2,
        host: "codex",
        turn_id: "turn-d",
        session_id: "session-d",
        agent_type: "worker",
        state: "pending",
        observed_at: at(14),
      },
      {
        ticket_id: "t-0001",
        agent_id: "agent-e",
        reservation_id: "reservation-1",
        attempt: 1,
        host: "claude",
        turn_id: "turn-e",
        session_id: "session-e",
        agent_type: "worker",
        state: "pending",
        observed_at: at(15),
      },
      {
        ticket_id: "t-keep",
        agent_id: "agent-keep",
        reservation_id: "reservation-1",
        attempt: 1,
        host: "codex",
        turn_id: "turn-keep",
        session_id: "session-keep",
        agent_type: "worker",
        state: "bound",
        observed_at: at(16),
      },
    ], null, 2));
    const lockFile = path.join(runsDir(cwd), "host-guard-bindings.json.lock");
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, created_at: at(17) })}\n`, "utf8");
    const stale = new Date(T0 - 60_000);
    fs.utimesSync(lockFile, stale, stale);

    const closed = finishAgent(cwd, "t-0001", { status: "closed", now: at(30) });
    assert.equal(closed.status, "closed");
    assert.deepEqual(readBindings(cwd), [
      {
        ticket_id: "t-0001",
        agent_id: "agent-c",
        reservation_id: "reservation-other",
        attempt: 1,
        host: "codex",
        turn_id: "turn-c",
        session_id: "session-c",
        agent_type: "worker",
        state: "pending",
        observed_at: at(13),
      },
      {
        ticket_id: "t-0001",
        agent_id: "agent-d",
        reservation_id: "reservation-1",
        attempt: 2,
        host: "codex",
        turn_id: "turn-d",
        session_id: "session-d",
        agent_type: "worker",
        state: "pending",
        observed_at: at(14),
      },
      {
        ticket_id: "t-0001",
        agent_id: "agent-e",
        reservation_id: "reservation-1",
        attempt: 1,
        host: "claude",
        turn_id: "turn-e",
        session_id: "session-e",
        agent_type: "worker",
        state: "pending",
        observed_at: at(15),
      },
      {
        ticket_id: "t-keep",
        agent_id: "agent-keep",
        reservation_id: "reservation-1",
        attempt: 1,
        host: "codex",
        turn_id: "turn-keep",
        session_id: "session-keep",
        agent_type: "worker",
        state: "bound",
        observed_at: at(16),
      },
    ]);
  });

  it("terminal tickets can never transition again", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1);
    reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    observeCodexReservation(cwd, "t-0001", "agent-1", at(15));
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
      status: "dispatching", dispatch_host: "codex", reservation_id: "reservation-stale", attempt: 1,
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
    fs.mkdirSync(runsDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(runsDir(cwd), "host-guard-bindings.json"), JSON.stringify([
      {
        ticket_id: "t-stale",
        agent_id: "stale-binding",
        reservation_id: "reservation-stale",
        attempt: 1,
        host: "codex",
        turn_id: "turn-stale",
        session_id: "session-stale",
        agent_type: "worker",
        state: "pending",
        observed_at: at(11),
      },
      {
        ticket_id: "t-runner",
        agent_id: "agent-live",
        reservation_id: null,
        attempt: null,
        host: "codex",
        turn_id: "turn-runner",
        session_id: "session-runner",
        agent_type: "worker",
        state: "bound",
        observed_at: at(12),
      },
    ], null, 2));

    const recovered = recoverDispatches(cwd, { staleMs: 60_000, now: at(120_000) });

    assert.deepEqual(recovered.expired, ["t-stale"]);
    assert.deepEqual(recovered.resumable, [{ ticket_id: "t-runner", agent_id: "agent-live", host: "codex" }]);
    assert.deepEqual(recovered.needs_close, []);

    const stale = readTicket(cwd, "t-stale");
    assert.equal(stale.status, "errored");
    assert.equal(stale.error.code, "DISPATCH_LEASE_EXPIRED");
    assert.deepEqual(readBindings(cwd), [{
      ticket_id: "t-runner",
      agent_id: "agent-live",
      reservation_id: null,
      attempt: null,
      host: "codex",
      turn_id: "turn-runner",
      session_id: "session-runner",
      agent_type: "worker",
      state: "bound",
      observed_at: at(12),
    }]);

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
    observeCodexReservation(cwd, "t-0001", "agent-1", at(15));
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
    assert.deepEqual(recoverDispatches(cwd, { staleMs: 60_000, now: at(45) }).needs_close, [
      { ticket_id: "t-0001", agent_id: "agent-1", host: "codex" },
    ]);
    releaseAgent(cwd, "t-0001", { agentId: "agent-1", now: at(46) });
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
    const stateFile = hostDispatchStatePath(cwd, "codex");
    assert.ok(fs.existsSync(stateFile));
    assert.equal(fs.existsSync(path.join(runsDir(cwd), "dispatch.json")), false);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).capacity, 2);
    assert.equal(persistedCapacity(cwd), 2);

    // Simulate a restart: a fresh call resolves capacity from disk, not from flags.
    const snap = dispatchSnapshot(cwd);
    assert.equal(snap.capacity, 2);
    assert.equal(snap.active, 2);
    assert.equal(snap.available, 0);

    // An explicit capacity still wins over the remembered one.
    assert.equal(dispatchSnapshot(cwd, { capacity: 5 }).capacity, 5);

    observeCodexReservation(cwd, "t-0001", "agent-1", at(15));
    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(20) });
    finishAgent(cwd, "t-0001", { status: "completed", conclusion: "done", now: at(30) });
    releaseAgent(cwd, "t-0001", { agentId: "agent-1", now: at(40) });
    const after = dispatchSnapshot(cwd);
    assert.equal(after.capacity, 2);
    assert.equal(after.available, 1);
  });
});

describe("host backpressure and progress", () => {
  it("blocks deliberative work that attempts terminal-only coordination", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1, {
      work_unit: {
        schema_version: 1,
        kind: "deliberative",
        objective: "analyze the lifecycle",
        deliverable: "recommendation",
        done_when: "tradeoffs resolved",
      },
      coordination: { mode: "terminal-only", progress_interval_ms: null },
      progress: null,
    });
    const result = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    assert.equal(result.reserved.length, 0);
    assert.equal(result.blocked[0].code, "COORDINATION_REQUIRED");
  });

  it("defers AgentLimitReached back to FIFO without consuming an attempt and remembers observed capacity", () => {
    const cwd = makeProject();
    seedQueued(cwd, 2, { max_attempts: 1 });
    reserveNext(cwd, { capacity: 2, host: "codex", now: at(10) });

    const deferred = deferDispatch(cwd, "t-0001", { observedCapacity: 1, now: at(20) });
    assert.equal(deferred.status, "queued");
    assert.equal(deferred.attempt, 0);
    assert.equal(deferred.error, null);
    assert.equal(persistedCapacity(cwd), 1);
    assert.deepEqual(dispatchSnapshot(cwd, { now: at(21) }).queued, ["t-0001"]);
  });

  it("invalidates the old reservation identity when a deferred ticket is reserved again", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1, { max_attempts: 1 });
    const [first] = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) }).reserved;

    const deferred = deferDispatch(cwd, "t-0001", { observedCapacity: 1, now: at(20) });
    assert.equal(deferred.status, "queued");
    assert.equal(deferred.reservation_id, undefined);

    const [retried] = reserveNext(cwd, { capacity: 1, host: "codex", now: at(30) }).reserved;
    assert.equal(retried.reservation.attempt, first.reservation.attempt);
    assert.notEqual(retried.reservation.reservation_id, first.reservation.reservation_id);
  });

  it("persists concise deliberative checkpoints and marks overdue progress", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1, {
      description: "analyze the lifecycle tradeoffs",
      prompt: "analyze the lifecycle tradeoffs",
      work_unit: compileWorkUnit("analyze the lifecycle tradeoffs", { kind: "deliberative" }),
    });
    const [spec] = reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) }).reserved;
    assert.equal(spec.work_unit.kind, "deliberative");
    assert.equal(spec.coordination.mode, "checkpointed");
    assert.match(spec.prompt, /\[Baton work unit\]/);
    assert.match(spec.prompt, /Send a brief progress update/);
    observeCodexReservation(cwd, "t-0001", "agent-1", at(15));
    bindAgent(cwd, "t-0001", { agentId: "agent-1", host: "codex", now: at(20) });

    const progress = reportAgentProgress(cwd, "t-0001", {
      phase: "working",
      summary: "mapped the lifecycle states",
      nextStep: "check restart behavior",
      now: at(30),
    });
    assert.equal(progress.progress?.sequence, 1);
    assert.equal(progress.progress?.summary, "mapped the lifecycle states");
    assert.equal(progress.liveness?.state, "running");
    assert.equal(progress.liveness?.activity, "output");
    assert.deepEqual(dispatchSnapshot(cwd, { capacity: 1, now: at(60_029) }).progress_due, []);
    assert.deepEqual(dispatchSnapshot(cwd, { capacity: 1, now: at(60_030) }).progress_due, ["t-0001"]);
    assert.deepEqual(dispatchSnapshot(cwd, { capacity: 1, now: at(60_029) }).probe_due, []);
    assert.deepEqual(dispatchSnapshot(cwd, { capacity: 1, now: at(60_030) }).probe_due, ["t-0001"]);
  });

  it("persists host probes without rewriting business progress or timing out a live agent", () => {
    const cwd = makeProject();
    seedQueued(cwd, 1, { description: "build the Android target", prompt: "build the Android target" });
    reserveNext(cwd, { capacity: 1, host: "codex", now: at(10) });
    observeCodexReservation(cwd, "t-0001", "agent-build", at(15));
    bindAgent(cwd, "t-0001", { agentId: "agent-build", host: "codex", now: at(20) });

    const first = reportAgentProbe(cwd, "t-0001", {
      agentId: "agent-build", state: "running", activity: "status", now: at(300_000),
    });
    assert.equal(first.status, "running");
    assert.equal(first.progress, null);
    assert.equal(first.liveness?.state, "running");
    assert.equal(first.liveness?.sequence, 2);
    assert.ok(first.history.some((entry) => entry.event === "agent_probe" && entry.state === "running"));
    expectDispatchError(
      () => finishAgent(cwd, "t-0001", {
        status: "timed_out", probeSequence: first.liveness?.sequence, now: at(600_000),
      }),
      "TIMEOUT_REQUIRES_NOT_FOUND_PROBE",
    );
    assert.equal(readTicket(cwd, "t-0001").status, "running");

    const heartbeat = reportAgentProbe(cwd, "t-0001", {
      agentId: "agent-build", state: "running", activity: "heartbeat", now: at(600_000),
    });
    assert.equal(heartbeat.liveness?.sequence, 3);
    assert.equal(heartbeat.progress, null);
    assert.deepEqual(dispatchSnapshot(cwd, { capacity: 1, now: at(659_999) }).probe_due, []);
    assert.deepEqual(dispatchSnapshot(cwd, { capacity: 1, now: at(660_000) }).probe_due, ["t-0001"]);
  });
});
