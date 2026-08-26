import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { BATON_CODEX_HOOK_COMMAND, batonCodexHookEntries, codexHooksPath, installCodexHooks } from "../src/lib/codex-hooks.js";
import { loadConfig, saveConfig } from "../src/lib/config.js";
import { HOST_SKILL_REL } from "../src/lib/hosts.js";
import { fakeEnv, withHome } from "./home.js";

describe("Baton update host guard integration", () => {
  it("refreshes the active global director skill from this checkout", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-update-skill-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const installed = path.join(home, ".baton", "SKILL.md");
      fs.writeFileSync(installed, "stale skill\n", "utf8");

      const result = updateProject(cwd, { env });
      assert.ok(result.actions.some((item) => item.includes("updated ~/.baton/SKILL.md")));
      assert.equal(
        fs.readFileSync(installed, "utf8"),
        fs.readFileSync(path.join(process.cwd(), "SKILL.md"), "utf8"),
      );
    });
  });

  it("refreshes the Baton hook and preserves unrelated Codex hooks", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-update-guard-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const config = loadConfig(cwd, { env });
      config.cli.codex = {
        enabled: true,
        runner: "",
        longctx: "",
        coding_models: [],
        guard_mode: "enforce",
      };
      saveConfig(cwd, config, { env });
      installCodexHooks({ cwd, env, guardMode: "enforce" });
      const file = codexHooksPath({ env });
      const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
      hooks.hooks.Stop = [{ hooks: [{ type: "command", command: "user-stop" }] }];
      hooks.hooks.PreToolUse.unshift({ matcher: "mcp__user__.*", hooks: [{ type: "command", command: "user-mcp" }] });
      fs.writeFileSync(file, `${JSON.stringify(hooks, null, 2)}\n`);

      const result = updateProject(cwd, { env });
      assert.equal(result.guard.installed, true);
      assert.ok(result.actions.some((item) => /Codex Baton host guard/.test(item)));
      const merged = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(merged.hooks.Stop[0].hooks[0].command, "user-stop");
      assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, "user-mcp");
      assert.match(fs.readFileSync(path.join(home, HOST_SKILL_REL.codex), "utf8"), /host-guard preflight|host-guard/i);
    });
  });

  it("keeps Codex hook posture empty when guard_mode is explicitly off", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-update-guard-off-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const config = loadConfig(cwd, { env });
      config.cli.codex = {
        enabled: true,
        runner: "",
        longctx: "",
        coding_models: [],
        guard_mode: "off",
      };
      saveConfig(cwd, config, { env });
      const result = updateProject(cwd, { env });
      assert.equal(result.guard.guard_mode, "off");
      assert.equal(result.guard.baton_entries, 0);
      assert.equal(result.guard.coverage, "none");
    });
  });

  it("records a recognized legacy guard posture without migrating legacy Coding fields", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-update-legacy-config-"));
      const env = fakeEnv(home);
      const configFile = path.join(home, ".baton", "config.toml");
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(configFile, [
        "[director]",
        "max_concurrent = 4",
        "max_depth = 1",
        "",
        "[cli.codex]",
        "enabled = true",
        'runner = "gpt-5.6-luna"',
        'longctx = "gpt-5.6-luna"',
        'subagent_models = ["gpt-5.3-codex-spark", "gpt-5.6-luna"]',
      ].join("\n"), "utf8");
      const hookFile = codexHooksPath({ cwd, env });
      fs.mkdirSync(path.dirname(hookFile), { recursive: true });
      fs.writeFileSync(hookFile, `${JSON.stringify({ hooks: batonCodexHookEntries(BATON_CODEX_HOOK_COMMAND) }, null, 2)}\n`);

      const result = updateProject(cwd, { env });
      assert.equal(result.guard.guard_mode, "enforce");
      const saved = fs.readFileSync(configFile, "utf8");
      assert.match(saved, /subagent_models = \["gpt-5\.3-codex-spark", "gpt-5\.6-luna"\]/);
      assert.doesNotMatch(saved, /coding_models/);
      assert.match(saved, /guard_mode = "enforce"/);
    });
  });
});
