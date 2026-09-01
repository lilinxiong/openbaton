import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveTaskLifecycle,
  validateTaskSealAgainstFacts,
  type RollingLifecycleContext,
} from "../src/lib/rolling-lifecycle.js";
import {
  appendRollingFact,
  appendRollingPlanDelta,
  appendRollingSeal,
  createRollingExecutionRun,
  readRollingExecutionRun,
  statusRollingExecutionRun,
  RollingRunError,
} from "../src/lib/rolling-run.js";
import { rollingRunFactLogPath } from "../src/lib/paths.js";
import type { PlanDelta, TaskManifestEntry, TaskSeal, TaskSourceDescriptor } from "../src/lib/rolling-plan.js";

const hash = "a".repeat(64);

function source(): TaskSourceDescriptor {
  return { schema_version: 1, source_kind: "director", adapter: "director", selection: { queue: "lifecycle-test" } };
}

function entry(taskKey = "task-1", sourceFingerprint = hash): TaskManifestEntry {
  return {
    schema_version: 1,
    task_key: taskKey,
    source_kind: "director",
    source_ref: { id: taskKey },
    display_id: taskKey,
    title: taskKey,
    source_fingerprint: sourceFingerprint,
    source_state: "pending",
    discovery_sequence: 0,
  };
}

function unit(unitKey = "unit-1", version = 1, taskKey = "task-1") {
  return {
    schema_version: 1 as const,
    unit_key: unitKey,
    version,
    task_keys: [taskKey],
    depends_on: [],
    execution_mode: "patch-only" as const,
    prompt: `implement ${unitKey}`,
    write_paths: [`src/${unitKey}.ts`],
    allowed_operations: ["write" as const],
    completion_criteria: ["tests pass"],
    permitted_validation: ["npm test"],
    input_fingerprints: { baseline: hash },
  };
}

function delta(id = "delta-1", taskKey = "task-1", withManifest = true): PlanDelta {
  return {
    schema_version: 1,
    delta_id: id,
    prepared_from_append_sequence: 0,
    ...(withManifest ? { manifest_additions: [entry(taskKey)] } : {}),
    unit_versions: [unit("unit-1", 1, taskKey)],
    gate_versions: [],
    task_coverage: [{ schema_version: 1, task_key: taskKey, kind: "unit", unit_versions: ["unit-1@1"] }],
  };
}

function seal(taskKey = "task-1", sourceFingerprint = hash, units = ["unit-1@1"]): TaskSeal {
  return {
    schema_version: 1,
    task_key: taskKey,
    required_unit_versions: units,
    required_gate_versions: [],
    source_fingerprint: sourceFingerprint,
  };
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-lifecycle-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-lifecycle-home-"));
  const env = { ...process.env, HOME: home, BATON_SESSION_ID: "rolling-lifecycle-session" };
  createRollingExecutionRun({ cwd, env, runId: "run-1", host: "codex", source: source(), now: "2026-01-01T00:00:00Z" });
  return { cwd, env };
}

function acceptUnit(f: ReturnType<typeof fixture>, sequence: number, state = "accepted") {
  return appendRollingFact({
    cwd: f.cwd,
    env: f.env,
    runId: "run-1",
    expected_append_sequence: sequence,
    kind: "unit-status",
    idempotency_key: `unit-status:${state}`,
    payload: { unit_key: "unit-1", unit_version: 1, status: state },
  });
}

