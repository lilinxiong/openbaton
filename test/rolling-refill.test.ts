import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { buildRollingStandalonePlans, refillRollingCapacity, type RollingRefillInput } from "../src/lib/rolling-dispatch.js";
import { fingerprintUnitVersion, type PlanDelta, type UnitVersion } from "../src/lib/rolling-plan.js";
import { receiptsDir, rollingRunsDir, spawnsDir } from "../src/lib/paths.js";
import { sessionUidFromEnv, type SpawnTicket } from "../src/lib/spawn.js";
import type { TicketMaterializationBatchEntry, TicketMaterializationBatchOptions } from "../src/lib/ticket-materialization.js";
import type { ModelCard } from "../src/types.js";

const HOST = "alpha";
const RUN_ID = "run-42";
const ROUTE = "alpha/model";
const NOW = "2026-08-31T00:00:00.000Z";
const CATALOG_FINGERPRINT = "catalog-fixed-v1";
const HASH = "a".repeat(64);

function fixture(): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-refill-"));
  const env = { ...process.env, HOME: cwd, BATON_SESSION_ID: "rolling-refill-test-session" };
  publishRouteSnapshot(cwd, [{
    id: "model",
    provider: HOST,
    route_id: ROUTE,
    description: "coding",
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
    contextWindow: 1_000_000,
  }], new Date(NOW), { cli: HOST, host: HOST, env });
  return { cwd, env };
}

function cards(): ModelCard[] {
  return [
    { id: ROUTE, route_id: ROUTE, strengths: "coding", provider: HOST, executable: true },
    { id: `${ROUTE}@low`, route_id: ROUTE, reasoning_effort: "low", strengths: "coding", provider: HOST, executable: true },
    { id: `${ROUTE}@high`, route_id: ROUTE, reasoning_effort: "high", strengths: "coding", provider: HOST, executable: true },
  ];
}

function unit(unit_key: string, execution_mode: UnitVersion["execution_mode"] = "patch-only"): UnitVersion {
  return {
    schema_version: 1,
    unit_key,
    version: 1,
    task_keys: [`task-${unit_key}`],
    depends_on: [],
    execution_mode,
    prompt: `implement ${unit_key}`,
    description: `implement ${unit_key}`,
    read_context: [`src/${unit_key}.ts`],
    // A verification-only input must not be able to smuggle these fields into
    // its generated ticket or Receipt.
    write_paths: [`src/${unit_key}.ts`],
    allowed_operations: ["write"],
    completion_criteria: [`${unit_key} is complete`],
    permitted_validation: ["read"],
    input_fingerprints: { head: HASH },
  };
}

function delta(delta_id: string, unit_versions: UnitVersion[]): PlanDelta {
  return {
    schema_version: 1,
    delta_id,
    prepared_from_append_sequence: 0,
    unit_versions,
    gate_versions: [],
    task_coverage: [],
  };
}

function input(cwd: string, env: NodeJS.ProcessEnv, accepted_deltas: PlanDelta[], overrides: Partial<RollingRefillInput> = {}): RollingRefillInput {
  return {
    cwd,
    env,
    run_id: RUN_ID,
    host: HOST,
    accepted_deltas,
    cards: cards(),
    coding_models: [ROUTE],
    automatic_cards: cards(),
    available_capacity: 8,
    stable_order: ["unit.alpha@1", "unit.beta@1", "unit.gamma@1"],
    now: NOW,
    catalog_fingerprint: CATALOG_FINGERPRINT,
    ...overrides,
  };
}

function selectedHigh(selection: Parameters<NonNullable<RollingRefillInput["select_unit"]>>[0], current: UnitVersion) {
  if (current.unit_key !== "unit.alpha") return undefined;
  return selection.candidates.find((candidate) => candidate.model_id === `${ROUTE}@high`);
}

function assertNoPersistence(cwd: string, env: NodeJS.ProcessEnv): void {
  assert.equal(fs.existsSync(spawnsDir(cwd, env)), false);
  assert.equal(fs.existsSync(receiptsDir(cwd, env)), false);
}

