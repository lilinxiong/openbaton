import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOpenSpecStatus } from "../src/lib/openspec.js";
import { OpenSpecTaskSourceAdapter } from "../src/lib/openspec-task-source.js";
import { DirectorTaskSourceAdapter } from "../src/lib/director-task-source.js";
import { TaskSourceAdapterRegistry } from "../src/lib/task-source.js";
import { validateTaskManifestEntry, type TaskManifestEntry, type TaskSourceDescriptor } from "../src/lib/rolling-plan.js";

type OpenSpecFixture = {
  cwd: string;
  tasksPath: string;
  source: TaskSourceDescriptor;
  runner: (command: string, args: string[], cwd: string) => { status: number; stdout: string; stderr: string };
};

function openSpecFixture(tasks = "## Work\n\n- [ ] 1.1 First task\n- [ ] 1.2 Second task\n") : OpenSpecFixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-task-source-parity-"));
  const changeDir = path.join(cwd, "openspec", "changes", "demo");
  fs.mkdirSync(changeDir, { recursive: true });
  const tasksPath = path.join(changeDir, "tasks.md");
  const proposalPath = path.join(changeDir, "proposal.md");
  fs.writeFileSync(tasksPath, tasks);
  fs.writeFileSync(proposalPath, "# Proposal\n");
  const runner = (_command: string, _args: string[], _workingDirectory: string) => ({
    status: 0,
    stdout: JSON.stringify({
      changeName: "demo",
      changeDir,
      schemaName: "spec-driven",
      contextFiles: { tasks: [tasksPath], proposal: [proposalPath] },
      tasks: [
        { id: 77, description: "1.1 First task", done: false },
        { id: 88, description: "1.2 Second task", done: false },
      ],
      instruction: "continue",
    }),
    stderr: "",
  });
  return {
    cwd,
    tasksPath,
    runner,
    source: {
      schema_version: 1,
      source_kind: "openspec",
      adapter: "openspec",
      selection: { change: "demo", cwd },
      source_ref: { external: "opaque-change-ref" },
    },
  };
}

function available<T>(result: { status: string; value?: T }): T {
  assert.equal(result.status, "available");
  assert.ok(result.value !== undefined);
  return result.value as T;
}

function semantic(entry: TaskManifestEntry) {
  return {
    title: entry.title,
    source_state: entry.source_state,
    discovery_sequence: entry.discovery_sequence,
    has_source_fingerprint: /^[0-9a-f]{64}$/.test(entry.source_fingerprint),
  };
}

