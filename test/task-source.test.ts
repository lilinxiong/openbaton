import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskSourceAdapterError,
  TaskSourceAdapterRegistry,
  type TaskSourceAdapter,
  type TaskSourceDiagnostic,
  type TaskSourceResult,
} from "../src/lib/task-source.js";
import type { TaskManifestEntry, TaskManifestPage, TaskSourceDescriptor } from "../src/lib/rolling-plan.js";

const hash = "a".repeat(64);
const source: TaskSourceDescriptor = { schema_version: 1, source_kind: "director", adapter: "alpha", selection: { queue: "opaque" }, source_ref: { caller: "opaque" } };

function entry(taskKey: string): TaskManifestEntry {
  return { schema_version: 1, task_key: taskKey, source_kind: "director", source_ref: { opaque: taskKey }, display_id: taskKey, title: `Task ${taskKey}`, source_fingerprint: hash, source_state: "pending", discovery_sequence: 0 };
}

function page(entries: TaskManifestEntry[] = [entry("director:one")]): TaskManifestPage {
  return { schema_version: 1, source, entries, has_more: false };
}

function adapter(id: string, calls: string[], overrides: Partial<TaskSourceAdapter> = {}): TaskSourceAdapter {
  return {
    id, source_kind: "director",
    discover: async (request) => { calls.push(`discover:${request.limit}:${request.cursor ?? ""}`); return page(); },
    refresh: async (request) => { calls.push(`refresh:${request.task_keys.join(",")}`); return request.task_keys.map(entry); },
    reconcile: async (request) => { calls.push(`reconcile:${request.task_key}:${request.expected_source_fingerprint}`); return { task_key: request.task_key, source_fingerprint: hash, source_state: "complete", source_ref: { opaque: true }, conclusion: request.conclusion }; },
    ...overrides,
  };
}

describe("source-neutral task adapter registry", () => {
  it("lists adapters deterministically and delegates bounded operations", async () => {
    const calls: string[] = [];
    const registry = new TaskSourceAdapterRegistry([adapter("zeta", calls), adapter("alpha", calls)]);
    assert.deepEqual(registry.ids(), ["alpha", "zeta"]);
    const discovered = await registry.discover(source, { cursor: "next", limit: 1000 });
    assert.equal(discovered.status, "available");
    if (discovered.status === "available") assert.deepEqual(discovered.value.entries[0]?.source_ref, { opaque: "director:one" });
    const refreshed = await registry.refresh(source, ["director:one"]);
    assert.equal(refreshed.status, "available");
    const reconciled = await registry.reconcile(source, "director:one", "done", hash);
    assert.equal(reconciled.status, "available");
    assert.deepEqual(calls, ["discover:100:next", "refresh:director:one", `reconcile:director:one:${hash}`]);
  });

  it("validates descriptors while preserving opaque selection and references", async () => {
    const calls: string[] = [];
    const opaque = { nested: [{ value: 1 }], token: "not-for-baton" };
    const registry = new TaskSourceAdapterRegistry([adapter("alpha", calls)]);
    const discovered = await registry.discover({ ...source, selection: opaque });
    assert.equal(discovered.status, "available");
    assert.deepEqual(calls, ["discover:100:"]);
  });

  it("rejects unknown and duplicate adapters with stable codes", () => {
    const calls: string[] = [];
    const registry = new TaskSourceAdapterRegistry([adapter("alpha", calls)]);
    assert.throws(() => registry.register(adapter("alpha", calls)), (error: unknown) => error instanceof TaskSourceAdapterError && error.code === "DUPLICATE_ADAPTER");
    assert.throws(() => registry.get("missing"), (error: unknown) => error instanceof TaskSourceAdapterError && error.code === "UNKNOWN_ADAPTER");
  });

  it("exposes adapter diagnostics and makes unavailable operations local", async () => {
    const calls: string[] = [];
    const diagnostics: TaskSourceDiagnostic[] = [{ code: "LEDGER_LOCKED", message: "source is locked", severity: "warning" }];
    const unavailableResult: TaskSourceResult<TaskManifestPage> = { ok: false, status: "unavailable", diagnostics };
    const registry = new TaskSourceAdapterRegistry([adapter("alpha", calls, {
      discover: async () => unavailableResult,
      refresh: async () => { throw new Error("offline"); },
      diagnostics: async () => diagnostics,
    })]);
    const discovered = await registry.discover(source);
    assert.equal(discovered.status, "unavailable");
    assert.deepEqual(discovered.diagnostics, diagnostics);
    const refreshed = await registry.refresh(source, ["director:one"]);
    assert.equal(refreshed.status, "unavailable");
    assert.equal(refreshed.diagnostics[0]?.code, "REFRESH_UNAVAILABLE");
    assert.deepEqual(await registry.diagnostics(source), { ok: true, status: "available", value: diagnostics, diagnostics: [] });
  });
});
