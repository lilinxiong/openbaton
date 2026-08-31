import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindAgent, deferDispatch, dispatchSnapshot, finishAgent, reserveNext } from "../src/lib/dispatch.js";
import {
  availabilityForRoute,
  markRouteExhausted,
  markRouteAvailable,
} from "../src/lib/model-availability.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { modelAvailabilityPath } from "../src/lib/paths.js";
import { buildSpawnTicket, nextSpawnId, readSpawn, writeSpawn, type SpawnTicket } from "../src/lib/spawn.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";

const HOST = "alpha";
const ROUTE = "alpha/quota-route";

function newWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-cross-tree-quota-"));
}

function selection() {
  return {
    host: HOST,
    proposal_id: "proposal-cross-tree-quota",
    approval_id: "approval-cross-tree-quota",
    approved_at: "2026-08-27T00:00:00.000Z",
    confirmed_by: "baton-recommendation" as const,
    catalog_fingerprint: "cross-tree-quota-catalog",
    recommended_model_id: ROUTE,
    selected_model_id: ROUTE,
    changed_by_user: false,
  };
}

function setup(cwd: string, env: NodeJS.ProcessEnv): void {
  configureCli(cwd, env, HOST, [ROUTE]);
  publishRouteSnapshot(cwd, {
    models: [{
      id: ROUTE,
      route_id: ROUTE,
      provider: HOST,
      supportedReasoningEfforts: ["low"],
      defaultReasoningEffort: "low",
    }],
  }, new Date("2026-08-27T00:00:00.000Z"), { cli: HOST, host: HOST, env });
}

function queuedTicket(cwd: string, env: NodeJS.ProcessEnv, ordinal: number): SpawnTicket {
  const now = new Date(Date.parse("2026-08-27T00:00:00.000Z") + ordinal * 1_000).toISOString();
  const id = nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    cwd,
    env,
    id,
    description: "cross-tree quota test",
    prompt: "cross-tree quota test",
    modelId: ROUTE,
    routeId: ROUTE,
    taskKind: "concrete",
    selection: selection(),
    targetHost: HOST,
    now,
  });
  const receipt = buildReadOnlyReceipt({
    ticketId: id,
    card: { id: ROUTE, strengths: "fixture", route_id: ROUTE, provider: HOST },
    issuedAt: now,
    selection: ticket.selection,
    host: HOST,
  });
  ticket.receipt_id = receipt.receipt_id;
  writeReceipt(cwd, receipt, env);
  writeSpawn(cwd, ticket, env);
  return ticket;
}

