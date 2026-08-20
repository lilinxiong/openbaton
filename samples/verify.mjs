#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const samplesDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceArg = process.argv[2];
const mode = process.argv[3];
if (!workspaceArg || !new Set(["standalone", "openspec"]).has(mode)) {
  fail("usage: bun samples/verify.mjs WORKSPACE standalone|openspec");
}

const workspace = fs.realpathSync(path.resolve(workspaceArg));
const root = git(["rev-parse", "--show-toplevel"]).trim();
if (fs.realpathSync(root) !== workspace) fail("workspace must be its own Git root");

const workspaceId = crypto.createHash("sha256").update(workspace).digest("hex");
const home = process.env.HOME || os.homedir();
const batonWorkspace = path.join(home, ".baton", "workspaces", workspaceId);
const spawnDir = path.join(batonWorkspace, "spawns");
const selectionDir = path.join(batonWorkspace, "selections");
if (!fs.existsSync(spawnDir)) fail(`no Baton runtime found for workspace: ${batonWorkspace}`);
if (!fs.existsSync(selectionDir)) fail(`no model-selection proposals found for workspace: ${selectionDir}`);

const tickets = fs.readdirSync(spawnDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(spawnDir, name), "utf8")))
  .filter((ticket) => ticket.source === (mode === "openspec" ? "openspec" : "standalone"))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

const proposals = fs.readdirSync(selectionDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(selectionDir, name), "utf8")))
  .filter((proposal) => proposal.source === (mode === "openspec" ? "openspec" : "standalone"))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

const forbiddenSubagentFamily = /(?:^|\/)(?:gpt-5\.5|gpt-5\.6-(?:sol|terra))(?:$|[-@/])/;

assert(tickets.length === 5, `expected 5 ${mode} tickets, got ${tickets.length}`);
assert(tickets.every((ticket) => ticket.status === "completed"), "every ticket must be completed");
assert(tickets.every((ticket) => ticket.agent_id), "every ticket must bind a real agent id");
assert(tickets.every((ticket) => ticket.attempt === 1), "every ticket must complete in one attempt");
assert(tickets.every((ticket) => ticket.slot_released_at), "every terminal ticket must release its host slot");
assert(tickets.every((ticket) => ticket.route_id), "every ticket must carry an exact route id");
assert(tickets.every((ticket) => !forbiddenSubagentFamily.test(ticket.model_id) && !forbiddenSubagentFamily.test(ticket.route_id)), "built-in forbidden families must never reach a subagent ticket");
assert(tickets.every((ticket) => {
  const expected = ticket.reasoning_effort ? `${ticket.route_id}@${ticket.reasoning_effort}` : ticket.route_id;
  return ticket.model_id === expected;
}), "model_id must be the exact route/profile id");

verifyModelSelection(tickets, proposals, batonWorkspace);

const concrete = tickets.filter((ticket) => ticket.work_unit?.kind === "concrete");
const deliberative = tickets.filter((ticket) => ticket.work_unit?.kind === "deliberative");
assert(concrete.length === 4, `expected 4 concrete tickets, got ${concrete.length}`);
assert(deliberative.length === 1, `expected 1 deliberative ticket, got ${deliberative.length}`);
assert(concrete.every((ticket) => ticket.coordination?.mode === "terminal-only"), "concrete tickets must be terminal-only");
assert(deliberative[0].coordination?.mode === "checkpointed", "deliberative ticket must be checkpointed");
assert(Number(deliberative[0].progress?.sequence || 0) >= 1, "deliberative ticket must persist at least one progress checkpoint");

