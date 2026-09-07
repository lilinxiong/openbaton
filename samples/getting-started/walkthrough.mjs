#!/usr/bin/env bun
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-native-example-"));
const home = path.join(temporary, "home");
const work = path.join(temporary, "work");
fs.mkdirSync(home);
fs.mkdirSync(work);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  BATON_HOST: "sample-adapter",
  BATON_ADAPTER_PATHS: path.join(root, "samples/manifest-example"),
};

function run(args, json = false) {
  const result = spawnSync("bun", [path.join(root, "bin/baton.ts"), ...args], {
    cwd: work, env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return json ? JSON.parse(result.stdout) : result.stdout;
}

try {
  run(["init", "--cli", "sample-adapter"]);
  run(["config", "--cli", "sample-adapter", "--implementation-model", "sample-model", "--enable"]);
  const catalog = run(["models", "--json"], true);
  assert.deepEqual(catalog.models.map((model) => model.id), ["sample-model"]);
  const matched = run(["match", "--work-mode", "implementation", "--json"], true);
  assert.equal(matched.model_id, "sample-model");
  assert.equal(Object.hasOwn(matched, "reasoning_effort"), false);

  const brief = path.join(work, "brief.json");
  fs.writeFileSync(brief, JSON.stringify({
    goal: "Check the known change",
    decisions: ["Keep existing public names"],
    scope: ["README.md"],
    acceptance: ["Report remaining references"],
    mode: "read-only",
    handoff: {
      existingChanges: "The implementation is already present",
      checks: "Static checks passed",
      unresolvedIssues: "One documentation reference needs review",
    },
  }));
  const prepared = run(["spawn", "--brief", brief, "--work-mode", "implementation", "--json"], true);
  assert.equal(prepared.spawned, false);
  assert.equal(prepared.model_id, "sample-model");
  assert.equal(prepared.fork_context, false);
  assert.equal(Object.hasOwn(prepared, "reasoning_effort"), false);
  assert.match(prepared.prompt, /One documentation reference needs review/);
  assert.deepEqual(fs.readdirSync(work), ["brief.json"]);
  for (const name of ["spawns", "receipts", "workspaces", "state", "cache"]) {
    assert.equal(fs.existsSync(path.join(home, ".baton", name)), false);
  }

  // Simulated host result. This example does not execute a native worker.
  run(["record", "--host", "sample-adapter", "--handle", "simulated-handle",
    "--model", "sample-model", "--status", "completed", "--text", "Simulated host result"]);
  const status = run(["status", "--json"], true);
  assert.equal(status.results.length, 1);
  assert.equal(status.results[0].native_handle, "simulated-handle");
  assert.equal(status.results[0].result, "Simulated host result");
  process.stdout.write("getting-started native-only walkthrough ok (simulated host; no worker executed)\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
