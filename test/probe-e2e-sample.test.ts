import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "bun:test";

const root = path.resolve(import.meta.dir, "..");
const verifier = path.join(root, "samples", "verify-probe.mjs");

describe("probe-e2e verifier", () => {
  it("accepts current-format evidence and rejects config or liveness mismatches", () => {
    const fixture = makeFixture();
    const first = runVerifier(fixture);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(JSON.parse(first.stdout).ok, true);

    const configFile = path.join(fixture.home, ".baton", "config.toml");
    const originalConfig = fs.readFileSync(configFile, "utf8");
    fs.writeFileSync(configFile, originalConfig.replace(`runner = "${fixture.model}"`, 'runner = "wrong-route"'));
    const configFailure = runVerifier(fixture);
    assert.notEqual(configFailure.status, 0);
    assert.match(`${configFailure.stderr}${configFailure.stdout}`, /runner must equal/i);
    fs.writeFileSync(configFile, originalConfig);

    const ticketFile = path.join(fixture.runtime, "spawns", "probe-1.json");
    const ticket = JSON.parse(fs.readFileSync(ticketFile, "utf8"));
    ticket.liveness.execution_handle.value = "wrong-native-handle";
    fs.writeFileSync(ticketFile, `${JSON.stringify(ticket, null, 2)}\n`);
    const second = runVerifier(fixture);
    assert.notEqual(second.status, 0);
    assert.match(`${second.stderr}${second.stdout}`, /liveness handle does not match/i);
  });
});

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-probe-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "baton-probe-workspace-"));
  const host = "codex";
  const model = "sample/probe-model";
  const now = "2026-08-27T10:00:00.000Z";
  run("git", ["init", "-q"], workspace);
  write(workspace, "STANDALONE_REQUEST.txt", "$baton 完成独立样例请求\n");
  write(workspace, "OPENSPEC_REQUEST.txt", "$baton $openspec-apply-change probe-e2e\n");
  write(workspace, "standalone/alpha.js", "export const alpha = 'alpha';\n");
  write(workspace, "standalone/beta.js", "export const beta = 'beta';\n");
  write(workspace, "package.json", '{"private":true,"type":"module"}\n');
  write(workspace, "src/utils/format.js", "export const formatLabel = (value) => value.trim().toUpperCase();\n");
  write(workspace, "src/utils/validate.js", "export const isNonEmpty = (value) => value.trim().length > 0;\n");
  write(workspace, "src/index.js", "export const runSmoke = () => ({ ok: true });\n");
  write(workspace, "verify-local.mjs", "process.stdout.write('local ok\\n');\n");
  write(workspace, "verify-standalone.mjs", "import { alpha } from './standalone/alpha.js'; import { beta } from './standalone/beta.js'; if (alpha !== 'alpha' || beta !== 'beta') process.exit(1);\n");
  write(workspace, "openspec/changes/probe-e2e/tasks.md", [
    "## 1. Utility modules",
    "- [x] 1.1 format",
    "  - conclusion: format complete",
    "- [x] 1.2 validate",
    "  - conclusion: validate complete",
    "## 2. Integration",
    "- [x] 2.1 index",
    "  - conclusion: index complete",
    "",
  ].join("\n"));
  write(workspace, "openspec/config.yaml", "schema: 1\n");
  run("git", ["add", "."], workspace);
  run("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture"], workspace);

  const workspaceId = crypto.createHash("sha256").update(fs.realpathSync(workspace)).digest("hex");
  const runtime = path.join(home, ".baton", "workspaces", workspaceId, "v2");
  const cache = path.join(home, ".baton", "cache");
  write(home, ".baton/config.toml", [
    "schema_version = 2",
    "[director]",
    "max_concurrent = 3",
    "max_depth = 1",
    "[cli.codex]",
    "enabled = true",
    `runner = "${model}"`,
    `longctx = "${model}"`,
    `coding_models = [\"${model}\"]`,
    "",
  ].join("\n"));
  write(cache, "cli-models-codex.json", JSON.stringify({
    schema_version: 5, source: "cli", cli: host, generation: 1, fingerprint: "fixture",
    fetched_at: now, engine_version: null, quota_refresh_error: null, provider_quotas: [],
    routes: [{ id: model, route_id: model, provider: "sample", disabled: false,
      native: true, reasoning_efforts: [], default_reasoning_effort: null, service_tiers: [],
      additional_speed_tiers: [], display_name: model, description: "fixture" }],
  }, null, 2));
  const openspec = path.join(workspace, "openspec/changes/probe-e2e");
  const tickets = [
    ticket("standalone-1", "standalone", null, "09:00", "09:02", "standalone-1", now, model, host),
    ticket("standalone-2", "standalone", null, "09:00", "09:03", "standalone-2", now, model, host),
    ticket("probe-1", "openspec", { change: "probe-e2e", number: "1.1", tasks_path: path.join(openspec, "tasks.md") }, "09:00", "09:10", "probe-1", now, model, host),
    ticket("probe-2", "openspec", { change: "probe-e2e", number: "1.2", tasks_path: path.join(openspec, "tasks.md") }, "09:01", "09:09", "probe-2", now, model, host),
    ticket("probe-3", "openspec", { change: "probe-e2e", number: "2.1", tasks_path: path.join(openspec, "tasks.md") }, "09:11", "09:12", "probe-3", now, model, host),
  ];
  for (const item of tickets) write(runtime, `spawns/${item.id}.json`, JSON.stringify(item, null, 2));

  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-probe-bin-"));
  write(fakeBin, "openspec", "#!/bin/sh\nexit 0\n", 0o755);
  return { home, workspace, runtime, host, model, pathEnv: `${fakeBin}${path.delimiter}${process.env.PATH || ""}` };
}

