import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerPrompt,
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
});
