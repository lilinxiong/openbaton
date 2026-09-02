import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendRollingFact,
  appendRollingPlanDelta,
  createRollingExecutionRun,
  normalizeLegacyCompiledRunStatus,
  readRollingExecutionRun,
  rebuildRollingRunCheckpoint,
  RollingRunError,
} from "../src/lib/rolling-run.js";
import { createApplyRun } from "../src/lib/apply/run.js";
import { rollingRunAcceptedDocumentPath, rollingRunCheckpointPath, rollingRunDeltaDocumentPath, rollingRunFactLogPath } from "../src/lib/paths.js";
import type { PlanDelta, TaskSourceDescriptor } from "../src/lib/rolling-plan.js";

const hash = "a".repeat(64);
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-run-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-home-"));
  const env = { ...process.env, HOME: home, BATON_SESSION_ID: "rolling-run-session" };
  return { cwd, env };
}
function source(): TaskSourceDescriptor {
  return { schema_version: 1, source_kind: "director", adapter: "director", selection: { queue: "test" } };
}
function delta(id = "delta-1"): PlanDelta {
  return {
    schema_version: 1,
    delta_id: id,
    prepared_from_append_sequence: 0,
    unit_versions: [{ schema_version: 1, unit_key: "unit-1", version: 1, task_keys: ["director:t1"], depends_on: [], execution_mode: "patch-only", prompt: "do it", write_paths: ["src/a.ts"], allowed_operations: ["write"], input_fingerprints: { baseline: hash } }],
    gate_versions: [],
    task_coverage: [{ schema_version: 1, task_key: "director:t1", kind: "unit", unit_versions: ["unit-1@1"] }],
  };
}
function create() {
  const f = fixture();
  const run = createRollingExecutionRun({ cwd: f.cwd, env: f.env, runId: "run-1", host: "codex", source: source(), now: "2026-01-01T00:00:00Z" });
  return { ...f, run };
}

