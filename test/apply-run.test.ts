import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendApplyRun,
  createApplyRun,
  readApplyRun,
  readApplyRunPlanBody,
  statusApplyRun,
  type ApplyRunState,
} from "../src/lib/apply-run.js";
import { compiledApplyRunBodyPath, compiledApplyRunStatePath } from "../src/lib/paths.js";
import type { ApplyExecutionPlan } from "../src/lib/apply-plan.js";

function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-run-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-home-"));
  const env = { ...process.env, HOME: home, BATON_SESSION_ID: "apply-run-test-session" };
  return { cwd, env };
}
function plan(description = "original"): ApplyExecutionPlan {
  return {
    schema_version: 1,
    identity: { plan_id: "plan-1", change_id: "change-1" },
    source_snapshot: { repo_root: "/repo", revision: "head" },
    selected_tasks: ["1", "2"],
    units: [
      { id: "u1", mode: "patch-only", task_ids: ["1"], description, write_paths: ["src/a.ts"], allowed_operations: ["write"] },
      { id: "u2", mode: "patch-only", task_ids: ["2"], write_paths: ["src/b.ts"], allowed_operations: ["write"] },
    ],
  };
}
function multiUnitPlan(): ApplyExecutionPlan {
  const result = plan();
  result.selected_tasks = ["1"];
  result.units = [
    { id: "u1", mode: "patch-only", task_ids: ["1"], write_paths: ["src/a.ts"], allowed_operations: ["write"] },
    { id: "u2", mode: "patch-only", task_ids: ["1"], write_paths: ["src/b.ts"], allowed_operations: ["write"] },
  ];
  result.task_mappings = [{ task_id: "1", unit_ids: ["u1", "u2"] }];
  return result;
}
function create(input: Partial<Parameters<typeof createApplyRun>[0]> = {}) {
  const base = setup();
  const result = createApplyRun({ cwd: base.cwd, env: base.env, runId: "run-1", host: "codex", plan: plan(), ...input });
  return { ...base, result };
}

