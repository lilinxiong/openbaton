import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasks, writeTaskConclusion } from "../src/lib/openspec.js";

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
});
