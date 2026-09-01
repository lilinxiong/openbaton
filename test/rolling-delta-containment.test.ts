import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendRollingFact,
  appendRollingPlanDelta,
  appendRollingSeal,
  createRollingExecutionRun,
  readRollingExecutionRun,
  statusRollingExecutionRun,
  RollingRunError,
} from "../src/lib/rolling-run.js";
import { rollingRunAcceptedDocumentPath, rollingRunCheckpointPath, rollingRunFactLogPath } from "../src/lib/paths.js";
import { captureUnitLocalInputs } from "../src/lib/rolling-inputs.js";
import { deriveRollingLifecycle, type RollingLifecycleContext } from "../src/lib/rolling-lifecycle.js";
import type {
  GateVersion,
  PlanDelta,
  TaskCoverage,
  TaskManifestEntry,
  TaskSeal,
  TaskSourceDescriptor,
  UnitVersion,
} from "../src/lib/rolling-plan.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const runId = "containment-run";

function source(): TaskSourceDescriptor {
  return {
    schema_version: 1,
    source_kind: "director",
    adapter: "director",
    selection: { queue: "rolling-delta-containment" },
  };
}

function manifest(taskKey: string, discoverySequence = 0, sourceFingerprint = HASH_A): TaskManifestEntry {
  return {
    schema_version: 1,
    task_key: taskKey,
    source_kind: "director",
    source_ref: { id: taskKey },
    display_id: taskKey,
    title: taskKey,
    source_fingerprint: sourceFingerprint,
    source_state: "pending",
    discovery_sequence: discoverySequence,
  };
}

function unit(
  unitKey: string,
  version: number,
  taskKey: string,
  overrides: Partial<UnitVersion> = {},
): UnitVersion {
  return {
    schema_version: 1,
    unit_key: unitKey,
    version,
    task_keys: [taskKey],
    depends_on: [],
    execution_mode: "patch-only",
    prompt: `implement ${unitKey}@${version}`,
    write_paths: [`src/${unitKey}-${version}.ts`],
    allowed_operations: ["write"],
    completion_criteria: ["tests pass"],
    permitted_validation: ["npm test"],
    input_fingerprints: { local: HASH_A },
    ...overrides,
  } as UnitVersion;
}

function gate(
  gateKey: string,
  version: number,
  taskKey: string,
  overrides: Partial<GateVersion> = {},
): GateVersion {
  return {
    schema_version: 1,
    gate_key: gateKey,
    version,
    type: "evidence",
    task_keys: [taskKey],
    depends_on: [],
    acceptance_contract: { required: true },
    ...overrides,
  } as GateVersion;
}

function unitCoverage(taskKey: string, unitKey: string, version: number): TaskCoverage {
  return {
    schema_version: 1,
    task_key: taskKey,
    kind: "unit",
    unit_versions: [`${unitKey}@${version}`],
  };
}

function gateCoverage(taskKey: string, gateKey: string, version: number): TaskCoverage {
  return {
    schema_version: 1,
    task_key: taskKey,
    kind: "gate",
    gate_versions: [`${gateKey}@${version}`],
  };
}

function delta(
  deltaId: string,
  appendSequence: number,
  units: UnitVersion[],
  gates: GateVersion[] = [],
  taskCoverage: TaskCoverage[] = [],
  overrides: Partial<PlanDelta> = {},
): PlanDelta {
  return {
    schema_version: 1,
    delta_id: deltaId,
    prepared_from_append_sequence: appendSequence,
    unit_versions: units,
    gate_versions: gates,
    task_coverage: taskCoverage,
    ...overrides,
  } as PlanDelta;
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-containment-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-containment-home-"));
  const env = { ...process.env, HOME: home, BATON_SESSION_ID: "rolling-delta-containment-session" };
  createRollingExecutionRun({ cwd, env, runId, host: "codex", source: source(), now: "2026-01-01T00:00:00Z" });
  return { cwd, env };
}

function firstWindowManifest(untouchedCount = 0): TaskManifestEntry[] {
  return [
    manifest("task-first", 0),
    manifest("task-independent", 1),
    ...Array.from({ length: untouchedCount }, (_, index) => manifest(`task-untouched-${index}`, index + 2)),
  ];
}

function firstWindow(
  appendSequence = 0,
  entries: TaskManifestEntry[] = firstWindowManifest(),
  withGate = false,
): PlanDelta {
  const units = [unit("unit-first", 1, "task-first")];
  const gates = withGate ? [gate("gate-first", 1, "task-first")] : [];
  const coverage = [withGate
    ? {
      schema_version: 1 as const,
      task_key: "task-first",
      kind: "unit" as const,
      unit_versions: ["unit-first@1"],
      gate_versions: ["gate-first@1"],
    }
    : unitCoverage("task-first", "unit-first", 1)];
  return delta("accepted-first", appendSequence, units, gates, coverage, { manifest_additions: entries });
}

