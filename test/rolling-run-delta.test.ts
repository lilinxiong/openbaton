import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendRollingFact,
  appendRollingPlanDelta,
  createRollingExecutionRun,
  readRollingExecutionRun,
  RollingRunError,
  RollingStorageRaceError,
} from "../src/lib/rolling-run.js";
import { rollingRunDeltaDocumentPath, rollingRunCheckpointPath, rollingRunFactLogPath } from "../src/lib/paths.js";
import type { PlanDelta, TaskManifestEntry, TaskSourceDescriptor } from "../src/lib/rolling-plan.js";

const hash = "a".repeat(64);

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-delta-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-delta-home-"));
  const env = { ...process.env, HOME: home, BATON_SESSION_ID: "rolling-delta-session" };
  createRollingExecutionRun({
    cwd,
    env,
    runId: "run-1",
    host: "codex",
    source: source(),
    now: "2026-01-01T00:00:00Z",
  });
  return { cwd, env };
}

function source(): TaskSourceDescriptor {
  return { schema_version: 1, source_kind: "director", adapter: "director", selection: { queue: "rolling-delta-test" } };
}

function manifest(taskKey = "task-1"): TaskManifestEntry {
  return {
    schema_version: 1,
    task_key: taskKey,
    source_kind: "director",
    source_ref: { id: taskKey },
    display_id: taskKey,
    title: taskKey,
    source_fingerprint: hash,
    source_state: "pending",
    discovery_sequence: 0,
  };
}

function unit(unitKey: string, version: number, taskKey = "task-1") {
  return {
    schema_version: 1 as const,
    unit_key: unitKey,
    version,
    task_keys: [taskKey],
    depends_on: [],
    execution_mode: "patch-only" as const,
    prompt: `implement ${unitKey}@${version}`,
    write_paths: [`src/${unitKey}-${version}.ts`],
    allowed_operations: ["write" as const],
    completion_criteria: ["tests pass"],
    permitted_validation: ["npm test"],
    input_fingerprints: { baseline: hash },
  };
}

function gate(gateKey: string, version: number, taskKey = "task-1") {
  return {
    schema_version: 1 as const,
    gate_key: gateKey,
    version,
    type: "evidence" as const,
    task_keys: [taskKey],
    depends_on: [],
    acceptance_contract: { required: true },
  };
}

function delta(id: string, sequence: number, overrides: Partial<PlanDelta> = {}): PlanDelta {
  return {
    schema_version: 1,
    delta_id: id,
    prepared_from_append_sequence: sequence,
    unit_versions: [unit("unit-1", 1)],
    gate_versions: [],
    task_coverage: [{ schema_version: 1, task_key: "task-1", kind: "unit", unit_versions: ["unit-1@1"] }],
    ...overrides,
  };
}

function appendInitial(f: ReturnType<typeof fixture>, value = delta("delta-1", 0)): ReturnType<typeof readRollingExecutionRun> {
  return appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 0, delta: {
    ...value,
    manifest_additions: [manifest("task-1")],
  } });
}

function status(f: ReturnType<typeof fixture>, sequence: number, unitKey: string, version: number, state: string) {
  return appendRollingFact({
    cwd: f.cwd,
    env: f.env,
    runId: "run-1",
    expected_append_sequence: sequence,
    kind: "unit-status",
    idempotency_key: `status:${unitKey}@${version}:${state}`,
    payload: { unit_key: unitKey, unit_version: version, status: state },
  });
}