verifyQueueRefill(tickets, batonWorkspace);
verifyWorkspace(mode);

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode,
  workspace,
  tickets: tickets.map((ticket) => ({
    id: ticket.id,
    source: ticket.source,
    task_kind: ticket.work_unit.kind,
    model: ticket.model_id,
    attempt: ticket.attempt,
    progress_sequence: ticket.progress?.sequence || 0,
    released: Boolean(ticket.slot_released_at),
    proposal_id: ticket.selection?.proposal_id,
    user_changed_model: ticket.selection?.changed_by_user,
  })),
  business_oracle: path.join(samplesDir, "EXPECTED.md"),
}, null, 2)}\n`);

function verifyQueueRefill(items, runtimeRoot) {
  const dispatchState = path.join(runtimeRoot, "runs", "dispatch.json");
  if (!fs.existsSync(dispatchState)) return;
  const capacity = Number(JSON.parse(fs.readFileSync(dispatchState, "utf8")).capacity);
  if (!Number.isInteger(capacity) || capacity >= items.length) return;
  const releases = items
    .map((ticket) => Date.parse(ticket.slot_released_at || ""))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const reservations = items.map((ticket) => {
    const event = ticket.history?.find((entry) => entry.event === "dispatch_reserved");
    return Date.parse(event?.at || "");
  }).filter(Number.isFinite);
  assert(releases.length > 0 && reservations.some((at) => at >= releases[0]), "queued work must refill only after a slot release");
}

function verifyModelSelection(items, selections, runtimeRoot) {
  const delegatedUnits = selections.flatMap((proposal) => proposal.units.filter((unit) => !unit.director_local));
  assert(delegatedUnits.length === items.length, `expected ${items.length} disclosed delegated units, got ${delegatedUnits.length}`);
  assert(selections.length === (mode === "openspec" ? 1 : 5), `unexpected ${mode} proposal count: ${selections.length}`);
  assert(selections.every((proposal) => proposal.status === "approved" && proposal.approved_at), "every selection proposal must be user-approved");
  assert(selections.every((proposal) => proposal.model_policy_id === "builtin-no-gpt-5.5-gpt-5.6-sol-terra-v2"), "every proposal must bind the current built-in model policy");
  assert(selections.every((proposal) => ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"].every((family) => proposal.policy_exclusions?.some((item) => item.family === family && item.code === "SUBAGENT_MODEL_FAMILY_FORBIDDEN"))), "every proposal must disclose all forbidden model families");
  assert(selections.every((proposal) => proposal.history?.[0]?.event === "pending_confirmation" && proposal.history?.some((event) => event.event === "approved")), "every proposal must prove pending disclosure before approval");

  const byId = new Map(selections.map((proposal) => [proposal.id, proposal]));
  const selectedProviders = new Set();
  const callableProviders = new Set();
  for (const proposal of selections) {
    assert(proposal.host_snapshot_id, `${proposal.id} must bind a Codex host snapshot`);
    assert(Array.isArray(proposal.unavailable_by_provider), `${proposal.id} must disclose host-unavailable providers`);
    for (const unit of proposal.units) {
      assert(Object.hasOwn(unit, "recommended_model_id"), `${proposal.id}/${unit.key} must disclose preferred model state`);
      if (unit.director_local) continue;
      assert(unit.candidates.length > 0, `${proposal.id}/${unit.key} must disclose candidates`);
      assert(unit.candidates.every((candidate) => !forbiddenSubagentFamily.test(candidate.model_id) && !forbiddenSubagentFamily.test(candidate.route_id)), `${proposal.id}/${unit.key} must exclude all built-in forbidden candidate families`);
      for (const candidate of unit.candidates) {
        assert(candidate.strengths, `${candidate.model_id} must disclose strengths`);
        assert(Object.hasOwn(candidate, "task_score"), `${candidate.model_id} must disclose task score`);
        assert(Object.hasOwn(candidate, "reference_only"), `${candidate.model_id} must disclose whether evidence is reference-only`);
        assert(Array.isArray(candidate.reference_reasons), `${candidate.model_id} must disclose reference provenance`);
        assert(Object.hasOwn(candidate, "reference_route_id"), `${candidate.model_id} must disclose reference route provenance`);
        assert(Object.hasOwn(candidate, "reference_profile"), `${candidate.model_id} must disclose reference profile provenance`);
        assert(Object.hasOwn(candidate, "aa_slug"), `${candidate.model_id} must disclose AA identity provenance`);
        assert(Object.hasOwn(candidate, "aa_data"), `${candidate.model_id} must disclose available AA data`);
        if (candidate.reference_only) {
          assert(candidate.reference_reasons.length > 0, `${candidate.model_id} reference-only evidence needs a reason`);
          assert(candidate.reference_route_id, `${candidate.model_id} reference-only evidence needs a source route`);
          assert(candidate.aa_slug, `${candidate.model_id} reference-only evidence needs an AA slug`);
          assert(/reference only/i.test(candidate.strengths), `${candidate.model_id} reference-only evidence must be visibly labelled`);
        }
        for (const key of ["intelligence", "coding", "agentic"]) {
          assert(Object.hasOwn(candidate.aa_scores, key), `${candidate.model_id} must disclose AA ${key}`);
        }
        assert(["reported", "unknown"].includes(candidate.quota.status), `${candidate.model_id} must disclose quota state`);
        if (candidate.quota.status === "unknown") assert(candidate.quota.reason, `${candidate.model_id} unknown quota needs a reason`);
        else assert(candidate.quota.windows.every((window) => Number.isFinite(window.remaining_percent)), `${candidate.model_id} reported quota needs remaining percentages`);
        assert(candidate.host.code, `${candidate.model_id} must disclose Codex callability`);
        if (candidate.selectable) callableProviders.add(candidate.provider || "unknown");
      }
    }
  }

  for (const ticket of items) {
    const selection = ticket.selection;
    assert(selection?.confirmed_by === "user", `${ticket.id} must carry user model confirmation`);
    assert(selection.selected_model_id === ticket.model_id, `${ticket.id} approval must match exact selected model`);
    const proposal = byId.get(selection.proposal_id);
    assert(proposal, `${ticket.id} references missing proposal ${selection.proposal_id}`);
    assert(proposal.host_snapshot_id === selection.host_snapshot_id, `${ticket.id} host snapshot must match its proposal`);
    const approval = proposal.approvals.find((item) => item.approval_id === selection.approval_id);
    assert(approval?.selected_model_id === ticket.model_id, `${ticket.id} proposal approval must match the ticket`);
    const unit = proposal.units.find((item) => item.key === (mode === "openspec" ? ticket.openspec?.number : "standalone"));
    const candidate = unit?.candidates.find((item) => item.model_id === ticket.model_id);
    assert(candidate?.selectable && candidate.host.code === "AVAILABLE", `${ticket.id} selected route must have been disclosed as callable`);
    selectedProviders.add(candidate.provider || "unknown");
    assert(Date.parse(ticket.created_at) >= Date.parse(proposal.created_at), `${ticket.id} must not predate model disclosure`);
  }
  assert(items.some((ticket) => ticket.selection?.changed_by_user), "at least one ticket must exercise user route choice/override");
  if (callableProviders.size >= 2) assert(selectedProviders.size >= 2, "select at least two currently callable providers to prove multi-provider dispatch");

  const hostSnapshot = path.join(runtimeRoot, "runs", "host-capabilities.json");
  assert(fs.existsSync(hostSnapshot), "current Codex host capability snapshot must be persisted");
  const host = JSON.parse(fs.readFileSync(hostSnapshot, "utf8"));
  assert(host.advertised_models.length > 0, "host snapshot must contain exact Codex spawn models");
  assert(host.provider_quotas.every((quota) => !Object.hasOwn(quota, "accounts")), "host quota disclosure must not contain provider credentials/accounts");
  assert(!hasSensitiveQuotaKey(host.provider_quotas), "host quota disclosure must not persist CodexBar account/auth fields");
  assert(host.provider_quotas.every((quota) => quota.source == null || typeof quota.source === "string"), "every quota source must be explicit or null");
  assert(host.provider_quotas.filter((quota) => quota.source?.startsWith("codexbar:")).every((quota) => quota.status === "reported" || quota.reason?.startsWith("CODEXBAR_")), "CodexBar fallback must preserve sanitized provenance and failure reason");
  const routeSnapshot = path.join(home, ".baton", "cache", "routes.json");
  if (fs.existsSync(routeSnapshot)) {
    const catalog = JSON.parse(fs.readFileSync(routeSnapshot, "utf8"));
    const catalogOnly = catalog.routes?.some((route) => !route.disabled && !host.advertised_models.includes(route.route_id));
    if (catalogOnly) {
      assert(selections.some((proposal) => proposal.unavailable_by_provider.some((item) => item.code.includes("HOST_ROUTE_UNAVAILABLE"))), "catalog-only routes must be disclosed as HOST_ROUTE_UNAVAILABLE");
    }
  }
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
  const validation = spawnSync("openspec", ["validate", "incident-audit", "--strict", "--no-interactive"], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert(validation.status === 0, validation.stderr || validation.stdout || "OpenSpec strict validation failed");
}

function hasSensitiveQuotaKey(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveQuotaKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    /^(?:accounts?|accountEmail|accountID|loginMethod|cookies?|tokens?|credentials?)$/i.test(key)
    || hasSensitiveQuotaKey(child));
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
