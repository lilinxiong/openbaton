import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintPlanDelta,
  fingerprintUnitVersion,
  type GateVersion,
  type PlanDelta,
  type UnitVersion,
} from "../src/lib/rolling-plan.js";
import { deriveRollingSafeFrontier } from "../src/lib/rolling-scheduler.js";

const HASH = "a".repeat(64);

function unit(unit_key: string, task_key: string): UnitVersion {
  return {
    schema_version: 1,
    unit_key,
    version: 1,
    task_keys: [task_key],
    depends_on: [],
    execution_mode: "patch-only",
    prompt: `change ${unit_key}`,
    write_paths: [`src/${unit_key}.ts`],
    allowed_operations: ["write"],
    input_fingerprints: { baseline: HASH },
  };
}

function delta(delta_id: string, unit_versions: UnitVersion[], gate_versions: GateVersion[] = []): PlanDelta {
  return {
    schema_version: 1,
    delta_id,
    prepared_from_append_sequence: 0,
    unit_versions,
    gate_versions,
    task_coverage: [],
  };
}

describe("rolling active append regressions", () => {
  it("preserves an accepted unit identity while an unrelated unit is appended", () => {
    const accepted = unit("unit-accepted", "task-accepted");
    const independent = unit("unit-independent", "task-independent");
    const first = delta("delta-accepted", [accepted]);
    const appended = delta("delta-independent", [independent]);
    const unitFingerprint = fingerprintUnitVersion(accepted);
    const deltaFingerprint = fingerprintPlanDelta(first);

    const result = deriveRollingSafeFrontier({
      accepted_deltas: [first, appended],
      runtime_facts: [{ unit_key: "unit-accepted", unit_version: 1, state: "accepted" }],
    });

    assert.equal(fingerprintUnitVersion(accepted), unitFingerprint);
    assert.equal(fingerprintPlanDelta(first), deltaFingerprint);
    assert.deepEqual(result.known_unit_versions, ["unit-accepted@1", "unit-independent@1"]);
    assert.deepEqual(result.frontier, ["unit-independent@1"]);
  });

  it("does not let an unrelated evidence gate fact block an independent unit", () => {
    const independent = unit("unit-independent-evidence", "task-independent-evidence");
    const unrelatedEvidence: GateVersion = {
      schema_version: 1,
      gate_key: "gate-unrelated-evidence",
      version: 1,
      type: "evidence",
      task_keys: ["task-unrelated-evidence"],
      depends_on: [],
      acceptance_contract: { required: true },
    };

    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta("delta-unrelated-evidence", [independent], [unrelatedEvidence])],
      runtime_facts: [{ kind: "gate-status", gate_key: "gate-unrelated-evidence", gate_version: 1, state: "failed" }],
    });

    assert.deepEqual(result.frontier, ["unit-independent-evidence@1"]);
    assert.equal(result.blockers["unit-independent-evidence@1"], undefined);
  });

  it("keeps a stale unit local while scheduling its independent sibling", () => {
    const stale = unit("unit-stale", "task-stale");
    const sibling = unit("unit-sibling", "task-sibling");

    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta("delta-stale-local", [stale, sibling])],
      runtime_facts: [{ kind: "unit-status", unit_key: "unit-stale", unit_version: 1, state: "stale" }],
    });

    assert.deepEqual(result.frontier, ["unit-sibling@1"]);
    assert.equal(result.blockers["unit-stale@1"]?.[0]?.code, "LOCAL_INPUT_STALE");
    assert.equal(result.blockers["unit-sibling@1"], undefined);
  });
});
