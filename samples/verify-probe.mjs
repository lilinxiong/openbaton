#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceParser = new URL("../src/lib/toml.ts", import.meta.url);
const packageParser = new URL("../dist/src/lib/toml.js", import.meta.url);
const parserUrl = fs.existsSync(fileURLToPath(sourceParser)) ? sourceParser : packageParser;
const { parseToml } = await import(parserUrl.href);

const CHANGE = "probe-e2e";
const PROBE_TASKS = ["1.1", "1.2", "2.1"];
const TERMINAL = new Set(["completed", "errored", "timed_out", "closed"]);
const ACTIVE = new Set(["queued", "dispatching", "running"]);
const LIVENESS_STATES = new Set(["pending_init", "running", "interrupted", "shutdown", "not_found"]);
const LIVENESS_ACTIVITIES = new Set(["status", "output", "heartbeat"]);
const NO_QUALIFIED_CODES = [
  "QUOTA_POOL_EXHAUSTED",
  "CURRENT_SESSION_QUOTA_EXHAUSTED",
  "CURRENT_SESSION_UNCALLABLE",
  "ROUTE_ABSENT_FROM_ACTIVE_CATALOG",
  "REASONING_CAPABILITY_INSUFFICIENT",
  "CONTEXT_WINDOW_INSUFFICIENT",
  "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED",
  "TASK_CAPABILITY_MISMATCH",
];

try {
  const { host, model, workspace } = parseArgs(process.argv.slice(2));
  const result = verify({ host, model, workspace });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function parseArgs(argv) {
  let host = null;
  let model = null;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host" || arg === "--model") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`usage: bun samples/verify-probe.mjs --host TARGET --model MODEL WORKSPACE`);
      if (arg === "--host") {
        if (host) throw new Error("--host may be supplied only once");
        host = value.trim().toLowerCase();
      } else {
        if (model) throw new Error("--model may be supplied only once");
        model = value.trim();
      }
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    positional.push(arg);
  }
  if (!host || !model || positional.length !== 1) {
    throw new Error("usage: bun samples/verify-probe.mjs --host TARGET --model MODEL WORKSPACE");
  }
  if (!/^[a-z][a-z0-9._-]*$/.test(host)) throw new Error(`invalid host: ${host}`);
  return { host, model, workspace: realpathWorkspace(positional[0]) };
}

function verify({ host, model, workspace }) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const runtime = path.join(home, ".baton", "workspaces", workspaceId(workspace), "v2");
  const routeId = routeOf(model);

  assert(model === routeId, `--model must be the picker-visible route id without an @effort suffix: ${model}`);
  verifyConfig(home, host, routeId);
  verifyRoute(home, host, routeId);
  const records = readJsonDirectory(path.join(runtime, "spawns"), "spawn runtime");
  verifyNoLeaks(records);

  const standalone = records.filter((ticket) => ticket.source === "standalone");
  const probe = records.filter((ticket) => isProbeTicket(ticket));
  assert(standalone.length === 2, `expected exactly 2 standalone tickets, got ${standalone.length}`);
  assert(probe.length === 3, `expected exactly 3 ${CHANGE} OpenSpec tickets, got ${probe.length}`);
  assert(standalone.length + probe.length === 5, "standalone and probe tickets must be the complete five-ticket evidence set");

  const tickets = [...standalone, ...probe];
  for (const ticket of tickets) verifyTicket(ticket, { host, model, routeId, workspace });
  verifyOneSession(tickets);
  verifyTaskNumbers(probe);
  verifyDependencyOrdering(probe);
  verifyWorkspace(workspace);
  const compiledApply = verifyCompiledApplyScenario(runtime, workspace);

  return {
    ok: true,
    host,
    model,
    workspace,
    runtime,
    tickets: tickets
      .slice()
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      .map((ticket) => ({
        id: ticket.id,
        source: ticket.source,
        task: ticket.openspec?.number || null,
        route_id: ticket.route_id,
        model: ticket.model_id,
        execution_handle: ticket.execution_handle,
        liveness: ticket.liveness?.state,
        status: ticket.status,
        released: Boolean(ticket.slot_released_at),
      })),
    compiled_apply: compiledApply,
  };
}

