import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveTaskKey } from "../src/lib/rolling-plan.js";
import { DirectorTaskSourceAdapter, createDirectorTaskSourceAdapter, type DirectorTaskDefinition } from "../src/lib/director-task-source.js";

const task = (id: string, description = `work on ${id}`): DirectorTaskDefinition => ({ id, description });

describe("director task source adapter", () => {
  it("discovers a standalone task list in deterministic pages and grows append-only", async () => {
    const adapter = createDirectorTaskSourceAdapter([task("one"), task("two"), task("three")]);
    const source = adapter.sourceDescriptor({ queue: "local" });
    const first = await adapter.discover({ source, limit: 2 });
    assert.equal(first.status, "available");
    if (first.status !== "available") return;
    assert.deepEqual(first.value.entries.map((entry) => entry.display_id), ["one", "two"]);
    assert.equal(first.value.entries[0]?.task_key, deriveTaskKey("director", "one"));
    assert.equal(first.value.next_cursor, "2");

    adapter.appendTasks([task("four")]);
    const second = await adapter.discover({ source, cursor: first.value.next_cursor, limit: 2 });
    assert.equal(second.status, "available");
    if (second.status === "available") {
      assert.deepEqual(second.value.entries.map((entry) => entry.display_id), ["three", "four"]);
      assert.equal(second.value.has_more, false);
    }
  });

  it("keeps completion local and does not invoke an absent callback", async () => {
    const adapter = new DirectorTaskSourceAdapter([task("local")]);
    const source = adapter.sourceDescriptor();
    const page = await adapter.discover({ source, limit: 1 });
    assert.equal(page.status, "available");
    if (page.status !== "available") return;
    const item = page.value.entries[0]!;
    const reconciled = await adapter.reconcile({ source, task_key: item.task_key, conclusion: "done", expected_source_fingerprint: item.source_fingerprint });
    assert.equal(reconciled.status, "available");
    const refreshed = await adapter.refresh({ source, task_keys: [item.task_key] });
    assert.equal(refreshed.status, "available");
    if (refreshed.status === "available") assert.equal(refreshed.value[0]?.source_state, "complete");
  });

  it("calls reconciliation only when explicitly configured and checks fingerprints", async () => {
    const calls: string[] = [];
    const adapter = new DirectorTaskSourceAdapter([task("callback")], {
      reconcile: async (request) => { calls.push(request.task_id); },
    });
    const source = adapter.sourceDescriptor();
    const page = await adapter.discover({ source, limit: 1 });
    assert.equal(page.status, "available");
    if (page.status !== "available") return;
    const item = page.value.entries[0]!;
    const stale = await adapter.reconcile({ source, task_key: item.task_key, conclusion: "done", expected_source_fingerprint: "f".repeat(64) });
    assert.equal(stale.status, "unavailable");
    assert.equal(stale.diagnostics[0]?.code, "FINGERPRINT_MISMATCH");
    assert.deepEqual(calls, []);
    await adapter.reconcile({ source, task_key: item.task_key, conclusion: "done", expected_source_fingerprint: item.source_fingerprint });
    assert.deepEqual(calls, ["callback"]);
    await adapter.reconcile({ source, task_key: item.task_key, conclusion: "done", expected_source_fingerprint: item.source_fingerprint });
    assert.deepEqual(calls, ["callback"]);
  });

  it("reports duplicate ids, malformed cursors, and changed definitions locally", async () => {
    assert.throws(() => new DirectorTaskSourceAdapter([task("same"), task("same")]), /duplicated/);
    const adapter = new DirectorTaskSourceAdapter([task("one")]);
    const source = adapter.sourceDescriptor();
    const badCursor = await adapter.discover({ source, cursor: "not-a-cursor", limit: 1 });
    assert.equal(badCursor.status, "unavailable");
    assert.equal(badCursor.diagnostics[0]?.code, "INVALID_CURSOR");
    assert.equal((await adapter.refresh({ source, task_keys: ["director:missing"] })).diagnostics[0]?.code, "UNKNOWN_TASK");

    const mutable = task("mutable");
    const changedAdapter = new DirectorTaskSourceAdapter([mutable]);
    mutable.description = "changed after discovery";
    const changed = await changedAdapter.discover({ source: changedAdapter.sourceDescriptor(), limit: 1 });
    assert.equal(changed.status, "unavailable");
    assert.equal(changed.diagnostics[0]?.code, "CHANGED_DEFINITION");
  });
});
