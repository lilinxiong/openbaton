import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindAgent,
  deferDispatch,
  dispatchSnapshot,
  finishAgent,
  releaseAgent,
  reportAgentProbe,
  reserveNext,
} from "../src/lib/dispatch.js";
import { createApplyRun, readApplyRun } from "../src/lib/apply-run.js";
import { materializeCompiledApplyFrontier } from "../src/lib/compiled-apply.js";
import { spawnsDir } from "../src/lib/paths.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { buildSpawnTicket, nextSpawnId, readSpawn, writeSpawn, type SpawnTicket } from "../src/lib/spawn.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";
import type { ModelSelectionApproval } from "../src/types.js";

const ROUTE = "alpha/lifecycle";
const HOST = "alpha";

function newCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-tree-lifecycle-"));
}

function selection(): ModelSelectionApproval {
  return {
    host: HOST,
    proposal_id: "proposal-tree-lifecycle",
    approval_id: "approval-tree-lifecycle",
    approved_at: "2026-08-27T00:00:00.000Z",
    confirmed_by: "baton-recommendation",
    catalog_fingerprint: "tree-lifecycle-catalog",
    recommended_model_id: ROUTE,
    selected_model_id: ROUTE,
    changed_by_user: false,
  };
}

/** Configure a real route so reserveNext exercises the normal validation path. */
function configureLifecycleRoute(cwd: string, env: NodeJS.ProcessEnv): void {
  configureCli(cwd, env, HOST, [ROUTE]);
  publishRouteSnapshot(cwd, {
    models: [{
      id: ROUTE,
      route_id: ROUTE,
      provider: HOST,
      supportedReasoningEfforts: [],
    }],
  }, new Date("2026-08-27T00:00:00.000Z"), { cli: HOST, host: HOST, env });
}

function queuedTicket(cwd: string, env: NodeJS.ProcessEnv): SpawnTicket {
  const approved = selection();
  const id = nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    cwd,
    env,
    id,
    description: "tree lifecycle regression",
    prompt: "tree lifecycle regression",
    modelId: ROUTE,
    routeId: ROUTE,
    taskKind: "concrete",
    selection: approved,
    targetHost: HOST,
  });
  const receipt = buildReadOnlyReceipt({
    ticketId: id,
    card: { id: ROUTE, strengths: "lifecycle", route_id: ROUTE, provider: HOST },
    issuedAt: ticket.created_at,
    selection: approved,
    host: HOST,
  });
  ticket.receipt_id = receipt.receipt_id;
  writeReceipt(cwd, receipt, env);
  writeSpawn(cwd, ticket, env);
  return ticket;
}

async function reservedAndBound(cwd: string, env: NodeJS.ProcessEnv): Promise<{ ticket: SpawnTicket; handle: { kind: "alpha-task"; value: string; source: "native-return" } }> {
  const ticket = queuedTicket(cwd, env);
  const reserved = await reserveNext(cwd, { capacity: 1, host: HOST, limit: 1, env });
  assert.deepEqual(reserved.reserved.map((item) => item.ticket_id), [ticket.id]);
  const handle = { kind: "alpha-task" as const, value: `lifecycle-${ticket.session_ordinal}`, source: "native-return" as const };
  bindAgent(cwd, ticket.id, { executionHandle: handle, host: HOST, env });
  return { ticket, handle };
}

