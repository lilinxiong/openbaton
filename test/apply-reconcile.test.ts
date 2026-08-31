import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApplyRun } from "../src/lib/apply-run.js";
import { acceptApplyGate, acceptApplyUnit, deriveApplyTaskEligibility, reconcileApplyRun } from "../src/lib/apply-reconcile.js";
import { compiledApplyRunStatePath } from "../src/lib/paths.js";
import type { ApplyExecutionPlan } from "../src/lib/apply-plan.js";

function fixture(options: { sourceSnapshot?: Record<string, unknown>; ticketFacts?: any[]; unitMode?: "patch-only" | "verification-only"; unitWritePaths?: string[] } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-reconcile-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-reconcile-home-"));
  const env = { ...process.env, HOME: home, BATON_SESSION_ID: "reconcile-session" };
  const change = path.join(cwd, "openspec", "changes", "demo"); fs.mkdirSync(change, { recursive: true });
  const tasksPath = path.join(change, "tasks.md"); fs.writeFileSync(tasksPath, "## Work\n\n- [ ] 1.1 Split\n- [ ] 1.2 Gate\n");
  const plan: ApplyExecutionPlan = {
    schema_version: 1, identity: { plan_id: "plan", change_id: "demo" }, source_snapshot: { repo_root: cwd, revision: "head" }, selected_tasks: ["1.1", "1.2"],
    units: [options.unitMode === "verification-only"
      ? { id: "u1", mode: "verification-only", task_ids: ["1.1"], verification: ["inspect"] }
      : { id: "u1", mode: "patch-only", task_ids: ["1.1"], write_paths: options.unitWritePaths || ["src/a.ts"], allowed_operations: ["write"], patch: "apply" }],
    parent_gates: [{ id: "g1", task_ids: ["1.2"], unit_ids: ["u1"] }],
  };
  if (options.sourceSnapshot) plan.source_snapshot = { ...plan.source_snapshot, ...options.sourceSnapshot } as ApplyExecutionPlan["source_snapshot"];
  createApplyRun({ cwd, env, runId: "run", host: "codex", plan, ticket_facts: options.ticketFacts });
  return { cwd, env, tasksPath, plan };
}