describe("cross-tree host/profile quota boundaries", () => {
  it("isolates durable route exhaustion to one session while blocking that session", async () => withHome(async (home) => {
    const cwd = newWorkspace();
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "quota-tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "quota-tree-b" });
    setup(cwd, treeA);
    const ticketA = queuedTicket(cwd, treeA, 0);
    const ticketA2 = queuedTicket(cwd, treeA, 1);
    const ticketB = queuedTicket(cwd, treeB, 2);

    markRouteExhausted(cwd, { host: HOST, routeId: ROUTE }, {
      reason: "MODEL_QUOTA_EXHAUSTED",
      resetAt: "2026-09-01T00:00:00.000Z",
      now: "2026-08-27T00:01:00.000Z",
      env: treeA,
    });
    const stateA = availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:02:00.000Z", treeA);
    const stateB = availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:02:00.000Z", treeB);
    assert.equal(stateA.status, "exhausted");
    assert.equal(stateB.status, "available");
    assert.notEqual(stateA.session_uid, stateB.session_uid);
    assert.equal(stateA.host, stateB.host);
    assert.equal(stateA.route_id, stateB.route_id);
    assert.equal(stateA.reset_at, "2026-09-01T00:00:00.000Z");

    const blockedA = await reserveNext(cwd, {
      capacity: 2,
      limit: 2,
      host: HOST,
      now: "2026-08-27T00:03:00.000Z",
      env: treeA,
    });
    const blockedB = await reserveNext(cwd, {
      capacity: 2,
      limit: 1,
      host: HOST,
      now: "2026-08-27T00:04:00.000Z",
      env: treeB,
    });

    assert.deepEqual(blockedA.reserved, []);
    assert.deepEqual(blockedA.blocked.map((item) => item.code), ["MODEL_QUOTA_EXHAUSTED", "MODEL_QUOTA_EXHAUSTED"]);
    assert.deepEqual(blockedB.reserved.map((item) => item.ticket_id), [ticketB.id]);
    assert.deepEqual(blockedB.blocked, []);
    assert.equal(readSpawn(cwd, ticketA.id, treeA).status, "errored");
    assert.equal(readSpawn(cwd, ticketA2.id, treeA).status, "errored");
    assert.equal(readSpawn(cwd, ticketB.id, treeB).status, "dispatching");
    assert.equal(dispatchSnapshot(cwd, { capacity: 2, host: HOST, env: treeA }).active, 0);
    assert.equal(dispatchSnapshot(cwd, { capacity: 2, host: HOST, env: treeB }).active, 1);
  }));

  it("does not gate on schema-1 host-profile evidence and recovers sessions independently", async () => withHome(async (home) => {
    const cwd = newWorkspace();
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "legacy-tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "legacy-tree-b" });
    const file = modelAvailabilityPath(cwd, treeA);
    const legacy = {
      schema_version: 1,
      records: [{
        host: HOST,
        account_scope: "host-profile",
        route_id: ROUTE,
        status: "exhausted",
        reason: "MODEL_QUOTA_EXHAUSTED",
        observed_at: "2026-08-27T00:01:00.000Z",
        reset_at: "2026-09-01T00:00:00.000Z",
        next_probe_at: "2026-09-01T00:00:00.000Z",
        probe_attempts: 1,
        probe_lease_owner: null,
        probe_lease_until: null,
      }],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`);
    const before = fs.readFileSync(file, "utf8");

    assert.equal(availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:02:00.000Z", treeA).status, "available");
    assert.equal(fs.readFileSync(file, "utf8"), before, "reading legacy evidence must not rewrite it");

    markRouteExhausted(cwd, { host: HOST, routeId: ROUTE }, {
      reason: "MODEL_QUOTA_EXHAUSTED",
      resetAt: "2026-09-01T00:00:00.000Z",
      now: "2026-08-27T00:03:00.000Z",
      env: treeA,
    });
    assert.equal(availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:04:00.000Z", treeA).status, "exhausted");
    assert.equal(availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:04:00.000Z", treeB).status, "available");

    markRouteAvailable(cwd, { host: HOST, routeId: ROUTE }, { now: "2026-08-27T00:05:00.000Z", env: treeB });
    assert.equal(availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:06:00.000Z", treeA).status, "exhausted");
    markRouteAvailable(cwd, { host: HOST, routeId: ROUTE }, { now: "2026-08-27T00:07:00.000Z", env: treeA });
    assert.equal(availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:08:00.000Z", treeA).status, "available");
  }));

  it("keeps native AGENT_LIMIT_REACHED backpressure local to the originating tree", async () => withHome(async (home) => {
    const cwd = newWorkspace();
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "backpressure-tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "backpressure-tree-b" });
    setup(cwd, treeA);
    const ticketA = queuedTicket(cwd, treeA, 0);
    const ticketB = queuedTicket(cwd, treeB, 1);
    const treeBBefore = readSpawn(cwd, ticketB.id, treeB);

    const reservedA = await reserveNext(cwd, {
      capacity: 1,
      limit: 1,
      host: HOST,
      now: "2026-08-27T00:02:00.000Z",
      env: treeA,
    });
    assert.deepEqual(reservedA.reserved.map((item) => item.ticket_id), [ticketA.id]);
    const reservedSnapshotA = readSpawn(cwd, ticketA.id, treeA);
    const deferredA = deferDispatch(cwd, ticketA.id, {
      code: "AGENT_LIMIT_REACHED",
      message: "native root tree is at capacity",
      host: HOST,
      now: "2026-08-27T00:03:00.000Z",
      env: treeA,
    });

    assert.equal(deferredA.status, "queued");
    assert.equal(deferredA.attempt, 0);
    assert.equal(deferredA.route_id, reservedSnapshotA.route_id);
    assert.equal(deferredA.model_id, reservedSnapshotA.model_id);
    assert.equal(deferredA.session_uid, reservedSnapshotA.session_uid);
    assert.deepEqual(readSpawn(cwd, ticketB.id, treeB), treeBBefore);
    assert.equal(dispatchSnapshot(cwd, { capacity: 1, host: HOST, env: treeA }).active, 0);

    const reservedB = await reserveNext(cwd, {
      capacity: 1,
      limit: 1,
      host: HOST,
      now: "2026-08-27T00:04:00.000Z",
      env: treeB,
    });
    assert.deepEqual(reservedB.reserved.map((item) => item.ticket_id), [ticketB.id]);
    assert.equal(readSpawn(cwd, ticketA.id, treeA).status, "queued");
    assert.equal(readSpawn(cwd, ticketA.id, treeA).attempt, 0);
    assert.equal(dispatchSnapshot(cwd, { capacity: 1, host: HOST, env: treeB }).active, 1);
  }));

  it("does not cache a generic native execution failure as session uncallability", async () => withHome(async (home) => {
    const cwd = newWorkspace();
    const env = fakeEnv(home, { BATON_SESSION_ID: "generic-native-failure" });
    setup(cwd, env);
    const ticket = queuedTicket(cwd, env, 0);
    const reserved = await reserveNext(cwd, { capacity: 1, limit: 1, host: HOST, env });
    assert.deepEqual(reserved.reserved.map((item) => item.ticket_id), [ticket.id]);
    const bound = bindAgent(cwd, ticket.id, {
      executionHandle: { kind: "alpha-task", value: "generic-native-failure", source: "native-return" },
      host: HOST,
      env,
    });
    const finished = await finishAgent(cwd, bound.id, {
      status: "errored",
      errorCode: "MODEL_EXECUTION_FAILED",
      errorMessage: "native execution failed",
      host: HOST,
      env,
    });
    assert.equal(finished.successor_id, undefined);
    assert.equal(availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, new Date(), env).status, "available");
  }));
});
