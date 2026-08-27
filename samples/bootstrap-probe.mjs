#!/usr/bin/env bun

/**
 * Build a disposable, deterministic workspace for a two-part Baton probe.
 *
 * The generated prompt document deliberately contains two prompts for one
 * session.  The first exercises independent standalone write units; the
 * second exercises the OpenSpec apply path after the first prompt completes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const samplesDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(samplesDir);
const templateDir = path.join(samplesDir, "probe-e2e");
const change = "probe-e2e";

const options = parseArgs(process.argv.slice(2));
const host = requiredOption(options, "host");
const model = requiredOption(options, "model");
assertToken(host, "host");
assertToken(model, "model");
if (model.lastIndexOf("@") > 0) fail("model must be the picker-visible route id without an @effort suffix");
assertRepository();
requireCommand("openspec", ["--version"], "Install OpenSpec before running the probe.");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "baton-probe-e2e-"));
copyContents(templateDir, workspace);
git(workspace, "init", "-q");
git(workspace, "config", "user.email", "baton-probe@example.invalid");
git(workspace, "config", "user.name", "Baton Probe");
git(workspace, "add", ".");
git(workspace, "commit", "-q", "-m", "baseline: probe-e2e");

const validation = spawnSync("openspec", ["validate", change, "--strict", "--no-interactive"], {
  cwd: workspace,
  encoding: "utf8",
});
if (validation.status !== 0) {
  fail(validation.stderr || validation.stdout || "OpenSpec strict validation failed");
}

const absoluteWorkspace = fs.realpathSync(workspace);
const sessionId = process.env.BATON_SESSION_ID?.trim() || crypto.randomUUID();
const prompts = renderPrompts({ absoluteWorkspace, host, model, sessionId });
const document = [
  "# Baton probe-e2e prompts",
  "",
  `workspace: ${absoluteWorkspace}`,
  `host: ${host}`,
  `model: ${model}`,
  `session_id: ${sessionId}`,
  "",
  "Run Prompt 1, wait for it to finish, then run Prompt 2 in the same session and workspace.",
  "",
  "## Prompt 1 — standalone Baton writes",
  "",
  prompts.standalone,
  "",
  "## Prompt 2 — OpenSpec apply",
  "",
  prompts.openspec,
  "",
  "## Workspace",
  "",
  `Disposable workspace: ${absoluteWorkspace}`,
  "The workspace is intentionally temporary. Remove it after both verifiers pass.",
  "",
].join("\n");

if (options.output) {
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, document, "utf8");
  process.stdout.write(`prompt_output: ${output}\n`);
}
process.stdout.write(document);

function renderPrompts({ absoluteWorkspace, host: targetHost, model: selectedModel, sessionId: sameSession }) {
  const variables = {
    ABSOLUTE_WORKSPACE: absoluteWorkspace,
    HOST: targetHost,
    MODEL: selectedModel,
    SESSION_ID: sameSession,
  };
  return {
    standalone: renderRequest("STANDALONE_REQUEST.txt", variables),
    openspec: renderRequest("OPENSPEC_REQUEST.txt", variables),
  };
}

function renderRequest(name, variables) {
  let request = fs.readFileSync(path.join(templateDir, name), "utf8");
  for (const [key, value] of Object.entries(variables)) {
    request = request.replaceAll(`{{${key}}}`, value);
  }
  return request.trimEnd();
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--") || !["--host", "--model", "--output"].includes(arg)) {
      fail(`usage: bun samples/bootstrap-probe.mjs --host TARGET --model MODEL [--output PATH]`);
    }
    const key = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
    if (result[key] !== undefined) fail(`duplicate option: ${arg}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function requiredOption(optionsObject, key) {
  const value = optionsObject[key];
  if (!value) fail(`usage: bun samples/bootstrap-probe.mjs --host TARGET --model MODEL [--output PATH]`);
  return value;
}

function assertToken(value, label) {
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) fail(`${label} must be a single non-whitespace token`);
}

function assertRepository() {
  const packagePath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packagePath) || JSON.parse(fs.readFileSync(packagePath, "utf8")).name !== "@zhouliuya/openbaton") {
    fail("bootstrap-probe.mjs must run from the OpenBaton repository");
  }
  if (!fs.existsSync(templateDir)) fail(`missing template: ${templateDir}`);
}

function copyContents(source, destination) {
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true });
  }
}

function git(cwd, ...args) {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  } catch (error) {
    fail(`git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireCommand(command, args, hint) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`${command} is unavailable. ${hint}`);
}

function fail(message) {
  process.stderr.write(`${String(message).trim()}\n`);
  process.exit(1);
}