function verifyConfig(home, host, routeId) {
  const file = path.join(home, ".baton", "config.toml");
  assert(fs.existsSync(file), `missing Baton config: ${file}`);
  let parsed;
  try {
    parsed = parseToml(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`invalid Baton config: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cli = parsed?.cli && typeof parsed.cli === "object" ? parsed.cli : {};
  const profile = cli[host];
  assert(profile && typeof profile === "object", `cli.${host} profile must exist`);
  const coding = Array.isArray(profile.coding_models) ? profile.coding_models.map(String) : [];
  assert(profile.runner === routeId, `cli.${host}.runner must equal ${routeId}`);
  assert(profile.longctx === routeId, `cli.${host}.longctx must equal ${routeId}`);
  assert(coding.length === 1, `cli.${host}.coding_models must contain exactly one model`);
  assert(coding[0] === routeId, `cli.${host} must configure exactly route_id ${routeId}`);
  for (const [configuredHost, value] of Object.entries(cli)) {
    if (configuredHost === host || !value || typeof value !== "object") continue;
    const other = value;
    if (Array.isArray(other.coding_models) && other.coding_models.length > 0) {
      throw new Error(`only cli.${host} may have configured coding models`);
    }
  }
}

function verifyRoute(home, host, routeId) {
  const file = path.join(home, ".baton", "cache", `cli-models-${host}.json`);
  assert(fs.existsSync(file), `missing ${host} CLI route snapshot: ${file}`);
  const snapshot = readJson(file);
  assert(snapshot.schema_version === 5 && snapshot.source === "cli" && snapshot.cli === host,
    `${host} route snapshot must be current CLI-owned schema`);
  const route = Array.isArray(snapshot.routes) ? snapshot.routes.find((item) => item?.route_id === routeId) : null;
  assert(route && route.disabled !== true, `route_id ${routeId} is absent or disabled in the ${host} snapshot`);
}

function verifyTicket(ticket, { host, model, routeId, workspace }) {
  assert(ticket && typeof ticket === "object" && !Array.isArray(ticket), "ticket must be an object");
  assert(ticket.schema_version === 8, `ticket ${ticket.id || "<unknown>"} is not schema 8`);
  assert(typeof ticket.id === "string" && ticket.id.trim(), "ticket id is required");
  assert(ticket.status === "completed", `ticket ${ticket.id} must be completed`);
  assert(ticket.attempt === 1 && ticket.max_attempts >= 1, `ticket ${ticket.id} must complete on attempt 1`);
  assert(ticket.route_id === routeId, `ticket ${ticket.id} must preserve exact route_id ${routeId}`);
  assert(routeOf(ticket.model_id) === routeId, `ticket ${ticket.id} must use selected route ${routeId}`);
  assert(ticket.mode === "write" && ticket.read_only === false, `ticket ${ticket.id} must be a native write unit`);
  assert(ticket.error == null, `ticket ${ticket.id} has a terminal error`);
  assert(typeof ticket.conclusion === "string" && ticket.conclusion.trim(), `ticket ${ticket.id} needs a conclusion`);
  assert(ticket.work_unit && typeof ticket.work_unit === "object", `ticket ${ticket.id} has no work unit`);
  assert(ticket.coordination && typeof ticket.coordination === "object", `ticket ${ticket.id} has no coordination policy`);
  assert(Object.hasOwn(ticket, "progress") && Object.hasOwn(ticket, "liveness") && Object.hasOwn(ticket, "selection"),
    `ticket ${ticket.id} is missing current-format lifecycle fields`);

  const ticketHosts = [ticket.target_host, ticket.dispatch_host, ticket.host, ticket.selection?.host]
    .filter((value) => value != null && String(value).trim());
  assert(ticketHosts.length > 0 && ticketHosts.every((value) => String(value).trim().toLowerCase() === host),
    `ticket ${ticket.id} must target host ${host}`);
  assert(routeOf(ticket.selection?.selected_model_id) === routeId, `ticket ${ticket.id} selection must match route ${model}`);
  if (ticket.selection?.recommended_model_id != null) {
    assert(routeOf(ticket.selection.recommended_model_id) === routeId, `ticket ${ticket.id} recommendation must match route ${model}`);
  }

  const handle = validHandle(ticket.execution_handle);
  assert(handle, `ticket ${ticket.id} must retain an execution handle`);
  const live = ticket.liveness;
  assert(live && Number.isInteger(live.sequence) && live.sequence >= 2, `ticket ${ticket.id} needs activity-wait evidence`);
  assert(LIVENESS_STATES.has(live.state) && LIVENESS_ACTIVITIES.has(live.activity), `ticket ${ticket.id} has invalid liveness state`);
  assert(validHandle(live.execution_handle), `ticket ${ticket.id} liveness handle is invalid`);
  assert(sameHandle(handle, live.execution_handle), `ticket ${ticket.id} liveness handle does not match execution handle`);
  assert(validDate(live.observed_at), `ticket ${ticket.id} liveness timestamp is invalid`);

  assert(typeof ticket.reservation_id === "string" && ticket.reservation_id.trim(), `ticket ${ticket.id} has no dispatch reservation`);
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  const reserved = history.find((event) => event?.event === "dispatch_reserved");
  assert(reserved && reserved.reservation_id === ticket.reservation_id && reserved.host === host,
    `ticket ${ticket.id} reservation evidence is missing`);
  const bound = history.find((event) => event?.event === "agent_bound");
  assert(bound && validHandle(bound.execution_handle) && sameHandle(handle, bound.execution_handle),
    `ticket ${ticket.id} has no matching bind evidence`);
  const probed = history.find((event) => event?.event === "agent_probe");
  assert(probed && validHandle(probed.execution_handle) && sameHandle(handle, probed.execution_handle),
    `ticket ${ticket.id} has no matching activity probe`);
  const completed = history.find((event) => event?.event === "agent_completed");
  const released = history.find((event) => event?.event === "agent_slot_released");
  assert(completed && released, `ticket ${ticket.id} must record terminal and release events`);
  assert(validDate(ticket.finished_at) && validDate(ticket.slot_released_at), `ticket ${ticket.id} needs finish/release timestamps`);
  assert(Date.parse(ticket.slot_released_at) >= Date.parse(ticket.finished_at), `ticket ${ticket.id} released before terminal completion`);
  assert(validDate(completed.at) && validDate(released.at), `ticket ${ticket.id} lifecycle event timestamps are invalid`);
  assert(Date.parse(released.at) >= Date.parse(completed.at), `ticket ${ticket.id} release event precedes completion event`);
  assert(validHandle(released.execution_handle) && sameHandle(handle, released.execution_handle),
    `ticket ${ticket.id} release handle does not match execution handle`);
  assert(ticket.safety_verdict?.accepted === true && Array.isArray(ticket.safety_verdict.changes),
    `ticket ${ticket.id} must retain an accepted safety verdict`);
}

function verifyOneSession(tickets) {
  const sessions = new Set(tickets.map((ticket) => String(ticket.session_uid || "")));
  assert(sessions.size === 1 && !sessions.has(""), "all five tickets must share one Baton session_uid");
  const ordinals = tickets.map((ticket) => ticket.session_ordinal).sort((left, right) => left - right);
  assert(ordinals.every(Number.isInteger) && new Set(ordinals).size === tickets.length,
    "all five tickets need unique session ordinals");
  for (let index = 1; index < ordinals.length; index += 1) {
    assert(ordinals[index] === ordinals[index - 1] + 1, "the five ticket ordinals must be contiguous in one session");
  }
}

function verifyNoLeaks(records) {
  const seen = new Set();
  for (const ticket of records) {
    assert(!seen.has(ticket.id), `duplicate ticket id: ${ticket.id}`);
    seen.add(ticket.id);
    assert(!ACTIVE.has(ticket.status), `active ticket leak: ${ticket.id} (${ticket.status})`);
    if (TERMINAL.has(ticket.status)) {
      assert(ticket.slot_released_at, `terminal ticket ${ticket.id} still owns a host slot`);
    }
  }
}

function verifyTaskNumbers(probe) {
  const numbers = probe.map((ticket) => String(ticket.openspec?.number || ""));
  assert(numbers.length === PROBE_TASKS.length && new Set(numbers).size === numbers.length, "probe task numbers must be unique");
  assert(PROBE_TASKS.every((number) => numbers.includes(number)), `probe tasks must be exactly ${PROBE_TASKS.join(", ")}`);
}

function verifyDependencyOrdering(probe) {
  const byTask = new Map(probe.map((ticket) => [String(ticket.openspec.number), ticket]));
  const firstWave = [byTask.get("1.1"), byTask.get("1.2")];
  const integration = byTask.get("2.1");
  assert(firstWave.every(Boolean) && integration, "probe dependency tasks are incomplete");
  const starts = firstWave.map((ticket) => dateOf(ticket.started_at));
  const finishes = firstWave.map((ticket) => dateOf(ticket.finished_at));
  assert(starts.every(Number.isFinite) && finishes.every(Number.isFinite), "parallel probe tasks need start/finish timestamps");
  assert(Math.max(...starts) < Math.min(...finishes), "probe tasks 1.1 and 1.2 must overlap");
  const reservation = (integration.history || []).find((event) => event?.event === "dispatch_reserved");
  const reservedAt = dateOf(reservation?.at);
  assert(Number.isFinite(reservedAt) && reservedAt >= Math.max(...finishes), "probe task 2.1 was dispatched before both dependencies finished");
  assert(dateOf(integration.started_at) >= Math.max(...finishes), "probe task 2.1 started before both dependencies finished");
}

/**
 * A compiled scenario is optional for older/manual probe runs.  When the
 * current dual-skill flow persists one, validate the complete director
 * contract in one place without changing the legacy five-ticket evidence.
 */
function verifyCompiledApplyScenario(runtime, workspace) {
  const file = path.join(runtime, "compiled-apply-scenario.json");
  if (!fs.existsSync(file)) return null;
  const scenario = readJson(file);
  assert(scenario && typeof scenario === "object" && !Array.isArray(scenario), "compiled apply scenario must be an object");
  assert(scenario.schema_version === 1, "compiled apply scenario must use schema version 1");
  const plan = scenario.plan;
  assert(plan && typeof plan === "object" && !Array.isArray(plan), "compiled apply scenario needs a plan");
  assert(plan.schema_version === 1, "compiled apply plan must use schema version 1");
  assert(plan.identity?.change_id === CHANGE, "compiled apply plan must target probe-e2e");
  const plannedRoot = String(plan.source_snapshot?.repo_root || "");
  assert(plannedRoot && fs.realpathSync(plannedRoot) === fs.realpathSync(workspace), "compiled apply plan source root must be the disposable workspace");
  assert(Array.isArray(plan.selected_tasks) && plan.selected_tasks.length > 0, "compiled apply plan needs selected tasks");
  const units = Array.isArray(plan.units) ? plan.units : [];
  assert(units.length >= 4, "compiled apply scenario needs split, merged, and integration units");
  const unitById = new Map(units.map((unit) => [unit?.id, unit]));
  assert(units.every((unit) => unit && (unit.mode === "patch-only" || unit.mode === "verification-only")), "compiled apply units must be patch-only or verification-only");
  const patchUnits = units.filter((unit) => unit.mode === "patch-only");
  assert(patchUnits.length >= 4, "compiled apply scenario needs patch-only units");
  assert(patchUnits.every((unit) => Array.isArray(unit.write_paths) && unit.write_paths.length > 0 && Array.isArray(unit.allowed_operations) && unit.allowed_operations.length > 0), "patch-only units need write paths and operations");
  assert(units.filter((unit) => unit.mode === "verification-only").every((unit) => !Object.hasOwn(unit, "write_paths") && !Object.hasOwn(unit, "allowed_operations") && !Object.hasOwn(unit, "patch")), "verification-only units must not carry write scope or patch fields");

  const mappings = Array.isArray(plan.task_mappings) ? plan.task_mappings : [];
  const split = mappings.find((mapping) => Array.isArray(mapping?.unit_ids) && mapping.unit_ids.length >= 2);
  assert(split, "compiled apply plan must map one broad task to multiple units");
  assert(new Set(split.unit_ids).size === split.unit_ids.length && split.unit_ids.every((id) => unitById.has(id)), "split mapping must reference distinct known units");
  const merged = patchUnits.find((unit) => Array.isArray(unit.task_ids) && unit.task_ids.length >= 2);
  assert(merged, "compiled apply plan must merge coupled tasks into one patch unit");
  const overlap = patchUnits.flatMap((left, leftIndex) => patchUnits.slice(leftIndex + 1).map((right) => {
    const leftPaths = new Set(left.write_paths || []);
    const shared = (right.write_paths || []).find((item) => leftPaths.has(item));
    if (!shared) return null;
    const leftDependsOnRight = Array.isArray(left.depends_on) && left.depends_on.includes(right.id);
    const rightDependsOnLeft = Array.isArray(right.depends_on) && right.depends_on.includes(left.id);
    return leftDependsOnRight || rightDependsOnLeft ? { left, right, path: shared } : null;
  }).filter(Boolean)).find(Boolean);
  assert(overlap, "later overlapping integration unit must be ordered after its predecessor");

  const prohibitions = Array.isArray(scenario.patch_only_prompt_prohibitions) ? scenario.patch_only_prompt_prohibitions : [];
  const requiredProhibitions = ["redesign", "broaden scope", "spawn children", "Git", "OpenSpec", "choose models"];
  for (const phrase of requiredProhibitions) assert(prohibitions.some((item) => String(item).toLowerCase().includes(phrase.toLowerCase())), `patch-only prohibition is missing: ${phrase}`);
  const patchPrompts = patchUnits.map((unit) => `${unit.prompt || ""} ${unit.patch || ""}`).join("\n").toLowerCase();
  for (const phrase of requiredProhibitions) assert(patchPrompts.includes(phrase.toLowerCase()), `patch-only prompt must prohibit ${phrase}`);

  const gate = (Array.isArray(plan.parent_gates) ? plan.parent_gates : []).find((item) => item?.id === scenario.parent_gate_id);
  assert(gate, "compiled apply scenario needs a parent gate");
  assert(Array.isArray(gate.unit_ids) && gate.unit_ids.length >= 3 && gate.unit_ids.every((id) => unitById.has(id)), "parent gate must aggregate mapped units");
  const state = scenario.run_state;
  assert(state && state.current_revision && state.current_fingerprint, "compiled apply scenario needs persisted run revision");
  assert(state.reconciled === true, "compiled apply scenario run must be reconciled");
  assert(Object.values(state.unit_status || {}).filter((status) => status === "accepted" || status === "reconciled").length >= gate.unit_ids.length, "parent gate units must be accepted");
  assert(state.gate_status?.[gate.id] === "accepted" || state.gate_status?.[gate.id] === "reconciled", "parent gate must be accepted");
  assert(plan.selected_tasks.every((taskId) => state.task_status?.[taskId] === "reconciled"), "all selected tasks must be reconciled");
  assert(Array.isArray(state.terminal_unreleased_tickets) && state.terminal_unreleased_tickets.length === 0, "compiled apply run must not retain terminal-unreleased tickets");

  const timeline = Array.isArray(scenario.timeline) ? scenario.timeline : [];
  const terminal = timeline.filter((event) => event?.event === "unit-terminal");
  const releases = timeline.filter((event) => event?.event === "ticket-released");
  const gateAccepted = timeline.find((event) => event?.event === "gate-accepted");
  const refill = timeline.find((event) => event?.event === "refill");
  const checkbox = timeline.find((event) => event?.event === "checkbox-reconciled");
  assert(terminal.length && releases.length && gateAccepted && refill && checkbox, "compiled apply timeline is incomplete");
  const terminalAt = Math.max(...terminal.map((event) => dateOf(event.at)));
  const releasedAt = Math.max(...releases.map((event) => dateOf(event.at)));
  const gateAt = dateOf(gateAccepted.at);
  const refillAt = dateOf(refill.at);
  const checkboxAt = dateOf(checkbox.at);
  assert([terminalAt, releasedAt, gateAt, refillAt, checkboxAt].every(Number.isFinite), "compiled apply timeline has invalid timestamps");
  assert(releases.some((event) => dateOf(event.at) <= refillAt && Array.isArray(event.ticket_ids) && event.ticket_ids.length > 0), "capacity must be released before refill");
  assert(checkboxAt > terminalAt && checkboxAt > gateAt && checkboxAt > releasedAt, "OpenSpec checkbox completed before parent acceptance/release");

  const routing = scenario.routing;
  assert(routing && Array.isArray(routing.configured_route_ids) && routing.configured_route_ids.length >= 2, "compiled apply scenario needs configured route order");
  assert(routing.configured_route_ids[0] === "spark", "Spark must be the first configured candidate");
  assert(Array.isArray(routing.candidates) && routing.candidates.length === routing.configured_route_ids.length, "route progression must cover every configured route");
  assert(routing.candidates.every((candidate, index) => candidate?.route_id === routing.configured_route_ids[index]), "route progression must preserve configured order");
  const spark = routing.candidates[0];
  assert(spark.status === "excluded" && (spark.reasons || []).some((reason) => /under-capable|session.*exhausted|quota.*exhausted/i.test(String(reason))), "Spark exclusion must be capability or current-session exhaustion");
  assert(routing.silent_advance === true && routing.selected_route_id && routing.configured_route_ids.includes(routing.selected_route_id) && routing.selected_route_id !== "spark", "a qualified later route must be selected silently");
  assert(routing.candidates.every((candidate) => routing.configured_route_ids.includes(candidate.route_id)), "routing must not select an unconfigured route");

  const cache = scenario.session_cache;
  assert(cache?.scope === "current-session-only" && cache.current_session_id !== cache.prior_session_id && cache.new_session_rechecks === true, "quota and uncallability cache must be session-local");
  assert(cache.prior_session_route === "spark", "prior-session Spark evidence must remain isolated");
  const noQualified = scenario.no_qualified;
  assert(noQualified?.code === "NO_QUALIFIED_CANDIDATE", "missing route qualification must use NO_QUALIFIED_CANDIDATE");
  assert(Array.isArray(noQualified.configured_route_ids) && Array.isArray(noQualified.exclusions), "no-qualified result must include configured routes and exclusions");
  assert(noQualified.exclusions.length === noQualified.configured_route_ids.length, "no-qualified result must explain every configured route");
  const exclusionCodes = new Set(noQualified.exclusions.flatMap((item) => item.codes || []));
  assert(NO_QUALIFIED_CODES.every((code) => exclusionCodes.has(code)), "no-qualified result must include the complete exclusion matrix");
  assert(noQualified.exclusions.every((item) => noQualified.configured_route_ids.includes(item.route_id)), "no-qualified exclusions must not contain unconfigured routes");

  assert(scenario.manual_compatibility?.legacy_ticket_id && scenario.manual_compatibility.compiled_apply_lineage === false, "manual ticket compatibility evidence is missing");
  assert(Array.isArray(scenario.active_ticket_ids) && scenario.active_ticket_ids.length === 0, "compiled apply scenario has leaked active tickets");
  return {
    run_id: scenario.run_id || state.run_id || null,
    revision: state.current_revision,
    split_task: split.task_id,
    merged_unit: merged.id,
    overlapping_units: [overlap.left.id, overlap.right.id],
    parent_gate: gate.id,
    selected_route: routing.selected_route_id,
    no_qualified_codes: [...exclusionCodes].sort(),
    active_ticket_count: scenario.active_ticket_ids.length,
  };
}

function verifyWorkspace(workspace) {
  const standaloneDir = path.join(workspace, "standalone");
  assert(fs.existsSync(standaloneDir), "missing standalone/ output directory");
  for (const name of ["alpha.js", "beta.js"]) {
    assert(fs.existsSync(path.join(standaloneDir, name)), `missing standalone output: standalone/${name}`);
  }
  const probeFiles = [
    "package.json",
    "src/utils/format.js",
    "src/utils/validate.js",
    "src/index.js",
    "verify-local.mjs",
    "verify-standalone.mjs",
    "openspec/changes/probe-e2e/tasks.md",
  ];
  for (const name of probeFiles) assert(fs.existsSync(path.join(workspace, name)), `missing probe file: ${name}`);

  const tasksPath = path.join(workspace, "openspec/changes/probe-e2e/tasks.md");
  const tasks = fs.readFileSync(tasksPath, "utf8");
  assert((tasks.match(/^- \[[xX]\]/gm) || []).length === PROBE_TASKS.length, "all probe tasks must be checked");
  assert((tasks.match(/^\s+- conclusion:/gm) || []).length === PROBE_TASKS.length, "all probe tasks need conclusions");
  const validation = spawnSync("openspec", ["validate", CHANGE, "--strict", "--no-interactive"], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert(validation.status === 0, validation.stderr || validation.stdout || "OpenSpec strict validation failed");
  const local = spawnSync("bun", ["verify-local.mjs"], { cwd: workspace, encoding: "utf8" });
  assert(local.status === 0, local.stderr || local.stdout || "verify-local.mjs failed");
  const standalone = spawnSync("bun", ["verify-standalone.mjs"], { cwd: workspace, encoding: "utf8" });
  assert(standalone.status === 0, standalone.stderr || standalone.stdout || "verify-standalone.mjs failed");
}

function isProbeTicket(ticket) {
  if (ticket?.source !== "openspec") return false;
  const change = String(ticket.openspec?.change || ticket.openspec?.change_id || "");
  const changeDir = String(ticket.openspec?.change_dir || ticket.openspec?.tasks_path || "");
  return change === CHANGE || /(?:^|\/)changes\/probe-e2e(?:\/|$)/.test(changeDir.replaceAll("\\", "/"));
}

function validHandle(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.kind === "string" && /^[a-z][a-z0-9._-]*$/.test(value.kind)
    && typeof value.value === "string" && value.value.trim()
    && (value.source === "native-return" || value.source === "manual")
    ? value
    : null;
}

function sameHandle(left, right) {
  return left.kind === right.kind && left.value === right.value && left.source === right.source;
}

function routeOf(model) {
  const value = typeof model === "string" ? model : "";
  const at = value.lastIndexOf("@");
  return at > 0 ? value.slice(0, at) : value;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJsonDirectory(directory, label) {
  assert(fs.existsSync(directory), `missing Baton ${label} directory: ${directory}`);
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(directory, name)));
}

function realpathWorkspace(value) {
  const workspace = fs.realpathSync(path.resolve(value));
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "WORKSPACE_NOT_GIT");
  const root = fs.realpathSync(result.stdout.trim());
  if (root !== workspace) throw new Error("workspace must be its own Git root");
  return workspace;
}

function workspaceId(workspace) {
  return crypto.createHash("sha256").update(workspace).digest("hex");
}

function dateOf(value) {
  return Date.parse(String(value || ""));
}

function validDate(value) {
  return Number.isFinite(dateOf(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  process.stderr.write(`FAIL: ${String(message).trim()}\n`);
  process.exitCode = 1;
}