function ticket(id, source, openspec, start, finish, handleValue, now, model, host) {
  const startAt = `2026-08-27T${start}:00.000Z`;
  const finishAt = `2026-08-27T${finish}:00.000Z`;
  const reservation = `reservation-${id}`;
  const handle = { kind: "task_name", value: handleValue, source: "native-return" };
  return {
    schema_version: 8, id, session_uid: "fixture-session", session_ordinal: ordinalOf(id),
    description: id, prompt: id,
    work_unit: { schema_version: 1, kind: "concrete", objective: id, deliverable: id, done_when: id },
    coordination: { mode: "terminal-only", progress_interval_ms: null }, progress: null,
    liveness: { sequence: 2, execution_handle: handle, state: "running", activity: "heartbeat", observed_at: finishAt },
    model_id: model, route_id: model, reasoning_effort: null, service_tier: null, fork_context: false,
    mode: "write", read_only: false, source, openspec, queue: "enqueue", status: "completed",
    attempt: 1, max_attempts: 1, reservation_id: reservation, execution_handle: handle,
    host, target_host: host, dispatch_host: host, error: null, conclusion: "done",
    receipt_id: `receipt-${id}`, created_at: now, updated_at: finishAt, started_at: startAt,
    finished_at: finishAt, slot_released_at: finishAt,
    selection: { host, proposal_id: "fixture", approval_id: `approval-${id}`, approved_at: now,
      confirmed_by: "baton-recommendation", catalog_fingerprint: "fixture", recommended_model_id: model,
      selected_model_id: model, changed_by_user: false },
    history: [
      { event: "ticket_queued", at: now },
      { event: "dispatch_reserved", at: startAt, host, reservation_id: reservation, attempt: 1 },
      { event: "agent_bound", at: startAt, host, execution_handle: handle },
      { event: "agent_probe", at: finishAt, sequence: 2, execution_handle: handle, state: "running", activity: "heartbeat" },
      { event: "agent_completed", at: finishAt },
      { event: "agent_slot_released", at: finishAt, execution_handle: handle },
    ],
    safety_verdict: { accepted: true, changes: [{ code: "??", path: `${id}.js`, operation: "create" }], violations: [] },
  };
}

function ordinalOf(id) {
  const order = ["standalone-1", "standalone-2", "probe-1", "probe-2", "probe-3"];
  return order.indexOf(id) + 1;
}

function runVerifier(fixture) {
  return spawnSync("bun", [verifier, "--host", fixture.host, "--model", fixture.model, fixture.workspace], {
    env: { ...process.env, HOME: fixture.home, PATH: fixture.pathEnv }, encoding: "utf8",
  });
}

function write(base, relative, content, mode = 0o644) {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `${command} failed`);
}