describe("compiled apply parent acceptance", () => {
  it("accepts exact terminal unit evidence, gate evidence, and reconciles atomically", () => {
    const f = fixture();
    const lineage = { run_id: "run", plan_revision: "1", plan_fingerprint: "", unit_id: "u1", task_refs: ["1.1"], mode: "patch-only" as const };
    // The fingerprint is filled from the persisted run identity.
    const runState = JSON.parse(fs.readFileSync(compiledApplyRunStatePath(f.cwd, "run", f.env), "utf8"));
    lineage.plan_fingerprint = runState.current_fingerprint;
    const ticket = { id: "ticket-1", status: "completed", receipt_id: "receipt-1", model_id: "model", compiled_apply_lineage: lineage, safety_verdict: { accepted: true, violations: [] }, conclusion: "done" } as any;
    const receipt = { ticket_id: "ticket-1", receipt_id: "receipt-1", compiled_apply_lineage: lineage } as any;
    assert.equal(acceptApplyUnit({ cwd: f.cwd, env: f.env, runId: "run", unitId: "u1", ticketId: "ticket-1", receiptId: "receipt-1", ticket, receipt }).accepted, true);
    assert.equal(acceptApplyGate({ cwd: f.cwd, env: f.env, runId: "run", gateId: "g1", evidence: "validated\nparent" }).accepted, true);
    assert.deepEqual(deriveApplyTaskEligibility({ cwd: f.cwd, env: f.env, runId: "run", tasksPath: f.tasksPath }).filter((x) => x.eligible).map((x) => x.task_id), ["1.1", "1.2"]);
    const result = reconcileApplyRun({ cwd: f.cwd, env: f.env, runId: "run", tasksPath: f.tasksPath });
    assert.deepEqual(result.task_ids, ["1.1", "1.2"]);
    assert.match(fs.readFileSync(f.tasksPath, "utf8"), /- \[x\] 1\.1 Split[\s\S]*- conclusion:/);
    const retry = reconcileApplyRun({ cwd: f.cwd, env: f.env, runId: "run", tasksPath: f.tasksPath });
    assert.equal(retry.reconciled, true);
  });

  it("resolves the ledger relative to the target cwd when process.cwd differs", () => {
    const f = fixture();
    const original = process.cwd();
    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "baton-reconcile-cwd-"));
    try {
      process.chdir(unrelated);
      const eligibility = deriveApplyTaskEligibility({ cwd: f.cwd, env: f.env, runId: "run", tasksPath: "openspec/changes/demo/tasks.md" });
      assert.deepEqual(eligibility.map((item) => item.task_id), ["1.1", "1.2"]);
    } finally {
      process.chdir(original);
      fs.rmSync(unrelated, { recursive: true, force: true });
    }
  });

  it("rejects an explicitly mismatched task-ledger SHA with a stable error code", () => {
    const f = fixture();
    assert.throws(
      () => reconcileApplyRun({ cwd: f.cwd, env: f.env, runId: "run", expectedLedgerSha256: "sha256-does-not-match" }),
      (error: unknown) => (error as { code?: string }).code === "TASK_LEDGER_CHANGED",
    );
  });

  it("does not compare the aggregate source fingerprint with the raw tasks.md SHA", () => {
    const f = fixture({
      sourceSnapshot: { fingerprint: "aggregate-compiled-source-fingerprint" },
    });
    const runState = JSON.parse(fs.readFileSync(compiledApplyRunStatePath(f.cwd, "run", f.env), "utf8"));
    const lineage = { run_id: "run", plan_revision: runState.current_revision, plan_fingerprint: runState.current_fingerprint, unit_id: "u1", task_refs: ["1.1"], mode: "patch-only" as const };
    const ticket = {
      id: "ticket-1",
      status: "completed",
      receipt_id: "receipt-1",
      model_id: "model",
      compiled_apply_lineage: lineage,
      safety_verdict: { accepted: true, violations: [] },
      conclusion: "done",
    } as any;
    const receipt = {
      ticket_id: "ticket-1",
      receipt_id: "receipt-1",
      compiled_apply_lineage: lineage,
    } as any;
    const accepted = acceptApplyUnit({ cwd: f.cwd, env: f.env, runId: "run", unitId: "u1", ticketId: ticket.id, receiptId: receipt.receipt_id, ticket, receipt });
    assert.equal(accepted.accepted, true);
    const result = reconcileApplyRun({ cwd: f.cwd, env: f.env, runId: "run" });
    assert.deepEqual(result.task_ids, ["1.1"]);
    assert.equal(result.reconciled, true);
  });

  it("accepts a verification-only unit with a strict read-only ticket and Receipt without a safety verdict", () => {
    const f = fixture({ unitMode: "verification-only" });
    const runState = JSON.parse(fs.readFileSync(compiledApplyRunStatePath(f.cwd, "run", f.env), "utf8"));
    const lineage = { run_id: "run", plan_revision: "1", plan_fingerprint: runState.current_fingerprint, unit_id: "u1", task_refs: ["1.1"], mode: "verification-only" as const };
    const ticket = { id: "ticket-read", status: "completed", receipt_id: "receipt-read", model_id: "model", mode: "read-only", read_only: true, compiled_apply_lineage: lineage, conclusion: "verified" } as any;
    const receipt = { ticket_id: "ticket-read", receipt_id: "receipt-read", compiled_apply_lineage: lineage, execution: { mode: "read-only" }, baseline: null, commit_baseline: null, scope: { write_allowlist: [], allowed_operations: ["read"] } } as any;
    const result = acceptApplyUnit({ cwd: f.cwd, env: f.env, runId: "run", unitId: "u1", ticketId: ticket.id, receiptId: receipt.receipt_id, ticket, receipt });
    assert.equal(result.accepted, true);
    assert.equal(ticket.safety_verdict, undefined);
  });

  it("still blocks a patch-only unit when no Git safety audit is provided", () => {
    const f = fixture();
    const runState = JSON.parse(fs.readFileSync(compiledApplyRunStatePath(f.cwd, "run", f.env), "utf8"));
    const lineage = { run_id: "run", plan_revision: "1", plan_fingerprint: runState.current_fingerprint, unit_id: "u1", task_refs: ["1.1"], mode: "patch-only" as const };
    const ticket = { id: "ticket-no-audit", status: "completed", receipt_id: "receipt-no-audit", model_id: "model", compiled_apply_lineage: lineage, conclusion: "done" } as any;
    const receipt = { ticket_id: "ticket-no-audit", receipt_id: "receipt-no-audit", compiled_apply_lineage: lineage } as any;
    const result = acceptApplyUnit({ cwd: f.cwd, env: f.env, runId: "run", unitId: "u1", ticketId: ticket.id, receiptId: receipt.receipt_id, ticket, receipt });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "SAFETY_NOT_ACCEPTED");
  });

  it("rejects a relative write scope that resolves to a custom task ledger", () => {
    const ledger = path.join("custom", "checklist.md");
    const f = fixture({ sourceSnapshot: { tasks_path: ledger }, unitWritePaths: [ledger] });
    const runState = JSON.parse(fs.readFileSync(compiledApplyRunStatePath(f.cwd, "run", f.env), "utf8"));
    const lineage = { run_id: "run", plan_revision: "1", plan_fingerprint: runState.current_fingerprint, unit_id: "u1", task_refs: ["1.1"], mode: "patch-only" as const };
    const ticket = { id: "ticket-ledger", status: "completed", receipt_id: "receipt-ledger", model_id: "model", compiled_apply_lineage: lineage, safety_verdict: { accepted: true, violations: [] }, conclusion: "done" } as any;
    const receipt = { ticket_id: ticket.id, receipt_id: ticket.receipt_id, compiled_apply_lineage: lineage, scope: { write_allowlist: [ledger] } } as any;
    assert.throws(
      () => acceptApplyUnit({ cwd: f.cwd, env: f.env, runId: "run", unitId: "u1", ticketId: ticket.id, receiptId: receipt.receipt_id, ticket, receipt }),
      (error: unknown) => (error as { code?: string }).code === "SAFETY_NOT_ACCEPTED",
    );
  });

  it("rejects a verification-only Receipt with write authority", () => {
    const f = fixture({ unitMode: "verification-only" });
    const runState = JSON.parse(fs.readFileSync(compiledApplyRunStatePath(f.cwd, "run", f.env), "utf8"));
    const lineage = { run_id: "run", plan_revision: "1", plan_fingerprint: runState.current_fingerprint, unit_id: "u1", task_refs: ["1.1"], mode: "verification-only" as const };
    const ticket = { id: "ticket-write-receipt", status: "completed", receipt_id: "receipt-write-receipt", model_id: "model", mode: "read-only", read_only: true, compiled_apply_lineage: lineage, conclusion: "verified" } as any;
    const receipt = { ticket_id: ticket.id, receipt_id: ticket.receipt_id, compiled_apply_lineage: lineage, execution: { mode: "write" }, baseline: {}, commit_baseline: null, scope: { write_allowlist: ["src/a.ts"], allowed_operations: ["write"] } } as any;
    const result = acceptApplyUnit({ cwd: f.cwd, env: f.env, runId: "run", unitId: "u1", ticketId: ticket.id, receiptId: receipt.receipt_id, ticket, receipt });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "SAFETY_NOT_ACCEPTED");
  });
});