describe("rolling run v2 append storage", () => {
  it("appends a delta and deterministically rebuilds the checkpoint", () => {
    const { cwd, env, run } = create();
    assert.equal(run.append_sequence, 0);
    assert.equal(run.identity.execution_mode, "isolated-worktree");
    const next = appendRollingPlanDelta({ cwd, env, runId: "run-1", expected_append_sequence: 0, delta: delta() });
    assert.equal(next.append_sequence, 1);
    assert.equal(next.accepted_deltas[0]!.delta_id, "delta-1");
    assert.equal(next.accepted_deltas[0]!.unit_versions[0]!.worktree_mode, "isolated-worktree");
    const before = fs.readFileSync(rollingRunCheckpointPath(cwd, "run-1", env), "utf8");
    fs.unlinkSync(rollingRunCheckpointPath(cwd, "run-1", env));
    const rebuilt = rebuildRollingRunCheckpoint(cwd, "run-1", { env });
    assert.equal(rebuilt.append_sequence, 1);
    assert.equal(fs.readFileSync(rollingRunCheckpointPath(cwd, "run-1", env), "utf8"), before);
  });

  it("deduplicates identical idempotency and rejects conflicting idempotency", () => {
    const { cwd, env } = create();
    const first = appendRollingFact({ cwd, env, runId: "run-1", kind: "note", idempotency_key: "note-1", payload: { value: 1 } });
    const duplicate = appendRollingFact({ cwd, env, runId: "run-1", kind: "note", idempotency_key: "note-1", payload: { value: 1 } });
    assert.equal(duplicate.append_sequence, first.append_sequence);
    assert.throws(() => appendRollingFact({ cwd, env, runId: "run-1", kind: "note", idempotency_key: "note-1", payload: { value: 2 } }), (cause: unknown) => (cause as RollingRunError).code === "ROLLING_IDEMPOTENCY_CONFLICT");
  });

  it("reports a retryable stale append sequence without mutating the log", () => {
    const { cwd, env } = create();
    const before = fs.readFileSync(rollingRunFactLogPath(cwd, "run-1", env), "utf8");
    assert.throws(() => appendRollingPlanDelta({ cwd, env, runId: "run-1", expected_append_sequence: 9, delta: delta() }), (cause: unknown) => (cause as RollingRunError).code === "ROLLING_SEQUENCE_MISMATCH" && (cause as RollingRunError).retryable);
    assert.equal(fs.readFileSync(rollingRunFactLogPath(cwd, "run-1", env), "utf8"), before);
  });

  it("serializes competing appends so exactly one delta is accepted", async () => {
    const { cwd, env } = create();
    const competing = (id: string, unitKey: string): PlanDelta => ({
      schema_version: 1,
      delta_id: id,
      prepared_from_append_sequence: 0,
      unit_versions: [{
        schema_version: 1,
        unit_key: unitKey,
        version: 1,
        task_keys: ["director:t1"],
        depends_on: [],
        execution_mode: "patch-only",
        prompt: `implement ${unitKey}`,
        write_paths: [`src/${unitKey}.ts`],
        allowed_operations: ["write"],
        input_fingerprints: { baseline: hash },
      }],
      gate_versions: [],
      task_coverage: [{ schema_version: 1, task_key: "director:t1", kind: "unit", unit_versions: [`${unitKey}@1`] }],
    });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => appendRollingPlanDelta({ cwd, env, runId: "run-1", expected_append_sequence: 0, delta: competing("race-a", "unit-a") })),
      Promise.resolve().then(() => appendRollingPlanDelta({ cwd, env, runId: "run-1", expected_append_sequence: 0, delta: competing("race-b", "unit-b") })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected);
    assert.equal((rejected.reason as RollingRunError).code, "ROLLING_SEQUENCE_MISMATCH");
    assert.equal((rejected.reason as RollingRunError).retryable, true);
    assert.equal(readRollingExecutionRun(cwd, "run-1", { env }).accepted_deltas.length, 1);
  });

  it("does not publish an accepted fact when atomic document persistence is interrupted", () => {
    const { cwd, env } = create();
    const original = fs.renameSync;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith("delta-delta-1.json")) throw new Error("interrupted document write");
      return original(from, to);
    }) as typeof fs.renameSync;
    try { assert.throws(() => appendRollingPlanDelta({ cwd, env, runId: "run-1", expected_append_sequence: 0, delta: delta() })); }
    finally { fs.renameSync = original; }
    assert.equal(readRollingExecutionRun(cwd, "run-1", { env }).append_sequence, 0);
    assert.equal(fs.existsSync(rollingRunDeltaDocumentPath(cwd, "run-1", "delta-1", env)), false);
  });

  it("binds session and host identity and fails closed on corrupt state", () => {
    const { cwd, env } = create();
    assert.throws(() => readRollingExecutionRun(cwd, "run-1", { env: { ...env, BATON_SESSION_ID: "other" } }), (cause: unknown) => (cause as RollingRunError).code === "ROLLING_SESSION_MISMATCH");
    assert.throws(() => readRollingExecutionRun(cwd, "run-1", { env, host: "other" }), (cause: unknown) => (cause as RollingRunError).code === "ROLLING_HOST_MISMATCH");
    fs.appendFileSync(rollingRunFactLogPath(cwd, "run-1", env), "not-json\n");
    assert.throws(() => readRollingExecutionRun(cwd, "run-1", { env }), (cause: unknown) => (cause as RollingRunError).code === "ROLLING_STATE_CORRUPT");
  });

  it("normalizes legacy compiled v1 status without rewriting bytes", () => {
    const { cwd, env } = fixture();
    const plan = { schema_version: 1, identity: { plan_id: "p", change_id: "c" }, source_snapshot: { repo_root: "/repo", revision: "head" }, selected_tasks: ["1"], units: [{ id: "u1", mode: "patch-only", task_ids: ["1"], write_paths: ["src/a.ts"], allowed_operations: ["write"] }] } as any;
    createApplyRun({ cwd, env, runId: "legacy", host: "codex", plan });
    const runRoot = path.join(env.HOME!, ".baton");
    const collect = (dir: string, snapshot = new Map<string, string>()) => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); const stat = fs.statSync(file); if (stat.isDirectory()) collect(file, snapshot); else snapshot.set(file, fs.readFileSync(file, "utf8")); } return snapshot; };
    const before = collect(runRoot);
    const status = normalizeLegacyCompiledRunStatus(cwd, "legacy", { env });
    assert.equal(status.legacy, true);
    const after = collect(runRoot);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [file, bytes] of before) assert.equal(after.get(file), bytes);
  });
});
