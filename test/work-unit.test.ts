import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerPrompt,
  compilePatchOnlyWorkUnit,
  compileRollingWorkUnit,
  compileVerificationOnlyWorkUnit,
  compileWorkUnit,
  coordinationFor,
} from "../src/lib/work-unit.js";
import { buildSpawnTicket, normalizeSpawnTicket, sessionTicketId, sessionUid } from "../src/lib/spawn.js";

describe("work-unit contract", () => {
  const exactRoot = {
    repository_id: "a".repeat(64),
    git_common_dir_identity: "b".repeat(64),
    execution_root: "/tmp/baton/worktrees/run/unit/attempt",
    base_tree: "c".repeat(40),
    worktree_record_id: "record-run-unit-attempt",
  } as const;
  const isolatedLineage = {
    schema_version: 1 as const,
    run_id: "rolling-run",
    unit_key: "rolling-unit",
    unit_version: 1,
    unit_fingerprint: "d".repeat(64),
    task_keys: ["director:task"],
    mode: "patch-only" as const,
    worktree_mode: "isolated-worktree" as const,
    ...exactRoot,
  };

  it("compiles one canonical isolated rolling identity across lineage and work unit", () => {
    const patchInstructions = "apply only the exact branch\nkeep trailing spaces  ";
    const unit = compileRollingWorkUnit("apply isolated patch", {
      mode: "patch-only",
      rollingUnitLineage: isolatedLineage,
      deliverable: "patch",
      doneWhen: "done",
      readContext: ["src/a.ts"],
      writePaths: ["src/a.ts"],
      allowedOperations: ["write"],
      completionCriteria: ["test passes"],
      permittedValidation: ["bun test"],
    });
    assert.equal(unit.worktree_mode, "isolated-worktree");
    for (const [field, value] of Object.entries(exactRoot)) assert.equal((unit as any)[field], value);
    assert.deepEqual(compileRollingWorkUnit(unit), unit);
    assert.throws(() => compileRollingWorkUnit({ ...unit, execution_root: "/tmp/other" }), /identity mismatch/);
    const partial = { ...unit } as any;
    delete partial.base_tree;
    assert.throws(() => compileRollingWorkUnit(partial), /partial|mismatch/);
    const prompt = buildWorkerPrompt(patchInstructions, unit, coordinationFor(unit));
    for (const [field, value] of Object.entries(exactRoot)) {
      assert.match(prompt, new RegExp(`^${field}: ${value}$`, "m"));
    }
    const framed = JSON.parse(prompt.match(/^instructions_json: (.+)$/m)?.[1] ?? "null");
    assert.equal(framed.patch_instructions, patchInstructions);
    assert.deepEqual(framed.permitted_validation, ["bun test"]);
    assert.match(prompt, /parent-only/);
    assert.match(prompt, /caller checkout or any sibling execution root/);
  });

  it("keeps explicit shared and legacy rolling identities free of isolated fields", () => {
    const sharedLineage = { ...isolatedLineage, worktree_mode: "shared-worktree" as const } as any;
    for (const field of Object.keys(exactRoot)) delete sharedLineage[field];
    const shared = compileRollingWorkUnit("verify", {
      mode: "verification-only",
      rollingUnitLineage: { ...sharedLineage, mode: "verification-only" },
      deliverable: "evidence", doneWhen: "done", readContext: ["src/a.ts"],
      completionCriteria: ["checked"], permittedValidation: ["read"],
    });
    assert.equal(shared.worktree_mode, "shared-worktree");
    assert.equal("execution_root" in shared, false);
    const sharedPrompt = buildWorkerPrompt("verify exactly", shared, coordinationFor(shared));
    assert.match(sharedPrompt, /explicit shared-worktree legacy\/manual compatibility/);
    assert.match(sharedPrompt, /parent-only/);
    assert.doesNotMatch(sharedPrompt, /^repository_id:/m);
    assert.doesNotMatch(sharedPrompt, /^git_common_dir_identity:/m);
    const forbidden = { ...shared.rolling_unit_lineage, ...exactRoot };
    assert.throws(() => compileRollingWorkUnit({ ...shared, rolling_unit_lineage: forbidden }), /shared lineage forbids/);
  });

  it("binds an isolated ticket and native handle to one acknowledged exact root", () => {
    const env = { ...process.env, BATON_SESSION_ID: "exact-root-unit-test" };
    const ticket = buildSpawnTicket({
      id: sessionTicketId("spn", sessionUid(env), 1), cwd: "/tmp", env,
      description: "apply isolated patch", prompt: "apply isolated patch", modelId: "alpha/default",
      routeId: "alpha/default", targetHost: "alpha", taskKind: "concrete",
      rollingUnitLineage: isolatedLineage, readContext: ["src/a.ts"], writePaths: ["src/a.ts"],
      allowedOperations: ["write"], completionCriteria: ["done"], permittedValidation: ["bun test"],
    });
    for (const [field, value] of Object.entries(exactRoot)) assert.equal((ticket as any)[field], value);
    ticket.execution_handle = { kind: "alpha-task", value: "native-1", source: "native-return", ...exactRoot };
    assert.deepEqual(normalizeSpawnTicket(ticket).execution_handle, ticket.execution_handle);
    assert.throws(() => normalizeSpawnTicket({
      ...ticket,
      execution_handle: { ...ticket.execution_handle!, execution_root: "/tmp/other" },
    }), /acknowledgement mismatch/);
    const partial = structuredClone(ticket) as any;
    delete partial.worktree_record_id;
    assert.throws(() => normalizeSpawnTicket(partial), /partial|mismatch/);
  });
  it("requires an explicit kind", () => {
    assert.throws(() => compileWorkUnit("implement the parser and run its unit tests" as string, undefined as never), /work unit kind is required/);
  });

  it("keeps explicitly concrete execution terminal-only", () => {
    const unit = compileWorkUnit("implement the parser and run its unit tests", { kind: "concrete" });
    assert.equal(coordinationFor(unit).mode, "terminal-only");
  });

  it("keeps explicitly deliberative work checkpointed", () => {
    const unit = compileWorkUnit("analyze the lifecycle tradeoffs", { kind: "deliberative" });
    const coordination = coordinationFor(unit);
    assert.equal(coordination.mode, "checkpointed");
    assert.equal(coordination.progress_interval_ms, 60_000);
    const prompt = buildWorkerPrompt(unit.objective, unit, coordination);
    assert.match(prompt, /phase, current result, next step, blocker/);
    assert.doesNotMatch(prompt, /\[Baton worktree worker policy\]/);
  });

  it("allows the director to make an explicit concrete contract", () => {
    const unit = compileWorkUnit("review exactly src/auth.ts for null handling", {
      kind: "concrete",
      deliverable: "a finding list with line references",
      doneWhen: "all null-producing branches are checked",
    });
    assert.equal(unit.kind, "concrete");
    assert.equal("classification" in unit, false);
    assert.equal(unit.deliverable, "a finding list with line references");
  });

  it("compiles an immutable patch-only contract with a complete scope", () => {
    const unit = compilePatchOnlyWorkUnit("apply the prescribed parser patch", {
      deliverable: "the bounded parser patch",
      doneWhen: "the patch and permitted checks are complete",
      runId: "run-17",
      planRevision: "rev-3",
      planFingerprint: "plan-sha",
      unitId: "unit-parser",
      taskRefs: ["task-parser"],
      satisfiedDependencies: ["unit-schema"],
      readContext: ["src/parser.ts", "test/parser.test.ts"],
      writePaths: ["src/parser.ts", "test/parser.test.ts"],
      allowedOperations: ["write"],
      patchRecipe: "replace the null branch with the specified guard",
      completionCriteria: ["all parser tests pass"],
      permittedValidation: ["bun test test/parser.test.ts"],
    });
    assert.equal(unit.schema_version, 2);
    assert.equal(unit.mode, "patch-only");
    assert.equal(unit.coordination, "terminal-only");
    assert.equal(Object.isFrozen(unit), true);
    assert.equal(Object.isFrozen(unit.write_paths), true);
    assert.throws(() => ((unit as any).run_id = "other"), TypeError);
    assert.deepEqual(unit.write_paths, ["src/parser.ts", "test/parser.test.ts"]);
  });

  it("compiles verification-only without any write scope", () => {
    const unit = compileVerificationOnlyWorkUnit("verify the prescribed parser patch", {
      deliverable: "verification evidence",
      doneWhen: "the permitted verification result is reported",
      runId: "run-18",
      planRevision: 4,
      planFingerprint: "plan-sha-2",
      unitId: "unit-parser-verify",
      taskRefs: ["task-parser"],
      satisfiedDependencies: [],
      readContext: ["src/parser.ts", "test/parser.test.ts"],
      patchRecipe: "do not patch; inspect the existing result",
      completionCriteria: ["the prescribed test result is captured"],
      permittedValidation: ["bun test test/parser.test.ts"],
    });
    assert.equal(unit.mode, "verification-only");
    assert.equal(unit.plan_revision, "4");
    assert.deepEqual(unit.write_paths, []);
    assert.deepEqual(unit.allowed_operations, []);
    assert.equal(coordinationFor(unit).mode, "terminal-only");
  });

  it("rejects invalid compiled write combinations", () => {
    const common = {
      deliverable: "result",
      doneWhen: "done",
      runId: "run",
      planRevision: "rev",
      planFingerprint: "fingerprint",
      unitId: "unit",
      taskRefs: ["task"],
      readContext: ["src/a.ts"],
      patchRecipe: "recipe",
      completionCriteria: ["criterion"],
      permittedValidation: ["bun test"],
    };
    assert.throws(() => compileWorkUnit("patch", { ...common, mode: "patch-only" }), /non-empty write_paths/);
    assert.throws(() => compileWorkUnit("verify", { ...common, mode: "verification-only", writePaths: ["src/a.ts"] }), /forbids/);
    assert.throws(() => compileWorkUnit("verify", { ...common, mode: "verification-only", allowedOperations: ["write"] }), /forbids/);
  });

  it("renders every compiled field deterministically and requires structured insufficiency", () => {
    const unit = compilePatchOnlyWorkUnit("apply the patch", {
      deliverable: "patch",
      doneWhen: "done",
      runId: "run",
      planRevision: "rev",
      planFingerprint: "fingerprint",
      unitId: "unit",
      taskRefs: ["task"],
      satisfiedDependencies: [],
      readContext: ["src/a.ts"],
      writePaths: ["src/a.ts"],
      allowedOperations: ["write"],
      patchRecipe: "apply exactly",
      completionCriteria: ["check passes"],
      permittedValidation: ["bun test"],
    });
    const first = buildWorkerPrompt("base", unit, coordinationFor(unit));
    const second = buildWorkerPrompt("base", unit, coordinationFor(unit));
    assert.equal(first, second);
    for (const field of ["schema_version", "objective", "deliverable", "done_when", "mode", "run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "satisfied_dependencies", "read_context", "write_paths", "allowed_operations", "patch_recipe", "completion_criteria", "permitted_validation", "coordination"]) {
      assert.match(first, new RegExp(`${field}:`));
    }
    assert.match(first, /PLAN_INSUFFICIENT/);
    assert.match(first, /file.*symbol.*missing_decision/);
    assert.match(first, /Do not spawn child agents/);
    assert.doesNotMatch(first, /\[Baton worktree worker policy\]/);
  });
});
