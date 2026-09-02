import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertPlanDeltaAgainstFacts,
  RollingDeltaValidationError,
  validatePlanDeltaAgainstFacts,
  type PlanDeltaValidationContext,
} from "../src/lib/rolling-delta.js";
import type { PlanDelta, TaskManifestEntry } from "../src/lib/rolling-plan.js";

const hash = "a".repeat(64);

function entry(task_key: string): TaskManifestEntry {
  return {
    schema_version: 1,
    task_key,
    source_kind: "director",
    source_ref: { id: task_key },
    display_id: task_key,
    title: task_key,
    source_fingerprint: hash,
    source_state: "pending",
    discovery_sequence: 0,
  };
}

function unit(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    unit_key: "unit-1",
    version: 1,
    task_keys: ["task-1"],
    depends_on: [],
    execution_mode: "patch-only",
    prompt: "make the change",
    write_paths: ["./src/../src/example.ts"],
    allowed_operations: ["write", "create"],
    completion_criteria: ["tests pass"],
    permitted_validation: ["npm test"],
    input_fingerprints: { baseline: hash },
    ...overrides,
  };
}

function gate(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    gate_key: "gate-1",
    version: 1,
    type: "evidence",
    task_keys: ["task-1"],
    depends_on: [],
    acceptance_contract: { required: true },
    ...overrides,
  };
}

function delta(overrides: Record<string, unknown> = {}): PlanDelta {
  return {
    schema_version: 1,
    delta_id: "delta-1",
    prepared_from_append_sequence: 0,
    unit_versions: [unit()],
    gate_versions: [gate()],
    task_coverage: [{
      schema_version: 1,
      task_key: "task-1",
      kind: "unit",
      unit_versions: ["unit-1@1"],
      gate_versions: ["gate-1@1"],
    }],
    ...overrides,
  } as PlanDelta;
}

function facts(): PlanDeltaValidationContext {
  return {
    manifest_entries: [entry("task-1"), entry("untouched")],
    unit_versions: [],
    gate_versions: [],
  };
}

describe("rolling PlanDelta semantic validation", () => {
  it("validates one local window and leaves untouched manifest tasks open-world", () => {
    const result = validatePlanDeltaAgainstFacts(delta(), facts());
    assert.equal(result.valid, true);
    assert.deepEqual(result.value?.unit_versions[0]?.write_paths, ["src/example.ts"]);
    assert.deepEqual(result.value?.unit_versions[0]?.allowed_operations, ["write", "create"]);
  });

  it("rejects case variants of the Git metadata directory", () => {
    const result = validatePlanDeltaAgainstFacts(delta({
      unit_versions: [unit({ write_paths: [".GIT/config"] })],
    }), facts());
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => item.code === "FORBIDDEN_PATH"));
  });

  it("accepts dependencies declared by fixed facts or the same delta", () => {
    const result = validatePlanDeltaAgainstFacts(delta({
      unit_versions: [
        unit({ unit_key: "unit-1" }),
        unit({ unit_key: "unit-2", version: 1, depends_on: ["unit-1"], write_paths: ["src/two.ts"] }),
      ],
      gate_versions: [gate({ gate_key: "gate-1" }), gate({ gate_key: "gate-2", depends_on: ["unit-2"] })],
      task_coverage: [{
        schema_version: 1,
        task_key: "task-1",
        kind: "unit",
        unit_versions: ["unit-1@1", "unit-2@1"],
        gate_versions: ["gate-1@1", "gate-2@1"],
      }],
    }), facts());
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  });

  it("reports task, dependency, cycle, coverage, and gate-local diagnostics", () => {
    const result = validatePlanDeltaAgainstFacts(delta({
      unit_versions: [unit({ task_keys: ["missing"], depends_on: ["unknown"] })],
      gate_versions: [gate({ type: "unsupported", depends_on: ["gate-1"] })],
      task_coverage: [{
        schema_version: 1,
        task_key: "missing",
        kind: "unit",
        unit_versions: ["unit-1@1"],
      }],
    }), facts());
    assert.equal(result.valid, false);
    for (const code of ["UNKNOWN_TASK_REFERENCE", "UNKNOWN_DEPENDENCY", "DEPENDENCY_CYCLE", "UNKNOWN_GATE_TYPE"]) {
      assert.ok(result.diagnostics.some((item) => item.code === code), code);
    }
    assert.ok(result.diagnostics.every((item) => item.path?.startsWith("delta.")));
  });

  it("rejects incomplete mode contracts, unsafe scopes, operations, and coverage references", () => {
    const result = validatePlanDeltaAgainstFacts(delta({
      unit_versions: [unit({
        execution_mode: "verification-only",
        write_paths: ["../outside"],
        allowed_operations: ["write", "nope"],
        completion_criteria: [],
        permitted_validation: [],
        input_fingerprints: {},
      })],
      task_coverage: [{
        schema_version: 1,
        task_key: "task-1",
        kind: "unit",
        unit_versions: ["missing-unit@1"],
      }],
    }), facts());
    assert.equal(result.valid, false);
    for (const code of ["FORBIDDEN_FIELD", "INCOMPLETE_EXECUTION_CONTRACT", "MISSING_BASELINE", "UNKNOWN_COVERAGE_REFERENCE"]) {
      assert.ok(result.diagnostics.some((item) => item.code === code), code);
    }
  });

  it("diagnoses malformed fixed-fact task claims without throwing", () => {
    const malformedFacts = {
      ...facts(),
      unit_versions: [{ ...unit(), task_keys: undefined }],
      gate_versions: [{ ...gate(), task_keys: undefined }],
    } as unknown as PlanDeltaValidationContext;
    const result = validatePlanDeltaAgainstFacts(delta({
      unit_versions: [],
      gate_versions: [],
      task_coverage: [{
        schema_version: 1,
        task_key: "task-1",
        kind: "unit",
        unit_versions: ["unit-1@1"],
        gate_versions: ["gate-1@1"],
      }],
    }), malformedFacts);
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics.filter((item) => item.code === "COVERAGE_TASK_MISMATCH").length, 2);
  });

  it("checks supersession references and throws the local assertion error", () => {
    const result = validatePlanDeltaAgainstFacts(delta({
      supersessions: [{
        schema_version: 1,
        owner: "unit_version",
        previous: "missing@1",
        successor: "unit-1@1",
        reason: "replace",
      }],
    }), facts());
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => item.code === "UNKNOWN_SUPERSESSION_REFERENCE"));
    assert.throws(() => assertPlanDeltaAgainstFacts(delta({
      supersessions: [{ schema_version: 1, owner: "unit_version", previous: "missing@1", successor: "unit-1@1", reason: "replace" }],
    }), facts()), (cause: unknown) => cause instanceof RollingDeltaValidationError);
  });
});
