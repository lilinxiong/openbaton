#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const standaloneArg = process.argv[2];
const openspecArg = process.argv[3];
if (!standaloneArg || !openspecArg) {
  fail("usage: bun samples/verify-bundle.mjs STANDALONE_WORKSPACE OPENSPEC_WORKSPACE");
}

const standalone = load(path.resolve(standaloneArg), "standalone");
const openspec = load(path.resolve(openspecArg), "openspec");
const proposals = [standalone.proposal, openspec.proposal];
const confirmationIds = [...new Set(proposals.map((proposal) => proposal.confirmation?.confirmation_id).filter(Boolean))];

assert(confirmationIds.length === 1, "standalone and OpenSpec must share one bundle confirmation_id from one Submit");
assert(proposals.every((proposal) => proposal.confirmation?.scope === "bundle"), "both proposals must record confirmation scope=bundle");
assert(proposals.every((proposal) => proposal.confirmation?.global_provider_ids?.length > 0), "bundle must record one global provider choice");

const providerSignatures = proposals.map((proposal) => [...proposal.confirmation.global_provider_ids].sort().join("\u0000"));
assert(new Set(providerSignatures).size === 1, "both proposals must persist the same global provider choice");
const globalProviders = new Set(proposals[0].confirmation.global_provider_ids);
const callableProviders = new Set(proposals.flatMap((proposal) => proposal.units)
  .flatMap((unit) => unit.candidates || [])
  .filter((candidate) => candidate.selectable)
  .map((candidate) => candidate.provider || "unknown"));
const selectedProviders = new Set();
for (const { proposal, tickets, mode } of [standalone, openspec]) {
  assert(proposal.approvals.length === 5, `${mode} proposal must contain five approvals`);
  assert(proposal.approvals.every((approval) => approval.confirmation_id === confirmationIds[0]), `${mode} approvals must share the bundle confirmation_id`);
  assert(tickets.length === 5, `${mode} must contain five tickets`);
  assert(tickets.every((ticket) => ticket.selection?.confirmation_id === confirmationIds[0]), `${mode} tickets must carry the bundle confirmation_id`);
  assert(tickets.every((ticket) => ticket.selection?.confirmation_scope === "bundle"), `${mode} tickets must carry confirmation_scope=bundle`);
  for (const ticket of tickets) {
    const unit = proposal.units.find((item) => item.key === ticket.selection?.unit_key);
    const candidate = unit?.candidates.find((item) => item.model_id === ticket.model_id);
    assert(candidate?.selectable && candidate.host?.code === "AVAILABLE", `${mode}/${ticket.id} selected route must have been disclosed as callable`);
    selectedProviders.add(candidate.provider || "unknown");
  }
}
assert([...selectedProviders].every((provider) => globalProviders.has(provider)), "every dispatched provider must belong to the bundle-level global Provider choice");
assert([...globalProviders].every((provider) => selectedProviders.has(provider)), "every globally selected Provider must be exercised by at least one bundled ticket");
if (callableProviders.size >= 2) assert(selectedProviders.size >= 2, "select at least two currently callable providers across the bundle to prove multi-provider dispatch");

process.stdout.write(`${JSON.stringify({
  ok: true,
  confirmation_id: confirmationIds[0],
  global_provider_ids: proposals[0].confirmation.global_provider_ids,
  selected_provider_ids: [...selectedProviders].sort(),
  standalone: standalone.workspace,
  openspec: openspec.workspace,
}, null, 2)}\n`);

function load(workspaceArg, mode) {
  const workspace = fs.realpathSync(workspaceArg);
  const workspaceId = crypto.createHash("sha256").update(workspace).digest("hex");
  const runtime = path.join(process.env.HOME || os.homedir(), ".baton", "workspaces", workspaceId);
  const proposals = readJsonDirectory(path.join(runtime, "selections"))
    .filter((proposal) => proposal.source === mode);
  const tickets = readJsonDirectory(path.join(runtime, "spawns"))
    .filter((ticket) => ticket.source === mode);
  assert(proposals.length === 1, `${mode} must have exactly one request-level proposal, got ${proposals.length}`);
  assert(proposals[0].status === "approved", `${mode} proposal must be approved`);
  return { workspace, mode, proposal: proposals[0], tickets };
}

function readJsonDirectory(directory) {
  if (!fs.existsSync(directory)) fail(`missing Baton runtime directory: ${directory}`);
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`FAIL: ${String(message).trim()}\n`);
  process.exit(1);
}
