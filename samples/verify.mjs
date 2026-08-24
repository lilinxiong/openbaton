#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
const argv = process.argv.slice(2);
const hostFlagIndex = argv.indexOf("--host");
const explicitHost = hostFlagIndex >= 0 ? argv[hostFlagIndex + 1] : null;
if (hostFlagIndex >= 0 && !explicitHost) fail("usage: --host requires codex|grok|cursor");
const positional = hostFlagIndex >= 0
  ? argv.filter((_, index) => index !== hostFlagIndex && index !== hostFlagIndex + 1)
  : argv;
const workspaceArg = positional[0];
const mode = positional[1];
if (!workspaceArg || !new Set(["standalone", "openspec"]).has(mode)) {
  fail("usage: bun samples/verify.mjs [--host codex|grok|cursor] WORKSPACE standalone|openspec");
}

const workspace = fs.realpathSync(path.resolve(workspaceArg));
const root = git(["rev-parse", "--show-toplevel"]).trim();
if (fs.realpathSync(root) !== workspace) fail("workspace must be its own Git root");

const home = userHome();
const batonRoot = batonHome();
const workspaceId = crypto.createHash("sha256").update(workspace).digest("hex");
const batonWorkspace = path.join(batonRoot, "workspaces", workspaceId);
const tickets = readJsonDirectory(path.join(batonWorkspace, "spawns"))
  .filter((ticket) => ticket.source === (mode === "openspec" ? "openspec" : "standalone"))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));
const proposals = readJsonDirectory(path.join(batonWorkspace, "selections"))
  .filter((proposal) => proposal.source === (mode === "openspec" ? "openspec" : "standalone"))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

const host = resolveInvokingHost({ explicitHost, env: process.env, tickets });

assert(tickets.length === 5, `expected 5 ${mode} tickets, got ${tickets.length}`);
assert(tickets.every((ticket) => ticket.status === "completed"), "every ticket must be completed");
assert(tickets.every((ticket) => ticket.agent_id), "every ticket must bind a real agent id");
assert(tickets.every((ticket) => ticket.attempt === 1), "every ticket must complete in one attempt");
assert(tickets.every((ticket) => ticket.slot_released_at), "every terminal ticket must release its host slot");
assert(tickets.every((ticket) => ticket.route_id), "every ticket must carry an exact CLI route id");
assert(tickets.every((ticket) => {
  const expected = ticket.reasoning_effort ? `${ticket.route_id}@${ticket.reasoning_effort}` : ticket.route_id;
  return ticket.model_id === expected;
}), "model_id must preserve the selected route/reasoning-effort pair");
assert(tickets.every((ticket) => {
  const ticketHost = ticket.target_host || ticket.dispatch_host || ticket.host || ticket.selection?.host;
  return ticketHost === host;
}), `every ticket must target the invoking host ${host}`);

verifyAutomaticSelection(tickets, proposals, host);

const concrete = tickets.filter((ticket) => ticket.work_unit?.kind === "concrete");
const deliberative = tickets.filter((ticket) => ticket.work_unit?.kind === "deliberative");
assert(concrete.length === 4, `expected 4 concrete tickets, got ${concrete.length}`);
assert(deliberative.length === 1, `expected 1 deliberative ticket, got ${deliberative.length}`);
assert(concrete.every((ticket) => ticket.coordination?.mode === "terminal-only"), "concrete tickets must be terminal-only");
assert(deliberative[0].coordination?.mode === "checkpointed", "deliberative ticket must be checkpointed");
assert(Number(deliberative[0].progress?.sequence || 0) >= 1, "deliberative ticket must persist at least one progress checkpoint");

