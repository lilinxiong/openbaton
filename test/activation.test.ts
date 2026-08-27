import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyConfig, saveConfig } from "../src/lib/config.js";
import { resolveActivation, runActivation } from "../src/lib/activation.js";
import { projectSettingsPath } from "../src/lib/paths.js";

function fixture(): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-activation-"));
  const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "baton-activation-home-")) };
  const config = emptyConfig();
  config.cli.codex = { enabled: true, runner: "", longctx: "", coding_models: [] };
  config.cli.grok = { enabled: true, runner: "", longctx: "", coding_models: [] };
  saveConfig(cwd, config, { env });
  return { cwd, env };
}
function sink() { return { write() { return true; } }; }

describe("activation settings", () => {
  it("defaults project activation to enabled for each configured host", () => {
    const { cwd, env } = fixture();
    assert.equal(resolveActivation(cwd, { env, host: "codex" }).effective_enabled, true);
    assert.equal(resolveActivation(cwd, { env, host: "grok" }).effective_enabled, true);
  });
  it("writes only the requested project host", () => {
    const { cwd, env } = fixture();
    runActivation(["disable", "curproject", "--host", "codex"], { cwd, env, stdout: sink() });
    assert.equal(resolveActivation(cwd, { env, host: "codex" }).effective_enabled, false);
    assert.equal(resolveActivation(cwd, { env, host: "grok" }).effective_enabled, true);
    const settings = fs.readFileSync(projectSettingsPath(cwd, env), "utf8");
    assert.match(settings, /\[cli\.codex\]/);
    assert.match(settings, /enabled = false/);
  });
  it("applies global activation independently of project settings", () => {
    const { cwd, env } = fixture();
    runActivation(["disable", "all", "--host", "grok"], { cwd, env, stdout: sink() });
    assert.equal(resolveActivation(cwd, { env, host: "grok" }).effective_enabled, false);
    assert.equal(resolveActivation(cwd, { env, host: "codex" }).effective_enabled, true);
  });
  it("fails closed for malformed activation settings", () => {
    const { cwd, env } = fixture();
    fs.mkdirSync(path.dirname(projectSettingsPath(cwd, env)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(cwd, env), "[cli.codex]\nenabled = \"yes\"\n", "utf8");
    const state = resolveActivation(cwd, { env, host: "codex" });
    assert.equal(state.valid, false);
    assert.equal(state.effective_enabled, false);
  });
});
