import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "bun:test";

const root = path.resolve(import.meta.dir, "..");
const verifier = path.join(root, "samples", "verify-probe.mjs");
const bootstrap = path.join(root, "samples", "bootstrap-probe.mjs");
const CHANGE = "probe-e2e";

describe("probe-e2e verifier", () => {
  it("accepts current-format evidence and rejects config or liveness mismatches", () => {
    const fixture = makeFixture();
    const first = runVerifier(fixture);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.ok, true);
    assert.equal(firstPayload.compiled_apply?.revision, "1");
    assert.equal(firstPayload.compiled_apply?.split_task, "1.1");
    assert.equal(firstPayload.compiled_apply?.active_ticket_count, 0);

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

  it("accepts the disposable dual-skill compiled apply contract and rejects early reconciliation", () => {
    const fixture = makeFixture();
    const accepted = runVerifier(fixture);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

    const scenarioFile = path.join(fixture.runtime, "compiled-apply-scenario.json");
    const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
    const checkbox = scenario.timeline.find((event: { event?: string }) => event.event === "checkbox-reconciled");
    assert.ok(checkbox);
    checkbox.at = "2026-08-27T09:10:00.000Z";
    fs.writeFileSync(scenarioFile, `${JSON.stringify(scenario, null, 2)}\n`);

    const rejected = runVerifier(fixture);
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stderr}${rejected.stdout}`, /checkbox completed before/i);
  });

  it("renders the host-specific Baton invocation syntax", () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-probe-bootstrap-bin-"));
    write(fakeBin, "openspec", "#!/bin/sh\nexit 0\n", 0o755);
    const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}` };

    for (const [host, invocation] of [["codex", "$baton"], ["grok", "/baton"]] as const) {
      const result = spawnSync("bun", [bootstrap, "--host", host, "--model", "probe-model"], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, new RegExp(`${invocation.replace("$", "\\$")} Complete this ordinary`));
      assert.match(result.stdout, new RegExp(`${invocation.replace("$", "\\$")} \\$openspec-apply-change probe-e2e`));
      assert.doesNotMatch(result.stdout, /\{\{BATON_INVOCATION\}\}/);
    }
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
  write(runtime, "compiled-apply-scenario.json", JSON.stringify(compiledApplyScenario(workspace, openspec, model), null, 2));

  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-probe-bin-"));
  write(fakeBin, "openspec", "#!/bin/sh\nexit 0\n", 0o755);
  return { home, workspace, runtime, host, model, pathEnv: `${fakeBin}${path.delimiter}${process.env.PATH || ""}` };
}

function compiledApplyScenario(workspace: string, openspec: string, model: string) {
  const patchOnlyProhibitions = [
    "Do not redesign the plan.",
    "Do not broaden scope.",
    "Do not spawn children.",
    "Do not touch Git.",
    "Do not touch OpenSpec.",
    "Do not choose models.",
  ];
  const patchPrompt = [
    "Apply only the imperative recipe and return terminal evidence.",
    ...patchOnlyProhibitions,
  ].join(" ");
  const units = [
    {
      id: "u-format", mode: "patch-only", task_ids: ["1.1"],
      write_paths: ["src/utils/format.js"], allowed_operations: ["write"],
      prompt: patchPrompt, patch: patchPrompt,
    },
    {
      id: "u-validate", mode: "patch-only", task_ids: ["1.1"],
      write_paths: ["src/utils/validate.js"], allowed_operations: ["write"],
      prompt: patchPrompt, patch: patchPrompt,
    },
    {
      id: "u-coupled", mode: "patch-only", task_ids: ["1.1", "1.2"],
      write_paths: ["src/index.js"], allowed_operations: ["write"],
      prompt: patchPrompt, patch: patchPrompt,
    },
    {
      id: "u-integration", mode: "patch-only", task_ids: ["2.1"],
      depends_on: ["u-coupled"], parent_gate_ids: ["g-parent"],
      write_paths: ["src/index.js"], allowed_operations: ["write"],
      prompt: patchPrompt, patch: patchPrompt,
    },
  ];
  return {
    schema_version: 1,
    run_id: "compiled-probe-run",
    plan: {
      schema_version: 1,
      identity: { plan_id: "compiled-probe-plan", change_id: CHANGE },
      source_snapshot: { repo_root: workspace, revision: "fixture-revision", tasks_path: path.join(openspec, "tasks.md") },
      selected_tasks: ["1.1", "1.2", "2.1"],
      units,
      parent_gates: [{ id: "g-parent", unit_ids: ["u-format", "u-validate", "u-coupled"], task_ids: ["2.1"] }],
      task_mappings: [
        { task_id: "1.1", unit_ids: ["u-format", "u-validate"] },
        { task_id: "1.2", unit_ids: ["u-coupled"] },
        { task_id: "2.1", unit_ids: ["u-integration"], gate_ids: ["g-parent"] },
      ],
    },
    parent_gate_id: "g-parent",
    run_state: {
      run_id: "compiled-probe-run", current_revision: "1", current_fingerprint: "fixture-fingerprint", reconciled: true,
      unit_status: { "u-format": "accepted", "u-validate": "accepted", "u-coupled": "accepted", "u-integration": "reconciled" },
      gate_status: { "g-parent": "accepted" },
      task_status: { "1.1": "reconciled", "1.2": "reconciled", "2.1": "reconciled" },
      terminal_unreleased_tickets: [],
    },
    timeline: [
      { event: "unit-terminal", units: ["u-format", "u-validate", "u-coupled"], at: "2026-08-27T09:10:00.000Z" },
      { event: "ticket-released", ticket_ids: ["compiled-u-format", "compiled-u-validate", "compiled-u-coupled"], at: "2026-08-27T09:11:00.000Z" },
      { event: "gate-accepted", gate_id: "g-parent", at: "2026-08-27T09:12:00.000Z" },
      { event: "refill", unit_id: "u-integration", at: "2026-08-27T09:13:00.000Z" },
      { event: "unit-terminal", units: ["u-integration"], at: "2026-08-27T09:14:00.000Z" },
      { event: "ticket-released", ticket_ids: ["compiled-u-integration"], at: "2026-08-27T09:15:00.000Z" },
      { event: "checkbox-reconciled", task_ids: ["1.1", "1.2", "2.1"], at: "2026-08-27T09:16:00.000Z" },
    ],
    patch_only_prompt_prohibitions: patchOnlyProhibitions,
    routing: {
      configured_route_ids: ["spark", "luna"], selected_route_id: "luna", silent_advance: true,
      candidates: [
        { route_id: "spark", status: "excluded", reasons: ["current-session quota exhausted"] },
        { route_id: "luna", status: "qualified", reasons: [] },
      ],
      per_unit: Object.fromEntries(units.map((unit) => [unit.id, "luna"])),
    },
    session_cache: {
      scope: "current-session-only", prior_session_id: "prior-session", current_session_id: "fixture-session",
      prior_session_route: "spark", new_session_rechecks: true,
    },
    no_qualified: {
      code: "NO_QUALIFIED_CANDIDATE",
      configured_route_ids: ["spark", "luna", "missing", "narrow", "weak", "sandbox", "task", "pool"],
      exclusions: [
        { route_id: "spark", codes: ["CURRENT_SESSION_QUOTA_EXHAUSTED"], reasons: ["current-session quota exhausted"] },
        { route_id: "luna", codes: ["CURRENT_SESSION_UNCALLABLE"], reasons: ["uncallable in current session"] },
        { route_id: "missing", codes: ["ROUTE_ABSENT_FROM_ACTIVE_CATALOG"], reasons: ["route absent from active catalog"] },
        { route_id: "narrow", codes: ["CONTEXT_WINDOW_INSUFFICIENT"], reasons: ["context window is insufficient"] },
        { route_id: "weak", codes: ["REASONING_CAPABILITY_INSUFFICIENT"], reasons: ["reasoning capability is insufficient"] },
        { route_id: "sandbox", codes: ["REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED"], reasons: ["required execution capability unsupported"] },
        { route_id: "task", codes: ["TASK_CAPABILITY_MISMATCH"], reasons: ["task capability mismatch"] },
        { route_id: "pool", codes: ["QUOTA_POOL_EXHAUSTED"], reasons: ["quota pool exhausted"] },
      ],
    },
    manual_compatibility: { legacy_ticket_id: "standalone-1", compiled_apply_lineage: false },
    active_ticket_ids: [],
    selected_model: model,
  };
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
