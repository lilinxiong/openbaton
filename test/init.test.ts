import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { loadConfig } from "../src/lib/config.js";
import { HOST_SKILL_REL } from "../src/lib/hosts.js";
import { parseToml } from "../src/lib/toml.js";
import { withHome, fakeEnv } from "./home.js";

describe("Codex init and update", () => {
  it("installs the CLI-owned automatic-routing policy and disabled config", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-"));
      const env = fakeEnv(home);
      const result = await initProject(cwd, { env });
      assert.deepEqual(result.tools, ["codex", "grok"]);

      const directorSkill = fs.readFileSync(path.join(home, ".baton", "SKILL.md"), "utf8");
      const hostSkill = fs.readFileSync(path.join(home, HOST_SKILL_REL.codex), "utf8");
      const grokSkill = fs.readFileSync(path.join(home, HOST_SKILL_REL.grok), "utf8");
      for (const skill of [directorSkill, hostSkill]) {
        assert.match(skill, /model\/list/);
        assert.match(skill, /gpt-5\.4-mini/);
        assert.match(skill, /gpt-5\.3-codex-spark/);
        assert.match(skill, /No human model selector|Never expose human model selection/);
        assert.match(skill, /OpenCodex/);
      }
      assert.match(grokSkill, /grok models/);
      assert.match(grokSkill, /spawn_subagent/);
      assert.match(grokSkill, /--host grok/);
      assert.match(grokSkill, /grok -p/);
      assert.doesNotMatch(grokSkill, /models --json/);
      assert.match(directorSkill, /Codex and Grok|adapters are Codex and Grok/i);
      assert.match(directorSkill, /spawn_subagent/);

      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.active, "codex");
      const emptyProfile = {
        enabled: false,
        runner: "",
        longctx: "",
        subagent_models: [],
      };
      assert.deepEqual(config.cli.codex, emptyProfile);
      assert.deepEqual(config.cli.grok, emptyProfile);
      assert.equal(config.director.max_concurrent, 4);
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal((raw.director as Record<string, unknown>).model_selection, undefined);
      assert.equal(((raw.ops as { longctx: Record<string, unknown> }).longctx).min_context_tokens, undefined);
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));
    });
  });

  it("writes Grok's host concurrent cap when --cli grok is selected", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-grok-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env, cli: "grok" });
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.active, "grok");
      assert.equal(config.director.max_concurrent, 8);
    });
  });

  it("honors GROK_MAX_CONCURRENT_SUBAGENTS when initializing Grok", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-grok-cap-"));
      const env = { ...fakeEnv(home), GROK_MAX_CONCURRENT_SUBAGENTS: "6" };
      await initProject(cwd, { env, cli: "grok" });
      assert.equal(loadConfig(cwd, { env }).director.max_concurrent, 6);
    });
  });

  it("keeps installed files without force and replaces them with force", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-force-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const skill = path.join(home, HOST_SKILL_REL.codex);
      fs.writeFileSync(skill, "CUSTOM\n");
      await initProject(cwd, { env });
      assert.equal(fs.readFileSync(skill, "utf8"), "CUSTOM\n");
      await initProject(cwd, { env, force: true });
      assert.match(fs.readFileSync(skill, "utf8"), /CLI-owned|model\/list/);
    });
  });

  it("migrates legacy ops routes into the Codex profile and removes old fields", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-update-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const file = path.join(home, ".baton", "config.toml");
      fs.writeFileSync(file, [
        "[director]",
        "max_concurrent = 2",
        "max_depth = 1",
        "model_selection = true",
        "",
        "[ops.runner]",
        "route = \"gpt-5.4-mini\"",
        "actions = [\"test\", \"build\", \"lint\", \"typecheck\"]",
        "",
        "[ops.longctx]",
        "route = \"gpt-5.5\"",
        "min_context_tokens = 1048576",
        "actions = [\"search\", \"digest\", \"git-summarize\", \"git-commit\"]",
      ].join("\n"));

      const result = updateProject(cwd, { env });
      assert.ok(result.actions.some((action) => /director\/CLI\/ops defaults/.test(action)));
      const config = loadConfig(cwd, { env });
      assert.equal(config.director.max_concurrent, 2);
      assert.deepEqual(config.cli.codex, {
        enabled: true,
        runner: "gpt-5.4-mini",
        longctx: "gpt-5.5",
        subagent_models: ["gpt-5.4-mini", "gpt-5.5"],
      });
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(text, /model_selection|min_context_tokens|route\s*=/);
      assert.match(text, /subagent_models/);
    });
  });
});