describe("rolling refill blueprint projection", () => {
  it("preserves isolated overlap concurrency and its integration risk through dispatch selection", () => {
    const { cwd, env } = fixture();
    try {
      const first = { ...unit("unit.alpha"), worktree_mode: "isolated-worktree" as const, write_paths: ["src/shared.ts"] };
      const second = { ...unit("unit.beta"), worktree_mode: "isolated-worktree" as const, write_paths: ["src/shared.ts"] };
      const common = { repository_id: "1".repeat(64), git_common_dir_identity: "2".repeat(64), base_tree: "3".repeat(40) };
      const result = buildRollingStandalonePlans(input(cwd, env, [delta("delta-isolated", [first, second])], {
        exact_execution_roots: {
          "unit.alpha@1": { ...common, execution_root: path.join(cwd, "worktrees", "alpha"), worktree_record_id: "record-alpha" },
          "unit.beta@1": { ...common, execution_root: path.join(cwd, "worktrees", "beta"), worktree_record_id: "record-beta" },
        },
      }));

      assert.deepEqual(result.frontier, ["unit.alpha@1", "unit.beta@1"]);
      assert.deepEqual(result.selection.integration_conflict_risks.map((risk) => [risk.from, risk.to]), [["unit.alpha@1", "unit.beta@1"]]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses frontier order and capacity for stable IDs, entries, source, and exact lineage", () => {
    const { cwd, env } = fixture();
    try {
      const first = unit("unit.alpha");
      const second = unit("unit.beta", "verification-only");
      const units = delta("delta-base", [second, first]);
      const limited = buildRollingStandalonePlans(input(cwd, env, [units], {
        stable_order: ["unit.beta@1", "unit.alpha@1"],
        available_capacity: 1,
        select_unit: selectedHigh,
      }));
      assert.deepEqual(limited.frontier, ["unit.beta@1"]);
      assert.deepEqual(limited.entries.map((entry) => entry.planned.ticket.rolling_unit_lineage?.unit_key), ["unit.beta"]);

      const full = buildRollingStandalonePlans(input(cwd, env, [units], {
        stable_order: ["unit.beta@1", "unit.alpha@1"],
        available_capacity: 2,
        select_unit: selectedHigh,
      }));
      const uid = sessionUidFromEnv(env);
      assert.deepEqual(full.frontier, ["unit.beta@1", "unit.alpha@1"]);
      assert.deepEqual(full.entries.map((entry) => entry.planned.ticket.id), [
        `spn-${uid}-0001`,
        `spn-${uid}-0002`,
      ]);
      assert.deepEqual(full.entries.map((entry) => entry.planned.ticket.id), full.plans.map((plan) => plan.ticket.id));
      assert.equal(full.plans[0]?.ticket.source, "rolling-run");

      const high = full.plans.find((plan) => plan.ticket.rolling_unit_lineage?.unit_key === "unit.alpha");
      assert.ok(high);
      assert.equal(high.ticket.selection?.selected_model_id, `${ROUTE}@high`);
      assert.equal(high.ticket.selection?.approval_id, `rolling-${RUN_ID}-unit.alpha@1`);
      assert.equal(high.ticket.reasoning_effort, "high");
      assert.equal(high.receipt.route.reasoning_effort, "high");

      for (const plan of full.plans) {
        const ticketLineage = plan.ticket.rolling_unit_lineage;
        const workUnit = plan.ticket.work_unit as { rolling_unit_lineage?: { unit_fingerprint?: string }; plan_revision?: unknown };
        const receiptLineage = plan.receipt.rolling_unit_lineage;
        assert.ok(ticketLineage);
        assert.ok(workUnit.rolling_unit_lineage);
        assert.ok(receiptLineage);
        assert.equal(ticketLineage?.unit_fingerprint, workUnit.rolling_unit_lineage?.unit_fingerprint);
        assert.equal(ticketLineage?.unit_fingerprint, receiptLineage?.unit_fingerprint);
        assert.equal(plan.ticket.selection?.approval_id, `rolling-${RUN_ID}-${ticketLineage?.unit_key}@${ticketLineage?.unit_version}`);
        assert.equal("plan_revision" in plan.ticket, false);
        assert.equal("plan_revision" in workUnit, false);
        assert.equal("plan_revision" in plan.receipt, false);
        assert.equal(ticketLineage?.unit_fingerprint, fingerprintUnitVersion(
          ticketLineage?.unit_key === "unit.alpha" ? first : second,
        ));
      }

      const verification = full.plans.find((plan) => plan.ticket.rolling_unit_lineage?.unit_key === "unit.beta");
      assert.ok(verification);
      const verificationWorkUnit = verification.ticket.work_unit as {
        write_paths: readonly string[];
        allowed_operations: readonly string[];
      };
      assert.deepEqual(verificationWorkUnit.write_paths, []);
      assert.deepEqual(verificationWorkUnit.allowed_operations, []);
      assert.deepEqual(full.entries.find((entry) => entry.planned === verification)?.writeAllowlist, []);
      assert.deepEqual(full.entries.find((entry) => entry.planned === verification)?.allowedOperations, []);
      assertNoPersistence(cwd, env);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps existing blueprints unchanged across unrelated deltas and event reasons", () => {
    const { cwd, env } = fixture();
    try {
      const base = delta("delta-base", [unit("unit.alpha")]);
      const appended = delta("delta-unrelated", [unit("unit.gamma")]);
      const baseline = buildRollingStandalonePlans(input(cwd, env, [base], { select_unit: selectedHigh }));
      const baselinePlan = baseline.plans[0];
      assert.ok(baselinePlan);
      for (const event_reason of ["release", "gate-acceptance", "delta-append"]) {
        const result = buildRollingStandalonePlans(input(cwd, env, [base, appended], {
          available_capacity: 2,
          event_reason,
          select_unit: selectedHigh,
        }));
        const existing = result.plans.find((plan) => plan.ticket.rolling_unit_lineage?.unit_key === "unit.alpha");
        assert.deepEqual(existing, baselinePlan);
        assert.deepEqual(result.diagnostics, [{ code: "EVENT_REASON", message: event_reason }]);
        assert.deepEqual(result.selected, ["unit.alpha@1", "unit.gamma@1"]);
      }
      assertNoPersistence(cwd, env);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not duplicate same-lineage tickets and retains mismatches as represented blockers", () => {
    const { cwd, env } = fixture();
    try {
      const first = unit("unit.alpha");
      const second = unit("unit.beta");
      const accepted = [delta("delta-base", [first, second])];
      const original = buildRollingStandalonePlans(input(cwd, env, accepted, { available_capacity: 2, select_unit: selectedHigh }));
      const existingTicket = original.plans.find((plan) => plan.ticket.rolling_unit_lineage?.unit_key === "unit.alpha")?.ticket;
      assert.ok(existingTicket);

      const deduplicated = buildRollingStandalonePlans(input(cwd, env, accepted, {
        available_capacity: 2,
        existing_tickets: [existingTicket as SpawnTicket],
        select_unit: selectedHigh,
      }));
      assert.deepEqual(deduplicated.represented_units, ["unit.alpha@1"]);
      assert.equal(deduplicated.plans.some((plan) => plan.ticket.rolling_unit_lineage?.unit_key === "unit.alpha"), false);
      assert.equal(deduplicated.selection.blockers["unit.alpha@1"]?.[0]?.code, "ALREADY_MATERIALIZED");
      assert.deepEqual(deduplicated.selected, ["unit.beta@1"]);

      const mismatched = structuredClone(existingTicket as SpawnTicket);
      mismatched.rolling_unit_lineage = {
        ...mismatched.rolling_unit_lineage!,
        unit_fingerprint: crypto.createHash("sha256").update("mismatch").digest("hex"),
      };
      const blocked = buildRollingStandalonePlans(input(cwd, env, accepted, {
        available_capacity: 2,
        existing_tickets: [mismatched],
        select_unit: selectedHigh,
      }));
      assert.deepEqual(blocked.represented_units, ["unit.alpha@1"]);
      assert.equal(blocked.plans.some((plan) => plan.ticket.rolling_unit_lineage?.unit_key === "unit.alpha"), false);
      assert.equal(blocked.selection.blockers["unit.alpha@1"]?.[0]?.code, "ROLLING_LINEAGE_MISMATCH");
      assertNoPersistence(cwd, env);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("rolling capacity refill materialization", () => {
  it("materializes non-empty entries once and forwards env and materialization options", async () => {
    const { cwd, env } = fixture();
    try {
      const calls: Array<{
        cwd: string;
        entries: TicketMaterializationBatchEntry[];
        options: TicketMaterializationBatchOptions;
      }> = [];
      const onComplete = () => undefined;
      const materialization = { safety: {}, onComplete };
      const materializer = async (
        materializerCwd: string,
        entries: TicketMaterializationBatchEntry[],
        options: TicketMaterializationBatchOptions,
      ): Promise<SpawnTicket[]> => {
        calls.push({ cwd: materializerCwd, entries, options });
        return entries.map((entry) => entry.planned.ticket);
      };

      const result = await refillRollingCapacity(input(cwd, env, [delta("delta-base", [unit("unit.alpha")])], {
        materialization,
        materializer,
      }));

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.cwd, cwd);
      assert.strictEqual(calls[0]?.entries, result.entries);
      assert.strictEqual(calls[0]?.options.env, env);
      assert.strictEqual(calls[0]?.options.safety, materialization.safety);
      assert.strictEqual(calls[0]?.options.onComplete, onComplete);
      assert.deepEqual(result.materialized, result.plans.map((plan) => plan.ticket));
      assertNoPersistence(cwd, env);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not call the materializer when capacity is zero or every unit is represented", async () => {
    const { cwd, env } = fixture();
    try {
      let calls = 0;
      const materializer = async (
        _materializerCwd: string,
        entries: TicketMaterializationBatchEntry[],
        _options: TicketMaterializationBatchOptions,
      ): Promise<SpawnTicket[]> => {
        calls += 1;
        return entries.map((entry) => entry.planned.ticket);
      };
      const accepted = [delta("delta-base", [unit("unit.alpha")])];
      const zero = await refillRollingCapacity(input(cwd, env, accepted, {
        available_capacity: 0,
        materializer,
      }));
      assert.deepEqual(zero.entries, []);
      assert.deepEqual(zero.materialized, []);
      assert.equal(calls, 0);

      const seed = buildRollingStandalonePlans(input(cwd, env, accepted));
      const represented = await refillRollingCapacity(input(cwd, env, accepted, {
        existing_tickets: seed.plans.map((plan) => plan.ticket),
        materializer,
      }));
      assert.deepEqual(represented.entries, []);
      assert.deepEqual(represented.materialized, []);
      assert.deepEqual(represented.represented_units, ["unit.alpha@1"]);
      assert.equal(calls, 0);
      assertNoPersistence(cwd, env);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reads an empty workspace when existing_tickets is omitted and remains idempotent", async () => {
    const { cwd, env } = fixture();
    try {
      const calls: TicketMaterializationBatchEntry[][] = [];
      const materializer = async (
        _materializerCwd: string,
        entries: TicketMaterializationBatchEntry[],
        _options: TicketMaterializationBatchOptions,
      ): Promise<SpawnTicket[]> => {
        calls.push(entries);
        return entries.map((entry) => entry.planned.ticket);
      };
      const accepted = [delta("delta-base", [unit("unit.alpha")])];
      const first = await refillRollingCapacity(input(cwd, env, accepted, { materializer }));
      assert.equal(calls.length, 1);
      assert.equal(first.materialized.length, 1);

      const second = await refillRollingCapacity(input(cwd, env, accepted, {
        existing_tickets: first.materialized,
        materializer,
      }));
      assert.equal(calls.length, 1);
      assert.deepEqual(second.entries, []);
      assert.deepEqual(second.plans, []);
      assert.deepEqual(second.materialized, []);
      assert.deepEqual(second.represented_units, ["unit.alpha@1"]);
      assert.equal(second.selection.blockers["unit.alpha@1"]?.[0]?.code, "ALREADY_MATERIALIZED");
      assertNoPersistence(cwd, env);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects the exact materializer error without creating refill state or artifacts", async () => {
    const { cwd, env } = fixture();
    try {
      const failure = new Error("materializer failed");
      const materializer = async (
        _materializerCwd: string,
        _entries: TicketMaterializationBatchEntry[],
        _options: TicketMaterializationBatchOptions,
      ): Promise<SpawnTicket[]> => {
        throw failure;
      };
      await assert.rejects(
        () => refillRollingCapacity(input(cwd, env, [delta("delta-base", [unit("unit.alpha")])], { materializer })),
        (error: unknown) => error === failure,
      );
      assertNoPersistence(cwd, env);
      assert.equal(fs.existsSync(rollingRunsDir(cwd, env)), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("preserves an explicitly null available capacity", async () => {
    const { cwd, env } = fixture();
    try {
      const materializer = async (
        _materializerCwd: string,
        entries: TicketMaterializationBatchEntry[],
        _options: TicketMaterializationBatchOptions,
      ): Promise<SpawnTicket[]> => entries.map((entry) => entry.planned.ticket);
      const result = await refillRollingCapacity(input(cwd, env, [delta("delta-base", [unit("unit.alpha")])], {
        available_capacity: null,
        materializer,
      }));
      assert.equal(result.available_capacity, null);
      assert.equal(result.materialized.length, 1);
      assertNoPersistence(cwd, env);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
