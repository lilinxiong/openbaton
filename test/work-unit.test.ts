import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerPrompt,
  compileWorkUnit,
  coordinationFor,
  inferWorkUnitKind,
} from "../src/lib/work-unit.js";

describe("work-unit contract", () => {
  it("keeps bounded execution terminal-only", () => {
    assert.equal(inferWorkUnitKind("implement the parser and run its unit tests"), "concrete");
    assert.equal(inferWorkUnitKind("修复登录超时并运行测试"), "concrete");
    const unit = compileWorkUnit("implement the parser and run its unit tests");
    assert.equal(coordinationFor(unit).mode, "terminal-only");
  });

  it("treats analysis and ambiguous work as deliberative with checkpoints", () => {
    assert.equal(inferWorkUnitKind("analyze the lifecycle tradeoffs"), "deliberative");
    assert.equal(inferWorkUnitKind("梳理并发模型"), "deliberative");
    assert.equal(inferWorkUnitKind("take care of this"), "deliberative");
    const unit = compileWorkUnit("analyze the lifecycle tradeoffs");
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
    assert.equal(unit.classification, "explicit");
    assert.equal(unit.deliverable, "a finding list with line references");
  });
});
