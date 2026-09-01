import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindAgent,
  finishAgent,
  releaseAgent,
  reserveNext,
} from "../src/lib/dispatch.js";
import {
  buildReadOnlyReceipt,
  buildWriteReceipt,
  writeReceipt,
  type DelegationReceipt,
} from "../src/lib/receipt.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { captureBaseline } from "../src/lib/safety.js";
import { markRouteAvailable } from "../src/lib/model-availability.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { buildSpawnTicket, nextSpawnId, writeSpawn, type SpawnTicket } from "../src/lib/spawn.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";
import type { ModelSelectionApproval } from "../src/types.js";

const HOST = "alpha";
const ROUTE = "alpha/rolling";
const LINEAGE = {
  schema_version: 1 as const,
  run_id: "rolling-dispatch-run",
  unit_key: "rolling-dispatch-unit",
  unit_version: 4,
  unit_fingerprint: "a".repeat(64),
  task_keys: ["task-a", "task-b"],
  mode: "patch-only" as const,
};

function repositoryCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-dispatch-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "baton@test"]);
  git(["config", "user.name", "Baton Test"]);
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".baton/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-q", "-m", "baseline"]);
  return cwd;
}

function selection(): ModelSelectionApproval {
  return {
    host: HOST,
    proposal_id: "proposal-rolling-dispatch",
    approval_id: "approval-rolling-dispatch",
    approved_at: "2026-08-31T00:00:00.000Z",
    confirmed_by: "baton-recommendation",
    catalog_fingerprint: "rolling-dispatch-catalog",
    recommended_model_id: ROUTE,
    selected_model_id: ROUTE,
    changed_by_user: false,
  };
}

interface Fixture {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ticket: SpawnTicket;
  receipt: DelegationReceipt;
  handle: { kind: "alpha-task"; value: string; source: "native-return" };
}

function fixture(home: string, sessionId: string): Fixture {
  const cwd = repositoryCwd();
  const env = fakeEnv(home, { BATON_SESSION_ID: sessionId });
  configureCli(cwd, env, HOST, [ROUTE]);
  publishRouteSnapshot(cwd, {
    models: [{ id: ROUTE, route_id: ROUTE, provider: HOST, supportedReasoningEfforts: [] }],
  }, new Date("2026-08-31T00:00:00.000Z"), { cli: HOST, host: HOST, env });
  markRouteAvailable(cwd, { host: HOST, routeId: ROUTE }, {
    now: "2026-08-31T00:00:00.000Z",
    env,
  });
  const approved = selection();
  const ticket = buildSpawnTicket({
    cwd,
    env,
    id: nextSpawnId(cwd, "spn", env),
    description: "rolling dispatch artifact boundary",
    prompt: "rolling dispatch artifact boundary",
    modelId: ROUTE,
    routeId: ROUTE,
    taskKind: "concrete",
    selection: approved,
    targetHost: HOST,
    rollingUnitLineage: LINEAGE,
    deliverable: "the rolling dispatch",
    doneWhen: "the rolling dispatch is verified",
    readContext: ["src/lib/dispatch.ts"],
    writePaths: ["test/rolling-dispatch-lineage.test.ts"],
    allowedOperations: ["write"],
    completionCriteria: ["lineage remains exact"],
    permittedValidation: ["read"],
  });
  const readOnlyReceipt = buildReadOnlyReceipt({
    ticketId: ticket.id,
    card: { id: ROUTE, route_id: ROUTE, provider: HOST, strengths: "rolling" },
    issuedAt: ticket.created_at,
    selection: approved,
    host: HOST,
    rollingUnitLineage: LINEAGE,
  });
  // Patch-only rolling lineage requires write execution at the Receipt edge.
  const receipt = buildWriteReceipt({
    base: readOnlyReceipt,
    baseline: captureBaseline(cwd, new Date(ticket.created_at)),
    writeAllowlist: ["test/rolling-dispatch-lineage.test.ts"],
    allowedOperations: ["write"],
  });
  ticket.receipt_id = receipt.receipt_id;
  ticket.mode = "write";
  ticket.read_only = false;
  writeReceipt(cwd, receipt, env);
  writeSpawn(cwd, ticket, env);
  return { cwd, env, ticket, receipt, handle: { kind: "alpha-task", value: "rolling-dispatch-agent", source: "native-return" } };
}

