import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runConfig } from "../src/commands/config.js";
import { initProject } from "../src/commands/init.js";
import {
  UNKNOWN_MAX_CONCURRENT,
  effectiveMaxConcurrentForHost,
  loadConfig,
  normalizeConfig,
  persistableCliMaxConcurrent,
  persistedConcurrentLimit,
  reportedConcurrentLimit,
  saveConfig,
} from "../src/lib/config.js";
import { parseToml } from "../src/lib/toml.js";
import { configPath } from "../src/lib/paths.js";
import { FIXTURE_ALPHA, fakeEnv, withHome } from "./home.js";

describe("CLI concurrent limit persistence", () => {
  it("treats 0 and -1 as unknown and falls back to director", () => {
    assert.equal(reportedConcurrentLimit(16), 16);
    assert.equal(reportedConcurrentLimit(0), undefined);
    assert.equal(reportedConcurrentLimit(-1), undefined);
    assert.equal(persistedConcurrentLimit(16), 16);
    assert.equal(persistedConcurrentLimit(0), UNKNOWN_MAX_CONCURRENT);
    assert.equal(persistedConcurrentLimit(-1), UNKNOWN_MAX_CONCURRENT);
    assert.equal(persistedConcurrentLimit("-1"), UNKNOWN_MAX_CONCURRENT);
    assert.equal(persistableCliMaxConcurrent(2, 16), 2);
    assert.equal(persistableCliMaxConcurrent(undefined, 16), 16);
    assert.equal(persistableCliMaxConcurrent(undefined, Number.NaN, -1), UNKNOWN_MAX_CONCURRENT);

    const cfg = normalizeConfig({
      director: { max_concurrent: 4, max_depth: 1 },
      cli: {
        grok: { enabled: true, runner: "grok-4.5", longctx: "grok-4.5", coding_models: ["grok-4.5"], max_concurrent: 0 },
        codex: { enabled: true, runner: "gpt-5.4", longctx: "gpt-5.4", coding_models: ["gpt-5.4"], max_concurrent: -1 },
      },
    });
    assert.equal(cfg.cli.grok?.max_concurrent, UNKNOWN_MAX_CONCURRENT);
    assert.equal(cfg.cli.codex?.max_concurrent, UNKNOWN_MAX_CONCURRENT);
    assert.equal(effectiveMaxConcurrentForHost(cfg, "grok"), 4);
    assert.equal(effectiveMaxConcurrentForHost(cfg, "codex"), 4);

    const reported = normalizeConfig({
      director: { max_concurrent: 4, max_depth: 1 },
      cli: { grok: { enabled: true, runner: "g", longctx: "g", coding_models: ["g"], max_concurrent: 16 } },
    });
    assert.equal(effectiveMaxConcurrentForHost(reported, "grok"), 16);
  });

  it("round-trips the unknown sentinel in config.toml", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-sentinel-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-sentinel-cwd-"));
    const env = { ...process.env, HOME: home };
    fs.mkdirSync(path.join(home, ".baton"), { recursive: true });
    saveConfig(cwd, {
      schema_version: 2,
      director: { max_concurrent: 4, max_depth: 1 },
      cli: {
        grok: {
          enabled: true,
          runner: "grok-4.5",
          longctx: "grok-4.5",
          coding_models: ["grok-4.5"],
          max_concurrent: UNKNOWN_MAX_CONCURRENT,
        },
      },
    }, { env });
    const text = fs.readFileSync(configPath(cwd, { env }), "utf8");
    assert.match(text, /\[cli\.grok\]/);
    assert.match(text, /max_concurrent = -1/);
    const loaded = loadConfig(cwd, { env });
    assert.equal(loaded.cli.grok?.max_concurrent, UNKNOWN_MAX_CONCURRENT);
    assert.equal(effectiveMaxConcurrentForHost(loaded, "grok"), 4);
  });

  it("writes a reported host limit onto [cli.alpha] during config", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-host-limit-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const out: string[] = [];
      const code = await runConfig([
        "--cli", "alpha",
        "--runner", "alpha-model",
        "--longctx", "alpha-model",
        "--coding-model", "alpha-model",
        "--enable",
        "--json",
      ], { cwd, env, stdout: { write: (chunk) => out.push(String(chunk)) } });
      assert.equal(code, 0, out.join(""));
      const payload = JSON.parse(out.join(""));
      assert.equal(payload.max_concurrent_subagents, 2);
      assert.equal(payload.max_concurrent_subagents_source, "adapter");
      assert.equal(loadConfig(cwd, { env }).cli.alpha?.max_concurrent, 2);
      const parsed = parseToml(fs.readFileSync(configPath(cwd, { env }), "utf8"));
      assert.equal((parsed.cli as { alpha: { max_concurrent: number } }).alpha.max_concurrent, 2);
    });
  });

  it("writes -1 when the adapter did not report a concurrent limit", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-unknown-limit-"));
      const adapterDir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-unknown-adapter-"));
      fs.cpSync(FIXTURE_ALPHA, adapterDir, { recursive: true });
      const manifestPath = path.join(adapterDir, "adapter.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        quota: Record<string, unknown>;
      };
      delete manifest.quota.max_concurrent_subagents;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      fs.chmodSync(path.join(adapterDir, "catalog.js"), 0o755);
      const env = fakeEnv(home, { BATON_ADAPTER_PATHS: adapterDir });
      await initProject(cwd, { env });
      const out: string[] = [];
      const code = await runConfig([
        "--cli", "alpha",
        "--runner", "alpha-model",
        "--longctx", "alpha-model",
        "--coding-model", "alpha-model",
        "--enable",
        "--json",
      ], {
        cwd,
        env,
        stdout: { write: (chunk) => out.push(String(chunk)) },
      });
      assert.equal(code, 0, out.join(""));
      const payload = JSON.parse(out.join(""));
      assert.equal(payload.max_concurrent_subagents, 4);
      assert.equal(payload.max_concurrent_subagents_source, "director_policy");
      assert.equal(loadConfig(cwd, { env }).cli.alpha?.max_concurrent, UNKNOWN_MAX_CONCURRENT);
      assert.match(fs.readFileSync(configPath(cwd, { env }), "utf8"), /max_concurrent = -1/);
    });
  });
});
