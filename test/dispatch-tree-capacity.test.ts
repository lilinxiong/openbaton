import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { dispatchSnapshot, releaseAgent, reserveNext } from "../src/lib/dispatch.js";
import { buildSpawnTicket, nextSpawnId, readSpawn, writeSpawn, type SpawnTicket } from "../src/lib/spawn.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";

const HOST = "beta";
const ROUTE = `${HOST}/default`;
const CAPACITY = 3;

function newCwd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function selection() {
  return {
    host: HOST,
    proposal_id: "proposal-tree-capacity",
    approval_id: "approval-tree-capacity",
    approved_at: "2026-08-27T00:00:00.000Z",
    confirmed_by: "baton-recommendation" as const,
    catalog_fingerprint: "tree-capacity-catalog",
    recommended_model_id: ROUTE,
    selected_model_id: ROUTE,
    changed_by_user: false,
  };
}

function prepareDispatch(cwd: string, env: NodeJS.ProcessEnv): void {
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

function createTicket(
  cwd: string,
  env: NodeJS.ProcessEnv,
  status: "queued" | "dispatching" | "completed",
  ordinalTime: number,
  {
    depth = 1,
    parentTicketId,
  }: { depth?: number; parentTicketId?: string } = {},
): SpawnTicket {
  const createdAt = new Date(Date.parse("2026-08-27T00:00:00.000Z") + ordinalTime * 1_000).toISOString();
  const id = nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    cwd,
    env,
    id,
    description: "tree capacity test",
    prompt: "tree capacity test",
    modelId: ROUTE,
    routeId: ROUTE,
    taskKind: "concrete",
    selection: selection(),
    targetHost: HOST,
    now: createdAt,
  });
  const receipt = buildReadOnlyReceipt({
    ticketId: id,
    card: { id: ROUTE, strengths: "fixture", route_id: ROUTE, provider: HOST },
    issuedAt: createdAt,
    selection: ticket.selection,
    host: HOST,
  });
  ticket.receipt_id = receipt.receipt_id;
  // These fields are intentionally only test metadata: dispatch capacity is
  // keyed by session_uid, so direct and nested descendants must count alike.
  ticket.agent_tree_depth = depth;
  if (parentTicketId) ticket.parent_ticket_id = parentTicketId;
  if (status !== "queued") {
    ticket.status = status;
    ticket.dispatch_host = HOST;
    ticket.dispatch_requested_at = createdAt;
    ticket.attempt = 1;
    ticket.reservation_id = `reservation-${id}`;
    ticket.history.push({ event: "dispatch_reserved", at: createdAt });
  }
  if (status === "completed") {
    ticket.execution_handle = { kind: "beta-session", value: `worker-${id}`, source: "manual" };
    ticket.host = HOST;
    ticket.started_at = createdAt;
    ticket.finished_at = createdAt;
    ticket.conclusion = "completed for capacity test";
    ticket.history.push({ event: "agent_bound", at: createdAt });
    ticket.history.push({ event: "agent_completed", at: createdAt });
  }
  writeReceipt(cwd, receipt, env);
  writeSpawn(cwd, ticket, env);
  return ticket;
}

