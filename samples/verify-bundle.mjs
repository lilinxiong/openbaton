#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInvokingHost } from "./lib/host.mjs";

const argv = process.argv.slice(2);
const hostFlagIndex = argv.indexOf("--host");
const explicitHost = hostFlagIndex >= 0 ? argv[hostFlagIndex + 1] : null;
if (hostFlagIndex >= 0 && !explicitHost) fail("usage: --host requires codex|grok|cursor");
const positional = hostFlagIndex >= 0
  ? argv.filter((_, index) => index !== hostFlagIndex && index !== hostFlagIndex + 1)
  : argv;
const standaloneArg = positional[0];
const openspecArg = positional[1];
if (!standaloneArg || !openspecArg) {
  fail("usage: bun samples/verify-bundle.mjs [--host codex|grok|cursor] STANDALONE_WORKSPACE OPENSPEC_WORKSPACE");
}

const runs = [
  load(path.resolve(standaloneArg), "standalone"),
  load(path.resolve(openspecArg), "openspec"),
];
const host = resolveInvokingHost({
  explicitHost,
  env: process.env,
  tickets: runs.flatMap(({ tickets }) => tickets),
});

for (const { proposal, tickets, mode } of runs) {
  assert(proposal.status === "approved", `${mode} proposal must be approved`);
  assert(proposal.confirmation?.scope === "proposal", `${mode} automatic approval must be request-scoped`);
  assert(proposal.confirmation?.confirmed_by === "baton-recommendation", `${mode} must not wait for user confirmation`);
  assert(proposal.approvals.length === 5, `${mode} proposal must contain five approvals`);
  assert(proposal.approvals.every((approval) =>
    approval.confirmed_by === "baton-recommendation"
    && approval.changed_by_user === false
    && approval.selected_model_id === approval.recommended_model_id
    && (!approval.host || approval.host === host)
  ), `${mode} approvals must preserve unchanged Baton recommendations`);
  assert(tickets.length === 5, `${mode} must contain five tickets`);
  assert(tickets.every((ticket) =>
    ticket.selection?.confirmed_by === "baton-recommendation"
    && ticket.selection?.changed_by_user === false
    && ticket.selection?.selected_model_id === ticket.model_id
    && (ticket.selection?.service_tier || null) === (ticket.service_tier || null)
    && (ticket.target_host || ticket.selection?.host || host) === host
  ), `${mode} tickets must carry automatic-selection evidence for host ${host}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  host,
  routing: "automatic",
  standalone: runs[0].workspace,
  openspec: runs[1].workspace,
  proposals: runs.map(({ mode, proposal }) => ({
    mode,
    proposal_id: proposal.id,
    confirmed_by: proposal.confirmation.confirmed_by,
    selected_models: proposal.approvals.map((approval) => approval.selected_model_id),
  })),
}, null, 2)}\n`);

function load(workspaceArg, mode) {
  const workspace = fs.realpathSync(workspaceArg);
  const workspaceId = crypto.createHash("sha256").update(workspace).digest("hex");
  const runtime = path.join(process.env.HOME || os.homedir(), ".baton", "workspaces", workspaceId, "v2");
  const proposals = readJsonDirectory(path.join(runtime, "selections")).filter((proposal) => proposal.source === mode);
  const tickets = readJsonDirectory(path.join(runtime, "spawns")).filter((ticket) => ticket.source === mode);
  assert(proposals.length === 1, `${mode} must have exactly one request-level proposal, got ${proposals.length}`);
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
