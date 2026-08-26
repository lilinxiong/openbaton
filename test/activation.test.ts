import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyConfig, loadConfig, saveConfig } from "../src/lib/config.js";
import {
  listDrainingTickets,
  resolveActivation,
  runActivation,
  withActivationLock,
} from "../src/lib/activation.js";
import {
  activationLockPath,
  configPath,
  globalActivationLockPath,
  projectSettingsPath,
  spawnsDir,
} from "../src/lib/paths.js";
import { parseToml } from "../src/lib/toml.js";

function project(prefix = "baton-activation-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function environment(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "baton-activation-home-")) };
}

function configure(cwd: string, env: NodeJS.ProcessEnv, hosts: Record<string, boolean> = { codex: true }): void {
  const config = emptyConfig();
  for (const [host, enabled] of Object.entries(hosts)) {
    config.cli[host as "codex" | "grok"] = {
      enabled,
      runner: "gpt-5.6-luna",
      longctx: "gpt-5.6-luna",
      coding_models: ["gpt-5.3-codex-spark", "gpt-5.6-luna"],
      guard_mode: host === "grok" ? "enforce" : "off",
    };
  }
  saveConfig(cwd, config, { env });
}

function sink(): { output: () => string; write: (chunk: string) => void } {
  const chunks: string[] = [];
  return { write: (chunk) => chunks.push(String(chunk)), output: () => chunks.join("") };
}