function seal(taskKey = "task-first", sourceFingerprint = HASH_A, units = ["unit-first@1"], gates: string[] = []): TaskSeal {
  return {
    schema_version: 1,
    task_key: taskKey,
    required_unit_versions: units,
    required_gate_versions: gates,
    source_fingerprint: sourceFingerprint,
  };
}

function errorFrom(action: () => unknown): RollingRunError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RollingRunError, `expected RollingRunError, got ${String(caught)}`);
  return caught;
}

function assertRejectedDelta(
  f: ReturnType<typeof fixture>,
  rejected: PlanDelta,
  expectedAppendSequence: number,
  diagnostic: string,
): void {
  const factLog = rollingRunFactLogPath(f.cwd, runId, f.env);
  const checkpoint = rollingRunCheckpointPath(f.cwd, runId, f.env);
  const beforeLog = fs.readFileSync(factLog, "utf8");
  const beforeCheckpoint = fs.readFileSync(checkpoint, "utf8");
  const failure = errorFrom(() => appendRollingPlanDelta({
    cwd: f.cwd,
    env: f.env,
    runId,
    expected_append_sequence: expectedAppendSequence,
    delta: rejected,
  }));

  assert.equal(failure.code, "ROLLING_DELTA_INVALID");
  assert.ok(failure.diagnostics?.some((item) => item.code === diagnostic), `${diagnostic}: ${JSON.stringify(failure.diagnostics)}`);
  assert.equal(fs.readFileSync(factLog, "utf8"), beforeLog);
  assert.equal(fs.readFileSync(checkpoint, "utf8"), beforeCheckpoint);
  assert.equal(fs.existsSync(rollingRunAcceptedDocumentPath(f.cwd, runId, `delta-${rejected.delta_id}`, f.env)), false);
}

function assertFirstWindowStillAccepted(f: ReturnType<typeof fixture>, untouchedCount = 0): void {
  const run = readRollingExecutionRun(f.cwd, runId, { env: f.env });
  assert.equal(run.accepted_deltas.length, 1);
  assert.equal(run.accepted_deltas[0]?.delta_id, "accepted-first");
  assert.deepEqual(run.accepted_deltas[0]?.unit_versions.map((value) => `${value.unit_key}@${value.version}`), ["unit-first@1"]);
  assert.equal(run.accepted_deltas[0]?.gate_versions.length, 0);

  const status = statusRollingExecutionRun(f.cwd, runId, { env: f.env });
  assert.equal(status.task_lifecycle["task-first"]?.state, "open");
  assert.equal(status.task_lifecycle["task-independent"]?.state, "unplanned");
  for (let index = 0; index < untouchedCount; index += 1) {
    assert.equal(status.task_lifecycle[`task-untouched-${index}`]?.state, "unplanned");
  }
}

