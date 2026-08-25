#!/usr/bin/env bun

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  batonHome,
  readRouteSnapshot,
  resolveInvokingHost,
  userHome,
} from "./lib/host.mjs";

const samplesDir = path.dirname(fileURLToPath(import.meta.url));
const CHANGE = "probe-e2e";
const EXPECTED_TASKS = ["1.1", "1.2", "2.1"];

const argv = process.argv.slice(2);
const hostFlagIndex = argv.indexOf("--host");
const explicitHost = hostFlagIndex >= 0 ? argv[hostFlagIndex + 1] : null;
if (hostFlagIndex >= 0 && !explicitHost) fail("usage: --host requires codex|grok|cursor|claude");
const positional = hostFlagIndex >= 0
  ? argv.filter((_, index) => index !== hostFlagIndex && index !== hostFlagIndex + 1)
  : argv;
const workspaceArg = positional[0];
if (!workspaceArg) fail("usage: bun samples/verify-probe.mjs [--host codex|grok|cursor|claude] WORKSPACE");

const workspace = fs.realpathSync(path.resolve(workspaceArg));
const root = git(["rev-parse", "--show-toplevel"]).trim();
if (fs.realpathSync(root) !== workspace) fail("workspace must be its own Git root");

const home = userHome();
const batonRoot = batonHome();
const workspaceId = crypto.createHash("sha256").update(workspace).digest("hex");
const batonWorkspace = path.join(batonRoot, "workspaces", workspaceId, "v2");
const tickets = readJsonDirectory(path.join(batonWorkspace, "spawns"))
  .filter(isProbeTicket)
  .sort((a, b) => String(a.openspec?.number || a.id).localeCompare(String(b.openspec?.number || b.id)));
const proposals = readJsonDirectory(path.join(batonWorkspace, "selections"))
  .filter((proposal) => proposal.source === "openspec" && proposal.payload?.change === CHANGE)
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

const host = resolveInvokingHost({ explicitHost, env: process.env, tickets });

assert(tickets.length === EXPECTED_TASKS.length, `expected ${EXPECTED_TASKS.length} openspec tickets, got ${tickets.length}`);
assert(tickets.every((ticket) => ticket.status === "completed"), "every ticket must be completed");
assert(tickets.every((ticket) => ticket.agent_id), "every ticket must bind a real agent id");
assert(tickets.every((ticket) => ticket.attempt === 1), "every ticket must complete in one attempt");
assert(tickets.every((ticket) => ticket.slot_released_at), "every terminal ticket must release its host slot");
assert(tickets.every((ticket) => ticket.route_id), "every ticket must carry an exact CLI route id");
assert(tickets.every((ticket) => ticket.work_unit?.kind === "concrete"), "probe tasks must be concrete");
assert(tickets.every((ticket) => {
  const expected = ticket.reasoning_effort ? `${ticket.route_id}@${ticket.reasoning_effort}` : ticket.route_id;
  return ticket.model_id === expected;
}), "model_id must preserve the selected route/reasoning-effort pair");
assert(tickets.every((ticket) => {
  const ticketHost = ticket.target_host || ticket.dispatch_host || ticket.host || ticket.selection?.host;
  return ticketHost === host;
}), `every ticket must target the invoking host ${host}`);
assert.deepEqual(
  tickets.map((ticket) => ticket.openspec?.number),
  EXPECTED_TASKS,
  "ticket task numbers must match probe-e2e",
);

verifyAutomaticSelection(tickets, proposals, host);
verifyQueueRefill(tickets, batonWorkspace, host);
verifyWaveConcurrency(tickets);
verifyWorkspace();
verifyLocal();

process.stdout.write(`${JSON.stringify({
  ok: true,
  change: CHANGE,
  host,
  workspace,
  routing: "automatic",
  tickets: tickets.map((ticket) => ({
    id: ticket.id,
    task: ticket.openspec?.number,
    model: ticket.model_id,
    attempt: ticket.attempt,
    released: Boolean(ticket.slot_released_at),
    confirmed_by: ticket.selection?.confirmed_by,
  })),
}, null, 2)}\n`);

