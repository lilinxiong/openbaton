#!/usr/bin/env node

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
  fail("usage: node samples/verify.mjs WORKSPACE standalone|openspec");
}

const workspace = fs.realpathSync(path.resolve(workspaceArg));
const root = git(["rev-parse", "--show-toplevel"]).trim();
if (fs.realpathSync(root) !== workspace) fail("workspace must be its own Git root");

const workspaceId = crypto.createHash("sha256").update(workspace).digest("hex");
const home = process.env.HOME || os.homedir();
const batonWorkspace = path.join(home, ".baton", "workspaces", workspaceId);
const spawnDir = path.join(batonWorkspace, "spawns");
if (!fs.existsSync(spawnDir)) fail(`no Baton runtime found for workspace: ${batonWorkspace}`);

const tickets = fs.readdirSync(spawnDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(spawnDir, name), "utf8")))
  .filter((ticket) => ticket.source === (mode === "openspec" ? "openspec" : "standalone"))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

assert(tickets.length === 5, `expected 5 ${mode} tickets, got ${tickets.length}`);
assert(tickets.every((ticket) => ticket.status === "completed"), "every ticket must be completed");
assert(tickets.every((ticket) => ticket.agent_id), "every ticket must bind a real agent id");
assert(tickets.every((ticket) => ticket.attempt === 1), "every ticket must complete in one attempt");
assert(tickets.every((ticket) => ticket.slot_released_at), "every terminal ticket must release its host slot");
assert(tickets.every((ticket) => ticket.route_id), "every ticket must carry an exact route id");
assert(tickets.every((ticket) => {
  const expected = ticket.reasoning_effort ? `${ticket.route_id}@${ticket.reasoning_effort}` : ticket.route_id;
  return ticket.model_id === expected;
}), "model_id must be the exact route/profile id");

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
