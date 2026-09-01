import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectRollingUnitVersions,
  indexRepresentedRollingTickets,
  rollingUnitRef,
} from "../src/lib/rolling-dispatch-state.js";
import { fingerprintUnitVersion, type PlanDelta, type UnitVersion } from "../src/lib/rolling-plan.js";
import type { SpawnTicket } from "../src/lib/spawn.js";

const RUN_ID = "rolling-run";

function unit(unit_key: string, version = 1, overrides: Partial<UnitVersion> = {}): UnitVersion {
  return {
    schema_version: 1,
    unit_key,
    version,
    task_keys: [`task-${unit_key}`],
    depends_on: [],
    execution_mode: "patch-only",
    ...overrides,
  };
}

function delta(unit_versions: UnitVersion[]): PlanDelta {
  return {
    schema_version: 1,
    delta_id: `delta-${unit_versions.map(rollingUnitRef).join("-")}`,
    prepared_from_append_sequence: 0,
    unit_versions,
    gate_versions: [],
    task_coverage: [],
  };
}

function ticket(
  id: string,
  lineage: { run_id?: string; unit_key?: string; unit_version?: number; unit_fingerprint?: string } | null,
  status = "queued",
  slot_released_at?: string,
): SpawnTicket {
  return {
    id,
    status,
    ...(slot_released_at ? { slot_released_at } : {}),
    ...(lineage ? {
      rolling_unit_lineage: {
        schema_version: 1,
        run_id: lineage.run_id ?? RUN_ID,
        unit_key: lineage.unit_key ?? "unit-a",
        unit_version: lineage.unit_version ?? 1,
        unit_fingerprint: lineage.unit_fingerprint ?? "a".repeat(64),
        task_keys: ["task-unit-a"],
        mode: "patch-only",
      },
    } : {}),
  } as unknown as SpawnTicket;
}

describe("rolling dispatch state", () => {
  it("forms refs and preserves first accepted delta/unit order", () => {
    const first = unit("first");
    const second = unit("second");
    const same = { ...first };
    const result = collectRollingUnitVersions([delta([first, second]), delta([same])]);
    assert.equal(rollingUnitRef(first), "first@1");
    assert.deepEqual([...result.keys()], ["first@1", "second@1"]);
    assert.strictEqual(result.get("first@1"), first);
  });

  it("rejects a conflicting fingerprint for one ref", () => {
    const first = unit("same");
    const changed = unit("same", 1, { prompt: "changed" });
    assert.throws(
      () => collectRollingUnitVersions([delta([first]), delta([changed])]),
      (error: unknown) => (error as { code?: string }).code === "ROLLING_LINEAGE_MISMATCH",
    );
  });

  it("represents every lifecycle and deduplicates released or failed tickets", () => {
    const known = unit("unit-a");
    const fingerprint = fingerprintUnitVersion(known);
    const statuses = ["queued", "dispatching", "running", "completed", "errored", "timed_out", "closed", "done"];
    const tickets = statuses.map((status, index) => ticket(`ticket-${index}`, { unit_fingerprint: fingerprint }, status));
    tickets.push(ticket("ticket-failed", { unit_fingerprint: fingerprint }, "failed", "released"));
    const result = indexRepresentedRollingTickets(RUN_ID, new Map([[rollingUnitRef(known), known]]), tickets);
    assert.deepEqual([...result.represented], ["unit-a@1"]);
    assert.deepEqual(result.ticket_ids_by_unit.get("unit-a@1"), [
      "ticket-0", "ticket-1", "ticket-2", "ticket-3", "ticket-4", "ticket-5", "ticket-6", "ticket-7", "ticket-failed",
    ]);
    assert.deepEqual(result.blockers, {});
  });

  it("ignores other runs, missing lineage, and unknown refs", () => {
    const known = unit("unit-a");
    const result = indexRepresentedRollingTickets(RUN_ID, [known], [
      ticket("other-run", { run_id: "other" }),
      ticket("missing-lineage", null),
      ticket("unknown-unit", { unit_key: "unknown", unit_fingerprint: fingerprintUnitVersion(known) }),
    ]);
    assert.deepEqual([...result.represented], []);
    assert.deepEqual([...result.ticket_ids_by_unit], []);
    assert.deepEqual(result.blockers, {});
  });

  it("keeps a mismatched unit represented and blocks only that unit", () => {
    const first = unit("first");
    const second = unit("second");
    const result = indexRepresentedRollingTickets(RUN_ID, [first, second], [
      ticket("z-matching", { unit_key: "first", unit_fingerprint: fingerprintUnitVersion(first) }),
      ticket("a-mismatched", { unit_key: "first", unit_fingerprint: "b".repeat(64) }),
      ticket("second-ticket", { unit_key: "second", unit_fingerprint: fingerprintUnitVersion(second) }),
    ]);
    assert.deepEqual([...result.represented], ["first@1", "second@1"]);
    assert.deepEqual(result.blockers["first@1"], [{
      code: "ROLLING_LINEAGE_MISMATCH",
      message: "existing rolling ticket lineage does not match unit first@1",
      refs: ["first@1", "a-mismatched", "z-matching"],
    }]);
    assert.equal(result.blockers["second@1"], undefined);
  });

  it("is independent of duplicate ticket input order", () => {
    const known = unit("unit-a");
    const tickets = [
      ticket("ticket-z", { unit_fingerprint: "b".repeat(64) }),
      ticket("ticket-a", { unit_fingerprint: fingerprintUnitVersion(known) }),
      ticket("ticket-z", { unit_fingerprint: "b".repeat(64) }),
    ];
    const forward = indexRepresentedRollingTickets(RUN_ID, [known], tickets);
    const reverse = indexRepresentedRollingTickets(RUN_ID, [known], [...tickets].reverse());
    assert.deepEqual(reverse, forward);
  });
});