describe("rolling task lifecycle and exact seals", () => {
  it("rejects a context-first call without a string task key", () => {
    const unsafeCall = deriveTaskLifecycle as (...args: unknown[]) => unknown;
    assert.throws(() => unsafeCall({ manifest_entries: [entry()] }), {
      name: "TypeError",
      message: "deriveTaskLifecycle requires a task key",
    });
    assert.throws(() => unsafeCall({ manifest_entries: [entry()] }, {}), TypeError);
    assert.equal(deriveTaskLifecycle({ manifest_entries: [entry()] }, "task-1").state, "unplanned");
  });

  it("moves from unplanned to open and stays open after all known work is accepted", () => {
    const context: RollingLifecycleContext = {
      manifest_entries: [entry()],
      accepted_deltas: [delta()],
      facts: [{ kind: "unit-status", payload: { unit_key: "unit-1", unit_version: 1, status: "accepted" } }],
    };
    assert.equal(deriveTaskLifecycle("task-1", { manifest_entries: [entry()] }).state, "unplanned");
    const lifecycle = deriveTaskLifecycle("task-1", context);
    assert.equal(lifecycle.state, "open");
    assert.equal(lifecycle.ready_to_seal, true);
    assert.equal(lifecycle.reconciled, false);
  });

  it("requires the exact non-superseded coverage and rejects stale or incomplete seals", () => {
    const context: RollingLifecycleContext = {
      manifest_entries: [entry()],
      accepted_deltas: [delta()],
      facts: [{ kind: "unit-status", payload: { unit_key: "unit-1", unit_version: 1, status: "accepted" } }],
    };
    assert.equal(validateTaskSealAgainstFacts(seal("task-1", "b".repeat(64)), context).valid, false);
    assert.equal(validateTaskSealAgainstFacts(seal("task-1", hash, []), context).valid, false);
    assert.equal(validateTaskSealAgainstFacts(seal(), context).valid, true);
  });

  it("surfaces local blockers without erasing the open lifecycle", () => {
    const context: RollingLifecycleContext = {
      manifest_entries: [entry()],
      accepted_deltas: [delta()],
      facts: [{ kind: "unit-status", payload: { unit_key: "unit-1", unit_version: 1, status: "failed" } }],
    };
    const lifecycle = deriveTaskLifecycle("task-1", context);
    assert.equal(lifecycle.state, "blocked");
    assert.equal(lifecycle.lifecycle_state, "open");
    assert.ok(lifecycle.blockers.length > 0);
  });

  it("accepts a seal only after exact unit acceptance and keeps failed seals atomic", () => {
    const f = fixture();
    const first = appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 0, delta: delta() });
    const factLog = rollingRunFactLogPath(f.cwd, "run-1", f.env);
    const before = fs.readFileSync(factLog, "utf8");
    assert.throws(
      () => appendRollingSeal({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: first.append_sequence, seal: seal("task-1", "b".repeat(64)) }),
      (cause: unknown) => cause instanceof RollingRunError && cause.code === "ROLLING_SEAL_INVALID",
    );
    assert.equal(fs.readFileSync(factLog, "utf8"), before);
    const accepted = acceptUnit(f, first.append_sequence);
    const sealed = appendRollingSeal({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: accepted.append_sequence, seal: seal() });
    assert.equal(sealed.seals.length, 1);
    assert.equal(statusRollingExecutionRun(f.cwd, "run-1", { env: f.env }).task_lifecycle["task-1"]?.state, "sealed");
  });

  it("permits a new exact seal after a manifest source refresh", () => {
    const f = fixture();
    const first = appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 0, delta: delta() });
    const accepted = acceptUnit(f, first.append_sequence);
    const sealed = appendRollingSeal({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: accepted.append_sequence, seal: seal() });
    const refreshed = appendRollingPlanDelta({
      cwd: f.cwd,
      env: f.env,
      runId: "run-1",
      expected_append_sequence: sealed.append_sequence,
      delta: {
        schema_version: 1,
        delta_id: "manifest-refresh",
        prepared_from_append_sequence: sealed.append_sequence,
        manifest_refreshes: [entry("task-1", "b".repeat(64))],
        unit_versions: [],
        gate_versions: [],
        task_coverage: [],
      },
    });
    assert.equal(statusRollingExecutionRun(f.cwd, "run-1", { env: f.env }).task_lifecycle["task-1"]?.state, "open");
    const resealed = appendRollingSeal({
      cwd: f.cwd,
      env: f.env,
      runId: "run-1",
      expected_append_sequence: refreshed.append_sequence,
      seal: seal("task-1", "b".repeat(64)),
    });
    assert.equal(resealed.seals.length, 2);
    assert.equal(statusRollingExecutionRun(f.cwd, "run-1", { env: f.env }).task_lifecycle["task-1"]?.state, "sealed");
  });

  it("allows an explicit typed no-op and reconciles only after a source fact", () => {
    const f = fixture();
    const noOp: PlanDelta = {
      schema_version: 1,
      delta_id: "no-op",
      prepared_from_append_sequence: 0,
      manifest_additions: [entry()],
      unit_versions: [],
      gate_versions: [],
      task_coverage: [{ schema_version: 1, task_key: "task-1", kind: "no-op", reason: "documentation-only task" }],
    };
    const planned = appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 0, delta: noOp });
    const sealed = appendRollingSeal({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: planned.append_sequence, seal: seal("task-1", hash, []) });
    assert.equal(statusRollingExecutionRun(f.cwd, "run-1", { env: f.env }).task_lifecycle["task-1"]?.state, "sealed");
    appendRollingFact({
      cwd: f.cwd,
      env: f.env,
      runId: "run-1",
      expected_append_sequence: sealed.append_sequence,
      kind: "reconciliation",
      idempotency_key: "reconciliation:task-1",
      payload: { task_key: "task-1", status: "complete" },
    });
    assert.equal(statusRollingExecutionRun(f.cwd, "run-1", { env: f.env }).task_lifecycle["task-1"]?.state, "reconciled");
  });
});
