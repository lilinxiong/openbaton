import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireOwnedLock } from "../src/lib/owned-lock.js";
import { OpenSpecError, resolveOpenSpecApplyInstructions } from "../src/lib/openspec.js";
import { OpenSpecTaskSourceAdapter } from "../src/lib/openspec/task-source.js";
import type { TaskSourceDescriptor } from "../src/lib/rolling-plan.js";

function fixture(outputTasks = [{ id: "77", description: "1.1 First", done: false }, { id: "78", description: "1.2 Second", done: false }]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-openspec-source-"));
  const changeDir = path.join(cwd, "openspec", "changes", "demo");
  fs.mkdirSync(changeDir, { recursive: true });
  const tasksPath = path.join(changeDir, "tasks.md");
  fs.writeFileSync(tasksPath, "## Work\n\n- [ ] 1.1 First\n- [ ] 1.2 Second\n");
  fs.writeFileSync(path.join(changeDir, "proposal.md"), "# Proposal\n");
  const runner = () => ({ status: 0, stdout: JSON.stringify({ changeName: "demo", changeDir, schemaName: "spec-driven", contextFiles: { tasks: [tasksPath], proposal: [path.join(changeDir, "proposal.md")] }, tasks: outputTasks, instruction: "continue" }), stderr: "" });
  const source: TaskSourceDescriptor = { schema_version: 1, source_kind: "openspec", adapter: "openspec", selection: { change: "demo", cwd }, source_ref: { change: "demo" } };
  return { cwd, changeDir, tasksPath, runner, source };
}

