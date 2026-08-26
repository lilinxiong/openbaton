import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { runConfig } from "../src/commands/config.js";
import {
  cliProfileForHost,
  configuredCodingModelsForHost,
  effectiveMaxConcurrentForHost,
  effectiveMaxDepthForHost,
  loadConfig,
  saveConfig,
} from "../src/lib/config.js";
import { resolveRuntimeHost } from "../src/lib/hosts.js";
import { configPath } from "../src/lib/paths.js";
import { parseToml } from "../src/lib/toml.js";
import type { CliModel, CliModelCatalog } from "../src/adapters/contract.js";
import { withHome, fakeEnv } from "./home.js";
import { adapterProviderFor } from "./configure.js";

function capture() {
  const chunks: string[] = [];
  return {
    write(value: unknown) { chunks.push(String(value)); },
    text() { return chunks.join(""); },
  };
}

function model(id: string, displayName: string, description: string): CliModel {
  return {
    id,
    model: id,
    display_name: displayName,
    description,
    hidden: false,
    reasoning_efforts: [{ id: "low", description: "" }, { id: "medium", description: "" }],
    default_reasoning_effort: "medium",
    input_modalities: ["text"],
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    is_default: false,
  };
}

const CODEX_CATALOG: CliModelCatalog = {
  cli: "codex",
  version: "codex-cli test",
  models: [
    model("gpt-5.4-mini", "5.4 Mini", "Small"),
    model("gpt-5.5", "5.5", "General"),
    model("gpt-5.6-luna", "5.6 Luna", "Fast"),
  ],
};

const GROK_CATALOG: CliModelCatalog = {
  cli: "grok",
  version: "grok 1.0.8",
  models: [
    model("grok-4.5", "Grok 4.5", "Fast"),
    model("grok-4.6", "Grok 4.6", "Flagship"),
  ],
};

