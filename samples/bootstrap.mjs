#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const samplesDir = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
if (!new Set(["standalone", "openspec"]).has(mode)) {
  fail("usage: bun samples/bootstrap.mjs standalone|openspec [--output PATH]");
}

const outputIndex = process.argv.indexOf("--output");
const requestedOutput = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (outputIndex >= 0 && !requestedOutput) fail("--output requires a path");

requireCommand("baton", ["version"], "Run `bun run build && bun link` from the OpenBaton checkout first.");
if (mode === "openspec") requireCommand("openspec", ["--version"], "Install OpenSpec before running the OpenSpec sample.");

const workspace = requestedOutput
  ? path.resolve(requestedOutput)
  : fs.mkdtempSync(path.join(os.tmpdir(), `openbaton-${mode}-`));
if (requestedOutput && fs.existsSync(workspace) && fs.readdirSync(workspace).length > 0) {
  fail(`output directory is not empty: ${workspace}`);
}
fs.mkdirSync(workspace, { recursive: true });
copyContents(path.join(samplesDir, mode), workspace);

git(workspace, "init", "-q");
git(workspace, "config", "user.email", "baton-sample@example.invalid");
git(workspace, "config", "user.name", "Baton Sample");
git(workspace, "add", ".");
git(workspace, "commit", "-q", "-m", `baseline: ${mode} incident audit`);

if (mode === "openspec") {
  const validation = spawnSync("openspec", ["validate", "incident-audit", "--strict", "--no-interactive"], {
    cwd: workspace,
    encoding: "utf8",
  });
  if (validation.status !== 0) fail(validation.stderr || validation.stdout || "OpenSpec validation failed");
}

const request = fs.readFileSync(path.join(samplesDir, mode, "REQUEST.txt"), "utf8").trim();
const verifyCommand = `bun ${JSON.stringify(path.join(samplesDir, "verify.mjs"))} ${JSON.stringify(workspace)} ${mode}`;

process.stdout.write([
  `mode: ${mode}`,
  `workspace: ${workspace}`,
  "",
  "Use this workspace from the CURRENT Codex task and feed this request to the trigger unchanged:",
  "---",
  request,
  "---",
  "",
  "Expected interaction: this request creates one request-level proposal containing all five units, with no ticket yet.",
  "Codex must use comparison tables to disclose preferred/candidate exact routes, strengths, task + AA scores,",
  "remaining quota/unknown reason, and current callability before any ticket exists.",
  "The proposal must auditably exclude every gpt-5.5, gpt-5.6-sol, and gpt-5.6-terra route/profile from subagent candidates.",
  "Review that disclosure, change or manually select at least one callable exact route,",
  "and use at least two providers when at least two are callable. When standalone and OpenSpec are tested together,",
  "Codex must combine both proposals under one global Provider choice and one Submit in this same task.",
  "",
  "After the task finishes, run:",
  verifyCommand,
  "",
].join("\n"));

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