function tamperReceipt(f: Fixture): void {
  const file = path.join(receiptsDir(f.cwd, f.env), `${f.receipt.receipt_id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
  raw.rolling_unit_lineage.unit_version = LINEAGE.unit_version + 1;
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

function rawTicket(f: Fixture): SpawnTicket {
  const file = path.join(spawnsDir(f.cwd, f.env), `${f.ticket.id}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as SpawnTicket;
}

function assertUnchanged(before: SpawnTicket, after: SpawnTicket): void {
  assert.equal(after.status, before.status);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.slot_released_at, before.slot_released_at);
}

describe("rolling dispatch artifact boundaries", () => {
  it("reserves the persisted lineage and binds without rolling-run state", async () => withHome(async (home) => {
    const f = fixture(home, "rolling-dispatch-reserve-bind");
    try {
      const reserved = await reserveNext(f.cwd, { capacity: 1, host: HOST, limit: 1, env: f.env });
      assert.deepEqual(reserved.reserved[0]?.rolling_unit_lineage, LINEAGE);
      assert.deepEqual(reserved.reserved[0]?.selection, selection());
      const unrelated = { append_sequence: 0, delta: { delta_id: "unrelated-delta", prepared_from_append_sequence: 0 } };
      unrelated.append_sequence = 99;
      unrelated.delta.prepared_from_append_sequence = 99;
      const bound = bindAgent(f.cwd, f.ticket.id, { executionHandle: f.handle, host: HOST, env: f.env });
      assert.equal(bound.status, "running");
    } finally {
      fs.rmSync(f.cwd, { recursive: true, force: true });
    }
  }));

  it("rejects Receipt drift before every mutation that grants or completes work", async () => withHome(async (home) => {
    const boundaries = ["bind", "finish-completed", "finish-errored-pre-bind", "finish-closed", "finish-timed-out"] as const;
    for (const [index, boundary] of boundaries.entries()) {
      const f = fixture(home, `rolling-dispatch-drift-${index}`);
      try {
        await reserveNext(f.cwd, { capacity: 1, host: HOST, limit: 1, env: f.env });
        if (["finish-completed", "finish-closed", "finish-timed-out"].includes(boundary)) {
          bindAgent(f.cwd, f.ticket.id, { executionHandle: f.handle, host: HOST, env: f.env });
        }
        const before = rawTicket(f);
        tamperReceipt(f);
        const reject = (error: unknown) => (error as { code?: string }).code === "ROLLING_LINEAGE_MISMATCH";
        if (boundary === "bind") assert.throws(() => bindAgent(f.cwd, f.ticket.id, { executionHandle: f.handle, host: HOST, env: f.env }), reject);
        else await assert.rejects(() => finishAgent(f.cwd, f.ticket.id, {
          status: boundary === "finish-completed" ? "completed" : boundary === "finish-timed-out" ? "timed_out" : boundary === "finish-errored-pre-bind" ? "errored" : "closed",
          conclusion: boundary === "finish-completed" ? "done" : null,
          errorCode: boundary === "finish-completed" ? null : "AGENT_FAILURE",
          errorMessage: boundary === "finish-completed" ? null : "failure",
          host: HOST,
          env: f.env,
        }), reject);
        assertUnchanged(before, rawTicket(f));
      } finally {
        fs.rmSync(f.cwd, { recursive: true, force: true });
      }
    }
  }));

  it("contains a corrupt rolling Receipt and reserves the next healthy ticket", async () => withHome(async (home) => {
    const f = fixture(home, "rolling-dispatch-corrupt-containment");
    try {
      const healthy = buildSpawnTicket({
        cwd: f.cwd,
        env: f.env,
        id: nextSpawnId(f.cwd, "spn", f.env),
        description: "healthy independent ticket",
        prompt: "healthy independent ticket",
        modelId: ROUTE,
        routeId: ROUTE,
        taskKind: "concrete",
        selection: selection(),
        targetHost: HOST,
      });
      const healthyReceipt = buildReadOnlyReceipt({
        ticketId: healthy.id,
        card: { id: ROUTE, route_id: ROUTE, provider: HOST, strengths: "healthy" },
        issuedAt: healthy.created_at,
        selection: selection(),
        host: HOST,
      });
      healthy.receipt_id = healthyReceipt.receipt_id;
      writeReceipt(f.cwd, healthyReceipt, f.env);
      writeSpawn(f.cwd, healthy, f.env);
      tamperReceipt(f);

      const result = await reserveNext(f.cwd, { capacity: 1, host: HOST, limit: 1, env: f.env });
      assert.equal(result.blocked.find((item) => item.ticket_id === f.ticket.id)?.code, "ROLLING_LINEAGE_MISMATCH");
      assert.equal(result.reserved[0]?.ticket_id, healthy.id);
      assert.equal(rawTicket(f).status, "errored");
      assert.equal(rawTicket(f).error?.code, "ROLLING_LINEAGE_MISMATCH");
    } finally {
      fs.rmSync(f.cwd, { recursive: true, force: true });
    }
  }));

  it("releases terminal capacity despite Receipt drift and keeps retries idempotent", async () => withHome(async (home) => {
    const f = fixture(home, "rolling-dispatch-release-cleanup");
    try {
      await reserveNext(f.cwd, { capacity: 1, host: HOST, limit: 1, env: f.env });
      bindAgent(f.cwd, f.ticket.id, { executionHandle: f.handle, host: HOST, env: f.env });
      await finishAgent(f.cwd, f.ticket.id, { status: "closed", errorCode: "AGENT_CLOSED", errorMessage: "closed", host: HOST, env: f.env });
      tamperReceipt(f);
      const released = releaseAgent(f.cwd, f.ticket.id, { executionHandle: f.handle, host: HOST, env: f.env });
      assert.ok(released.slot_released_at);
      const retry = releaseAgent(f.cwd, f.ticket.id, { host: HOST, env: f.env });
      assert.equal(retry.slot_released_at, released.slot_released_at);
    } finally {
      fs.rmSync(f.cwd, { recursive: true, force: true });
    }
  }));

  it("keeps legacy manual reservations and compiled schema-2 tickets compatible", async () => withHome(async (home) => {
    const f = fixture(home, "rolling-dispatch-compatibility");
    try {
      const manual = buildSpawnTicket({ cwd: f.cwd, env: f.env, id: nextSpawnId(f.cwd, "spn", f.env), description: "legacy manual", prompt: "legacy manual", modelId: ROUTE, routeId: ROUTE, taskKind: "concrete", selection: selection(), targetHost: HOST });
      const manualReceipt = buildReadOnlyReceipt({ ticketId: manual.id, card: { id: ROUTE, route_id: ROUTE, provider: HOST, strengths: "legacy" }, issuedAt: manual.created_at, selection: selection(), host: HOST });
      manual.receipt_id = manualReceipt.receipt_id;
      writeReceipt(f.cwd, manualReceipt, f.env);
      writeSpawn(f.cwd, manual, f.env);
      const reserved = await reserveNext(f.cwd, { capacity: 2, host: HOST, limit: 2, env: f.env });
      assert.ok(reserved.reserved.some((item) => item.ticket_id === manual.id));
      assert.equal(manual.work_unit.schema_version, 1);
      assert.equal(manual.rolling_unit_lineage, undefined);
      const compiled = buildSpawnTicket({ cwd: f.cwd, env: f.env, id: nextSpawnId(f.cwd, "spn", f.env), description: "compiled compatibility", prompt: "compiled compatibility", modelId: ROUTE, routeId: ROUTE, taskKind: "concrete", compiledApplyLineage: { run_id: "run", plan_revision: "1", plan_fingerprint: "b".repeat(64), unit_id: "unit", task_refs: ["4.2"], mode: "verification-only" } });
      assert.equal(compiled.work_unit.schema_version, 2);
      assert.deepEqual(compiled.compiled_apply_lineage?.task_refs, ["4.2"]);
    } finally {
      fs.rmSync(f.cwd, { recursive: true, force: true });
    }
  }));
});
