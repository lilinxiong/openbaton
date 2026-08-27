import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deferDispatch, dispatchSnapshot, reserveNext } from "../src/lib/dispatch.js";
import {
  availabilityForRoute,
  markRouteExhausted,
} from "../src/lib/model-availability.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
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
  it("applies durable route exhaustion to every tree using the host/profile route", async () => withHome(async (home) => {
    const cwd = newWorkspace();
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "quota-tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "quota-tree-b" });
    setup(cwd, treeA);
    const ticketA = queuedTicket(cwd, treeA, 0);
    const ticketB = queuedTicket(cwd, treeB, 1);

    markRouteExhausted(cwd, { host: HOST, routeId: ROUTE }, {
      reason: "MODEL_QUOTA_EXHAUSTED",
      resetAt: "2026-09-01T00:00:00.000Z",
      now: "2026-08-27T00:01:00.000Z",
      env: treeA,
    });
    const stateA = availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:02:00.000Z", treeA);
    const stateB = availabilityForRoute(cwd, { host: HOST, routeId: ROUTE }, "2026-08-27T00:02:00.000Z", treeB);
    assert.equal(stateA.status, "exhausted");
    assert.equal(stateB.status, "exhausted");
    assert.equal(stateA.account_scope, stateB.account_scope);
    assert.equal(stateA.reset_at, "2026-09-01T00:00:00.000Z");

    const blockedA = await reserveNext(cwd, {
      capacity: 2,
      limit: 1,
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
    assert.deepEqual(blockedB.reserved, []);
    assert.deepEqual(blockedA.blocked.map((item) => item.code), ["MODEL_QUOTA_EXHAUSTED"]);
    assert.deepEqual(blockedB.blocked.map((item) => item.code), ["MODEL_QUOTA_EXHAUSTED"]);
    assert.equal(readSpawn(cwd, ticketA.id, treeA).status, "errored");
    assert.equal(readSpawn(cwd, ticketB.id, treeB).status, "errored");
    assert.equal(dispatchSnapshot(cwd, { capacity: 2, host: HOST, env: treeA }).active, 0);
    assert.equal(dispatchSnapshot(cwd, { capacity: 2, host: HOST, env: treeB }).active, 0);
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
});