describe("rolling delta ingestion and immutable supersession", () => {
  it("validates before creating any accepted object", () => {
    const f = fixture();
    appendInitial(f);
    const beforeLog = fs.readFileSync(rollingRunFactLogPath(f.cwd, "run-1", f.env), "utf8");
    const beforeCheckpoint = fs.readFileSync(rollingRunCheckpointPath(f.cwd, "run-1", f.env), "utf8");
    assert.throws(
      () => appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 1, delta: delta("bad", 1, {
        unit_versions: [unit("bad-unit", 1, "missing-task")],
        task_coverage: [{ schema_version: 1, task_key: "missing-task", kind: "unit", unit_versions: ["bad-unit@1"] }],
      }) }),
      (cause: unknown) => cause instanceof RollingRunError && cause.code === "ROLLING_DELTA_INVALID",
    );
    assert.equal(fs.readFileSync(rollingRunFactLogPath(f.cwd, "run-1", f.env), "utf8"), beforeLog);
    assert.equal(fs.readFileSync(rollingRunCheckpointPath(f.cwd, "run-1", f.env), "utf8"), beforeCheckpoint);
    assert.equal(fs.existsSync(rollingRunDeltaDocumentPath(f.cwd, "run-1", "bad", f.env)), false);
    assert.equal(readRollingExecutionRun(f.cwd, "run-1", { env: f.env }).accepted_deltas.length, 1);
  });

  it("returns a typed retryable storage race and keeps the append atomic", () => {
    const f = fixture();
    appendInitial(f);
    const beforeLog = fs.readFileSync(rollingRunFactLogPath(f.cwd, "run-1", f.env), "utf8");
    assert.throws(
      () => appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 0, delta: delta("race", 0) }),
      (cause: unknown) => cause instanceof RollingStorageRaceError
        && cause instanceof RollingRunError
        && cause.retryable
        && cause.code === "ROLLING_SEQUENCE_MISMATCH"
        && cause.expected_append_sequence === 0
        && cause.current_append_sequence === 1,
    );
    assert.equal(fs.readFileSync(rollingRunFactLogPath(f.cwd, "run-1", f.env), "utf8"), beforeLog);
    assert.equal(fs.existsSync(rollingRunDeltaDocumentPath(f.cwd, "run-1", "race", f.env)), false);
  });

  it("makes identical accepted deltas idempotent even after sequence advancement", () => {
    const f = fixture();
    const first = appendInitial(f);
    appendRollingFact({ cwd: f.cwd, env: f.env, runId: "run-1", kind: "note", idempotency_key: "note-1", payload: { note: true } });
    const replay = appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 0, delta: delta("delta-1", 0, { manifest_additions: [manifest("task-1")] }) });
    assert.equal(replay.append_sequence, 2);
    assert.equal(replay.accepted_deltas.length, 1);
  });

  for (const state of ["reserved", "running", "terminal-unreleased", "accepted"]) {
    it(`preserves a ${state} unit version`, () => {
      const f = fixture();
      appendInitial(f);
      status(f, 1, "unit-1", 1, state);
      assert.throws(
        () => appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 2, delta: delta("replace", 2, {
          unit_versions: [unit("unit-1", 2)],
          task_coverage: [{ schema_version: 1, task_key: "task-1", kind: "unit", unit_versions: ["unit-1@2"] }],
          supersessions: [{ schema_version: 1, owner: "unit_version", previous: "unit-1@1", successor: "unit-1@2", reason: "repair" }],
        }) }),
        (cause: unknown) => cause instanceof RollingRunError && cause.code === "ROLLING_DELTA_INVALID" && cause.diagnostics?.some((item) => item.code === "SUPERSESSION_FORBIDDEN"),
      );
      assert.equal(readRollingExecutionRun(f.cwd, "run-1", { env: f.env }).accepted_deltas.length, 1);
    });
  }

  it("allows replacement only after a failed unit lineage and preserves the earlier delta", () => {
    const f = fixture();
    appendInitial(f);
    status(f, 1, "unit-1", 1, "failed");
    const next = appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 2, delta: delta("replace", 2, {
      unit_versions: [unit("unit-1", 2)],
      task_coverage: [{ schema_version: 1, task_key: "task-1", kind: "unit", unit_versions: ["unit-1@2"] }],
      supersessions: [{ schema_version: 1, owner: "unit_version", previous: "unit-1@1", successor: "unit-1@2", reason: "repair" }],
    }) });
    assert.equal(next.accepted_deltas.length, 2);
    assert.equal(next.accepted_deltas[0]!.unit_versions[0]!.version, 1);
    assert.equal(next.accepted_deltas[1]!.unit_versions[0]!.version, 2);
  });

  it("allows replacement after cancellation even when a later safety pass shares the unit owner", () => {
    const f = fixture();
    appendInitial(f);
    appendRollingFact({
      cwd: f.cwd,
      env: f.env,
      runId: "run-1",
      expected_append_sequence: 1,
      kind: "execution",
      idempotency_key: "execution:cancelled",
      payload: { kind: "native-attempt", unit_key: "unit-1", unit_version: 1, state: "cancelled" },
    });
    appendRollingFact({
      cwd: f.cwd,
      env: f.env,
      runId: "run-1",
      expected_append_sequence: 2,
      kind: "execution",
      idempotency_key: "execution:safety-pass",
      payload: { kind: "safety-verdict", owner_type: "unit_version", unit_key: "unit-1", unit_version: 1, accepted: true },
    });
    const next = appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 3, delta: delta("replace-cancelled", 3, {
      unit_versions: [unit("unit-1", 2)],
      task_coverage: [{ schema_version: 1, task_key: "task-1", kind: "unit", unit_versions: ["unit-1@2"] }],
      supersessions: [{ schema_version: 1, owner: "unit_version", previous: "unit-1@1", successor: "unit-1@2", reason: "replace cancelled dispatch" }],
    }) });
    assert.equal(next.accepted_deltas.length, 2);
    assert.equal(next.accepted_deltas[1]!.unit_versions[0]!.version, 2);
  });

  it("applies the same immutable boundary to gates", () => {
    const f = fixture();
    appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 0, delta: delta("gate-1", 0, {
      manifest_additions: [manifest("task-1")],
      unit_versions: [],
      gate_versions: [gate("gate-1", 1)],
      task_coverage: [{ schema_version: 1, task_key: "task-1", kind: "gate", gate_versions: ["gate-1@1"] }],
    }) });
    appendRollingFact({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 1, kind: "gate-status", idempotency_key: "gate-status-1", payload: { gate_key: "gate-1", gate_version: 1, status: "running" } });
    assert.throws(
      () => appendRollingPlanDelta({ cwd: f.cwd, env: f.env, runId: "run-1", expected_append_sequence: 2, delta: delta("gate-replace", 2, {
        unit_versions: [],
        gate_versions: [gate("gate-1", 2)],
        task_coverage: [{ schema_version: 1, task_key: "task-1", kind: "gate", gate_versions: ["gate-1@2"] }],
        supersessions: [{ schema_version: 1, owner: "gate_version", previous: "gate-1@1", successor: "gate-1@2", reason: "repair" }],
      }) }),
      (cause: unknown) => cause instanceof RollingRunError && cause.code === "ROLLING_DELTA_INVALID",
    );
  });
});