describe("cli host profiles without active", () => {
  it("ignores a legacy active key on read and omits it on the next save", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-legacy-active-"));
      const env = fakeEnv(home);
      const file = configPath(cwd, { env });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        "[director]",
        "max_concurrent = 4",
        "max_depth = 1",
        "",
        "[cli]",
        'active = "codex"',
        "",
        "[cli.codex]",
        "enabled = true",
        'runner = "gpt-5.4-mini"',
        'longctx = "gpt-5.5"',
        'subagent_models = ["gpt-5.4-mini", "gpt-5.5"]',
        "",
        "[cli.grok]",
        "enabled = true",
        'runner = "grok-4.5"',
        'longctx = ""',
        'subagent_models = ["grok-4.5"]',
      ].join("\n"), "utf8");

      const loaded = loadConfig(cwd, { env });
      assert.equal(Object.hasOwn(loaded.cli, "active"), false);
      assert.equal(loaded.cli.codex.enabled, true);
      assert.equal(loaded.cli.grok.enabled, true);

      assert.throws(
        () => resolveRuntimeHost({ cwd, env }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /HOST_REQUIRED/);
          assert.match(error.message, /--host/);
          assert.match(error.message, /BATON_HOST/);
          return true;
        },
      );

      saveConfig(cwd, loaded, { env });
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(text, /^\s*active\s*=/m);
      assert.doesNotMatch(text, /\[cli\]\s*$/m);
      const parsed = parseToml(text);
      assert.equal(Object.hasOwn((parsed.cli as Record<string, unknown>), "active"), false);
    });
  });

  it("fails unqualified runtime commands with HOST_REQUIRED naming --host and BATON_HOST", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-required-cli-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init", "--cli", "grok"], { cwd, env, stdout: capture(), stderr: capture() }), 0);

      for (const args of [["status"], ["models", "status"], ["spawn", "implement the parser"]] as const) {
        const out = capture();
        const code = await run([...args], { cwd, env, stdout: out, stderr: out });
        assert.equal(code, 1, out.text());
        assert.match(out.text(), /HOST_REQUIRED/);
        assert.match(out.text(), /--host/);
        assert.match(out.text(), /BATON_HOST/);
      }
    });
  });

  it("still resolves a unique runtime invoking-host signal", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-unique-signal-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init", "--cli", "codex"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(
        resolveRuntimeHost({ cwd, env: { ...env, CURSOR_AGENT: "1" } }),
        "cursor",
      );
    });
  });

  it("does not let a disabled host borrow another enabled profile", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-disabled-borrow-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex",
        "--runner", "gpt-5.4-mini",
        "--longctx", "gpt-5.5",
        "--coding-model", "gpt-5.6-luna",
        "--enable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CODEX_CATALOG) }), 0);
      assert.equal(await runConfig([
        "--cli", "grok",
        "--runner", "grok-4.5",
        "--longctx", "-",
        "--coding-model", "grok-4.5",
        "--enable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(GROK_CATALOG) }), 0);

      const config = loadConfig(cwd, { env });
      config.cli.codex.enabled = false;
      saveConfig(cwd, config, { env });

      const disabled = loadConfig(cwd, { env });
      assert.equal(disabled.cli.codex.enabled, false);
      assert.equal(disabled.cli.grok.enabled, true);
      assert.deepEqual(configuredCodingModelsForHost(disabled, "codex"), []);
      assert.deepEqual(cliProfileForHost(disabled, "codex").coding_models, [
        "gpt-5.6-luna",
      ]);
      assert.equal(cliProfileForHost(disabled, "codex").runner, "gpt-5.4-mini");
      assert.notEqual(cliProfileForHost(disabled, "codex").runner, cliProfileForHost(disabled, "grok").runner);

      const out = capture();
      assert.equal(await run(["spawn", "implement the Codex unit", "--host", "codex", "--json"], {
        cwd, env, stdout: out, stderr: out,
      }), 0, out.text());
      assert.match(out.text(), /bypassed|ACTIVATION_DISABLED|tickets=\[\]/i);
      assert.doesNotMatch(out.text(), /grok-4\.5/);
    });
  });

  it("uses CLI-reported limits per profile and director fallbacks when absent", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-leaves-codex-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex",
        "--runner", "gpt-5.4-mini",
        "--longctx", "gpt-5.5",
        "--coding-model", "gpt-5.6-luna",
        "--enable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CODEX_CATALOG) }), 0);

      const before = loadConfig(cwd, { env });
      assert.equal(before.director.max_concurrent, 4);
      assert.deepEqual(before.cli.codex, {
        enabled: true,
        runner: "gpt-5.4-mini",
        longctx: "gpt-5.5",
        coding_models: ["gpt-5.6-luna"],
        guard_mode: "off",
      });

      const out = capture();
      assert.equal(await runConfig([
        "--cli", "grok",
        "--runner", "grok-4.5",
        "--longctx", "-",
        "--coding-model", "grok-4.6",
        "--enable",
      ], {
        cwd,
        env,
        stdout: out,
        adapterProvider: adapterProviderFor({
          ...structuredClone(GROK_CATALOG),
          max_concurrent: 8,
          max_depth: 2,
        }),
      }), 0, out.text());

      const after = loadConfig(cwd, { env });
      assert.deepEqual(after.cli.codex, before.cli.codex);
      assert.equal(after.cli.grok.enabled, true);
      assert.equal(after.cli.grok.runner, "grok-4.5");
      assert.equal(after.cli.grok.max_concurrent, 8);
      assert.equal(after.cli.grok.max_depth, 2);
      assert.equal(after.director.max_concurrent, 4);
      assert.notEqual(after.director.max_concurrent, 8);
      assert.equal(effectiveMaxConcurrentForHost(after, "codex", env), 4);
      assert.equal(effectiveMaxConcurrentForHost(after, "grok", env), 8);
      assert.equal(effectiveMaxDepthForHost(after, "codex"), 1);
      assert.equal(effectiveMaxDepthForHost(after, "grok"), 2);

      const status = capture();
      assert.equal(await run(["status", "--host", "codex"], { cwd, env, stdout: status, stderr: status }), 0, status.text());
      assert.match(status.text(), /cli: codex \(enabled\)/);
      assert.match(status.text(), /max_concurrent: 4/);
      assert.doesNotMatch(status.text(), /max_concurrent: 8/);

      const parsed = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((parsed.cli as Record<string, unknown>), "active"), false);
      assert.equal((parsed.director as { max_concurrent: number }).max_concurrent, 4);
      assert.equal(((parsed.cli as Record<string, Record<string, unknown>>).grok).max_concurrent, 8);
      assert.equal(((parsed.cli as Record<string, Record<string, unknown>>).grok).max_depth, 2);
    });
  });

  it("drops stale profile limits when the latest CLI response has no valid values", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-stale-cli-limits-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const args = [
        "--cli", "grok",
        "--runner", "grok-4.5",
        "--longctx", "-",
        "--coding-model", "grok-4.5",
        "--enable",
      ];
      assert.equal(await runConfig(args, {
        cwd,
        env,
        stdout: capture(),
        adapterProvider: adapterProviderFor({
          ...structuredClone(GROK_CATALOG),
          capabilities: { max_concurrent: 9, max_depth: 3 },
        }),
      }), 0);
      assert.equal(loadConfig(cwd, { env }).cli.grok.max_concurrent, 9);

      assert.equal(await runConfig(args, {
        cwd,
        env,
        stdout: capture(),
        adapterProvider: adapterProviderFor({
          ...structuredClone(GROK_CATALOG),
          capabilities: { max_concurrent: 0, max_depth: -1 },
        }),
      }), 0);
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.grok.max_concurrent, undefined);
      assert.equal(config.cli.grok.max_depth, undefined);
      assert.equal(effectiveMaxConcurrentForHost(config, "grok", env), 4);
      assert.equal(effectiveMaxDepthForHost(config, "grok"), 1);

      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      const profile = (raw.cli as Record<string, Record<string, unknown>>).grok;
      assert.equal(profile.max_concurrent, undefined);
      assert.equal(profile.max_depth, undefined);
    });
  });

  it("migrates legacy Coding candidates only when config save succeeds", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-coding-migration-"));
      const env = fakeEnv(home);
      const file = configPath(cwd, { env });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        "[director]",
        "max_concurrent = 4",
        "max_depth = 1",
        "",
        "[cli.codex]",
        "enabled = true",
        'runner = "gpt-5.4-mini"',
        'longctx = "gpt-5.5"',
        'subagent_models = ["gpt-5.3-codex-spark", "gpt-5.6-luna"]',
      ].join("\n"), "utf8");
      const before = fs.readFileSync(file, "utf8");
      await assert.rejects(
        runConfig(["--cli", "codex", "--subagent-model", "gpt-5.6-luna"], {
          cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CODEX_CATALOG),
        }),
        (error: unknown) => (error as { code?: string }).code === "LEGACY_FLAG_REMOVED",
      );
      assert.equal(fs.readFileSync(file, "utf8"), before);
      assert.equal(await runConfig([
        "--cli", "codex", "--runner", "gpt-5.4-mini", "--longctx", "gpt-5.5",
        "--coding-model", "gpt-5.4-mini,gpt-5.6-luna", "--enable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CODEX_CATALOG) }), 0);
      const config = loadConfig(cwd, { env });
      assert.deepEqual(config.cli.codex.coding_models, ["gpt-5.4-mini", "gpt-5.6-luna"]);
      const saved = fs.readFileSync(file, "utf8");
      assert.match(saved, /coding_models = \["gpt-5\.4-mini", "gpt-5\.6-luna"\]/);
      assert.doesNotMatch(saved, /subagent_models/);
      assert.match(saved, /schema_version = 2/);
    });
  });

  it("fails closed on an invalid explicit guard mode", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-invalid-guard-mode-"));
      const env = fakeEnv(home);
      const file = configPath(cwd, { env });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        "[director]",
        "max_concurrent = 4",
        "max_depth = 1",
        "",
        "[cli.codex]",
        "enabled = true",
        'runner = "gpt-5.6-luna"',
        'longctx = "gpt-5.6-luna"',
        'coding_models = ["gpt-5.6-luna"]',
        'guard_mode = "enfore"',
      ].join("\n"), "utf8");
      assert.throws(
        () => loadConfig(cwd, { env }),
        (error: unknown) => (error as { code?: string }).code === "CONFIG_GUARD_MODE_INVALID",
      );
    });
  });
});