describe("task-source adapter parity and failure containment", () => {
  it("normalizes both sources to stable manifest semantics and preserves opaque refs", async () => {
    const opaqueRef = { provider: "director", token: "opaque-token", nested: { value: 7 } };
    const director = new DirectorTaskSourceAdapter([{ id: "first", description: "First task", title: "First task", source_ref: opaqueRef }]);
    const openSpec = openSpecFixture();
    const openSpecAdapter = new OpenSpecTaskSourceAdapter({ runner: openSpec.runner, cli: "/fake/openspec" });

    const directorPage = available(await director.discover({ source: director.sourceDescriptor({ queue: "standalone" }), limit: 1 }));
    const openSpecPage = available(openSpecAdapter.discover({ source: openSpec.source, limit: 1 }));
    const directorEntry = directorPage.entries[0]!;
    const openSpecEntry = openSpecPage.entries[0]!;

    assert.deepEqual(semantic(directorEntry), semantic(openSpecEntry));
    assert.equal(validateTaskManifestEntry(directorEntry).valid, true);
    assert.equal(validateTaskManifestEntry(openSpecEntry).valid, true);
    assert.deepEqual(directorEntry.source_ref, opaqueRef);
    assert.deepEqual(openSpecEntry.source_ref, {
      change: "demo",
      number: "1.1",
      tasks_path: openSpec.tasksPath,
    });

    const directorAgain = available(await director.discover({ source: director.sourceDescriptor({ queue: "standalone" }), limit: 1 })).entries[0]!;
    const openSpecAgain = available(openSpecAdapter.discover({ source: openSpec.source, limit: 1 })).entries[0]!;
    assert.deepEqual(
      { task_key: directorAgain.task_key, source_fingerprint: directorAgain.source_fingerprint, fingerprint: directorAgain.fingerprint },
      { task_key: directorEntry.task_key, source_fingerprint: directorEntry.source_fingerprint, fingerprint: directorEntry.fingerprint },
    );
    assert.deepEqual(
      { task_key: openSpecAgain.task_key, source_fingerprint: openSpecAgain.source_fingerprint, fingerprint: openSpecAgain.fingerprint },
      { task_key: openSpecEntry.task_key, source_fingerprint: openSpecEntry.source_fingerprint, fingerprint: openSpecEntry.fingerprint },
    );
  });

  it("runs standalone director work without an OpenSpec adapter or change", async () => {
    const adapter = new DirectorTaskSourceAdapter([{ id: "local", description: "local standalone work", source_ref: { local: "opaque" } }]);
    const registry = new TaskSourceAdapterRegistry([adapter]);
    const source = adapter.sourceDescriptor({ queue: "no-openspec" });
    const page = available(await registry.discover(source));
    const entry = page.entries[0]!;

    const reconciled = available(await registry.reconcile(source, entry.task_key, "completed locally", entry.source_fingerprint));
    assert.equal(reconciled.source_state, "complete");
    const refreshed = available(await registry.refresh(source, [entry.task_key]));
    assert.equal(refreshed[0]?.source_state, "complete");
    assert.deepEqual(adapter.completedTaskKeys(), [entry.task_key]);
    assert.deepEqual(await registry.diagnostics(source), { ok: true, status: "available", value: [], diagnostics: [] });
  });

  it("uses the Markdown number for OpenSpec reconciliation when apply ordinal differs", () => {
    const fixture = openSpecFixture();
    const adapter = new OpenSpecTaskSourceAdapter({ runner: fixture.runner, cli: "/fake/openspec" });
    const page = available(adapter.discover({ source: fixture.source, limit: 2 }));
    const first = page.entries[0]!;

    assert.equal(first.task_key, "openspec:demo:1.1");
    assert.equal(first.apply_ordinal, 77);
    assert.equal(first.metadata?.apply_id, "77");
    assert.equal(first.metadata?.markdown_number, "1.1");
    assert.throws(
      () => adapter.reconcile({ source: fixture.source, task_key: "openspec:demo:77", conclusion: "accepted", expected_source_fingerprint: first.source_fingerprint }),
      (error: unknown) => (error as { code?: string }).code === "TASK_ID_NOT_FOUND",
    );

    const reconciled = available(adapter.reconcile({
      source: fixture.source,
      task_key: "openspec:demo:1.1",
      conclusion: "accepted",
      expected_source_fingerprint: first.source_fingerprint,
    }));
    assert.equal(reconciled.task_key, "openspec:demo:1.1");
    assert.match(fs.readFileSync(fixture.tasksPath, "utf8"), /- \[x\] 1\.1 First task\n  - conclusion: accepted/);
  });

  it("fails an ambiguous Markdown entry locally instead of choosing one", () => {
    const fixture = openSpecFixture("## Work\n\n- [ ] 1.1 First task\n- [ ] 1.1 Duplicate task\n");
    const adapter = new OpenSpecTaskSourceAdapter({ runner: fixture.runner, cli: "/fake/openspec" });
    assert.throws(
      () => adapter.reconcile({
        source: fixture.source,
        task_key: "openspec:demo:1.1",
        conclusion: "accepted",
        expected_source_fingerprint: "a".repeat(64),
      }),
      (error: unknown) => (error as { code?: string }).code === "TASK_ID_AMBIGUOUS",
    );
    assert.doesNotMatch(fs.readFileSync(fixture.tasksPath, "utf8"), /conclusion:/);
  });

  it("blocks only reconciliation when the OpenSpec ledger fingerprint changes", () => {
    const fixture = openSpecFixture();
    const adapter = new OpenSpecTaskSourceAdapter({ runner: fixture.runner, cli: "/fake/openspec" });
    const initial = available(adapter.discover({ source: fixture.source, limit: 1 }));
    const entry = initial.entries[0]!;
    fs.appendFileSync(fixture.tasksPath, "\n");

    const discovered = available(adapter.discover({ source: fixture.source, limit: 1 }));
    const refreshed = available(adapter.refresh({ source: fixture.source, task_keys: [entry.task_key] }));
    assert.notEqual(discovered.entries[0]?.source_fingerprint, entry.source_fingerprint);
    assert.notEqual(refreshed[0]?.source_fingerprint, entry.source_fingerprint);
    const blocked = adapter.reconcile({ source: fixture.source, task_key: entry.task_key, conclusion: "accepted", expected_source_fingerprint: entry.source_fingerprint });
    assert.equal(blocked.status, "unavailable");
    assert.equal(blocked.diagnostics[0]?.code, "TASK_LEDGER_CHANGED");
  });

  it("keeps local status and diagnostics available during temporary source unavailability", async () => {
    const fixture = openSpecFixture();
    const adapter = new OpenSpecTaskSourceAdapter({ cwd: fixture.cwd, cli: null });
    const registry = new TaskSourceAdapterRegistry([adapter]);
    const unavailable = await registry.discover(fixture.source);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.diagnostics[0]?.code, "NOT_FOUND");

    const status = readOpenSpecStatus(fixture.cwd, { cli: null });
    assert.equal(status.ok, true);
    assert.equal(status.source, "artifacts");
    assert.match(status.text, /demo/);
    const diagnostics = await registry.diagnostics(fixture.source, "discover");
    assert.equal(diagnostics.status, "available");
  });
});