describe("activation settings", () => {
  it("defaults project activation to true and isolates hosts", () => {
    const cwd = project();
    const env = environment();
    configure(cwd, env, { codex: true, grok: true });

    assert.equal(resolveActivation(cwd, { env, host: "codex" }).effective_enabled, true);
    assert.equal(resolveActivation(cwd, { env, host: "grok" }).effective_enabled, true);

    const settings = projectSettingsPath(cwd, env);
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, "[cli.codex]\nenabled = false\n[cli.grok]\nenabled = true\n", "utf8");
    const codex = resolveActivation(cwd, { env, host: "codex" });
    const grok = resolveActivation(cwd, { env, host: "grok" });
    assert.equal(codex.effective_enabled, false);
    assert.equal(codex.provenance, "project");
    assert.equal(grok.effective_enabled, true);
    assert.equal(grok.provenance, "global-and-project");
  });

  it("fails closed for missing or malformed global/project profiles", () => {
    const cwd = project();
    const env = environment();
    configure(cwd, env, { codex: true });
    const missingHost = resolveActivation(cwd, { env, host: "grok" });
    assert.equal(missingHost.valid, false);
    assert.equal(missingHost.effective_enabled, false);

    fs.writeFileSync(configPath(cwd, { env }), "[cli.codex]\nenabled = \"yes\"\n", "utf8");
    const malformedGlobal = resolveActivation(cwd, { env, host: "codex" });
    assert.equal(malformedGlobal.valid, false);
    assert.equal(malformedGlobal.effective_enabled, false);
    assert.throws(
      () => runActivation(["disable", "all", "--host", "codex"], { cwd, env, stdout: sink() }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ACTIVATION_INVALID",
    );
    assert.equal(fs.readFileSync(configPath(cwd, { env }), "utf8"), "[cli.codex]\nenabled = \"yes\"\n");

    configure(cwd, env);
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd, env)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd, env), "[cli.codex]\nenabled = \"no\"\n", "utf8");
    const malformedProject = resolveActivation(cwd, { env, host: "codex" });
    assert.equal(malformedProject.valid, false);
    assert.equal(malformedProject.effective_enabled, false);
  });

  it("writes only the requested scope and preserves other project hosts", () => {
    const cwd = project();
    const env = environment();
    configure(cwd, env, { codex: true, grok: true });
    const settings = projectSettingsPath(cwd, env);
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, "[cli.codex]\nenabled = true\n[cli.grok]\nenabled = false\n", "utf8");

    const output = sink();
    assert.equal(runActivation(["disable", "curproject", "--host", "codex", "--json"], { cwd, env, stdout: output }), 0);
    const projectRaw = parseToml(fs.readFileSync(settings, "utf8"));
    assert.equal((projectRaw.cli as Record<string, Record<string, unknown>>).codex.enabled, false);
    assert.equal((projectRaw.cli as Record<string, Record<string, unknown>>).grok.enabled, false);
    assert.match(output.output(), /\"draining_count\": 0/);

    assert.equal(runActivation(["disable", "all", "--host", "grok"], { cwd, env, stdout: sink() }), 0);
    const config = loadConfig(cwd, { env });
    assert.equal(config.cli.codex?.enabled, true);
    assert.equal(config.cli.grok?.enabled, false);
    assert.equal(resolveActivation(cwd, { env, host: "codex" }).effective_enabled, false);
  });

  it("does not migrate legacy Coding fields when changing global activation", () => {
    const cwd = project();
    const env = environment();
    const file = configPath(cwd, { env });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      "schema_version = 1",
      "[director]",
      "max_concurrent = 4",
      "max_depth = 1",
      "[cli.codex]",
      "enabled = true",
      'runner = "gpt-5.6-luna"',
      'longctx = "gpt-5.6-luna"',
      'subagent_models = ["gpt-5.3-codex-spark", "gpt-5.6-luna"]',
      "",
    ].join("\n"), "utf8");

    assert.equal(runActivation(["disable", "all", "--host", "codex"], { cwd, env, stdout: sink() }), 0);
    const saved = fs.readFileSync(file, "utf8");
    assert.match(saved, /subagent_models = \["gpt-5\.3-codex-spark", "gpt-5\.6-luna"\]/);
    assert.doesNotMatch(saved, /coding_models/);
    assert.equal(resolveActivation(cwd, { env, host: "codex" }).global_enabled, false);
  });

  it("reports active tickets as draining without cancelling them", () => {
    const cwd = project();
    const env = environment();
    configure(cwd, env);
    const directory = spawnsDir(cwd, env);
    fs.mkdirSync(directory, { recursive: true });
    const ticket = path.join(directory, "ticket-1.json");
    fs.writeFileSync(ticket, JSON.stringify({ id: "ticket-1", status: "running", host: "codex" }), "utf8");

    const draining = listDrainingTickets(cwd, "codex", { scope: "curproject", env });
    assert.equal(draining.length, 1);
    assert.equal(draining[0].status, "running");
    const result = sink();
    runActivation(["disable", "curproject", "--host", "codex", "--json"], { cwd, env, stdout: result });
    assert.equal(fs.existsSync(ticket), true);
    assert.match(result.output(), /\"draining_count\": 1/);
  });

  it("scans every canonical project for global disable", () => {
    const cwd = project();
    const other = project();
    const env = environment();
    configure(cwd, env);
    const otherDirectory = spawnsDir(other, env);
    fs.mkdirSync(otherDirectory, { recursive: true });
    fs.writeFileSync(path.join(otherDirectory, "ticket-other.json"), JSON.stringify({
      id: "ticket-other",
      status: "dispatching",
      target_host: "codex",
    }), "utf8");

    const result = sink();
    runActivation(["disable", "all", "--host", "codex", "--json"], { cwd, env, stdout: result });
    const payload = JSON.parse(result.output()) as { draining_count: number; draining_tickets: Array<{ ticket_id: string }> };
    assert.equal(payload.draining_count, 1);
    assert.equal(payload.draining_tickets[0].ticket_id, "ticket-other");
    assert.equal(fs.existsSync(path.join(otherDirectory, "ticket-other.json")), true);
  });

  it("refuses malformed dispatch state before changing activation", () => {
    const cwd = project();
    const env = environment();
    configure(cwd, env);
    const directory = spawnsDir(cwd, env);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "broken.json"), "not-json", "utf8");
    assert.throws(
      () => runActivation(["disable", "curproject", "--host", "codex"], { cwd, env, stdout: sink() }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ACTIVATION_INVALID",
    );
    assert.equal(loadConfig(cwd, { env }).cli.codex?.enabled, true);
  });

  it("uses and recovers the bounded activation lock", () => {
    const cwd = project();
    const env = environment();
    configure(cwd, env);
    const lock = activationLockPath(cwd, env);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "stale", { mode: 0o600 });
    const old = new Date(Date.now() - 61_000);
    fs.utimesSync(lock, old, old);
    assert.equal(withActivationLock(cwd, env, () => "ok"), "ok");
    assert.equal(fs.existsSync(lock), false);

    fs.writeFileSync(lock, "live", { mode: 0o600 });
    assert.throws(
      () => withActivationLock(cwd, env, () => "unreachable"),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ACTIVATION_LOCK_BUSY",
    );
    fs.unlinkSync(lock);
  });

  it("shares the host lock across projects and scopes", () => {
    const cwd = project();
    const other = project();
    const env = environment();
    configure(cwd, env);
    const globalLock = globalActivationLockPath("codex", env);
    fs.mkdirSync(path.dirname(globalLock), { recursive: true });
    fs.writeFileSync(globalLock, "live", { mode: 0o600 });
    assert.throws(
      () => runActivation(["disable", "curproject", "--host", "codex"], { cwd, env, stdout: sink() }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ACTIVATION_LOCK_BUSY",
    );
    assert.throws(
      () => withActivationLock(other, env, () => "unreachable", { host: "codex", scope: "both" }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ACTIVATION_LOCK_BUSY",
    );
    fs.unlinkSync(globalLock);
  });
});
