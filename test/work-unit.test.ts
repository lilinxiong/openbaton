import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerPrompt,
  compilePatchOnlyWorkUnit,
  compileVerificationOnlyWorkUnit,
  compileWorkUnit,
  coordinationFor,
} from "../src/lib/work-unit.js";

describe("work-unit contract", () => {
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
    assert.match(buildWorkerPrompt(unit.objective, unit, coordination), /phase, current result, next step, blocker/);
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
  });
});
