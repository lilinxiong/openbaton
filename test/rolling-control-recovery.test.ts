import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { getCliAdapter } from "../src/adapters/registry.js";
import { bindAgent, finishAgent, releaseAgent, reserveNext } from "../src/lib/dispatch.js";
import {
  appendRollingControl,
  discoverRollingTaskManifest,
  reconcileRollingTasks,
  sealRollingTask,
  startRollingControl,
  statusRollingControl,
  synchronizeRollingTicketFacts,
} from "../src/lib/rolling-control.js";
import { deriveTaskKey, type PlanDelta, type TaskSourceDescriptor } from "../src/lib/rolling-plan.js";
import { readRollingExecutionRun } from "../src/lib/rolling-run.js";
import { readRouteSnapshot, publishRouteSnapshot } from "../src/lib/routes.js";
import { listSpawns } from "../src/lib/spawn.js";
import { createTaskSourceAdapterRegistry, type TaskSourceAdapter } from "../src/lib/task-source.js";
import { configureCli } from "./configure.js";
import { fakeEnv } from "./home.js";

async function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-control-"));
  const env = fakeEnv(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-control-home-")), { BATON_SESSION_ID: `rolling-control-${Date.now()}-${Math.random()}` });
  const catalog = await getCliAdapter("alpha", env).discoverModels({ env });
  const model = catalog.models[0]?.id;
  if (!model) throw new Error("fixture adapter exposes no model");
  configureCli(cwd, env, "alpha", [model], { runner: model });
  publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), { cli: "alpha", host: "alpha", env });
  const taskKey = deriveTaskKey("director", "task-1");
  const source: TaskSourceDescriptor = {
    schema_version: 1,
    source_kind: "director",
    adapter: "director",
    selection: { tasks: [{ id: "task-1", description: "verify recovery" }] },
  };
  const delta: PlanDelta = {
    schema_version: 1,
    delta_id: "delta-control",
    prepared_from_append_sequence: 0,
    unit_versions: [{
      schema_version: 1,
      unit_key: "unit-control",
      version: 1,
      task_keys: [taskKey],
      depends_on: [],
      execution_mode: "verification-only",
      route_profile: "runner",
      prompt: "verify rolling recovery",
      completion_criteria: ["recovery verified"],
      permitted_validation: ["read"],
      input_fingerprints: { fixture: "a".repeat(64) },
    }],
    gate_versions: [],
    task_coverage: [{ schema_version: 1, task_key: taskKey, kind: "unit", unit_versions: ["unit-control@1"] }],
  };
  return { cwd, env, model, source, delta, taskKey };
}

