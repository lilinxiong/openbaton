import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { ingestInitialApplyExecutionPlan, ingestSuccessorApplyExecutionPlan, materializeCompiledApplyFrontier } from "../src/lib/apply/compiled.js";
import { buildSelectionUnit } from "../src/lib/selection.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { compiledApplyRunStatePath } from "../src/lib/paths.js";
import { readApplyRunPlanBody } from "../src/lib/apply/run.js";
import { sessionUidFromEnv } from "../src/lib/session-scope.js";
import type { CompiledApplySourceFacts } from "../src/lib/apply-source.js";

function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-compiled-apply-"));
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "baton-compiled-home-")), BATON_SESSION_ID: "compiled-apply-test" };
  publishRouteSnapshot(cwd, [{ id: "alpha/default", provider: "alpha", native: true, supportedReasoningEfforts: ["high"], contextWindow: 1_000_000 }], new Date(), { host: "codex", env });
  return { cwd, env };
}

function source(repoRoot: string): CompiledApplySourceFacts {
  return {
    schema_version: 1,
    repo_root: repoRoot,
    repository: { head: "head", branch_ref: "refs/heads/main", staged_tree: "tree", index_control: { algorithm: "framed-v1", checksum: "index", entryCount: 0 } },
    open_spec: { context_files: [], context_file_hashes: {}, selected_task_snapshot_fingerprint: "tasks", selected_task_numbers: ["1"], selected_tasks: [], task_ledger: null, task_ledger_identity: "" },
    units: [], fingerprint: "source-fingerprint",
  };
}

function plan(repoRoot: string, description = "verify") {
  return { schema_version: 1 as const, identity: { plan_id: "run-1", change_id: "demo" }, source_snapshot: { repo_root: repoRoot, revision: "head" }, selected_tasks: ["1"], units: [{ id: "u1", mode: "verification-only" as const, task_ids: ["1"], description, prompt: description, verification: ["read"] }] };
}

function frontierPlan(repoRoot: string, unitIds = ["u1", "u2"]) {
  return { schema_version: 1 as const, identity: { plan_id: "frontier-run", change_id: "demo" }, source_snapshot: { repo_root: repoRoot, revision: "head" }, selected_tasks: unitIds, units: unitIds.map((id) => ({ id, mode: "verification-only" as const, task_ids: [id], description: id, prompt: id, verification: ["read"] })) };
}

function candidate(modelId = "alpha/default"): any {
  return { model_id: modelId, route_id: modelId, reasoning_effort: "high", service_tier: null, provider: "alpha", strengths: "verification", automatic_eligible: true };
}

