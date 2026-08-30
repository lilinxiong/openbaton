import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { getCliAdapter } from "../src/adapters/registry.js";
import { discoverAdapterManifests } from "../src/adapters/sdk.js";
import { initProject } from "../src/commands/init.js";
import { runConfig } from "../src/commands/config.js";
import { runHost } from "../src/commands/host.js";
import { detectInvokingHosts, hostSkillDest } from "../src/lib/hosts.js";
import { resolveAgentTreeCapacity } from "../src/lib/agent-tree-capacity.js";
import { dispatchSnapshot, reserveNext } from "../src/lib/dispatch.js";
import { loadConfig } from "../src/lib/config.js";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { buildSpawnTicket, nextSpawnId, writeSpawn } from "../src/lib/spawn.js";
import {
  adapterInstallDir,
  installBundledAdaptersAndRecord,
} from "../src/lib/adapter-install.js";
import {
  installManifestPath,
  readInstallManifest,
  directoryFingerprint,
} from "../src/lib/install-manifest.js";
import { buildUninstallPlan } from "../src/lib/uninstall.js";
import { configPath, skillPath } from "../src/lib/paths.js";
import { parseToml } from "../src/lib/toml.js";
import { concurrentSubagentsFromInitialize, discoverGrokCatalog, normalizeGrokModels, resolveGrokCommand } from "../adapters/grok/catalog.mjs";

const repoRoot = process.cwd();
const packageSource = path.join(repoRoot, "adapters", "grok");

function isolatedEnv(): { home: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-package-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-package-cwd-"));
  const env = { ...process.env, HOME: home };
  delete env.BATON_ADAPTER_PATHS;
  delete env.GROK_SESSION_ID;
  delete env.GROK_AGENT;
  delete env.BATON_HOST;
  delete env.BATON_GROK_PATH;
  return { home, cwd, env };
}

function installPackage(env: NodeJS.ProcessEnv): string {
  const destination = path.join(env.HOME!, ".baton", "adapters", "grok");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(packageSource, destination, { recursive: true });
  fs.chmodSync(path.join(destination, "catalog.mjs"), 0o755);
  return destination;
}

function fakeGrokExecutable(script: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-protocol-"));
  const executable = path.join(directory, "grok");
  fs.writeFileSync(executable, script, "utf8");
  fs.chmodSync(executable, 0o755);
  return executable;
}

