import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRollingAcceptance,
  normalizeRollingExecutionFact,
  type RollingExecutionFact,
} from "../src/lib/rolling-acceptance.js";
import { deriveRollingSafeFrontier, type RollingRouteFact } from "../src/lib/rolling-scheduler.js";
import { fingerprintUnitVersion, type PlanDelta, type UnitVersion } from "../src/lib/rolling-plan.js";

const stamp = "2026-01-01T00:00:00.000Z";

function unit(key: string, overrides: Partial<UnitVersion> = {}): UnitVersion {
  return {
    schema_version: 1,
    unit_key: key,
    version: 1,
    task_keys: [`task-${key}`],
    depends_on: [],
    execution_mode: "patch-only",
    write_paths: [`src/${key}.ts`],
    allowed_operations: ["write"],
    ...overrides,
  };
}

function delta(units: UnitVersion[]): PlanDelta {
  return {
    schema_version: 1,
    delta_id: `delta-${units.map((value) => value.unit_key).join("-")}`,
    prepared_from_append_sequence: 0,
    unit_versions: units,
    gate_versions: [],
    task_coverage: [],
  };
}

function route(route_id: string, extra: Partial<RollingRouteFact> = {}): RollingRouteFact {
  return { route_id, selectable: true, availability_status: "available", ...extra };
}

function fact(kind: string, version: UnitVersion, extra: Record<string, unknown>, attempt = 1): RollingExecutionFact {
  const identity = `${version.unit_key}@${version.version}`;
  const attemptOwned = ["reservation", "native-attempt", "terminal-result", "retry", "release"].includes(kind);
  return normalizeRollingExecutionFact({
    schema_version: 1,
    kind,
    unit_key: version.unit_key,
    unit_version: version.version,
    unit_fingerprint: fingerprintUnitVersion(version),
    owner_type: attemptOwned ? "attempt" : "unit_version",
    owner_key: attemptOwned ? `${identity}:attempt-${attempt}` : identity,
    ...(attemptOwned ? { attempt } : {}),
    recorded_at: stamp,
    ...extra,
  });
}

describe("rolling route and acceptance regressions", () => {
  it("localizes a failed route/model and keeps an independent unit in the frontier", () => {
    const failed = unit("route-failed");
    const independent = unit("independent");
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([failed, independent])],
      routes_by_unit: {
        "route-failed@1": [route("model/failing", { selectable: false, diagnostic_code: "MODEL_CALL_FAILED" })],
        "independent@1": [route("model/healthy")],
      },
      configured_routes: ["model/failing", "model/healthy"],
      capacity: 2,
    });

    assert.deepEqual(result.frontier, ["independent@1"]);
    assert.equal(result.selected_routes["independent@1"], "model/healthy");
    assert.equal(result.blockers["route-failed@1"]?.[0]?.code, "MODEL_CALL_FAILED");
    assert.equal(result.blockers["independent@1"], undefined);
  });

  it("does not infer acceptance or unlock a dependency from a succeeded terminal and matching release", () => {
    const completed = unit("completed");
    const downstream = unit("downstream", { depends_on: ["completed@1"] });
    const terminalAndRelease = [
      fact("terminal-result", completed, { status: "succeeded", result: "ok" }),
      fact("release", completed, { released: true }),
    ];
    const acceptance = deriveRollingAcceptance({ units: [completed, downstream], facts: terminalAndRelease });
    assert.equal(acceptance.units["completed@1"]?.accepted, false);
    assert.equal(acceptance.units["completed@1"]?.state, "released");
    assert.equal(acceptance.units["downstream@1"]?.accepted, false);

    const frontier = deriveRollingSafeFrontier({
      accepted_deltas: [delta([completed, downstream])],
      runtime_facts: terminalAndRelease,
      capacity: 2,
    });
    assert.equal(frontier.frontier.includes("downstream@1"), false);
    assert.equal(frontier.blockers["downstream@1"]?.[0]?.code, "DEPENDENCY_NOT_ACCEPTED");
  });

  it("requires safety verdict and parent acceptance, then keeps acceptance monotonic after a failed retry", () => {
    const version = unit("monotonic");
    const terminalAndRelease = [
      fact("terminal-result", version, { status: "succeeded", result: "ok" }),
      fact("release", version, { released: true }),
    ];
    const pending = deriveRollingAcceptance({ units: [version], facts: terminalAndRelease });
    assert.equal(pending.units["monotonic@1"]?.accepted, false);

    const acceptedFacts = [
      ...terminalAndRelease,
      fact("safety-verdict", version, { accepted: true, violations: [] }),
      fact("parent-acceptance", version, { accepted: true, evidence: "reviewed" }),
    ];
    const accepted = deriveRollingAcceptance({ units: [version], facts: acceptedFacts });
    assert.equal(accepted.units["monotonic@1"]?.accepted, true);
    assert.equal(accepted.units["monotonic@1"]?.state, "accepted");

    const afterFailedRetry = deriveRollingAcceptance({
      units: [version],
      facts: [
        ...acceptedFacts,
        fact("retry", version, { retry_kind: "route", retry_of: "monotonic@1:attempt-1", reason: "route failed" }, 2),
        fact("terminal-result", version, { status: "errored", result: "failed" }, 2),
      ],
    });
    assert.equal(afterFailedRetry.units["monotonic@1"]?.accepted, true);
    assert.equal(afterFailedRetry.units["monotonic@1"]?.state, "accepted");
  });
});