describe("dispatch tree slot lifecycle", () => {
  it("holds a reservation before native bind", async () => withHome(async (home) => {
    const cwd = newCwd();
    const env = fakeEnv(home, { BATON_SESSION_ID: "tree-reservation-before-bind" });
    try {
      configureLifecycleRoute(cwd, env);
      const ticket = queuedTicket(cwd, env);
      const reserved = await reserveNext(cwd, { capacity: 1, host: HOST, limit: 1, env });

      assert.equal(reserved.reserved.length, 1);
      assert.equal(reserved.reserved[0]?.ticket_id, ticket.id);
      assert.equal(reserved.reserved[0]?.attempt, 1);
      assert.equal(readSpawn(cwd, ticket.id, env).status, "dispatching");
      assert.equal(dispatchSnapshot(cwd, { capacity: 1, host: HOST, env }).active, 1);
      assert.equal(dispatchSnapshot(cwd, { capacity: 1, host: HOST, env }).available, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("keeps every terminal state occupied until confirmed release", async () => withHome(async (home) => {
    for (const terminal of ["completed", "errored", "closed", "timed_out"] as const) {
      const cwd = newCwd();
      const env = fakeEnv(home, { BATON_SESSION_ID: `tree-terminal-${terminal}` });
      try {
        configureLifecycleRoute(cwd, env);
        const { ticket, handle } = await reservedAndBound(cwd, env);
        let finished: SpawnTicket;
        if (terminal === "timed_out") {
          const probed = reportAgentProbe(cwd, ticket.id, {
            executionHandle: handle,
            state: "not_found",
            host: HOST,
            env,
          });
          finished = await finishAgent(cwd, ticket.id, {
            status: terminal,
            probeSequence: probed.liveness!.sequence,
            host: HOST,
            env,
          });
        } else {
          finished = await finishAgent(cwd, ticket.id, {
            status: terminal,
            conclusion: terminal === "completed" ? "terminal result" : null,
            errorCode: terminal === "completed" ? null : `AGENT_${terminal.toUpperCase()}`,
            errorMessage: terminal === "completed" ? null : `terminal ${terminal}`,
            host: HOST,
            env,
          });
        }
        assert.equal(finished.status, terminal);
        const awaiting = dispatchSnapshot(cwd, { capacity: 1, host: HOST, env });
        assert.equal(awaiting.active, 1, `${terminal} must retain its slot`);
        assert.equal(awaiting.available, 0, `${terminal} must not refill early`);
        assert.deepEqual(awaiting.awaiting_release.map((item) => item.ticket_id), [ticket.id]);

        const released = releaseAgent(cwd, ticket.id, { executionHandle: handle, host: HOST, env });
        assert.ok(released.slot_released_at);
        const available = dispatchSnapshot(cwd, { capacity: 1, host: HOST, env });
        assert.equal(available.active, 0, `${terminal} release returns its slot`);
        assert.equal(available.available, 1, `${terminal} release returns one slot`);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  }));

  it("makes confirmed release idempotent without adding another release event", async () => withHome(async (home) => {
    const cwd = newCwd();
    const env = fakeEnv(home, { BATON_SESSION_ID: "tree-release-idempotent" });
    try {
      configureLifecycleRoute(cwd, env);
      const { ticket, handle } = await reservedAndBound(cwd, env);
      await finishAgent(cwd, ticket.id, { status: "completed", conclusion: "done", host: HOST, env });
      const first = releaseAgent(cwd, ticket.id, { executionHandle: handle, host: HOST, env });
      const firstHistory = first.history.filter((entry) => entry.event === "agent_slot_released");
      const second = releaseAgent(cwd, ticket.id, { executionHandle: handle, host: HOST, env });

      assert.equal(second.slot_released_at, first.slot_released_at);
      assert.deepEqual(
        second.history.filter((entry) => entry.event === "agent_slot_released"),
        firstHistory,
      );
      assert.equal(dispatchSnapshot(cwd, { capacity: 1, host: HOST, env }).active, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("does not count historical released tickets against a new reservation", async () => withHome(async (home) => {
    const cwd = newCwd();
    const env = fakeEnv(home, { BATON_SESSION_ID: "tree-released-history" });
    try {
      configureLifecycleRoute(cwd, env);
      for (let index = 0; index < 3; index += 1) {
        const { ticket, handle } = await reservedAndBound(cwd, env);
        await finishAgent(cwd, ticket.id, { status: "completed", conclusion: `history ${index}`, host: HOST, env });
        releaseAgent(cwd, ticket.id, { executionHandle: handle, host: HOST, env });
      }
      const next = queuedTicket(cwd, env);
      const before = dispatchSnapshot(cwd, { capacity: 1, host: HOST, env });
      assert.equal(before.active, 0);
      assert.equal(before.available, 1);
      const reserved = await reserveNext(cwd, { capacity: 1, host: HOST, limit: 1, env });
      assert.deepEqual(reserved.reserved.map((item) => item.ticket_id), [next.id]);
      assert.equal(dispatchSnapshot(cwd, { capacity: 1, host: HOST, env }).active, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("defers native backpressure without changing route or attempt state", async () => withHome(async (home) => {
    const cwd = newCwd();
    const env = fakeEnv(home, { BATON_SESSION_ID: "tree-native-backpressure" });
    try {
      configureLifecycleRoute(cwd, env);
      const ticket = queuedTicket(cwd, env);
      const before = readSpawn(cwd, ticket.id, env);
      const reserved = await reserveNext(cwd, { capacity: 1, host: HOST, limit: 1, env });
      assert.equal(reserved.reserved[0]?.ticket_id, ticket.id);
      const deferred = deferDispatch(cwd, ticket.id, {
        code: "AGENT_LIMIT_REACHED",
        message: "native tree is at capacity",
        host: HOST,
        env,
      });

      assert.equal(deferred.status, "queued");
      assert.equal(deferred.attempt, before.attempt, "backpressure must not consume an attempt");
      assert.equal(deferred.route_id, before.route_id);
      assert.equal(deferred.model_id, before.model_id);
      assert.deepEqual(deferred.selection, before.selection);
      assert.equal(deferred.session_uid, before.session_uid);
      assert.equal(dispatchSnapshot(cwd, { capacity: 1, host: HOST, env }).active, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("keeps compiled verification parent-owned and never synthesizes safety acceptance", async () => withHome(async (home) => {
    const cwd = newCwd();
    const env = fakeEnv(home, { BATON_SESSION_ID: "tree-compiled-parent-owned" });
    try {
      configureLifecycleRoute(cwd, env);
      const tasksPath = path.join(cwd, "openspec", "changes", "demo", "tasks.md");
      fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
      const beforeTasks = "## Work\n\n- [ ] 1.1 Verify\n";
      fs.writeFileSync(tasksPath, beforeTasks);
      const plan = {
        schema_version: 1 as const,
        identity: { plan_id: "compiled-parent-owned", change_id: "demo" },
        source_snapshot: { repo_root: cwd, revision: "head", tasks_path: tasksPath },
        selected_tasks: ["1.1"],
        units: [{ id: "u1", mode: "verification-only" as const, task_ids: ["1.1"], description: "verify parent-owned", prompt: "verify parent-owned", verification: ["read"] }],
      };
      createApplyRun({ cwd, env, runId: "compiled-parent-owned", host: HOST, plan });
      const card = { id: ROUTE, route_id: ROUTE, provider: HOST, strengths: "verification", native: true, tool: true };
      const materialized = await materializeCompiledApplyFrontier({
        cwd, env, host: HOST, runId: "compiled-parent-owned", capacity: 1,
        cards: [card], automaticCards: [card], codingModels: [ROUTE],
      });
      assert.equal(materialized.materialized.length, 1);
      const ticket = materialized.materialized[0]!;
      ticket.openspec = { tasks_path: tasksPath, number: "1.1" };
      writeSpawn(cwd, ticket, env);
      const reserved = await reserveNext(cwd, { capacity: 1, host: HOST, limit: 1, env });
      assert.deepEqual(reserved.reserved.map((item) => item.ticket_id), [ticket.id]);
      const bound = bindAgent(cwd, ticket.id, {
        executionHandle: { kind: "alpha-task", value: "compiled-parent-owned", source: "native-return" },
        host: HOST, env,
      });
      const finished = await finishAgent(cwd, bound.id, { status: "completed", conclusion: "verification result", host: HOST, env });
      assert.equal(finished.status, "completed");
      assert.equal(finished.safety_verdict, undefined);
      assert.equal(finished.compiled_acceptance?.accepted, true);
      assert.equal(fs.readFileSync(tasksPath, "utf8"), beforeTasks);
      assert.equal(readApplyRun(cwd, "compiled-parent-owned", { env }).unit_state.u1?.status, "accepted");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("rejects a tampered compiled lineage before native bind", async () => withHome(async (home) => {
    const cwd = newCwd();
    const env = fakeEnv(home, { BATON_SESSION_ID: "tree-compiled-lineage-tamper" });
    try {
      configureLifecycleRoute(cwd, env);
      const plan = {
        schema_version: 1 as const,
        identity: { plan_id: "compiled-lineage-tamper", change_id: "demo" },
        source_snapshot: { repo_root: cwd, revision: "head" },
        selected_tasks: ["1.1"],
        units: [{ id: "u1", mode: "verification-only" as const, task_ids: ["1.1"], description: "verify tamper", prompt: "verify tamper", verification: ["read"] }],
      };
      createApplyRun({ cwd, env, runId: "compiled-lineage-tamper", host: HOST, plan });
      const card = { id: ROUTE, route_id: ROUTE, provider: HOST, strengths: "verification", native: true, tool: true };
      const materialized = await materializeCompiledApplyFrontier({
        cwd, env, host: HOST, runId: "compiled-lineage-tamper", capacity: 1,
        cards: [card], automaticCards: [card], codingModels: [ROUTE],
      });
      const ticket = materialized.materialized[0]!;
      const file = path.join(spawnsDir(cwd, env), `${ticket.id}.json`);
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
      raw.compiled_apply_lineage.plan_fingerprint = "tampered-fingerprint";
      raw.work_unit.plan_fingerprint = "tampered-fingerprint";
      fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
      const blocked = await reserveNext(cwd, { capacity: 1, host: HOST, limit: 1, env });
      assert.equal(blocked.reserved.length, 0);
      assert.equal(blocked.blocked[0]?.code, "COMPILED_LINEAGE_MISMATCH");
      assert.equal(readSpawn(cwd, ticket.id, env).status, "errored");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));
});
