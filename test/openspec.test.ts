import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenSpecError, parseTasks, writeTaskConclusion, writeTaskConclusionByNumber } from "../src/lib/openspec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures/openspec/changes/demo/tasks.md");

describe("parseTasks + writeTaskConclusion", () => {
  it("parses pending/done/skipped and flips a checkbox with a conclusion", () => {
    const text = fs.readFileSync(fixture, "utf8");
    const tasks = parseTasks(text);
    assert.ok(tasks.length >= 12);
    const pending = tasks.filter((t) => t.status === "pending");
    const done = tasks.filter((t) => t.status === "done");
    const skipped = tasks.filter((t) => t.status === "skipped");
    assert.ok(pending.length >= 10);
    assert.equal(done.length, 1);
    assert.equal(skipped.length, 1);

    const target = pending.find((t) => t.number === "2.1");
    assert.ok(target);
    const updated = writeTaskConclusion(text, target.line_index, "login form shipped");
    assert.ok(updated);
    const lines = updated.split(/\r?\n/);
    assert.match(lines[target.line_index], /^- \[x\]\s+2\.1 /);
    assert.match(lines[target.line_index + 1], /^\s+- conclusion: login form shipped$/);

    const again = parseTasks(updated);
    const flipped = again.find((t) => t.number === "2.1");
    assert.equal(flipped.status, "done");
  });

  it("writes by stable task number after unrelated insertion", () => {
    const source = [
      "# Tasks", "", "- [ ] 1.1 First", "- [ ] 1.2 Inserted", "- [ ] 2.1 Target", "- [ ] 2.2 Later",
    ].join("\n");
    const updated = writeTaskConclusionByNumber(source, "2.1", "target accepted");
    assert.match(updated, /- \[ \] 1\.2 Inserted/);
    assert.match(updated, /- \[x\] 2\.1 Target\n  - conclusion: target accepted/);
    assert.equal(parseTasks(updated).find((task) => task.number === "1.2")?.status, "pending");
    assert.equal(parseTasks(updated).find((task) => task.number === "2.1")?.status, "done");
  });

  it("fails closed for missing or duplicate task numbers", () => {
    assert.throws(() => writeTaskConclusionByNumber("- [ ] 1.1 One", "2.1", "x"), (error) => error instanceof OpenSpecError && error.code === "TASK_ID_NOT_FOUND");
    assert.throws(() => writeTaskConclusionByNumber("- [ ] 2.1 One\n- [ ] 2.1 Two", "2.1", "x"), (error) => error instanceof OpenSpecError && error.code === "TASK_ID_AMBIGUOUS");
  });
});