describe("rolling control recovery", () => {
  it("rejects a partially discovered manifest when a later page is unavailable", async () => {
    const partialSource: TaskSourceDescriptor = {
      schema_version: 1,
      source_kind: "director",
      adapter: "partial",
      selection: { queue: "partial" },
    };
    const adapter: TaskSourceAdapter = {
      id: "partial",
      source_kind: "director",
      discover: async ({ cursor }) => cursor === null || cursor === undefined
        ? {
          schema_version: 1,
          source: partialSource,
          entries: [{
            schema_version: 1,
            task_key: "director:first",
            source_kind: "director",
            source_ref: { id: "first" },
            display_id: "first",
            title: "first",
            source_fingerprint: "a".repeat(64),
            source_state: "pending",
            discovery_sequence: 0,
          }],
          has_more: true,
          next_cursor: "second",
        }
        : { ok: false, status: "unavailable", diagnostics: [{ code: "PAGE_OFFLINE", message: "second page unavailable" }] },
      refresh: async () => [],
      reconcile: async (request) => ({ task_key: request.task_key, source_fingerprint: request.expected_source_fingerprint, source_state: "pending", source_ref: null }),
    };
    const result = await discoverRollingTaskManifest("/unused", partialSource, createTaskSourceAdapterRegistry([adapter], { max_page_size: 1 }));
    assert.equal(result.complete, false);
    assert.deepEqual(result.entries.map((entry) => entry.task_key), ["director:first"]);
    assert.equal(result.diagnostics[0]?.code, "PAGE_OFFLINE");
  });

  it("recovers native lifecycle facts idempotently, seals, and reconciles", async () => {
    const f = await fixture();
    const started = await startRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-control", host: "alpha", source: f.source, delta: f.delta, dispatch: true });
    assert.equal(started.code, "ROLLING_RUN_STARTED");
    assert.equal(listSpawns(f.cwd, f.env).length, 1);
    assert.equal(listSpawns(f.cwd, f.env)[0]?.route_id, f.model);

    const reserved = await reserveNext(f.cwd, { host: "alpha", env: f.env });
    const ticketId = reserved.reserved[0]?.ticket_id;
    assert.ok(ticketId);
    const kind = getCliAdapter("alpha", f.env).host.executionHandleKind;
    const handle = { kind, value: "rolling-native-1", source: "manual" as const };
    bindAgent(f.cwd, ticketId, { host: "alpha", executionHandle: handle, env: f.env });
    await finishAgent(f.cwd, ticketId, { host: "alpha", status: "completed", conclusion: "rolling recovery passed", env: f.env });
    releaseAgent(f.cwd, ticketId, { host: "alpha", executionHandle: handle, env: f.env });

    const firstRecovery = synchronizeRollingTicketFacts({ cwd: f.cwd, env: f.env, run_id: "run-control" });
    assert.ok(firstRecovery.appended > 0);
    const firstSequence = firstRecovery.run.append_sequence;
    const replay = synchronizeRollingTicketFacts({ cwd: f.cwd, env: f.env, run_id: "run-control" });
    assert.equal(replay.appended, 0);
    assert.equal(replay.run.append_sequence, firstSequence);

    const accepted = await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-control" });
    assert.equal(accepted.task_status[f.taskKey]?.state, "accepted");
    assert.equal(accepted.acceptance.units["unit-control@1"]?.accepted, true);

    const entry = readRollingExecutionRun(f.cwd, "run-control", { env: f.env }).manifest_entries.find((item) => item.task_key === f.taskKey)!;
    await sealRollingTask({
      cwd: f.cwd,
      env: f.env,
      run_id: "run-control",
      seal: { schema_version: 1, task_key: f.taskKey, required_unit_versions: ["unit-control@1"], required_gate_versions: [], source_fingerprint: entry.source_fingerprint },
    });
    const sealed = await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-control" });
    assert.equal(sealed.task_status[f.taskKey]?.state, "sealed");

    await reconcileRollingTasks({ cwd: f.cwd, env: f.env, run_id: "run-control", task_key: f.taskKey });
    const reconciled = await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-control" });
    assert.equal(reconciled.task_status[f.taskKey]?.state, "reconciled");
    const beforeReplay = reconciled.append_sequence;
    await reconcileRollingTasks({ cwd: f.cwd, env: f.env, run_id: "run-control", task_key: f.taskKey });
    assert.equal((await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-control" })).append_sequence, beforeReplay);
    assert.ok(readRouteSnapshot(f.cwd, { host: "alpha", env: f.env }));
  });

  it("projects only the accepted successor after failed versions are superseded", async () => {
    const f = await fixture();
    await startRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-successor", host: "alpha", source: f.source, delta: f.delta, dispatch: true });
    const firstReservation = await reserveNext(f.cwd, { host: "alpha", env: f.env });
    const firstTicket = firstReservation.reserved[0]?.ticket_id;
    assert.ok(firstTicket);
    const kind = getCliAdapter("alpha", f.env).host.executionHandleKind;
    const firstHandle = { kind, value: "rolling-native-failed", source: "manual" as const };
    bindAgent(f.cwd, firstTicket, { host: "alpha", executionHandle: firstHandle, env: f.env });
    await finishAgent(f.cwd, firstTicket, {
      host: "alpha",
      status: "errored",
      errorCode: "VERIFICATION_FAILED",
      errorMessage: "fixture failure",
      env: f.env,
    });
    releaseAgent(f.cwd, firstTicket, { host: "alpha", executionHandle: firstHandle, env: f.env });

    const failed = await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-successor" });
    const successor: PlanDelta = {
      schema_version: 1,
      delta_id: "delta-control-successor",
      prepared_from_append_sequence: failed.append_sequence,
      unit_versions: [{
        ...f.delta.unit_versions[0]!,
        version: 2,
        input_fingerprints: { fixture: "b".repeat(64) },
      }],
      gate_versions: [],
      task_coverage: [{ schema_version: 1, task_key: f.taskKey, kind: "unit", unit_versions: ["unit-control@2"] }],
      supersessions: [{
        schema_version: 1,
        owner: "unit_version",
        previous: "unit-control@1",
        successor: "unit-control@2",
        reason: "repair failed verification",
      }],
    };
    await appendRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-successor", delta: successor, dispatch: true });

    const secondReservation = await reserveNext(f.cwd, { host: "alpha", env: f.env });
    const secondTicket = secondReservation.reserved[0]?.ticket_id;
    assert.ok(secondTicket);
    const secondHandle = { kind, value: "rolling-native-successor", source: "manual" as const };
    bindAgent(f.cwd, secondTicket, { host: "alpha", executionHandle: secondHandle, env: f.env });
    await finishAgent(f.cwd, secondTicket, { host: "alpha", status: "completed", conclusion: "successor passed", env: f.env });
    releaseAgent(f.cwd, secondTicket, { host: "alpha", executionHandle: secondHandle, env: f.env });

    const accepted = await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-successor" });
    assert.equal(accepted.task_status[f.taskKey]?.state, "accepted");
    assert.deepEqual(accepted.task_status[f.taskKey]?.unit_versions, ["unit-control@2"]);
    assert.deepEqual(accepted.task_status[f.taskKey]?.blockers, []);
    assert.equal(accepted.acceptance.units["unit-control@1"]?.state, "failed");
    assert.equal(accepted.acceptance.units["unit-control@2"]?.accepted, true);
  });

  it("appends a later window while the first worker runs and contains a rejected delta", async () => {
    const f = await fixture();
    const secondTaskKey = deriveTaskKey("director", "task-2");
    const source: TaskSourceDescriptor = {
      ...f.source,
      selection: { tasks: [
        { id: "task-1", description: "verify first window" },
        { id: "task-2", description: "verify later window" },
      ] },
    };
    await startRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-active-append", host: "alpha", source, delta: f.delta, dispatch: true });
    const firstReservation = await reserveNext(f.cwd, { host: "alpha", env: f.env });
    const firstTicket = firstReservation.reserved[0]?.ticket_id;
    assert.ok(firstTicket);
    const kind = getCliAdapter("alpha", f.env).host.executionHandleKind;
    const firstHandle = { kind, value: "active-first", source: "manual" as const };
    bindAgent(f.cwd, firstTicket, { host: "alpha", executionHandle: firstHandle, env: f.env });

    const active = await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-active-append" });
    const badDelta: PlanDelta = {
      schema_version: 1,
      delta_id: "later-window-invalid",
      prepared_from_append_sequence: active.append_sequence,
      unit_versions: [{
        schema_version: 1,
        unit_key: "later-unit-invalid",
        version: 1,
        task_keys: [secondTaskKey],
        depends_on: ["missing-unit"],
        execution_mode: "verification-only",
        prompt: "invalid later window",
        input_fingerprints: { fixture: "d".repeat(64) },
      }],
      gate_versions: [],
      task_coverage: [{ schema_version: 1, task_key: secondTaskKey, kind: "unit", unit_versions: ["later-unit-invalid@1"] }],
    };
    await assert.rejects(
      appendRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-active-append", delta: badDelta, dispatch: true }),
      (error: unknown) => (error as { code?: string }).code === "ROLLING_DELTA_INVALID",
    );
    assert.equal(readRollingExecutionRun(f.cwd, "run-active-append", { env: f.env }).accepted_deltas.length, 1);
    assert.equal(listSpawns(f.cwd, f.env).length, 1);
    const afterReject = await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-active-append" });
    assert.equal(afterReject.task_status[f.taskKey]?.state, "active");
    assert.equal(afterReject.task_status[secondTaskKey]?.state, "unplanned");

    const laterDelta: PlanDelta = {
      schema_version: 1,
      delta_id: "later-window-valid",
      prepared_from_append_sequence: afterReject.append_sequence,
      unit_versions: [{
        schema_version: 1,
        unit_key: "later-unit",
        version: 1,
        task_keys: [secondTaskKey],
        depends_on: [],
        execution_mode: "verification-only",
        route_profile: "runner",
        prompt: "verify later window",
        completion_criteria: ["later window accepted"],
        permitted_validation: ["read"],
        input_fingerprints: { fixture: "e".repeat(64) },
      }],
      gate_versions: [],
      task_coverage: [{ schema_version: 1, task_key: secondTaskKey, kind: "unit", unit_versions: ["later-unit@1"] }],
    };
    await appendRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-active-append", delta: laterDelta, dispatch: true });
    assert.equal(listSpawns(f.cwd, f.env).length, 2);
    const secondReservation = await reserveNext(f.cwd, { host: "alpha", env: f.env });
    const secondTicket = secondReservation.reserved[0]?.ticket_id;
    assert.ok(secondTicket);
    const secondHandle = { kind, value: "active-second", source: "manual" as const };
    bindAgent(f.cwd, secondTicket, { host: "alpha", executionHandle: secondHandle, env: f.env });
    await finishAgent(f.cwd, secondTicket, { host: "alpha", status: "completed", conclusion: "later passed", env: f.env });
    releaseAgent(f.cwd, secondTicket, { host: "alpha", executionHandle: secondHandle, env: f.env });
    await finishAgent(f.cwd, firstTicket, { host: "alpha", status: "completed", conclusion: "first passed", env: f.env });
    releaseAgent(f.cwd, firstTicket, { host: "alpha", executionHandle: firstHandle, env: f.env });
    const completed = await statusRollingControl({ cwd: f.cwd, env: f.env, run_id: "run-active-append" });
    assert.equal(completed.task_status[f.taskKey]?.state, "accepted");
    assert.equal(completed.task_status[secondTaskKey]?.state, "accepted");
  });

  it("seals and reconciles an OpenSpec source by stable Markdown task number", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-openspec-"));
    const env = fakeEnv(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-openspec-home-")), { BATON_SESSION_ID: `rolling-openspec-${Date.now()}` });
    const changeDir = path.join(cwd, "openspec", "changes", "demo");
    const tasksPath = path.join(changeDir, "tasks.md");
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(tasksPath, "## Work\n\n- [ ] 1.1 Stable task\n");
    fs.writeFileSync(path.join(changeDir, "proposal.md"), "# Proposal\n");
    const cli = path.join(cwd, "fake-openspec.mjs");
    const applyPayload = {
      changeName: "demo",
      changeDir,
      schemaName: "spec-driven",
      contextFiles: { tasks: [tasksPath], proposal: [path.join(changeDir, "proposal.md")] },
      tasks: [{ id: "77", description: "1.1 Stable task", done: false }],
      instruction: "continue",
    };
    fs.writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(applyPayload))});\n`);
    fs.chmodSync(cli, 0o755);

    const catalog = await getCliAdapter("alpha", env).discoverModels({ env });
    const model = catalog.models[0]?.id;
    assert.ok(model);
    configureCli(cwd, env, "alpha", [model], { runner: model });
    publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), { cli: "alpha", host: "alpha", env });
    const taskKey = "openspec:demo:1.1";
    const source: TaskSourceDescriptor = {
      schema_version: 1,
      source_kind: "openspec",
      adapter: "openspec",
      selection: { change: "demo", cwd, cli },
      source_ref: { change: "demo" },
    };
    const delta: PlanDelta = {
      schema_version: 1,
      delta_id: "openspec-first-window",
      prepared_from_append_sequence: 0,
      unit_versions: [{
        schema_version: 1,
        unit_key: "openspec-unit",
        version: 1,
        task_keys: [taskKey],
        depends_on: [],
        execution_mode: "verification-only",
        route_profile: "runner",
        prompt: "verify stable OpenSpec reconciliation",
        completion_criteria: ["verification accepted"],
        permitted_validation: ["read"],
        input_fingerprints: { fixture: "c".repeat(64) },
      }],
      gate_versions: [],
      task_coverage: [{ schema_version: 1, task_key: taskKey, kind: "unit", unit_versions: ["openspec-unit@1"] }],
    };

    await startRollingControl({ cwd, env, run_id: "run-openspec", host: "alpha", source, delta, dispatch: true });
    const reservation = await reserveNext(cwd, { host: "alpha", env });
    const ticketId = reservation.reserved[0]?.ticket_id;
    assert.ok(ticketId);
    const kind = getCliAdapter("alpha", env).host.executionHandleKind;
    const handle = { kind, value: "openspec-native", source: "manual" as const };
    bindAgent(cwd, ticketId, { host: "alpha", executionHandle: handle, env });
    await finishAgent(cwd, ticketId, { host: "alpha", status: "completed", conclusion: "stable task passed", env });
    releaseAgent(cwd, ticketId, { host: "alpha", executionHandle: handle, env });

    const accepted = await statusRollingControl({ cwd, env, run_id: "run-openspec" });
    assert.equal(accepted.task_status[taskKey]?.state, "accepted");
    const entry = readRollingExecutionRun(cwd, "run-openspec", { env }).manifest_entries.find((item) => item.task_key === taskKey)!;
    await sealRollingTask({
      cwd,
      env,
      run_id: "run-openspec",
      seal: { schema_version: 1, task_key: taskKey, required_unit_versions: ["openspec-unit@1"], required_gate_versions: [], source_fingerprint: entry.source_fingerprint },
    });
    await reconcileRollingTasks({ cwd, env, run_id: "run-openspec", task_key: taskKey });
    const reconciled = await statusRollingControl({ cwd, env, run_id: "run-openspec" });
    assert.equal(reconciled.task_status[taskKey]?.state, "reconciled");
    assert.match(fs.readFileSync(tasksPath, "utf8"), /- \[x\] 1\.1 Stable task\n  - conclusion: stable task passed/);
  });

  it("reconciles several sealed OpenSpec tasks atomically from one ledger fingerprint", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-openspec-batch-"));
    const env = fakeEnv(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-openspec-batch-home-")), { BATON_SESSION_ID: `rolling-openspec-batch-${Date.now()}` });
    const changeDir = path.join(cwd, "openspec", "changes", "demo");
    const tasksPath = path.join(changeDir, "tasks.md");
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(tasksPath, "## Work\n\n- [ ] 1.1 First stable task\n- [ ] 1.2 Second stable task\n");
    fs.writeFileSync(path.join(changeDir, "proposal.md"), "# Proposal\n");
    const cli = path.join(cwd, "fake-openspec.mjs");
    const applyPayload = {
      changeName: "demo",
      changeDir,
      schemaName: "spec-driven",
      contextFiles: { tasks: [tasksPath], proposal: [path.join(changeDir, "proposal.md")] },
      tasks: [
        { id: "77", description: "1.1 First stable task", done: false },
        { id: "91", description: "1.2 Second stable task", done: false },
      ],
      instruction: "continue",
    };
    fs.writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(applyPayload))});\n`);
    fs.chmodSync(cli, 0o755);

    const catalog = await getCliAdapter("alpha", env).discoverModels({ env });
    const model = catalog.models[0]?.id;
    assert.ok(model);
    configureCli(cwd, env, "alpha", [model], { runner: model });
    publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), { cli: "alpha", host: "alpha", env });
    const taskKeys = ["openspec:demo:1.1", "openspec:demo:1.2"];
    const source: TaskSourceDescriptor = {
      schema_version: 1,
      source_kind: "openspec",
      adapter: "openspec",
      selection: { change: "demo", cwd, cli },
      source_ref: { change: "demo" },
    };
    const delta: PlanDelta = {
      schema_version: 1,
      delta_id: "openspec-batch-window",
      prepared_from_append_sequence: 0,
      unit_versions: [{
        schema_version: 1,
        unit_key: "openspec-batch-unit",
        version: 1,
        task_keys: taskKeys,
        depends_on: [],
        execution_mode: "verification-only",
        route_profile: "runner",
        prompt: "verify atomic OpenSpec reconciliation",
        completion_criteria: ["batch verification accepted"],
        permitted_validation: ["read"],
        input_fingerprints: { fixture: "d".repeat(64) },
      }],
      gate_versions: [],
      task_coverage: taskKeys.map((task_key) => ({ schema_version: 1, task_key, kind: "unit" as const, unit_versions: ["openspec-batch-unit@1"] })),
    };

    await startRollingControl({ cwd, env, run_id: "run-openspec-batch", host: "alpha", source, delta, dispatch: true });
    const reservation = await reserveNext(cwd, { host: "alpha", env });
    const ticketId = reservation.reserved[0]?.ticket_id;
    assert.ok(ticketId);
    const handle = { kind: getCliAdapter("alpha", env).host.executionHandleKind, value: "openspec-batch-native", source: "manual" as const };
    bindAgent(cwd, ticketId, { host: "alpha", executionHandle: handle, env });
    await finishAgent(cwd, ticketId, { host: "alpha", status: "completed", conclusion: "batch stable tasks passed", env });
    releaseAgent(cwd, ticketId, { host: "alpha", executionHandle: handle, env });

    const run = readRollingExecutionRun(cwd, "run-openspec-batch", { env });
    for (const taskKey of taskKeys) {
      const entry = run.manifest_entries.find((item) => item.task_key === taskKey)!;
      await sealRollingTask({
        cwd,
        env,
        run_id: "run-openspec-batch",
        seal: { schema_version: 1, task_key: taskKey, required_unit_versions: ["openspec-batch-unit@1"], required_gate_versions: [], source_fingerprint: entry.source_fingerprint },
      });
    }
    await reconcileRollingTasks({ cwd, env, run_id: "run-openspec-batch" });
    const reconciled = await statusRollingControl({ cwd, env, run_id: "run-openspec-batch" });
    assert.deepEqual(taskKeys.map((taskKey) => reconciled.task_status[taskKey]?.state), ["reconciled", "reconciled"]);
    const ledger = fs.readFileSync(tasksPath, "utf8");
    assert.match(ledger, /- \[x\] 1\.1 First stable task\n  - conclusion: batch stable tasks passed/);
    assert.match(ledger, /- \[x\] 1\.2 Second stable task\n  - conclusion: batch stable tasks passed/);
  });
});
