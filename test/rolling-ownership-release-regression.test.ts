import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { deriveRollingSafeFrontier } from "../src/lib/rolling-scheduler.js";
import { indexRepresentedRollingTickets, rollingUnitRef } from "../src/lib/rolling-dispatch-state.js";
import { selectRollingFrontier } from "../src/lib/rolling-dispatch-selection.js";
import { fingerprintUnitVersion, type PlanDelta, type UnitVersion } from "../src/lib/rolling-plan.js";
import type { SpawnTicket } from "../src/lib/spawn.js";
import type { ModelCard } from "../src/types.js";

const RUN_ID = "rolling-ownership-regression";
const HOST = "alpha";
const ROUTE = "alpha/model";
const HASH = "a".repeat(64);

function unit(unit_key: string, overrides: Partial<UnitVersion> = {}): UnitVersion {
  return {
    schema_version: 1,
    unit_key,
    version: 1,
    task_keys: [`task-${unit_key}`],
    depends_on: [],
    execution_mode: "patch-only",
    prompt: `implement ${unit_key}`,
    description: `implement ${unit_key}`,
    write_paths: [`src/${unit_key}.ts`],
    allowed_operations: ["write"],
    input_fingerprints: { head: HASH },
    ...overrides,
  };
}

function delta(unit_versions: UnitVersion[]): PlanDelta {
  return {
    schema_version: 1,
    delta_id: "rolling-ownership-regression-delta",
    prepared_from_append_sequence: 0,
    unit_versions,
    gate_versions: [],
    task_coverage: [],
  };
}

function attemptFacts(status: "failed" | "succeeded", released = false): Record<string, unknown>[] {
  const owner_key = "held@1:attempt-1";
  return [
    { kind: "terminal-result", owner_type: "attempt", owner_key, unit_key: "held", unit_version: 1, status },
    ...(released ? [{ kind: "release", owner_type: "attempt", owner_key, unit_key: "held", unit_version: 1, released: true }] : []),
  ];
}

function ticket(
  id: string,
  version: UnitVersion,
  status: string,
  unit_fingerprint = fingerprintUnitVersion(version),
  slot_released_at?: string,
): SpawnTicket {
  return {
    id,
    status,
    ...(slot_released_at ? { slot_released_at } : {}),
    rolling_unit_lineage: {
      schema_version: 1,
      run_id: RUN_ID,
      unit_key: version.unit_key,
      unit_version: version.version,
      unit_fingerprint,
      task_keys: version.task_keys,
      mode: version.execution_mode,
    },
  } as unknown as SpawnTicket;
}

function cards(): ModelCard[] {
  return [
    { id: ROUTE, route_id: ROUTE, strengths: "coding", provider: HOST, executable: true },
    { id: `${ROUTE}@low`, route_id: ROUTE, reasoning_effort: "low", strengths: "coding", provider: HOST, executable: true },
    { id: `${ROUTE}@medium`, route_id: ROUTE, reasoning_effort: "medium", strengths: "coding", provider: HOST, executable: true },
  ];
}

function selectionWorkspace(): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-ownership-"));
  const env = { ...process.env, HOME: cwd, BATON_SESSION_ID: "rolling-ownership-regression-session" };
  publishRouteSnapshot(cwd, [{
    id: "model",
    provider: HOST,
    route_id: ROUTE,
    description: "coding",
    supportedReasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "medium",
    contextWindow: 1_000_000,
  }], new Date("2026-08-31T00:00:00.000Z"), { host: HOST, env });
  return { cwd, env };
}

describe("rolling terminal ownership and representation regressions", () => {
  it("retains terminal-unreleased attempt ownership and blocks an overlapping unit", () => {
    const held = unit("held");
    const overlap = unit("overlap", { write_paths: ["src/held.ts"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([held, overlap])],
      runtime_facts: attemptFacts("failed"),
      capacity: 2,
    });

    assert.equal(result.blockers[rollingUnitRef(held)]?.[0]?.code, "TERMINAL_UNRELEASED");
    assert.equal(result.blockers[rollingUnitRef(overlap)]?.[0]?.code, "WRITE_SCOPE_CONFLICT");
    assert.deepEqual(result.frontier, []);
  });

  it("clears only the released attempt ownership while retaining its failed state", () => {
    const held = unit("held");
    const overlap = unit("overlap", { write_paths: ["src/held.ts"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([held, overlap])],
      runtime_facts: attemptFacts("failed", true),
      capacity: 1,
    });

    assert.equal(result.blockers[rollingUnitRef(held)]?.[0]?.code, "UNIT_BLOCKED");
    assert.equal(result.blockers[rollingUnitRef(overlap)], undefined);
    assert.deepEqual(result.frontier, [rollingUnitRef(overlap)]);
  });

  it("represents completed, released, failed, and mismatched lineage without consuming capacity", () => {
    const represented = unit("represented");
    const mismatch = unit("mismatch");
    const next = unit("next");
    const existing = [
      ticket("ticket-completed", represented, "completed"),
      ticket("ticket-completed", represented, "completed"),
      ticket("ticket-released", represented, "completed", undefined, "2026-08-31T00:00:00.000Z"),
      ticket("ticket-failed", represented, "failed", undefined, "2026-08-31T00:00:01.000Z"),
      ticket("ticket-mismatch", mismatch, "failed", "b".repeat(64)),
    ];
    const indexed = indexRepresentedRollingTickets(
      RUN_ID,
      [represented, mismatch, next],
      existing,
    );
    assert.deepEqual([...indexed.represented], [rollingUnitRef(mismatch), rollingUnitRef(represented)]);
    assert.deepEqual(indexed.ticket_ids_by_unit.get(rollingUnitRef(represented)), [
      "ticket-completed", "ticket-failed", "ticket-released",
    ]);
    assert.deepEqual(indexed.blockers[rollingUnitRef(mismatch)]?.map((item) => item.code), ["ROLLING_LINEAGE_MISMATCH"]);

    const { cwd, env } = selectionWorkspace();
    try {
      const result = selectRollingFrontier({
        cwd,
        host: HOST,
        run_id: RUN_ID,
        accepted_deltas: [delta([represented, mismatch, next])],
        existing_tickets: existing,
        cards: cards(),
        coding_models: [ROUTE],
        available_capacity: 1,
        env,
      });
      assert.deepEqual(result.represented_units, [rollingUnitRef(mismatch), rollingUnitRef(represented)]);
      assert.deepEqual(result.frontier, [rollingUnitRef(next)]);
      assert.deepEqual(result.blockers[rollingUnitRef(mismatch)]?.map((item) => item.code), ["ROLLING_LINEAGE_MISMATCH"]);
      assert.equal(result.blockers[rollingUnitRef(mismatch)]?.length, 1);
      assert.equal(result.blockers[rollingUnitRef(represented)]?.[0]?.code, "ALREADY_MATERIALIZED");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