function acpInitializeFake(payload: string): string {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${payload} }) + "\\n");
  }
});
`;
}

describe("external Grok adapter package", () => {
  it("discovers from the installed home without BATON_ADAPTER_PATHS", () => {
    const { env } = isolatedEnv();
    installPackage(env);
    const manifests = discoverAdapterManifests(env);
    assert.deepEqual(manifests.map((manifest) => manifest.adapter.id), ["grok"]);
    assert.equal(manifests[0].catalog.command, "catalog.mjs");
    assert.equal(manifests[0].native.execution_handle_kind, "subagent_id");
    assert.equal(manifests[0].invocation.signal, "GROK_SESSION_ID");
    assert.equal(manifests[0].quota.max_concurrent_subagents, 16);
    assert.equal(manifests[0].quota.max_depth, 1);
    assert.equal(getCliAdapter("grok", env).host.defaultMaxConcurrent, 16);
    assert.equal(getCliAdapter("grok", env).host.executionHandleKind, "subagent_id");
    assert.equal(resolveAgentTreeCapacity({ host: getCliAdapter("grok", env).host }).capacity, 16);
  });

  it("detects Grok from GROK_SESSION_ID without adapter-path signals", () => {
    const { cwd, env } = isolatedEnv();
    installPackage(env);
    delete env.BATON_ADAPTER_PATHS;
    env.GROK_SESSION_ID = "grok-session-test";
    assert.deepEqual(detectInvokingHosts(env), ["grok"]);
    const output: string[] = [];
    assert.equal(runHost(["detect", "--json"], { cwd, env, stdout: { write: (chunk) => output.push(chunk) } }), 0);
    const payload = JSON.parse(output.join(""));
    assert.equal(payload.invoking, "grok");
    assert.deepEqual(payload.matches, ["grok"]);
    assert.equal(payload.resolved, "grok");
    assert.equal(payload.source, "runtime_signal");
  });

  it("runs ACP initialize and preserves picker metadata", async () => {
    const { env } = isolatedEnv();
    installPackage(env);
    env.BATON_GROK_PATH = fakeGrokExecutable(acpInitializeFake(`{
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: {
        agentVersion: "fake-grok/1",
        modelState: {
          currentModelId: "grok-visible",
          availableModels: [
            {
              modelId: "grok-visible",
              name: "Visible",
              description: "Exact",
              _meta: {
                reasoningEffort: "high",
                reasoningEfforts: [{ id: "high", value: "high", description: "Deep", default: true }],
                experimentalFlag: "keep-me"
              }
            },
            { modelId: "hidden", name: "Hidden", hidden: true },
            { modelId: "grok-second", name: "Second" }
          ]
        }
      }
    }`));
    const catalog = await getCliAdapter("grok", env).discoverModels({ cwd: repoRoot, env });
    assert.equal(catalog.adapter_id, "grok");
    assert.equal(catalog.version, "fake-grok/1");
    assert.deepEqual(catalog.models.map((model) => model.id), ["grok-visible", "grok-second"]);
    assert.equal(catalog.models[0].default_reasoning_effort, "high");
    assert.deepEqual(catalog.models[0].reasoning_efforts, [{ id: "high", description: "Deep" }]);
    assert.equal(catalog.models[0].is_default, true);
    assert.equal(catalog.models[0].experimentalFlag, undefined);
    assert.equal((catalog.models[0] as { _meta?: { experimentalFlag?: string } })._meta?.experimentalFlag, "keep-me");
    assert.equal(catalog.models.some((model) => model.id === "hidden"), false);
  });

  it("rejects an invalid BATON_GROK_PATH instead of falling through", async () => {
    const { env } = isolatedEnv();
    env.BATON_GROK_PATH = path.join(env.HOME!, "missing-grok");
    assert.equal(resolveGrokCommand(env), null);
    await assert.rejects(
      () => discoverGrokCatalog({ cwd: repoRoot, env }),
      /GROK_CLI_NOT_AVAILABLE/,
    );
  });

  it("classifies empty, malformed, timeout, and prose catalog failures", async () => {
    const { env } = isolatedEnv();
    installPackage(env);

    env.BATON_GROK_PATH = fakeGrokExecutable(acpInitializeFake(`{
      protocolVersion: 1,
      _meta: { agentVersion: "empty", modelState: { availableModels: [] } }
    }`));
    await assert.rejects(
      () => getCliAdapter("grok", env).discoverModels({ cwd: repoRoot, env }),
      /GROK_CATALOG_INVALID: initialize returned no picker-visible models/,
    );

    env.BATON_GROK_PATH = fakeGrokExecutable(acpInitializeFake(`{
      protocolVersion: 1,
      _meta: { agentVersion: "bad", modelState: { availableModels: "nope" } }
    }`));
    await assert.rejects(
      () => getCliAdapter("grok", env).discoverModels({ cwd: repoRoot, env }),
      /GROK_CATALOG_INVALID/,
    );

    env.BATON_GROK_PATH = fakeGrokExecutable(`#!/usr/bin/env node
const readline = require("node:readline");
readline.createInterface({ input: process.stdin });
`);
    await assert.rejects(
      () => discoverGrokCatalog({ cwd: repoRoot, env, timeoutMs: 200 }),
      /GROK_CATALOG_TIMEOUT/,
    );

    env.BATON_GROK_PATH = fakeGrokExecutable(`#!/usr/bin/env node