describe("dispatch tree capacity", () => {
  it("lets a second tree reserve when the first tree is full", async () => withHome(async (home) => {
    const cwd = newCwd("baton-dispatch-tree-independent-");
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "tree-b" });
    prepareDispatch(cwd, treeA);
    const activeA = [0, 1, 2].map((offset) => createTicket(cwd, treeA, "dispatching", offset));
    const queuedB = createTicket(cwd, treeB, "queued", 10);

    const result = await reserveNext(cwd, { capacity: CAPACITY, host: HOST, now: "2026-08-27T00:01:00.000Z", env: treeB });
    assert.deepEqual(result.reserved.map((item) => item.ticket_id), [queuedB.id]);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeA }).active, CAPACITY);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeA }).available, 0);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeB }).active, 1);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeB }).available, CAPACITY - 1);
    assert.deepEqual(activeA.map((ticket) => readSpawn(cwd, ticket.id, treeA).status), ["dispatching", "dispatching", "dispatching"]);
  }));

  it("keeps a fourth ticket queued only in its full tree", async () => withHome(async (home) => {
    const cwd = newCwd("baton-dispatch-tree-queue-");
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "tree-b" });
    prepareDispatch(cwd, treeA);
    [0, 1, 2].forEach((offset) => createTicket(cwd, treeA, "dispatching", offset));
    const queuedA = createTicket(cwd, treeA, "queued", 3);
    const activeB = createTicket(cwd, treeB, "dispatching", 4);
    const queuedB = createTicket(cwd, treeB, "queued", 5);

    const result = await reserveNext(cwd, { capacity: CAPACITY, host: HOST, now: "2026-08-27T00:01:00.000Z", env: treeA });
    assert.deepEqual(result.reserved, []);
    assert.deepEqual(result.snapshot.queued, [queuedA.id]);
    assert.equal(readSpawn(cwd, queuedA.id, treeA).status, "queued");
    assert.equal(readSpawn(cwd, queuedB.id, treeB).status, "queued");
    assert.deepEqual(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeB }).queued, [queuedB.id]);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeB }).active, 1);
    assert.equal(readSpawn(cwd, activeB.id, treeB).status, "dispatching");
  }));

  it("refills the originating tree after confirmed release", async () => withHome(async (home) => {
    const cwd = newCwd("baton-dispatch-tree-refill-");
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "tree-b" });
    prepareDispatch(cwd, treeA);
    [0, 1].forEach((offset) => createTicket(cwd, treeA, "dispatching", offset));
    const terminalA = createTicket(cwd, treeA, "completed", 2);
    const queuedA = createTicket(cwd, treeA, "queued", 3);
    const activeB = createTicket(cwd, treeB, "dispatching", 4);
    const queuedB = createTicket(cwd, treeB, "queued", 5);

    const handle = terminalA.execution_handle!;
    const released = releaseAgent(cwd, terminalA.id, { executionHandle: handle, host: HOST, env: treeA, now: "2026-08-27T00:02:00.000Z" });
    assert.ok(released.slot_released_at);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeA }).active, 2);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeA }).available, 1);

    const refill = await reserveNext(cwd, { capacity: CAPACITY, host: HOST, now: "2026-08-27T00:03:00.000Z", env: treeA });
    assert.deepEqual(refill.reserved.map((item) => item.ticket_id), [queuedA.id]);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeA }).active, CAPACITY);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeA }).available, 0);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeB }).active, 1);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeB }).available, CAPACITY - 1);
    assert.equal(readSpawn(cwd, activeB.id, treeB).status, "dispatching");
    assert.equal(readSpawn(cwd, queuedB.id, treeB).status, "queued");
  }));

  it("counts direct and nested descendants in one tree limit", async () => withHome(async (home) => {
    const cwd = newCwd("baton-dispatch-tree-descendants-");
    const treeA = fakeEnv(home, { BATON_SESSION_ID: "tree-a" });
    const treeB = fakeEnv(home, { BATON_SESSION_ID: "tree-b" });
    prepareDispatch(cwd, treeA);
    const directA = createTicket(cwd, treeA, "dispatching", 0, { depth: 1 });
    const directB = createTicket(cwd, treeA, "dispatching", 1, { depth: 1 });
    const nested = createTicket(cwd, treeA, "dispatching", 2, { depth: 2, parentTicketId: directA.id });
    const queued = createTicket(cwd, treeA, "queued", 3, { depth: 3, parentTicketId: nested.id });
    const activeB = createTicket(cwd, treeB, "dispatching", 4);

    const result = await reserveNext(cwd, { capacity: CAPACITY, host: HOST, now: "2026-08-27T00:04:00.000Z", env: treeA });
    assert.deepEqual(result.reserved, []);
    assert.equal(result.snapshot.active, CAPACITY);
    assert.equal(result.snapshot.available, 0);
    assert.deepEqual(result.snapshot.queued, [queued.id]);
    assert.equal(dispatchSnapshot(cwd, { capacity: CAPACITY, host: HOST, env: treeB }).active, 1);
    assert.equal(readSpawn(cwd, activeB.id, treeB).status, "dispatching");
    assert.deepEqual(
      [directA, directB, nested].map((ticket) => readSpawn(cwd, ticket.id, treeA).session_uid),
      [directA.session_uid, directA.session_uid, directA.session_uid],
    );
  }));
});
