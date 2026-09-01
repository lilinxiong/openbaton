import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RollingProtocolValidationError,
  RollingWorktreeModeError,
  assertPlanDelta,
  canonicalizeRolling,
  deriveTaskKey,
  fingerprintUnitVersion,
  parsePlanDelta,
  parseTaskManifestPage,
  resolveWorktreeExecutionMode,
  serializePlanDelta,
  serializeTaskManifestPage,
  validateGateVersion,
  validateTaskManifestPage,
  type PlanDelta,
  type TaskManifestPage,
} from "../src/lib/rolling-plan.js";
import { validatePlanDeltaAgainstFacts } from "../src/lib/rolling-delta.js";

const hash = "a".repeat(64);

function page(overrides: Record<string, unknown> = {}): TaskManifestPage {
  const source = { schema_version: 1, source_kind: "director", adapter: "director", selection: { queue: "demo" } };
  return {
    schema_version: 1,
    source,
    entries: [{
      schema_version: 1,
      task_key: "director:t1",
      source_kind: "director",
      source_ref: { caller_id: "opaque-1" },
      display_id: "t1",
      title: "First task",
      source_fingerprint: hash,
      source_state: "pending",
      discovery_sequence: 0,
    }],
    has_more: false,
    ...overrides,
  } as TaskManifestPage;
}

function delta(overrides: Record<string, unknown> = {}): PlanDelta {
  return {
    schema_version: 1,
    delta_id: "delta-1",
    prepared_from_append_sequence: 0,
    unit_versions: [{
      schema_version: 1,
      unit_key: "unit-1",
      version: 1,
      task_keys: ["director:t1"],
      depends_on: [],
      execution_mode: "patch-only",
      prompt: "make the change",
      write_paths: ["src/example.ts"],
      allowed_operations: ["write"],
      completion_criteria: ["tests pass"],
      permitted_validation: ["npm test"],
      input_fingerprints: { baseline: hash },
    }],
    gate_versions: [{
      schema_version: 1,
      gate_key: "gate-1",
      version: 1,
      type: "evidence",
      task_keys: ["director:t1"],
      depends_on: [],
      acceptance_contract: { required: false },
    }],
    task_coverage: [{
      schema_version: 1,
      task_key: "director:t1",
      kind: "unit",
      unit_versions: ["unit-1@1"],
      gate_versions: ["gate-1@1"],
    }],
    ...overrides,
  } as PlanDelta;
}

