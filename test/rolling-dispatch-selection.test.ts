import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markRouteExhausted } from "../src/lib/model-availability.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { selectRollingFrontier } from "../src/lib/rolling-dispatch-selection.js";
import { fingerprintUnitVersion, type PlanDelta, type UnitVersion } from "../src/lib/rolling-plan.js";
import type { ModelCard } from "../src/types.js";
import type { SpawnTicket } from "../src/lib/spawn.js";

const hash = "a".repeat(64);
const host = "alpha";

function workspace(): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-selection-"));
  const env = { ...process.env, HOME: cwd, BATON_SESSION_ID: "rolling-dispatch-selection-session" };
  return { cwd, env };
}

function unit(unit_key: string, version = 1, extra: Partial<UnitVersion> = {}): UnitVersion {
  return {
    schema_version: 1, unit_key, version, task_keys: [`task-${unit_key}`], depends_on: [],
    execution_mode: "patch-only", prompt: `implement ${unit_key}`, description: unit_key,
    write_paths: [`src/${unit_key}.ts`], allowed_operations: ["write"], input_fingerprints: { head: hash }, ...extra,
  };
}

function delta(units: UnitVersion[]): PlanDelta {
  return { schema_version: 1, delta_id: "delta", prepared_from_append_sequence: 0,
    unit_versions: units, gate_versions: [], task_coverage: [] };
}

function cards(): ModelCard[] {
  return [
    { id: "alpha/model", route_id: "alpha/model", strengths: "coding", provider: "alpha", executable: true },
    { id: "alpha/model@low", route_id: "alpha/model", reasoning_effort: "low", strengths: "coding", provider: "alpha", executable: true },
    { id: "alpha/model@medium", route_id: "alpha/model", reasoning_effort: "medium", strengths: "coding", provider: "alpha", executable: true },
    { id: "alpha/model@high", route_id: "alpha/model", reasoning_effort: "high", strengths: "coding", provider: "alpha", executable: true },
  ];
}

function setup(cwd: string, env: NodeJS.ProcessEnv): void {
  publishRouteSnapshot(cwd, [{ id: "alpha/model", route_id: "alpha/model", provider: "alpha",
    description: "coding", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", contextWindow: 1_000_000 }], new Date(), { host, env });
}

function ticket(run_id: string, unit_key: string, lineageOverrides: Partial<NonNullable<SpawnTicket["rolling_unit_lineage"]>> = {}): SpawnTicket {
  const version = unit(unit_key);
  return {
    id: `${run_id}-${unit_key}`,
    rolling_unit_lineage: {
      schema_version: 1,
      run_id,
      unit_key: version.unit_key,
      unit_version: version.version,
      unit_fingerprint: fingerprintUnitVersion(version),
      task_keys: version.task_keys,
      mode: version.execution_mode,
      ...lineageOverrides,
    },
  } as unknown as SpawnTicket;
}

describe("rolling dispatch selection projection", () => {
  it("blocks only the unit whose selection hook returns null", () => {
    const { cwd, env } = workspace(); setup(cwd, env);
    try {
      const result = selectRollingFrontier({ cwd, host, run_id: "run", accepted_deltas: [delta([unit("bad"), unit("good")])],
        cards: cards(), coding_models: ["alpha/model"], available_capacity: 1, env,
        select_unit: (_selection, current) => current.unit_key === "bad" ? null : undefined });
      assert.deepEqual(result.frontier, ["good@1"]);
      assert.equal(result.blockers["bad@1"]?.[0]?.code, "NO_QUALIFIED_CANDIDATE");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("marks an existing ticket without consuming capacity", () => {
    const { cwd, env } = workspace(); setup(cwd, env);
    try {
      const result = selectRollingFrontier({ cwd, host, run_id: "run", accepted_deltas: [delta([unit("already"), unit("next")])],
        existing_tickets: [ticket("run", "already")], cards: cards(), coding_models: ["alpha/model"], available_capacity: 1, env });
      assert.deepEqual(result.frontier, ["next@1"]);
      assert.equal(result.blockers["already@1"]?.[0]?.code, "ALREADY_MATERIALIZED");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("honors stable order and available capacity", () => {
    const { cwd, env } = workspace(); setup(cwd, env);
    try {
      const result = selectRollingFrontier({ cwd, host, run_id: "run", accepted_deltas: [delta([unit("later"), unit("first")])],
        cards: cards(), coding_models: ["alpha/model"], stable_order: ["later@1", "first@1"], available_capacity: 1, env });
      assert.deepEqual(result.frontier, ["later@1"]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("passes the exact effort candidate selected by the hook", () => {
    const { cwd, env } = workspace(); setup(cwd, env);
    try {
      const result = selectRollingFrontier({ cwd, host, run_id: "run", accepted_deltas: [delta([unit("effort")])],
        cards: cards(), coding_models: ["alpha/model"], available_capacity: 1, env,
        select_unit: (selection) => selection.candidates.find((candidate) => candidate.model_id === "alpha/model@high") });
      assert.equal(result.selected_candidates["effort@1"]?.model_id, "alpha/model@high");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not deduplicate a ticket from another run", () => {
    const { cwd, env } = workspace(); setup(cwd, env);
    try {
      const result = selectRollingFrontier({ cwd, host, run_id: "run", accepted_deltas: [delta([unit("unit")])],
        existing_tickets: [ticket("other-run", "unit")], cards: cards(), coding_models: ["alpha/model"], available_capacity: 1, env });
      assert.deepEqual(result.frontier, ["unit@1"]);
      assert.equal(result.represented_units.length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a fingerprint-mismatched ticket represented and blocks it", () => {
    const { cwd, env } = workspace(); setup(cwd, env);
    try {
      const result = selectRollingFrontier({ cwd, host, run_id: "run", accepted_deltas: [delta([unit("mismatch"), unit("good")])],
        existing_tickets: [ticket("run", "mismatch", { unit_fingerprint: "b".repeat(64) })],
        cards: cards(), coding_models: ["alpha/model"], available_capacity: 1, env });
      assert.deepEqual(result.represented_units, ["mismatch@1"]);
      assert.deepEqual(result.frontier, ["good@1"]);
      assert.equal(result.blockers["mismatch@1"]?.[0]?.code, "ROLLING_LINEAGE_MISMATCH");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("passes probe route ids through to an observable probe candidate", () => {
    const { cwd, env } = workspace(); setup(cwd, env);
    try {
      markRouteExhausted(cwd, { host, routeId: "alpha/model" }, { resetAt: new Date(0), now: new Date(1_000), env });
      const result = selectRollingFrontier({ cwd, host, run_id: "run", accepted_deltas: [delta([unit("probe")])],
        cards: cards(), coding_models: ["alpha/model"], probe_route_ids: ["alpha/model"], available_capacity: 1, env });
      const candidate = result.selection_units["probe@1"]?.candidates.find((item) => item.route_id === "alpha/model");
      assert.equal(candidate?.availability_status, "probe_due");
      assert.equal(candidate?.probe_available, true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
