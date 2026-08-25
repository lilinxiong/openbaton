#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const samplesDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(samplesDir, "..");
const templateDir = path.join(samplesDir, "probe-e2e");
const CHANGE = "probe-e2e";

const argv = process.argv.slice(2);
const hostFlagIndex = argv.indexOf("--host");
const host = hostFlagIndex >= 0 ? argv[hostFlagIndex + 1] : null;
if (hostFlagIndex >= 0 && !host) fail("usage: --host requires codex|grok|cursor|claude");

const worktreeFlagIndex = argv.indexOf("--worktree");
const outputFlagIndex = argv.indexOf("--output");
const requestedPath = worktreeFlagIndex >= 0
  ? argv[worktreeFlagIndex + 1]
  : outputFlagIndex >= 0
    ? argv[outputFlagIndex + 1]
    : null;
if ((worktreeFlagIndex >= 0 || outputFlagIndex >= 0) && !requestedPath) {
  fail("--worktree/--output requires a path");
}

requireCommand("baton", ["version"], "Run `bun run build && bun link` from the OpenBaton checkout first.");
requireCommand("openspec", ["--version"], "Install OpenSpec before running the probe E2E bootstrap.");
assertRepo();

const useWorktree = worktreeFlagIndex >= 0;
const workspace = requestedPath
  ? path.resolve(requestedPath)
  : useWorktree
    ? path.resolve(repoRoot, "..", `openbaton-probe-${host || "e2e"}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), "openbaton-probe-e2e-"));

if (fs.existsSync(workspace) && fs.readdirSync(workspace).length > 0) {
  fail(`workspace is not empty: ${workspace}`);
}

if (useWorktree) {
  const branch = `probe/${(host || "e2e").replace(/[^a-z0-9-]+/gi, "-")}-e2e`;
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  git(repoRoot, "worktree", "add", "-b", branch, workspace);
} else {
  fs.mkdirSync(workspace, { recursive: true });
  git(workspace, "init", "-q");
}

copyContents(templateDir, workspace);
git(workspace, "config", "user.email", "baton-probe@example.invalid");
git(workspace, "config", "user.name", "Baton Probe");
git(workspace, "add", ".");
git(workspace, "commit", "-q", "-m", `baseline: ${CHANGE} probe`);

const validation = spawnSync("openspec", ["validate", CHANGE, "--strict", "--no-interactive"], {
  cwd: workspace,
  encoding: "utf8",
});
if (validation.status !== 0) fail(validation.stderr || validation.stdout || "OpenSpec validation failed");

const request = fs.readFileSync(path.join(workspace, "REQUEST.txt"), "utf8").trim();
const verifyCommand = [
  "bun",
  JSON.stringify(path.join(samplesDir, "verify-probe.mjs")),
  ...(host ? ["--host", host] : []),
  JSON.stringify(workspace),
].join(" ");

process.stdout.write([
  `change: ${CHANGE}`,
  `workspace: ${workspace}`,
  host ? `host: ${host}` : "",
  "",
  "Open a fresh chat with this workspace as the working directory.",
  "Run:",
  `/openspec-apply-change ${CHANGE}`,
  "",
  "Feed this business request unchanged when applying:",
  "---",
  request,
  "---",
  "",
  "After apply completes, run:",
  verifyCommand,
  "",
  useWorktree ? "Cleanup after PASS:" : "",
  useWorktree ? `  git -C ${JSON.stringify(repoRoot)} worktree remove ${JSON.stringify(workspace)}` : "",
  useWorktree ? `  git -C ${JSON.stringify(repoRoot)} branch -D probe/${(host || "e2e").replace(/[^a-z0-9-]+/gi, "-")}-e2e` : "",
  "",
].filter(Boolean).join("\n"));

function assertRepo() {
  const pkg = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkg)) fail("bootstrap-probe.mjs must run from the OpenBaton repository");
  const meta = JSON.parse(fs.readFileSync(pkg, "utf8"));
  if (meta.name !== "@zhouliuya/openbaton") fail("bootstrap-probe.mjs must run from the OpenBaton repository");
  if (!fs.existsSync(templateDir)) fail(`missing template: ${templateDir}`);
}

function copyContents(source, destination) {
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true });
  }
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function requireCommand(command, args, hint) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`${command} is unavailable. ${hint}`);
}

function fail(message) {
  process.stderr.write(`${String(message).trim()}\n`);
  process.exit(1);
}