describe("compiled apply orchestration", () => {
  it("freezes the accepted source fingerprint into the persisted plan", async () => {
    const f = setup(); const snapshot = source(f.cwd); const p = plan(f.cwd);
    const accepted = await ingestInitialApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "run-1", plan: p, captureSource: () => structuredClone(snapshot) });
    assert.equal(accepted.plan.source_snapshot.fingerprint, snapshot.fingerprint);
    assert.equal(readApplyRunPlanBody(f.cwd, "run-1", "1", f.env).source_snapshot.fingerprint, snapshot.fingerprint);
  });

  it("resolves a relative source repository against the invocation cwd", async () => {
    const f = setup(); const snapshot = source(f.cwd); const p = plan(".");
    const accepted = await ingestInitialApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "run-1", plan: p, captureSource: () => structuredClone(snapshot) });
    assert.equal(accepted.run.current_revision, "1");
  });

  it("rejects an explicit source fingerprint mismatch before run persistence", async () => {
    const f = setup(); const snapshot = source(f.cwd); const p = { ...plan(f.cwd), source_snapshot: { ...plan(f.cwd).source_snapshot, fingerprint: "0".repeat(64) } };
    await assert.rejects(ingestInitialApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "run-1", plan: p, captureSource: () => structuredClone(snapshot) }), (error: unknown) => (error as { code?: string }).code === "APPLY_PLAN_STALE");
    assert.equal(fs.existsSync(compiledApplyRunStatePath(f.cwd, "run-1", f.env)), false);
  });

  it("ingests an initial plan and reconstructs a deterministic frontier", async () => {
    const f = setup(); const snapshot = source(f.cwd); const p = plan(f.cwd);
    const accepted = await ingestInitialApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "run-1", plan: p, captureSource: () => structuredClone(snapshot) });
    assert.equal(accepted.run.current_revision, "1");
    const result = await materializeCompiledApplyFrontier({ cwd: f.cwd, env: f.env, host: "codex", runId: "run-1", capacity: 1, cards: [{ id: "alpha/default", route_id: "alpha/default", provider: "alpha", strengths: "verification", reasoning_effort: "high", native: true, tool: true } as any], automaticCards: [{ id: "alpha/default", route_id: "alpha/default", provider: "alpha", strengths: "verification", reasoning_effort: "high", native: true, tool: true } as any], codingModels: ["alpha/default"] });
    assert.deepEqual(result.selected, ["u1"]);
    assert.equal(result.materialized.length, 1);
    assert.equal(fs.existsSync(compiledApplyRunStatePath(f.cwd, "run-1", f.env)), true);
  });

  it("rejects a stale source before creating a successor revision", async () => {
    const f = setup(); const baseline = source(f.cwd); const p = plan(f.cwd);
    await ingestInitialApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "run-1", plan: p, captureSource: () => structuredClone(baseline) });
    const stale = { ...baseline, repository: { ...baseline.repository, head: "changed" } };
    await assert.rejects(ingestSuccessorApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "run-1", plan: p, expectedSource: baseline, captureSource: () => structuredClone(stale) }), /APPLY_PLAN_STALE/);
  });

  it("honors an explicit available capacity instead of deriving it from the empty run", async () => {
    const f = setup(); const snapshot = source(f.cwd); const p = frontierPlan(f.cwd);
    await ingestInitialApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "frontier-run", plan: p, captureSource: () => structuredClone(snapshot) });
    const result = await materializeCompiledApplyFrontier({ cwd: f.cwd, env: f.env, host: "codex", runId: "frontier-run", capacity: 2, availableCapacity: 1,
      cards: [candidate()], automaticCards: [candidate()], codingModels: ["alpha/default"], selectUnit: () => candidate() });
    assert.equal(result.capacity, 2);
    assert.equal(result.available_capacity, 1);
    assert.equal(result.selected.length, 1);
  });

  it("counts same-session same-host terminal-unreleased tickets but not queued tickets", async () => {
    const queued = setup(); const queuedSnapshot = source(queued.cwd); const queuedPlan = frontierPlan(queued.cwd);
    await ingestInitialApplyExecutionPlan({ cwd: queued.cwd, env: queued.env, host: "codex", change: "demo", runId: "frontier-run", plan: queuedPlan, captureSource: () => structuredClone(queuedSnapshot) });
    const queuedResult = await materializeCompiledApplyFrontier({ cwd: queued.cwd, env: queued.env, host: "codex", runId: "frontier-run", capacity: 1,
      ticket_facts: [{ ticket_id: "queued", status: "queued", run_id: "frontier-run", host: "codex", session_uid: sessionUidFromEnv(queued.env), unit_ids: ["u1"] }],
      cards: [candidate()], automaticCards: [candidate()], codingModels: ["alpha/default"], selectUnit: () => candidate() });
    assert.equal(queuedResult.available_capacity, 1, "queued work is not a consumed execution slot");
    assert.deepEqual(queuedResult.selected, ["u2"]);

    const held = setup(); const heldSnapshot = source(held.cwd); const heldPlan = frontierPlan(held.cwd);
    await ingestInitialApplyExecutionPlan({ cwd: held.cwd, env: held.env, host: "codex", change: "demo", runId: "frontier-run", plan: heldPlan, captureSource: () => structuredClone(heldSnapshot) });
    const heldResult = await materializeCompiledApplyFrontier({ cwd: held.cwd, env: held.env, host: "codex", runId: "frontier-run", capacity: 1,
      ticket_facts: [{ ticket_id: "held", status: "completed", run_id: "frontier-run", host: "codex", session_uid: sessionUidFromEnv(held.env), unit_ids: ["u1"] }],
      cards: [candidate()], automaticCards: [candidate()], codingModels: ["alpha/default"], selectUnit: () => candidate() });
    assert.equal(heldResult.available_capacity, 0, "terminal-unreleased work still owns its slot");
    assert.deepEqual(heldResult.selected, []);
  });

  it("backfills a later independent unit when the stable-first unit has no qualified model", async () => {
    const f = setup(); const snapshot = source(f.cwd); const p = frontierPlan(f.cwd);
    p.units[0]!.prompt = "verify context=2m";
    await ingestInitialApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "frontier-run", plan: p, captureSource: () => structuredClone(snapshot) });
    const result = await materializeCompiledApplyFrontier({ cwd: f.cwd, env: f.env, host: "codex", runId: "frontier-run", capacity: 1,
      cards: [candidate()], automaticCards: [candidate()], codingModels: ["alpha/default"], selectUnit: (selection, unit) => unit.id === "u1" && selection.no_qualified_result ? null : candidate() });
    assert.deepEqual(result.selected, ["u2"]);
    assert.deepEqual(result.blocked.map((item) => item.unit_id), ["u1"]);
  });

  it("keeps unconfigured routes out of compiled selection candidates", () => {
    const f = setup();
    const result = buildSelectionUnit({ cwd: f.cwd, env: f.env, host: "codex", key: "u1", description: "verify", prompt: "verify",
      cards: [candidate(), { ...candidate("beta/missing"), route_id: "beta/missing" }], automaticCards: [candidate()], codingModels: ["alpha/default"],
      requestedModelId: null, directorLocal: false, metadata: { regression: true } });
    assert.equal(result.candidates.some((item) => item.route_id === "beta/missing"), false);
  });

  it("does not rematerialize a unit already materialized in the current revision", async () => {
    const f = setup(); const snapshot = source(f.cwd); const p = plan(f.cwd);
    await ingestInitialApplyExecutionPlan({ cwd: f.cwd, env: f.env, host: "codex", change: "demo", runId: "run-1", plan: p, captureSource: () => structuredClone(snapshot) });
    const options = { cwd: f.cwd, env: f.env, host: "codex", runId: "run-1", capacity: 1, cards: [candidate()], automaticCards: [candidate()], codingModels: ["alpha/default"], selectUnit: () => candidate() };
    const first = await materializeCompiledApplyFrontier(options);
    const second = await materializeCompiledApplyFrontier(options);
    assert.deepEqual(first.selected, ["u1"]);
    assert.deepEqual(second.selected, []);
    assert.deepEqual(second.materialized, []);
  });
});
