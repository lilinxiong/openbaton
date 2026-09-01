import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCommitReceipt,
  buildReadOnlyReceipt,
  buildWriteReceipt,
  normalizeReceipt,
  normalizeRollingUnitLineage,
  ReceiptError,
  validateTicketReceiptLineage,
} from "../src/lib/receipt.js";
import {
  buildWorkerPrompt,
  compileRollingWorkUnit,
  compileWorkUnit,
  coordinationFor,
} from "../src/lib/work-unit.js";

const fingerprint = "a".repeat(64);
const rolling = {
  schema_version: 1 as const,
  run_id: "run-1",
  unit_key: "unit-1",
  unit_version: 2,
  unit_fingerprint: fingerprint,
  task_keys: ["task-a", "task-b"],
  mode: "verification-only" as const,
};

const writeBaseline = {
  repo_root: "/repo", head: "a".repeat(40), branch: "main", branch_ref: "refs/heads/main",
  index_path: "/repo/.git/index", index_tree: "b".repeat(40), index_control_checksum: "c".repeat(64),
  index_control_algorithm: "git-index-control-framed-sha256-v2", index_control_entry_count: 0,
  staged_paths: [], refs: [], head_reflog_count: 0, head_reflog_checksum: "d".repeat(64),
  dirty_entries: [], dirty_checksums: {}, captured_at: "2026-08-21T00:00:00.000Z",
};

describe("rolling lineage and schema-3 work-unit contract", () => {
  it("normalizes the exact immutable lineage and rejects run-wide identity", () => {
    const normalized = normalizeRollingUnitLineage(rolling);
    assert.deepEqual(Object.keys(normalized), ["schema_version", "run_id", "unit_key", "unit_version", "unit_fingerprint", "task_keys", "mode"]);
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.task_keys), true);
    assert.throws(() => normalizeRollingUnitLineage({ ...rolling, append_sequence: 4 }), (error) => error instanceof ReceiptError && error.code === "ROLLING_LINEAGE_UNKNOWN_FIELD");
    assert.throws(() => normalizeRollingUnitLineage({ ...rolling, task_keys: ["task-b", "task-a"] }), (error) => error instanceof ReceiptError && error.code === "ROLLING_LINEAGE_TASK_KEYS_UNSORTED");
  });

  it("validates schema-3 mode scope and round-trips only its exact fields", () => {
    assert.throws(() => compileRollingWorkUnit({
      schema_version: 3,
      kind: "concrete",
      objective: "verify the unit",
      deliverable: "verification evidence",
      done_when: "the evidence is captured",
      mode: "verification-only",
      rolling_unit_lineage: rolling,
      read_context: ["src/a.ts"],
      write_paths: [],
      allowed_operations: [],
      completion_criteria: ["the check passes"],
      permitted_validation: ["bun test"],
      coordination: "terminal-only",
      run_revision: "forbidden",
    } as any), /unknown field/);
    const unit = compileRollingWorkUnit({
      schema_version: 3,
      kind: "concrete",
      objective: "verify the unit",
      deliverable: "verification evidence",
      done_when: "the evidence is captured",
      mode: "verification-only",
      rolling_unit_lineage: rolling,
      read_context: ["src/a.ts"],
      write_paths: [],
      allowed_operations: [],
      completion_criteria: ["the check passes"],
      permitted_validation: ["bun test"],
      coordination: "terminal-only",
    } as any);
    assert.deepEqual(Object.keys(unit), ["schema_version", "kind", "objective", "deliverable", "done_when", "mode", "rolling_unit_lineage", "read_context", "write_paths", "allowed_operations", "completion_criteria", "permitted_validation", "coordination"]);
    assert.deepEqual(compileWorkUnit(unit), unit);
    const prompt = buildWorkerPrompt("base", unit, coordinationFor(unit));
    assert.match(prompt, /\[Baton rolling execution contract\]/);
    assert.doesNotMatch(prompt, /run_revision|delta_id|append_sequence/);
    assert.throws(() => compileRollingWorkUnit({
      ...unit,
      mode: "patch-only",
    } as any), /mode must equal/);
    assert.throws(() => compileRollingWorkUnit("patch", {
      mode: "patch-only",
      deliverable: "x",
      doneWhen: "y",
      rollingUnitLineage: rolling,
      readContext: ["src/a"],
      writePaths: ["src/a"],
      allowedOperations: ["write"],
      completionCriteria: ["x"],
      permittedValidation: ["test"],
    }), /mode must equal/);
    assert.throws(() => compileRollingWorkUnit("patch", { mode: "patch-only", deliverable: "x", doneWhen: "y", rollingUnitLineage: { ...rolling, mode: "patch-only" }, readContext: ["src/a"], writePaths: [], allowedOperations: ["write"], completionCriteria: ["x"], permittedValidation: ["test"] }), /non-empty write_paths/);
  });

  it("keeps Receipt lineages mutually exclusive and preserves rolling read/write state", () => {
    const base = buildReadOnlyReceipt({ ticketId: "rolling-ticket", card: { id: "model", strengths: "", route_id: "model/default" }, rollingUnitLineage: rolling });
    assert.deepEqual(base.rolling_unit_lineage, rolling);
    assert.throws(() => buildReadOnlyReceipt({ ticketId: "bad", card: { id: "model", strengths: "", route_id: "model/default" }, rollingUnitLineage: rolling, compiledApplyLineage: { run_id: "r", plan_revision: "1", plan_fingerprint: "p", unit_id: "u", task_refs: ["t"], mode: "verification-only" } }), /mutually exclusive/);
    assert.deepEqual(normalizeReceipt(base).rolling_unit_lineage, rolling);
    assert.equal(validateTicketReceiptLineage({ id: base.ticket_id, model_id: "model", route_id: "model/default", mode: "read-only", read_only: true, rolling_unit_lineage: rolling }, base), null);
    assert.equal(validateTicketReceiptLineage({ id: base.ticket_id, model_id: "model", route_id: "model/default", mode: "read-only", read_only: true }, base), "ROLLING_LINEAGE_MISMATCH");
    const writeBase = buildReadOnlyReceipt({ ticketId: "write-ticket", card: { id: "model", strengths: "", route_id: "model/default" }, rollingUnitLineage: { ...rolling, mode: "patch-only" } });
    const write = buildWriteReceipt({ base: writeBase, baseline: writeBaseline, writeAllowlist: ["src/a.ts"], allowedOperations: ["write"] });
    assert.equal(write.rolling_unit_lineage?.mode, "patch-only");
    assert.throws(() => buildWriteReceipt({
      base: writeBase,
      baseline: writeBaseline,
      writeAllowlist: ["src/a.ts"],
      allowedOperations: ["write"],
      rollingUnitLineage: { ...rolling, mode: "patch-only", unit_version: 3 },
    }), (error) => error instanceof ReceiptError && error.code === "ROLLING_LINEAGE_MISMATCH");
    assert.throws(() => buildCommitReceipt({ base, baseline: { ...writeBaseline, staged_tree: "e".repeat(40), staged_index_control_checksum: "c".repeat(64), staged_index_control_algorithm: "git-index-control-framed-sha256-v2", staged_index_control_entry_count: 1, staged_paths: ["src/a.ts"] } as any }), /rolling unit lineage/);
  });
});
