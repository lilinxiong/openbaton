import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { getCliAdapter } from "../src/adapters/registry.js";
import { discoverAdapterManifests } from "../src/adapters/sdk.js";
import { runHost } from "../src/commands/host.js";
import { detectInvokingHosts } from "../src/lib/hosts.js";
import {
  adapterInstallDir,
  installBundledAdaptersAndRecord,
} from "../src/lib/adapter-install.js";
import {
  buildInstallManifest,
  installManifestPath,
  readInstallManifest,
  writeInstallManifest,
} from "../src/lib/install-manifest.js";
import { buildUninstallPlan } from "../src/lib/uninstall.js";

const repoRoot = process.cwd();
const packageSource = path.join(repoRoot, "adapters", "codex");

function isolatedEnv(): { home: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-codex-package-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-codex-package-cwd-"));
  const env = { ...process.env, HOME: home };
  delete env.BATON_ADAPTER_PATHS;
  return { home, cwd, env };
}

function fakeCodexExecutable(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baton-codex-protocol-"));
  const executable = path.join(directory, "codex");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
let page = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: 0, result: { userAgent: "fake-codex/1" } }) + "\\n");
  if (message.method === "model/list") {
    page += 1;
    const data = page === 1
      ? [{ id: "gpt-visible", model: "gpt-visible", displayName: "Visible", description: "Exact", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }], defaultReasoningEffort: "high", inputModalities: ["text", "image"], serviceTiers: [{ id: "priority", name: "Fast", description: "Quick" }], defaultServiceTier: "priority", isDefault: true, experimentalFlag: "keep-me" }, { id: "hidden", hidden: true }]
      : [{ id: "gpt-second", displayName: "Second", hidden: false }];
    process.stdout.write(JSON.stringify({ id: message.id, result: { data, nextCursor: page === 1 ? "next" : null } }) + "\\n");
  }
});
`, "utf8");
  fs.chmodSync(executable, 0o755);
  return executable;
}

describe("external Codex adapter package", () => {
  it("discovers from the installed home without BATON_ADAPTER_PATHS", () => {
    const { env } = isolatedEnv();
    fs.mkdirSync(path.join(env.HOME!, ".baton", "adapters", "codex"), { recursive: true });
    fs.cpSync(packageSource, path.join(env.HOME!, ".baton", "adapters", "codex"), { recursive: true });
    const manifests = discoverAdapterManifests(env);
    assert.deepEqual(manifests.map((manifest) => manifest.adapter.id), ["codex"]);
    assert.equal(manifests[0].catalog.command, "catalog.mjs");
    assert.equal(manifests[0].native.execution_handle_kind, "task_name");
  });

  it("detects Codex from CODEX_THREAD_ID without sandbox or adapter-path signals", () => {
    const { cwd, env } = isolatedEnv();
    const destination = path.join(env.HOME!, ".baton", "adapters", "codex");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(packageSource, destination, { recursive: true });
    delete env.BATON_ADAPTER_PATHS;
    delete env.CODEX_SANDBOX;
    env.CODEX_THREAD_ID = "codex-thread-test";
    assert.deepEqual(detectInvokingHosts(env), ["codex"]);
    const output: string[] = [];
    assert.equal(runHost(["detect", "--json"], { cwd, env, stdout: { write: (chunk) => output.push(chunk) } }), 0);
    const payload = JSON.parse(output.join(""));
    assert.equal(payload.invoking, "codex");
    assert.deepEqual(payload.matches, ["codex"]);
    assert.equal(payload.resolved, "codex");
    assert.equal(payload.source, "runtime_signal");
  });

  it("runs app-server model/list pagination and preserves picker metadata", async () => {
    const { env } = isolatedEnv();
    fs.mkdirSync(path.join(env.HOME!, ".baton", "adapters", "codex"), { recursive: true });
    fs.cpSync(packageSource, path.join(env.HOME!, ".baton", "adapters", "codex"), { recursive: true });
    env.BATON_CODEX_PATH = fakeCodexExecutable();
    const catalog = await getCliAdapter("codex", env).discoverModels({ cwd: repoRoot, env });
    assert.equal(catalog.adapter_id, "codex");
    assert.equal(catalog.version, "fake-codex/1");
    assert.deepEqual(catalog.models.map((model) => model.id), ["gpt-visible", "gpt-second"]);
    assert.equal(catalog.models[0].default_reasoning_effort, "high");
    assert.deepEqual(catalog.models[0].reasoning_efforts, [{ id: "high", description: "Deep" }]);
    assert.deepEqual(catalog.models[0].service_tiers, [{ id: "priority", name: "Fast", description: "Quick" }]);
    assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
    assert.equal(catalog.models[0].experimentalFlag, "keep-me");
    assert.equal(catalog.models.some((model) => model.id === "hidden"), false);
  });

  it("records adapter ownership and preserves a modified package on update", () => {
    const { home, cwd, env } = isolatedEnv();
    const first = installBundledAdaptersAndRecord(cwd, ["codex"], env);
    assert.equal(first.installed.length, 1);
    const destination = adapterInstallDir("codex", env);
    const before = readInstallManifest(env);
    assert.ok(before?.files.some((entry) => entry.kind === "adapter-package" && entry.path === path.resolve(destination)));
    const catalogFile = path.join(destination, "catalog.mjs");
    fs.appendFileSync(catalogFile, "\n// user change\n");
    const original = fs.readFileSync(catalogFile, "utf8");
    const second = installBundledAdaptersAndRecord(cwd, ["codex"], env);
    assert.equal(second.conflicts.length, 1);
    assert.equal(fs.readFileSync(catalogFile, "utf8"), original);
    assert.equal(readInstallManifest(env)?.files.find((entry) => entry.kind === "adapter-package")?.fingerprint,
      before?.files.find((entry) => entry.kind === "adapter-package")?.fingerprint);
    assert.equal(fs.existsSync(installManifestPath(env)), true);
    assert.ok(home);
  });

  it("keeps a no-op update byte-stable for package ownership", () => {
    const { cwd, env } = isolatedEnv();
    installBundledAdaptersAndRecord(cwd, ["codex"], env);
    const manifestFile = installManifestPath(env);
    const before = fs.readFileSync(manifestFile);
    const result = installBundledAdaptersAndRecord(cwd, ["codex"], env);
    assert.equal(result.updated.length, 0);
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(fs.readFileSync(manifestFile), before);
  });

  it("plans safe host and clean removal of an owned adapter package", () => {
    const { cwd, env } = isolatedEnv();
    installBundledAdaptersAndRecord(cwd, ["codex"], env);
    const destination = adapterInstallDir("codex", env);
    const surgical = buildUninstallPlan({ cwd, env, hosts: ["codex"] });
    const target = surgical.targets.find((item) => item.path.endsWith("/.baton/adapters/codex"));
    assert.equal(target?.action, "remove");
    const clean = buildUninstallPlan({ cwd, env, clean: true, dry_run: true });
    assert.ok(clean.targets.some((item) => item.path === target?.path && item.action === "remove"));
    fs.appendFileSync(path.join(destination, "catalog.mjs"), "\n// modified\n");
    const conflict = buildUninstallPlan({ cwd, env, hosts: ["codex"] });
    assert.equal(conflict.targets.find((item) => item.path === target?.path)?.action, "conflict");
  });
});