describe("rolling delta failure containment", () => {
  it("rejects an invalid task id without touching the first accepted window or a large unplanned manifest", async () => {
    const f = fixture();
    const untouchedCount = 1_024;
    const inputRoot = "/virtual/rolling-delta-first-window";
    const reads: string[] = [];
    const firstInputs = await captureUnitLocalInputs({
      repoRoot: inputRoot,
      ownerKey: "unit-first",
      inputs: [{ label: "declared-source", kind: "repository-path", path: "src/first.ts" }],
      lstat: async (absolutePath: string) => {
        reads.push(`stat:${absolutePath}`);
        return { kind: "file" as const, mode: 0o644, size: 12 };
      },
      readBytes: async (absolutePath: string) => {
        reads.push(`read:${absolutePath}`);
        return Buffer.from("first-v1\n");
      },
    });
    assert.deepEqual(reads, [
      `stat:${inputRoot}/src/first.ts`,
      `read:${inputRoot}/src/first.ts`,
    ]);
    const firstDelta = firstWindow(0, firstWindowManifest(untouchedCount));
    firstDelta.unit_versions = [unit("unit-first", 1, "task-first", { input_fingerprints: { local: firstInputs.fingerprint } })];
    const first = appendRollingPlanDelta({
      cwd: f.cwd,
      env: f.env,
      runId,
      expected_append_sequence: 0,
      delta: firstDelta,
    });
    const rejected = delta(
      "invalid-task-id",
      first.append_sequence,
      [unit("unit-invalid-task", 1, "task-does-not-exist")],
      [],
      [unitCoverage("task-does-not-exist", "unit-invalid-task", 1)],
    );

    assertRejectedDelta(f, rejected, first.append_sequence, "UNKNOWN_TASK_REFERENCE");
    assertFirstWindowStillAccepted(f, untouchedCount);
  });

  it("rejects an unknown dependency locally while preserving the independent task lifecycle", () => {
    const f = fixture();
    const first = appendRollingPlanDelta({
      cwd: f.cwd,
      env: f.env,
      runId,
      expected_append_sequence: 0,
      delta: firstWindow(),
    });
    const rejected = delta(
      "unknown-dependency",
      first.append_sequence,
      [unit("unit-invalid-dependency", 1, "task-independent", { depends_on: ["unit-missing"] })],
      [],
      [unitCoverage("task-independent", "unit-invalid-dependency", 1)],
    );

    assertRejectedDelta(f, rejected, first.append_sequence, "UNKNOWN_DEPENDENCY");
    assertFirstWindowStillAccepted(f);
  });

  it("changes only the unit owner when a declared local input becomes stale", async () => {
    const root = "/virtual/rolling-delta-containment";
    const files: Record<string, string> = {
      [`${root}/src/unit-a.ts`]: "unit-a-v1\n",
      [`${root}/src/unit-b.ts`]: "unit-b-v1\n",
    };
    const reads: string[] = [];
    const capture = (ownerKey: string, inputPath: string) => captureUnitLocalInputs({
      repoRoot: root,
      ownerKey,
      inputs: [{ label: "declared-source", kind: "repository-path", path: inputPath }],
      lstat: async (absolutePath: string) => {
        reads.push(`stat:${absolutePath}`);
        const value = files[absolutePath];
        return value === undefined
          ? { kind: "missing" as const, exists: false }
          : { kind: "file" as const, mode: 0o644, size: Buffer.byteLength(value) };
      },
      readBytes: async (absolutePath: string) => {
        reads.push(`read:${absolutePath}`);
        return Buffer.from(files[absolutePath] || "");
      },
    });

    const beforeA = await capture("unit-a", "src/unit-a.ts");
    const beforeB = await capture("unit-b", "src/unit-b.ts");
    files[`${root}/src/unit-a.ts`] = "unit-a-v2\n";
    const afterA = await capture("unit-a", "src/unit-a.ts");
    const afterB = await capture("unit-b", "src/unit-b.ts");

    assert.notEqual(afterA.fingerprint, beforeA.fingerprint);
    assert.equal(afterB.fingerprint, beforeB.fingerprint);
    assert.deepEqual(afterA.components.map((value) => value.path), ["src/unit-a.ts"]);
    assert.deepEqual(afterB.components.map((value) => value.path), ["src/unit-b.ts"]);
    assert.deepEqual(reads, [
      `stat:${root}/src/unit-a.ts`, `read:${root}/src/unit-a.ts`,
      `stat:${root}/src/unit-b.ts`, `read:${root}/src/unit-b.ts`,
      `stat:${root}/src/unit-a.ts`, `read:${root}/src/unit-a.ts`,
      `stat:${root}/src/unit-b.ts`, `read:${root}/src/unit-b.ts`,
    ]);

    const context: RollingLifecycleContext = {
      manifest_entries: [manifest("task-a"), manifest("task-b")],
      accepted_deltas: [
        delta("unit-a-window", 0, [unit("unit-a", 1, "task-a", { input_fingerprints: { local: beforeA.fingerprint } })], [], [unitCoverage("task-a", "unit-a", 1)]),
        delta("unit-b-window", 1, [unit("unit-b", 1, "task-b", { input_fingerprints: { local: beforeB.fingerprint } })], [], [unitCoverage("task-b", "unit-b", 1)]),
      ],
      facts: [
        { kind: "unit-status", payload: { unit_key: "unit-a", unit_version: 1, status: "accepted" } },
        { kind: "unit-status", payload: { unit_key: "unit-b", unit_version: 1, status: "accepted" } },
        {
          kind: "local-failure",
          payload: {
            owner: "unit_version",
            owner_key: "unit-a",
            owner_version: 1,
            code: "LOCAL_INPUT_STALE",
            message: "declared-source changed after planning",
            retryable: true,
          },
        },
      ],
    };
    const report = deriveRollingLifecycle(context);
    assert.equal(report.task_lifecycle["task-a"]?.state, "blocked");
    assert.equal(report.task_lifecycle["task-a"]?.lifecycle_state, "open");
    assert.ok(report.task_lifecycle["task-a"]?.blockers.some((item) => item.code === "UNIT_BLOCKED" || item.code === "LOCAL_FAILURE"));
    assert.equal(report.task_lifecycle["task-b"]?.state, "open");
    assert.deepEqual(report.task_lifecycle["task-b"]?.accepted_unit_versions, ["unit-b@1"]);
  });

  it("rejects an illegal gate supersession without erasing the accepted gate version", () => {
    const f = fixture();
    const first = appendRollingPlanDelta({
      cwd: f.cwd,
      env: f.env,
      runId,
      expected_append_sequence: 0,
      delta: firstWindow(0, firstWindowManifest(), true),
    });
    const gateAccepted = appendRollingFact({
      cwd: f.cwd,
      env: f.env,
      runId,
      expected_append_sequence: first.append_sequence,
      kind: "gate-status",
      idempotency_key: "gate-status:accepted",
      payload: { gate_key: "gate-first", gate_version: 1, status: "accepted" },
    });
    const rejected = delta(
      "illegal-gate-supersession",
      gateAccepted.append_sequence,
      [unit("unit-replacement", 1, "task-first")],
      [gate("gate-first", 2, "task-first")],
      [{
        schema_version: 1,
        task_key: "task-first",
        kind: "unit",
        unit_versions: ["unit-replacement@1"],
        gate_versions: ["gate-first@2"],
      }],
      {
        supersessions: [{
          schema_version: 1,
          owner: "gate_version",
          previous: "gate-first@1",
          successor: "gate-first@2",
          reason: "replace accepted gate",
        }],
      },
    );

    assertRejectedDelta(f, rejected, gateAccepted.append_sequence, "SUPERSESSION_FORBIDDEN");
    const run = readRollingExecutionRun(f.cwd, runId, { env: f.env });
    assert.equal(run.accepted_deltas.length, 1);
    assert.deepEqual(run.accepted_deltas[0]?.gate_versions.map((value) => `${value.gate_key}@${value.version}`), ["gate-first@1"]);
    assert.equal(run.accepted_deltas.some((value) => value.gate_versions.some((item) => item.version === 2)), false);
    const status = statusRollingExecutionRun(f.cwd, runId, { env: f.env });
    assert.equal(status.task_lifecycle["task-first"]?.gate_status["gate-first@1"], "accepted");
    assert.equal(status.task_lifecycle["task-independent"]?.state, "unplanned");
  });

  it("rejects a stale seal with no seal object and keeps accepted units and independent tasks", () => {
    const f = fixture();
    const first = appendRollingPlanDelta({
      cwd: f.cwd,
      env: f.env,
      runId,
      expected_append_sequence: 0,
      delta: firstWindow(),
    });
    const accepted = appendRollingFact({
      cwd: f.cwd,
      env: f.env,
      runId,
      expected_append_sequence: first.append_sequence,
      kind: "unit-status",
      idempotency_key: "unit-status:unit-first@1:accepted",
      payload: { unit_key: "unit-first", unit_version: 1, status: "accepted" },
    });
    const factLog = rollingRunFactLogPath(f.cwd, runId, f.env);
    const checkpoint = rollingRunCheckpointPath(f.cwd, runId, f.env);
    const beforeLog = fs.readFileSync(factLog, "utf8");
    const beforeCheckpoint = fs.readFileSync(checkpoint, "utf8");
    const failure = errorFrom(() => appendRollingSeal({
      cwd: f.cwd,
      env: f.env,
      runId,
      expected_append_sequence: accepted.append_sequence,
      seal: seal("task-first", HASH_B),
    }));

    assert.equal(failure.code, "ROLLING_SEAL_INVALID");
    assert.ok(failure.diagnostics?.some((item) => item.code === "SEAL_SOURCE_FINGERPRINT_STALE"));
    assert.equal(fs.readFileSync(factLog, "utf8"), beforeLog);
    assert.equal(fs.readFileSync(checkpoint, "utf8"), beforeCheckpoint);
    assert.equal(fs.existsSync(rollingRunAcceptedDocumentPath(f.cwd, runId, "seal-task-first", f.env)), false);

    const status = statusRollingExecutionRun(f.cwd, runId, { env: f.env });
    assert.equal(status.seals.length, 0);
    assert.equal(status.task_lifecycle["task-first"]?.state, "open");
    assert.deepEqual(status.task_lifecycle["task-first"]?.accepted_unit_versions, ["unit-first@1"]);
    assert.equal(status.task_lifecycle["task-independent"]?.state, "unplanned");
  });
});