describe("compiled apply run persistence", () => {
  it("writes versioned immutable revisions and mutable state separately", () => {
    const { cwd, env, result } = create();
    assert.deepEqual(result.revisions.map((entry) => entry.revision), ["1"]);
    assert.equal(fs.existsSync(compiledApplyRunBodyPath(cwd, "run-1", "1", env)), true);
    assert.equal(fs.existsSync(compiledApplyRunStatePath(cwd, "run-1", env)), true);
    const next = appendApplyRun({ cwd, env, runId: "run-1", host: "codex", plan: plan("successor"), parent_revision: result.current_revision, parent_fingerprint: result.current_fingerprint });
    assert.equal(next.current_revision, "2");
    assert.deepEqual(result.revisions.map((entry) => entry.revision), ["1"]);
    assert.deepEqual(next.revisions.map((entry) => entry.revision), ["1", "2"]);
    assert.equal(readApplyRunPlanBody(cwd, "run-1", "1", env).units[0]!.description, "original");
  });

  it("removes a newly written revision body when the state update fails", () => {
    const { cwd, env, result } = create();
    const statePath = compiledApplyRunStatePath(cwd, "run-1", env);
    const revisionPath = compiledApplyRunBodyPath(cwd, "run-1", "2", env);
    const rename = fs.renameSync;
    const failure = new Error("injected state write failure");
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (String(destination) === statePath) throw failure;
      return rename(source, destination);
    }) as typeof fs.renameSync;
    try {
      assert.throws(
        () => appendApplyRun({ cwd, env, runId: "run-1", host: "codex", plan: plan("successor"), parent_revision: result.current_revision, parent_fingerprint: result.current_fingerprint }),
        failure,
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.existsSync(revisionPath), false);
    assert.equal(appendApplyRun({ cwd, env, runId: "run-1", host: "codex", plan: plan("successor"), parent_revision: result.current_revision, parent_fingerprint: result.current_fingerprint }).current_revision, "2");
  });

  it("does not infer acceptance from completed ticket facts", () => {
    const { cwd, env } = create({ ticket_facts: [{ ticket_id: "ticket-1", status: "running", unit_ids: ["u1"], model_id: "gpt" }] });
    assert.equal(readApplyRun(cwd, "run-1", { env }).unit_state.u1!.status, "running");
    const held = statusApplyRun(cwd, "run-1", { env, ticket_facts: [{ ticket_id: "ticket-1", status: "completed", unit_ids: ["u1"], model_id: "gpt" }] });
    assert.equal(held.unit_status.u1, "terminal-unreleased");
    const released = statusApplyRun(cwd, "run-1", { env, ticket_facts: [{ ticket_id: "ticket-1", status: "completed", unit_ids: ["u1"], model_id: "gpt", slot_released_at: "2026-01-01T00:00:00Z" }] });
    assert.equal(released.unit_status.u1, "terminal-unreleased");
    assert.equal(released.task_status["1"], "terminal-unreleased");
    assert.deepEqual(released.terminal_unreleased_tickets, []);
    assert.equal(readApplyRun(cwd, "run-1", { env, ticket_facts: [{ ticket_id: "ticket-1", status: "completed", unit_ids: ["u1"], model_id: "gpt", slot_released_at: "2026-01-01T00:00:00Z" }] }).unit_state.u1!.frozen_execution_facts?.slot_released_at, "2026-01-01T00:00:00Z");

    // Simulate the parent acceptance API's persisted decision, then replay
    // the same ticket fact. Reconstruction must retain that decision.
    const statePath = compiledApplyRunStatePath(cwd, "run-1", env);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as ApplyRunState;
    persisted.unit_state.u1!.status = "accepted";
    fs.writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
    assert.equal(readApplyRun(cwd, "run-1", { env, ticket_facts: [{ ticket_id: "ticket-1", status: "completed", unit_ids: ["u1"], model_id: "gpt", slot_released_at: "2026-01-01T00:00:00Z" }] }).unit_state.u1!.status, "accepted");
  });

  it("keeps multi-unit task aggregation pending until every unit is parent-accepted", () => {
    const { cwd, env } = create({ plan: multiUnitPlan(), ticket_facts: [{ ticket_id: "ticket-1", status: "completed", unit_ids: ["u1"], model_id: "gpt", slot_released_at: "2026-01-01T00:00:00Z" }] });
    const statePath = compiledApplyRunStatePath(cwd, "run-1", env);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as ApplyRunState;
    persisted.unit_state.u1!.status = "accepted";
    fs.writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
    assert.notEqual(readApplyRun(cwd, "run-1", { env }).task_state["1"]!.status, "accepted");

    const completed = JSON.parse(fs.readFileSync(statePath, "utf8")) as ApplyRunState;
    completed.unit_state.u2!.status = "accepted";
    fs.writeFileSync(statePath, `${JSON.stringify(completed, null, 2)}\n`);
    assert.equal(readApplyRun(cwd, "run-1", { env }).task_state["1"]!.status, "accepted");
  });

  it("keeps task execution facts separate across multiple mapped units", () => {
    const { cwd, env, result } = create({
      plan: multiUnitPlan(),
      ticket_facts: [
        { ticket_id: "ticket-u1", status: "queued", unit_ids: ["u1"], task_ids: ["1"] },
        { ticket_id: "ticket-u2", status: "queued", unit_ids: ["u2"], task_ids: ["1"] },
      ],
    });

    assert.deepEqual(result.task_state["1"]!.ticket_ids, ["ticket-u1", "ticket-u2"]);
    assert.equal(result.task_state["1"]!.frozen_execution_facts, null);
    const queued = statusApplyRun(cwd, "run-1", { env });
    assert.equal(queued.unit_status.u1, "materialized");
    assert.equal(queued.unit_status.u2, "materialized");
    assert.equal(queued.task_status["1"], "materialized");

    const statePath = compiledApplyRunStatePath(cwd, "run-1", env);
    const firstAccepted = JSON.parse(fs.readFileSync(statePath, "utf8")) as ApplyRunState;
    firstAccepted.unit_state.u1!.status = "accepted";
    fs.writeFileSync(statePath, `${JSON.stringify(firstAccepted, null, 2)}\n`);
    assert.equal(statusApplyRun(cwd, "run-1", { env }).task_status["1"], "materialized");

    const bothAccepted = JSON.parse(fs.readFileSync(statePath, "utf8")) as ApplyRunState;
    bothAccepted.unit_state.u2!.status = "accepted";
    fs.writeFileSync(statePath, `${JSON.stringify(bothAccepted, null, 2)}\n`);
    const accepted = statusApplyRun(cwd, "run-1", { env });
    assert.equal(accepted.task_status["1"], "accepted");
    assert.equal(readApplyRun(cwd, "run-1", { env }).task_state["1"]!.frozen_execution_facts, null);
  });

  it("preserves failure facts when state is reconstructed", () => {
    for (const status of ["errored", "timed_out", "closed"] as const) {
      const { cwd, env } = create({ ticket_facts: [{ ticket_id: `ticket-${status}`, status, unit_ids: ["u1"] }] });
      assert.equal(readApplyRun(cwd, "run-1", { env, ticket_facts: [{ ticket_id: `ticket-${status}`, status, unit_ids: ["u1"] }] }).unit_state.u1!.status, "failed");
    }
  });

  it("rejects stale parents, duplicate facts, and foreign-session reconnects", () => {
    const { cwd, env, result } = create();
    assert.throws(() => appendApplyRun({ cwd, env, runId: "run-1", host: "codex", plan: plan(), parent_revision: "0", parent_fingerprint: result.current_fingerprint }), (error: unknown) => (error as { code?: string }).code === "RUN_PARENT_MISMATCH");
    assert.throws(() => createApplyRun({ cwd, env, runId: "run-2", host: "codex", plan: plan(), ticket_facts: [{ ticket_id: "x", status: "queued" }, { ticket_id: "x", status: "queued" }] }), (error: unknown) => (error as { code?: string }).code === "DUPLICATE_TICKET_FACT");
    const foreign = { ...env, BATON_SESSION_ID: "foreign-session" };
    assert.throws(() => readApplyRun(cwd, "run-1", { env: foreign }), (error: unknown) => (error as { code?: string }).code === "SESSION_SCOPE_MISMATCH");
  });

  it("freezes materialized plan and execution facts but permits undispatched replacement", () => {
    const first = create({ ticket_facts: [{ ticket_id: "ticket-1", status: "running", unit_ids: ["u1"], model_id: "gpt" }] });
    assert.throws(() => appendApplyRun({ cwd: first.cwd, env: first.env, runId: "run-1", host: "codex", plan: plan("changed-active"), parent_revision: first.result.current_revision, parent_fingerprint: first.result.current_fingerprint }), (error: unknown) => (error as { code?: string }).code === "RUN_UNIT_IMMUTABLE_CHANGE");
    const second = create();
    const replacement = plan(); replacement.units[1] = { ...replacement.units[1]!, id: "u2-replaced", description: "new", write_paths: ["src/c.ts"] };
    const next = appendApplyRun({ cwd: second.cwd, env: second.env, runId: "run-1", host: "codex", plan: replacement, parent_revision: second.result.current_revision, parent_fingerprint: second.result.current_fingerprint });
    assert.equal(next.unit_state.u2!.status, "superseded");
    assert.equal(next.unit_state["u2-replaced"]!.status, "undispatched");
    assert.ok(next.superseded_ids.includes("u2"));
  });

  it("does not leave a run when the initial plan is invalid", () => {
    const { cwd, env } = setup();
    assert.throws(() => createApplyRun({ cwd, env, runId: "invalid", host: "codex", plan: { ...plan(), units: [] } as ApplyExecutionPlan }));
    assert.equal(fs.existsSync(compiledApplyRunStatePath(cwd, "invalid", env)), false);
  });
});