process.stdout.write("Please log in to grok.com\\n");
process.exit(0);
`);
    await assert.rejects(
      () => getCliAdapter("grok", env).discoverModels({ cwd: repoRoot, env }),
      /GROK_CATALOG_FAILED|ADAPTER_CATALOG/,
    );
  });

  it("normalizes duplicates to last-wins and skips hidden rows without inventing aliases", () => {
    const models = normalizeGrokModels({
      currentModelId: "grok-keep",
      availableModels: [
        { modelId: "grok-keep", name: "First" },
        { modelId: "grok-keep", name: "Second", description: "Later" },
        { modelId: "hidden", hidden: true, name: "Nope" },
        { modelId: "  ", name: "blank" },
      ],
    }, "grok-keep");
    assert.deepEqual(models.map((model) => ({ id: model.id, display_name: model.display_name, is_default: model.is_default })), [
      { id: "grok-keep", display_name: "Second", is_default: true },
    ]);
    assert.equal(models[0].description, "Later");
  });

  it("records adapter ownership and preserves a modified package on update", () => {
    const { home, cwd, env } = isolatedEnv();
    const first = installBundledAdaptersAndRecord(cwd, ["grok"], env);
    assert.ok(first.installed.some((line) => line.includes("grok")));
    const destination = adapterInstallDir("grok", env);
    const before = readInstallManifest(env);
    assert.ok(before?.files.some((entry) => entry.kind === "adapter-package" && entry.path === path.resolve(destination)));
    const catalogFile = path.join(destination, "catalog.mjs");
    fs.appendFileSync(catalogFile, "\n// user change\n");
    const original = fs.readFileSync(catalogFile, "utf8");
    const second = installBundledAdaptersAndRecord(cwd, ["grok"], env);
    assert.ok(second.conflicts.some((line) => line.includes("grok")));
    assert.equal(fs.readFileSync(catalogFile, "utf8"), original);
    assert.equal(readInstallManifest(env)?.files.find((entry) => entry.path === path.resolve(destination))?.fingerprint,
      before?.files.find((entry) => entry.path === path.resolve(destination))?.fingerprint);
    assert.equal(fs.existsSync(installManifestPath(env)), true);
    assert.ok(home);
  });

  it("keeps a no-op update byte-stable for package ownership", () => {
    const { cwd, env } = isolatedEnv();
    installBundledAdaptersAndRecord(cwd, ["grok"], env);
    const manifestFile = installManifestPath(env);
    const before = fs.readFileSync(manifestFile);
    const result = installBundledAdaptersAndRecord(cwd, ["grok"], env);
    assert.equal(result.updated.length, 0);
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(fs.readFileSync(manifestFile), before);
  });

  it("keeps bundled and isolated installed adapter/runtime artifacts synchronized", async () => {
    const { cwd, env } = isolatedEnv();
    await initProject(cwd, { env });

    const installedPackage = adapterInstallDir("grok", env);
    assert.equal(directoryFingerprint(installedPackage), directoryFingerprint(packageSource));

    const sourceManifest = path.join(packageSource, "adapter.json");
    const installedManifest = path.join(installedPackage, "adapter.json");
    const sourceRuntimeSkill = path.join(packageSource, "runtime", "SKILL.md");
    const installedRuntimeSkill = path.join(installedPackage, "runtime", "SKILL.md");
    const installedHostSkill = hostSkillDest("grok", { cwd, env });
    const installedSharedSkill = skillPath(cwd, { env });
    const installedConfig = configPath(cwd, { env });
    assert.deepEqual(fs.readFileSync(installedManifest), fs.readFileSync(sourceManifest));
    assert.deepEqual(fs.readFileSync(installedRuntimeSkill), fs.readFileSync(sourceRuntimeSkill));
    assert.deepEqual(fs.readFileSync(installedHostSkill), fs.readFileSync(sourceRuntimeSkill));
    assert.deepEqual(fs.readFileSync(installedSharedSkill), fs.readFileSync(path.join(repoRoot, "SKILL.md")));
    assert.deepEqual(
      parseToml(fs.readFileSync(installedConfig, "utf8")),
      parseToml(fs.readFileSync(path.join(repoRoot, "templates", "config.toml"), "utf8")),
    );
    const sourceManifestText = fs.readFileSync(sourceManifest, "utf8");
    const sourceRuntimeText = fs.readFileSync(sourceRuntimeSkill, "utf8");
    assert.match(sourceManifestText, /"max_concurrent_subagents": 16/);
    assert.match(sourceManifestText, /max_depth/);
    assert.doesNotMatch(sourceManifestText, /"max_concurrent"\s*:/);
    assert.match(sourceRuntimeText, /measured concurrent subagent ceiling is 16/);
    assert.doesNotMatch(sourceRuntimeText, /host\/workspace-global/);
    assert.match(sourceRuntimeText, /spawn_subagent/);
    assert.match(sourceRuntimeText, /subagent_id=/);
  });

  it("plans safe host and clean removal of an owned adapter package", () => {
    const { cwd, env } = isolatedEnv();
    installBundledAdaptersAndRecord(cwd, ["grok"], env);
    const destination = adapterInstallDir("grok", env);
    const surgical = buildUninstallPlan({ cwd, env, hosts: ["grok"] });
    const target = surgical.targets.find((item) => item.path.endsWith("/.baton/adapters/grok"));
    assert.equal(target?.action, "remove");
    const clean = buildUninstallPlan({ cwd, env, clean: true, dry_run: true });
    assert.ok(clean.targets.some((item) => item.path === target?.path && item.action === "remove"));
    fs.appendFileSync(path.join(destination, "catalog.mjs"), "\n// modified\n");
    const conflict = buildUninstallPlan({ cwd, env, hosts: ["grok"] });
    assert.equal(conflict.targets.find((item) => item.path === target?.path)?.action, "conflict");
  });

  it("omits catalog capabilities when Grok does not report a concurrent limit", async () => {
    const { env } = isolatedEnv();
    installPackage(env);
    env.BATON_GROK_PATH = fakeGrokExecutable(acpInitializeFake(`{
      protocolVersion: 1,
      _meta: { agentVersion: "fake-grok/1", modelState: { currentModelId: "grok-visible", availableModels: [{ modelId: "grok-visible", name: "Visible" }] } }
    }`));
    const catalog = await getCliAdapter("grok", env).discoverModels({ cwd: repoRoot, env });
    assert.equal(catalog.capabilities, undefined);
    assert.equal(concurrentSubagentsFromInitialize({
      _meta: { modelState: { availableModels: [{ modelId: "grok-visible" }] } },
    }), undefined);
  });

  it("persists the adapter-measured Grok limit when the catalog omits it", async () => {
    const { cwd, env } = isolatedEnv();
    installPackage(env);
    env.BATON_GROK_PATH = fakeGrokExecutable(acpInitializeFake(`{
      protocolVersion: 1,
      _meta: { agentVersion: "fake-grok/1", modelState: { currentModelId: "grok-visible", availableModels: [{ modelId: "grok-visible", name: "Visible" }] } }
    }`));
    await initProject(cwd, { env });
    const output: string[] = [];
    const code = await runConfig(
      ["--cli", "grok", "--runner", "grok-visible", "--longctx", "grok-visible", "--coding-model", "grok-visible", "--enable", "--json"],
      { cwd, env, stdout: { write: (chunk) => output.push(String(chunk)) } },
    );
    assert.equal(code, 0, output.join(""));
    const payload = JSON.parse(output.join(""));
    assert.equal(payload.max_concurrent_subagents, 16);
    assert.equal(payload.max_concurrent_subagents_source, "adapter");
    assert.equal(loadConfig(cwd, { env }).cli.grok?.max_concurrent, 16);
    assert.match(fs.readFileSync(configPath(cwd, { env }), "utf8"), /max_concurrent = 16/);
  });

  it("uses the live CLI concurrent limit to persist config and fill that many dispatch slots", async () => {
    const { cwd, env } = isolatedEnv();
    installPackage(env);
    env.BATON_GROK_PATH = fakeGrokExecutable(acpInitializeFake(`{
      protocolVersion: 1,
      agentCapabilities: { max_concurrent_subagents: 2 },
      _meta: {
        agentVersion: "fake-grok/2",
        modelState: {
          currentModelId: "grok-visible",
          availableModels: [{ modelId: "grok-visible", name: "Visible", description: "Exact" }]
        }
      }
    }`));
    const catalog = await getCliAdapter("grok", env).discoverModels({ cwd: repoRoot, env });
    assert.deepEqual(catalog.capabilities, { max_concurrent_subagents: 2 });

    await initProject(cwd, { env });
    const output: string[] = [];
    const code = await runConfig(
      ["--cli", "grok", "--runner", "grok-visible", "--longctx", "grok-visible", "--coding-model", "grok-visible", "--enable", "--json"],
      { cwd, env, stdout: { write: (chunk) => output.push(String(chunk)) } },
    );
    assert.equal(code, 0, output.join(""));
    const payload = JSON.parse(output.join(""));
    assert.equal(payload.max_concurrent_subagents, 2);
    assert.equal(payload.max_concurrent_subagents_source, "adapter");
    assert.equal(loadConfig(cwd, { env }).cli.grok?.max_concurrent, 2);

    env.BATON_SESSION_ID = "grok-obtained-capacity";
    const now = "2026-08-30T06:00:00.000Z";
    const selection = {
      host: "grok",
      proposal_id: "proposal-grok-capacity",
      approval_id: "approval-grok-capacity",
      approved_at: now,
      confirmed_by: "baton-recommendation" as const,
      catalog_fingerprint: "grok-capacity-catalog",
      recommended_model_id: "grok-visible",
      selected_model_id: "grok-visible",
      changed_by_user: false,
    };
    for (let offset = 0; offset < 3; offset += 1) {
      const id = nextSpawnId(cwd, "spn", env);
      const ticket = buildSpawnTicket({
        cwd,
        env,
        id,
        description: `capacity unit ${offset + 1}`,
        prompt: `capacity unit ${offset + 1}`,
        modelId: "grok-visible",
        routeId: "grok-visible",
        taskKind: "concrete",
        selection,
        targetHost: "grok",
        now: new Date(Date.parse(now) + offset * 1000).toISOString(),
      });
      const receipt = buildReadOnlyReceipt({
        ticketId: id,
        card: { id: "grok-visible", strengths: "fixture", route_id: "grok-visible" },
        issuedAt: ticket.created_at,
        selection,
        host: "grok",
      });
      ticket.receipt_id = receipt.receipt_id;
      writeReceipt(cwd, receipt, env);
      writeSpawn(cwd, ticket, env);
    }

    const before = dispatchSnapshot(cwd, { host: "grok", env });
    assert.equal(before.capacity, 2);
    assert.equal(before.available, 2);
    const reserved = await reserveNext(cwd, { host: "grok", now: "2026-08-30T06:01:00.000Z", env });
    assert.equal(reserved.reserved.length, 2);
    assert.equal(reserved.snapshot.active, 2);
    assert.equal(reserved.snapshot.available, 0);
    assert.equal(reserved.snapshot.queued.length, 1);
    assert.equal(reserved.snapshot.capacity, 2);
  });
});