describe("rolling protocol", () => {
  it("round trips canonical manifest pages and preserves opaque references", () => {
    const value = page();
    const encoded = serializeTaskManifestPage(value);
    assert.deepEqual(parseTaskManifestPage(encoded), value);
    assert.equal(JSON.parse(encoded).entries[0].source_ref.caller_id, "opaque-1");
  });

  it("canonicalizes reordered object keys and derives stable task keys", () => {
    const left = { b: { z: 1, a: 2 }, a: [3, { d: 4, c: 5 }] };
    const right = { a: [3, { c: 5, d: 4 }], b: { a: 2, z: 1 } };
    assert.equal(canonicalizeRolling(left), canonicalizeRolling(right));
    assert.equal(deriveTaskKey("director", { id: "x", n: 1 }), deriveTaskKey("director", { n: 1, id: "x" }));
  });

  it("round trips a locally complete delta with typed gates and contracts", () => {
    const value = delta();
    const encoded = serializePlanDelta(value);
    assert.deepEqual(parsePlanDelta(encoded), value);
    assert.doesNotThrow(() => assertPlanDelta(JSON.parse(encoded)));
  });

  it("reports invalid shapes, duplicate versions, unknown gates, and bad identities", () => {
    const bad = delta({
      delta_id: "bad id",
      unit_versions: [
        (delta().unit_versions as unknown[])[0],
        (delta().unit_versions as unknown[])[0],
      ],
      gate_versions: [{
        schema_version: 1, gate_key: "g", version: 1, type: "unknown", task_keys: ["bad id"], depends_on: [],
      }],
    });
    assert.throws(() => serializePlanDelta(bad), (error: unknown) => error instanceof RollingProtocolValidationError
      && error.diagnostics.some((item) => item.code === "INVALID_IDENTITY")
      && error.diagnostics.some((item) => item.code === "DUPLICATE_VERSION")
      && error.diagnostics.some((item) => item.code === "UNKNOWN_GATE_TYPE"));
  });

  it("rejects unknown fields with a stable diagnostic", () => {
    const result = validateTaskManifestPage({ ...page(), unexpected: true });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => item.code === "UNKNOWN_FIELD"));
  });

  it("keeps unit fingerprints local and independent of run append sequence", () => {
    const unit = delta().unit_versions[0];
    assert.equal(fingerprintUnitVersion({ ...unit, append_sequence: 1 }), fingerprintUnitVersion({ ...unit, append_sequence: 99 }));
    assert.notEqual(fingerprintUnitVersion({ ...unit, prompt: "different" }), fingerprintUnitVersion(unit));
  });

  it("rejects an unknown gate type at the gate boundary", () => {
    const result = validateGateVersion({ schema_version: 1, gate_key: "g", version: 1, type: "device", task_keys: ["t"], depends_on: [] });
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0]?.code, "UNKNOWN_GATE_TYPE");
  });

  it("gates immutable isolated mode on rolling-run v2 without migrating legacy state", () => {
    assert.equal(resolveWorktreeExecutionMode({ schema_version: 1 }), "shared-worktree");
    assert.equal(resolveWorktreeExecutionMode({ schema_version: 2, identity: { execution_mode: "isolated-worktree" } }), "isolated-worktree");
    assert.equal(resolveWorktreeExecutionMode({ schema_version: 2, identity: { execution_mode: "shared-worktree" } }, "shared-worktree"), "shared-worktree");
    assert.throws(
      () => resolveWorktreeExecutionMode({ schema_version: 1 }, "isolated-worktree"),
      (error: unknown) => error instanceof RollingWorktreeModeError && error.code === "ROLLING_V2_REQUIRED",
    );
    assert.throws(
      () => resolveWorktreeExecutionMode({ schema_version: 2, identity: { execution_mode: "isolated-worktree" } }, "shared-worktree"),
      (error: unknown) => error instanceof RollingWorktreeModeError && error.code === "WORKTREE_MODE_IMMUTABLE",
    );
    assert.throws(
      () => resolveWorktreeExecutionMode({ schema_version: 2 }),
      (error: unknown) => error instanceof RollingWorktreeModeError && error.code === "WORKTREE_MODE_REQUIRED",
    );
  });

  it("requires an explicit isolated unit mode that matches rolling-run v2 state", () => {
    const proposed = delta();
    proposed.unit_versions[0] = { ...proposed.unit_versions[0]!, worktree_mode: "isolated-worktree" };
    const context = {
      schema_version: 2,
      identity: { execution_mode: "isolated-worktree" as const },
      manifest_entries: page().entries,
    };
    assert.equal(validatePlanDeltaAgainstFacts(proposed, context).valid, true);

    const incompatible = validatePlanDeltaAgainstFacts(proposed, { ...context, schema_version: 1 });
    assert.equal(incompatible.valid, false);
    assert.ok(incompatible.diagnostics.some((item) => item.code === "ROLLING_V2_REQUIRED"));

    const mismatched = validatePlanDeltaAgainstFacts(proposed, { ...context, identity: { execution_mode: "shared-worktree" as const } });
    assert.equal(mismatched.valid, false);
    assert.ok(mismatched.diagnostics.some((item) => item.code === "WORKTREE_MODE_IMMUTABLE"));

    const implicit = delta();
    const missing = validatePlanDeltaAgainstFacts(implicit, context);
    assert.equal(missing.valid, false);
    assert.ok(missing.diagnostics.some((item) => item.code === "WORKTREE_MODE_REQUIRED"));
  });

  it("preserves explicit repository-local dependencies and integration gates", () => {
    const proposed = delta();
    proposed.unit_versions[0] = {
      ...proposed.unit_versions[0]!,
      worktree_mode: "isolated-worktree",
      write_paths: ["src/a.ts", "vendor/sub/b.ts"],
      repository_parts: [
        { part_key: "part-main", repository_id: "b".repeat(64), write_paths: ["src/a.ts"], depends_on: [], integration_order: 0 },
        { part_key: "part-sub", repository_id: "c".repeat(64), write_paths: ["vendor/sub/b.ts"], depends_on: ["part-main"], integration_order: 1 },
      ],
      integration_gate_keys: ["gate-integration"],
    };
    proposed.gate_versions.push({
      schema_version: 1,
      gate_key: "gate-integration",
      version: 1,
      type: "integration-acceptance",
      task_keys: ["director:t1"],
      depends_on: [],
      acceptance_contract: { required: true },
    });
    proposed.task_coverage[0] = {
      ...proposed.task_coverage[0]!,
      gate_versions: ["gate-1@1", "gate-integration@1"],
    };
    const result = validatePlanDeltaAgainstFacts(proposed, {
      schema_version: 2,
      identity: { execution_mode: "isolated-worktree" },
      manifest_entries: page().entries,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.normalized?.unit_versions[0]?.repository_parts?.map((part) => part.part_key), ["part-main", "part-sub"]);

    const noGate = structuredClone(proposed);
    delete noGate.unit_versions[0]!.integration_gate_keys;
    const invalid = validatePlanDeltaAgainstFacts(noGate, {
      schema_version: 2,
      identity: { execution_mode: "isolated-worktree" },
      manifest_entries: page().entries,
    });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.diagnostics.some((item) => item.code === "INTEGRATION_GATE_REQUIRED"));
  });
});
