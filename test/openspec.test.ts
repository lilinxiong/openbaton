import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenSpecError, parseTasks, readOpenSpecStatus, writeTaskConclusion, writeTaskConclusionByNumber } from "../src/lib/openspec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures/openspec/changes/demo/tasks.md");

describe("parseTasks + writeTaskConclusion", () => {
  it("retries status with the sole change for OpenSpec CLIs that require --change", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-openspec-status-"));
    const change = path.join(cwd, "openspec", "changes", "incident-audit");
    fs.mkdirSync(change, { recursive: true });
    fs.writeFileSync(path.join(change, "tasks.md"), "- [ ] 1.1 Verify incidents\n");
    const calls: string[][] = [];
    const status = readOpenSpecStatus(cwd, {
      cli: "/fake/openspec",
      runner: (_command, args) => {
        calls.push(args);
        return args.includes("--change")
          ? { status: 0, stdout: "incident-audit 0/1 complete\n", stderr: "- Loading change status...\n" }
          : { status: 1, stdout: "", stderr: "Missing required option --change" };
      },
    });
    assert.equal(status.ok, true);
    assert.equal(status.text, "incident-audit 0/1 complete");
    assert.deepEqual(calls, [["status"], ["status", "--change", "incident-audit"]]);
  });

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