function verifyAutomaticSelection(items, selections, expectedHost) {
  assert(selections.length >= 1, "expected at least one openspec proposal");
  const proposal = selections[0];
  const delegatedUnits = proposal.units.filter((unit) => !unit.director_local);
  assert(delegatedUnits.length === items.length, `expected ${items.length} delegated units, got ${delegatedUnits.length}`);
  assert(proposal.status === "approved" && proposal.approved_at, "the recommendation must be approved automatically");
  assert(proposal.confirmation?.confirmed_by === "baton-recommendation", "approval must not claim user model confirmation");

  const approvals = new Map(proposal.approvals.map((approval) => [approval.key, approval]));
  for (const unit of delegatedUnits) {
    assert(unit.recommended_model_id, `${proposal.id}/${unit.key} must have an automatic recommendation`);
    assert(unit.requires_manual_choice === false, `${proposal.id}/${unit.key} must not require manual model choice`);
    const approval = approvals.get(unit.key);
    assert(approval?.confirmed_by === "baton-recommendation", `${proposal.id}/${unit.key} must be approved by Baton`);
    assert(approval?.changed_by_user === false, `${proposal.id}/${unit.key} must not record a user override`);
  }

  const snapshot = readRouteSnapshot(home, expectedHost);
  assert(snapshot, `Baton must persist the ${expectedHost} CLI model snapshot`);
  assert(snapshot.schema_version === 5 && snapshot.source === "cli" && snapshot.cli === expectedHost);
}

function verifyQueueRefill(items, runtimeRoot, expectedHost) {
  const dispatchState = path.join(runtimeRoot, "runs", `dispatch-${expectedHost}.json`);
  if (!fs.existsSync(dispatchState)) return;
  const capacity = Number(JSON.parse(fs.readFileSync(dispatchState, "utf8")).capacity);
  if (!Number.isInteger(capacity) || capacity >= items.length) return;
  const releases = items.map((ticket) => Date.parse(ticket.slot_released_at || "")).filter(Number.isFinite).sort((a, b) => a - b);
  const reservations = items.map((ticket) => Date.parse(ticket.history?.find((entry) => entry.event === "dispatch_reserved")?.at || "")).filter(Number.isFinite);
  assert(releases.length > 0 && reservations.some((at) => at >= releases[0]), "queued work must refill only after a slot release");
}

function verifyWaveConcurrency(items) {
  const byTask = new Map(items.map((ticket) => [ticket.openspec?.number, ticket]));
  const firstWave = [byTask.get("1.1"), byTask.get("1.2")];
  const later = byTask.get("2.1");
  assert(firstWave.every(Boolean) && later, "probe tickets must include both first-wave tasks and the later task");

  const starts = firstWave.map((ticket) => Date.parse(ticket.started_at || ""));
  const finishes = firstWave.map((ticket) => Date.parse(ticket.finished_at || ""));
  assert(starts.every(Number.isFinite) && finishes.every(Number.isFinite), "first-wave tickets need start and finish timestamps");
  assert(Math.max(...starts) < Math.min(...finishes), "OpenSpec tasks 1.1 and 1.2 must overlap in worker time");

  const laterReservation = Date.parse(later.history?.find((entry) => entry.event === "dispatch_reserved")?.at || "");
  assert(Number.isFinite(laterReservation), "later task needs a dispatch reservation timestamp");
  assert(laterReservation >= Math.max(...finishes), "task 2.1 must not dispatch before the first wave finishes");
}

function verifyWorkspace() {
  const tasksPath = path.join(workspace, "openspec", "changes", CHANGE, "tasks.md");
  const tasks = fs.readFileSync(tasksPath, "utf8");
  assert((tasks.match(/^- \[x\]/gm) || []).length === EXPECTED_TASKS.length, "all probe tasks must be checked");
  assert((tasks.match(/^\s+- conclusion:/gm) || []).length === EXPECTED_TASKS.length, "all probe tasks must have conclusions");

  for (const file of [
    "src/utils/format.js",
    "src/utils/validate.js",
    "src/index.js",
  ]) {
    assert(fs.existsSync(path.join(workspace, file)), `missing implementation file: ${file}`);
  }

  const validation = spawnSync("openspec", ["validate", CHANGE, "--strict", "--no-interactive"], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert(validation.status === 0, validation.stderr || validation.stdout || "OpenSpec strict validation failed");
}

function verifyLocal() {
  const result = spawnSync("bun", ["verify-local.mjs"], { cwd: workspace, encoding: "utf8" });
  assert(result.status === 0, result.stderr || result.stdout || "verify-local.mjs failed");
}

function isProbeTicket(ticket) {
  if (ticket.source !== "openspec") return false;
  const changeDir = String(ticket.openspec?.change_dir || "");
  const tasksPath = String(ticket.openspec?.tasks_path || "");
  return changeDir.includes(`${path.sep}changes${path.sep}${CHANGE}`)
    || tasksPath.includes(`${path.sep}changes${path.sep}${CHANGE}${path.sep}tasks.md`);
}

function readJsonDirectory(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
}

function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function fail(message) {
  process.stderr.write(`FAIL: ${String(message).trim()}\n`);
  process.exit(1);
}