describe("OpenSpec stable task source", () => {
  it("keeps Markdown number as identity while retaining a different apply ordinal", () => {
    const f = fixture();
    const instructions = resolveOpenSpecApplyInstructions(f.cwd, "demo", { cli: "/fake/openspec", runner: f.runner });
    assert.equal(instructions.selectedTasks[0].number, "1.1");
    assert.equal(instructions.selectedTasks[0].applyOrdinal, 77);
    const adapter = new OpenSpecTaskSourceAdapter({ runner: f.runner, cli: "/fake/openspec" });
    const result = adapter.discover({ source: f.source, limit: 10 });
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(result.value.entries[0].task_key, "openspec:demo:1.1");
      assert.equal(result.value.entries[0].apply_ordinal, 77);
      assert.equal(result.value.entries[0].metadata?.apply_id, "77");
    }
  });

  it("does not treat apply id reallocation as OpenSpec source drift", () => {
    const f = fixture();
    let ids = ["77", "78"];
    const runner = () => ({
      status: 0,
      stdout: JSON.stringify({
        changeName: "demo",
        changeDir: f.changeDir,
        schemaName: "spec-driven",
        contextFiles: { tasks: [f.tasksPath], proposal: [path.join(f.changeDir, "proposal.md")] },
        tasks: ids.map((id, index) => ({ id, description: `${index === 0 ? "1.1 First" : "1.2 Second"}`, done: false })),
        instruction: "continue",
      }),
      stderr: "",
    });
    const adapter = new OpenSpecTaskSourceAdapter({ runner, cli: "/fake/openspec" });
    const first = adapter.discover({ source: f.source, limit: 10 });
    assert.equal(first.status, "available");
    if (first.status !== "available") return;
    ids = ["177", "178"];
    const second = adapter.discover({ source: f.source, limit: 10 });
    assert.equal(second.status, "available");
    if (second.status !== "available") return;
    assert.equal(second.value.entries[0]?.fingerprint, first.value.entries[0]?.fingerprint);
    assert.notEqual(second.value.entries[0]?.metadata?.apply_id, first.value.entries[0]?.metadata?.apply_id);
  });

  it("rejects missing and duplicate/contradictory mappings", () => {
    const missing = fixture([{ id: "1", description: "First", done: false }]);
    assert.throws(() => resolveOpenSpecApplyInstructions(missing.cwd, "demo", { cli: "/fake/openspec", runner: missing.runner }), (error) => error instanceof OpenSpecError && error.code === "TASK_NUMBER_MISSING");
    const duplicate = fixture([{ id: "1", description: "1.1 First", done: false }, { id: "2", description: "1.1 First again", done: false }]);
    assert.throws(() => resolveOpenSpecApplyInstructions(duplicate.cwd, "demo", { cli: "/fake/openspec", runner: duplicate.runner }), (error) => error instanceof OpenSpecError && error.code === "TASK_MAPPING_DUPLICATE");
    const contradictory = fixture([{ id: "1", number: "9.9", description: "1.1 First", done: false }]);
    assert.throws(() => resolveOpenSpecApplyInstructions(contradictory.cwd, "demo", { cli: "/fake/openspec", runner: contradictory.runner }), (error) => error instanceof OpenSpecError && error.code === "TASK_MAPPING_CONTRADICTORY");
  });

  it("reports unavailable source locally, locks writeback, and is idempotent", async () => {
    const f = fixture();
    const unavailable = new OpenSpecTaskSourceAdapter({ cwd: f.cwd, cli: null });
    const unavailableResult = await unavailable.discover({ source: f.source, limit: 1 });
    assert.equal(unavailableResult.status, "unavailable");
    const adapter = new OpenSpecTaskSourceAdapter({ runner: f.runner, cli: "/fake/openspec" });
    const page = await adapter.discover({ source: f.source, limit: 1 });
    assert.equal(page.status, "available");
    if (page.status !== "available") return;
    const entry = page.value.entries[0];
    const lock = acquireOwnedLock(`${f.tasksPath}.baton.lock`, { operation: "test-lock" });
    try {
      const locked = await adapter.reconcile({ source: f.source, task_key: entry.task_key, conclusion: "accepted", expected_source_fingerprint: entry.source_fingerprint });
      assert.equal(locked.status, "unavailable");
      assert.equal(locked.diagnostics[0]?.code, "LEDGER_LOCKED");
    } finally { lock.release(); }
    fs.chmodSync(f.tasksPath, 0o664);
    const first = await adapter.reconcile({ source: f.source, task_key: entry.task_key, conclusion: "accepted", expected_source_fingerprint: entry.source_fingerprint });
    assert.equal(first.status, "available");
    if (first.status !== "available") return;
    assert.equal(fs.statSync(f.tasksPath).mode & 0o777, 0o664);
    const second = await adapter.reconcile({ source: f.source, task_key: entry.task_key, conclusion: "accepted", expected_source_fingerprint: entry.source_fingerprint });
    assert.equal(second.status, "available");
    fs.appendFileSync(f.tasksPath, "\n");
    const changed = adapter.reconcile({ source: f.source, task_key: "openspec:demo:1.2", conclusion: "accepted", expected_source_fingerprint: entry.source_fingerprint });
    assert.equal(changed.status, "unavailable");
    assert.equal(changed.diagnostics[0]?.code, "TASK_LEDGER_CHANGED");
  });

  it("atomically reconciles one shared ledger and replays a mixed complete/pending batch", async () => {
    const f = fixture([{ id: "77", description: "1.1 First", done: true }, { id: "78", description: "1.2 Second", done: false }]);
    fs.writeFileSync(f.tasksPath, "## Work\n\n- [x] 1.1 First\n  - conclusion: first accepted\n- [ ] 1.2 Second\n");
    const adapter = new OpenSpecTaskSourceAdapter({ runner: f.runner, cli: "/fake/openspec" });
    const page = adapter.discover({ source: f.source, limit: 10 });
    assert.equal(page.status, "available");
    if (page.status !== "available") return;
    const first = page.value.entries.find((entry) => entry.display_id === "1.1")!;
    const second = page.value.entries.find((entry) => entry.display_id === "1.2")!;
    const request = {
      source: f.source,
      items: [
        { task_key: first.task_key, conclusion: "first accepted", expected_source_fingerprint: first.source_fingerprint, expected_source_state: first.source_state },
        { task_key: second.task_key, conclusion: "second accepted", expected_source_fingerprint: second.source_fingerprint, expected_source_state: second.source_state },
      ],
    };
    const reconciled = adapter.reconcile_batch(request);
    assert.equal(reconciled.status, "available");
    const bytes = fs.readFileSync(f.tasksPath, "utf8");
    assert.match(bytes, /- \[x\] 1\.1 First\n  - conclusion: first accepted/);
    assert.match(bytes, /- \[x\] 1\.2 Second\n  - conclusion: second accepted/);
    const replay = adapter.reconcile_batch(request);
    assert.equal(replay.status, "available");
    assert.equal(fs.readFileSync(f.tasksPath, "utf8"), bytes);
  });

  it("rejects distinct key forms that resolve to the same Markdown task", () => {
    const f = fixture();
    const adapter = new OpenSpecTaskSourceAdapter({ runner: f.runner, cli: "/fake/openspec" });
    const page = adapter.discover({ source: f.source, limit: 10 });
    assert.equal(page.status, "available");
    if (page.status !== "available") return;
    const first = page.value.entries[0]!;
    assert.throws(() => adapter.reconcile_batch({
      source: f.source,
      items: [
        { task_key: first.task_key, conclusion: "first", expected_source_fingerprint: first.source_fingerprint, expected_source_state: first.source_state },
        { task_key: "1.1", conclusion: "duplicate", expected_source_fingerprint: first.source_fingerprint, expected_source_state: first.source_state },
      ],
    }), (error: unknown) => error instanceof OpenSpecError && error.code === "TASK_ID_AMBIGUOUS");
  });
});