verifyQueueRefill(tickets, batonWorkspace, host);
verifyWorkspace(mode);

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode,
  host,
  workspace,
  routing: "automatic",
  tickets: tickets.map((ticket) => ({
    id: ticket.id,
    source: ticket.source,
    task_kind: ticket.work_unit.kind,
    model: ticket.model_id,
    attempt: ticket.attempt,
    progress_sequence: ticket.progress?.sequence || 0,
    released: Boolean(ticket.slot_released_at),
    proposal_id: ticket.selection?.proposal_id,
    confirmed_by: ticket.selection?.confirmed_by,
  })),
  business_oracle: path.join(samplesDir, "EXPECTED.md"),
}, null, 2)}\n`);

function verifyAutomaticSelection(items, selections, expectedHost) {
  assert(selections.length === 1, `one request must create exactly one ${mode} proposal, got ${selections.length}`);
  const proposal = selections[0];
  const delegatedUnits = proposal.units.filter((unit) => !unit.director_local);
  assert(delegatedUnits.length === items.length, `expected ${items.length} delegated units, got ${delegatedUnits.length}`);
  assert(proposal.status === "approved" && proposal.approved_at, "the recommendation must be approved automatically");
  assert(proposal.model_policy_id === "configured-cli-subagent-allowlist-v1", "proposal must bind the configured CLI allowlist policy");
  assert(Array.isArray(proposal.policy_exclusions) && proposal.policy_exclusions.length === 0, "there must be no hard-coded model-family exclusions");
  assert(proposal.confirmation?.scope === "proposal", "automatic approval is scoped to its request proposal");
  assert(proposal.confirmation?.confirmed_by === "baton-recommendation", "approval must not claim user model confirmation");
  assert(proposal.history?.[0]?.event === "pending_confirmation" && proposal.history?.some((event) => event.event === "approved"), "proposal must retain create-then-auto-approve audit order");
  if (proposal.host) assert(proposal.host === expectedHost, `proposal must target the invoking host ${expectedHost}`);

  if (mode === "standalone") {
    const sourceRequest = fs.readFileSync(path.join(workspace, "REQUEST.txt"), "utf8").trim();
    assert(proposal.payload?.source_shape === "multi-unit-v1", "standalone must use one request-level multi-unit proposal");
    assert(proposal.payload?.description === sourceRequest, "standalone proposal must preserve the request text");
  }

  const approvals = new Map(proposal.approvals.map((approval) => [approval.key, approval]));
  for (const unit of delegatedUnits) {
    assert(unit.recommended_model_id, `${proposal.id}/${unit.key} must have an automatic recommendation`);
    assert(unit.default_model_id === unit.recommended_model_id, `${proposal.id}/${unit.key} default must equal its recommendation`);
    assert(unit.requires_manual_choice === false, `${proposal.id}/${unit.key} must not require manual model choice`);
    assert(unit.candidates.some((candidate) => candidate.model_id === unit.recommended_model_id && candidate.selectable && candidate.automatic_eligible), `${proposal.id}/${unit.key} recommendation must be an eligible CLI candidate`);
    const approval = approvals.get(unit.key);
    assert(approval?.confirmed_by === "baton-recommendation", `${proposal.id}/${unit.key} must be approved by Baton`);
    assert(approval?.selected_model_id === unit.recommended_model_id, `${proposal.id}/${unit.key} must select its recommendation`);
    const selectedCandidate = unit.candidates.find((candidate) => candidate.model_id === unit.recommended_model_id);
    assert((approval?.service_tier || null) === (selectedCandidate?.service_tier || null), `${proposal.id}/${unit.key} must persist its automatic service tier`);
    assert(approval?.changed_by_user === false, `${proposal.id}/${unit.key} must not record a user override`);
    if (approval?.host) assert(approval.host === expectedHost, `${proposal.id}/${unit.key} must target the invoking host ${expectedHost}`);
  }

  for (const ticket of items) {
    const selection = ticket.selection;
    assert(selection?.confirmed_by === "baton-recommendation", `${ticket.id} must carry automatic recommendation evidence`);
    assert(selection?.changed_by_user === false, `${ticket.id} must not claim user model input`);
    assert(selection?.selected_model_id === ticket.model_id, `${ticket.id} selection must match its exact model id`);
    assert((selection?.service_tier || null) === (ticket.service_tier || null), `${ticket.id} must preserve its selected service tier`);
    const unitKey = selection?.unit_key || (mode === "openspec" ? ticket.openspec?.number : null);
    const unit = proposal.units.find((item) => item.key === unitKey);
    assert(unit?.recommended_model_id === ticket.model_id, `${ticket.id} must use its unit recommendation`);
    if (selection?.host) assert(selection.host === expectedHost, `${ticket.id} must target the invoking host ${expectedHost}`);
  }

  const snapshot = readRouteSnapshot(home, expectedHost);
  assert(snapshot, `Baton must persist the ${expectedHost} CLI model snapshot`);
  assert(snapshot.schema_version === 5 && snapshot.source === "cli" && snapshot.cli === expectedHost, `snapshot must use the ${expectedHost} CLI-owned schema`);
  const routes = new Map(snapshot.routes.map((route) => [route.route_id, route]));
  for (const ticket of items) {
    const route = routes.get(ticket.route_id);
    assert(route && !route.disabled, `${ticket.id} route must exist in the current ${expectedHost} snapshot`);
    if (ticket.reasoning_effort) {
      assert(route.reasoning_efforts.includes(ticket.reasoning_effort), `${ticket.id} effort must be returned by ${expectedHost} for ${ticket.route_id}`);
    }
    if (ticket.service_tier) {
      assert(route.service_tiers.includes(ticket.service_tier) || route.additional_speed_tiers.includes(ticket.service_tier), `${ticket.id} service tier must be returned by ${expectedHost} for ${ticket.route_id}`);
    }
  }
}

function verifyQueueRefill(items, runtimeRoot, expectedHost) {
  const dispatchState = path.join(runtimeRoot, "runs", `dispatch-${expectedHost}.json`);
  const legacyState = path.join(runtimeRoot, "runs", "dispatch.json");
  const file = fs.existsSync(dispatchState) ? dispatchState : legacyState;
  if (!fs.existsSync(file)) return;
  const capacity = Number(JSON.parse(fs.readFileSync(file, "utf8")).capacity);
  if (!Number.isInteger(capacity) || capacity >= items.length) return;
  const releases = items.map((ticket) => Date.parse(ticket.slot_released_at || "")).filter(Number.isFinite).sort((a, b) => a - b);
  const reservations = items.map((ticket) => Date.parse(ticket.history?.find((entry) => entry.event === "dispatch_reserved")?.at || "")).filter(Number.isFinite);
  assert(releases.length > 0 && reservations.some((at) => at >= releases[0]), "queued work must refill only after a slot release");
}

function verifyWorkspace(sampleMode) {
  const status = git(["status", "--short"]);
  if (sampleMode === "standalone") {
    assert(!fs.existsSync(path.join(workspace, "openspec")), "standalone sample must not contain openspec/");
    assert(status.trim() === "", `standalone workspace must stay clean:\n${status}`);
    return;
  }
  const tasksPath = path.join(workspace, "openspec", "changes", "incident-audit", "tasks.md");
  const tasks = fs.readFileSync(tasksPath, "utf8");
  assert((tasks.match(/^- \[x\]/gm) || []).length === 5, "all five OpenSpec tasks must be checked");
  assert((tasks.match(/^\s+- conclusion:/gm) || []).length === 5, "all five OpenSpec tasks must have conclusions");
  const changed = status.trim().split(/\r?\n/).filter(Boolean);
  assert(changed.length === 1 && changed[0].endsWith("openspec/changes/incident-audit/tasks.md"), `unexpected OpenSpec workspace changes:\n${status}`);
  const validation = spawnSync("openspec", ["validate", "incident-audit", "--strict", "--no-interactive"], { cwd: workspace, encoding: "utf8" });
  assert(validation.status === 0, validation.stderr || validation.stdout || "OpenSpec strict validation failed");
}

function readJsonDirectory(directory) {
  if (!fs.existsSync(directory)) fail(`missing Baton runtime directory: ${directory}`);
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
}

function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`FAIL: ${String(message).trim()}\n`);
  process.exit(1);
}
