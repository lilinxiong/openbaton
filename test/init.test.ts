import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { HOST_SKILL_REL } from "../src/lib/hosts.js";
import { loadConfig } from "../src/lib/config.js";
import { withHome, fakeEnv } from "./home.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-"));
}

function assertNoProjectHostDirs(cwd) {
  assert.ok(!fs.existsSync(path.join(cwd, ".baton")), "project .baton");
  assert.ok(!fs.existsSync(path.join(cwd, ".grok")), "project .grok");
  assert.ok(!fs.existsSync(path.join(cwd, ".codex")), "project .codex");
}

describe("initProject", () => {
  it("writes ~/.baton and default host skill paths; grok/codex stay in home", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      const result = await initProject(cwd, { env });
      assert.equal(result.dir, "~/.baton");
      assert.ok(fs.existsSync(path.join(home, ".baton", "config.toml")));
      assert.ok(fs.existsSync(path.join(home, ".baton", "SKILL.md")));
      assert.ok(fs.existsSync(path.join(cwd, HOST_SKILL_REL.claude)));
      assert.ok(fs.existsSync(path.join(cwd, HOST_SKILL_REL.cursor)));
      assert.ok(fs.existsSync(path.join(cwd, HOST_SKILL_REL.agents)));
      assert.ok(fs.existsSync(path.join(home, HOST_SKILL_REL.grok)));
      assert.ok(fs.existsSync(path.join(home, HOST_SKILL_REL.codex)));
      const cfg = loadConfig(cwd, { env });
      assert.equal(cfg.models.length, 4);
      assert.equal(cfg.models.some((model) => /AA Terminal-Bench/.test(model.strengths)), false);
      const k3 = cfg.models.find((model) => model.id === "k3");
      assert.equal(k3.route_id, "kimi/k3[1m]");
      assert.equal(k3.reasoning_effort, "max");
      assert.equal(cfg.models.find((model) => model.id === "k3-256k").route_id, "kimi/k3-256k");
      assert.ok(fs.existsSync(path.join(cwd, "AGENTS.md")));
      assert.match(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), /baton/);
      assertNoProjectHostDirs(cwd);
      assert.ok(result.created.some((f) => f.includes("config.toml") || f.endsWith("config.toml")));
    });
  });

  it("init --tools grok writes home skill + k3 agent and nothing in the project", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { tools: ["grok"], env });
      assert.ok(fs.existsSync(path.join(home, ".baton", "config.toml")));
      assert.ok(fs.existsSync(path.join(home, ".grok", "skills", "baton", "SKILL.md")));
      const k3 = fs.readFileSync(path.join(home, ".grok", "agents", "k3.md"), "utf8");
      assert.match(k3, /^model: k3$/m);
      assertNoProjectHostDirs(cwd);
    });
  });

  it("init --tools codex writes home skill but not card agents", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { tools: ["codex"], env });
      assert.ok(fs.existsSync(path.join(home, ".baton", "config.toml")));
      assert.ok(fs.existsSync(path.join(home, ".codex", "skills", "baton", "SKILL.md")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "k3.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "k3-256k.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "kimi-for-coding.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "mimo-v2.5.toml")));
      assertNoProjectHostDirs(cwd);
    });
  });

  it("init --tools claude writes project .claude and does not write home grok/codex agents", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { tools: ["claude"], env });
      assert.ok(fs.existsSync(path.join(cwd, ".claude/skills/baton/SKILL.md")));
      assert.ok(fs.existsSync(path.join(home, ".baton", "config.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".grok")));
      assert.ok(!fs.existsSync(path.join(home, ".codex")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));
      assert.ok(!fs.existsSync(path.join(cwd, ".grok")));
      assert.ok(!fs.existsSync(path.join(cwd, ".codex")));
      assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.md")));
    });
  });

  it("honors --tools and does not clobber without --force", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { tools: ["claude"], env });
      assert.ok(fs.existsSync(path.join(cwd, ".claude/skills/baton/SKILL.md")));
      assert.ok(!fs.existsSync(path.join(cwd, ".cursor/skills/baton/SKILL.md")));
      assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.md")));

      fs.writeFileSync(path.join(cwd, ".claude/skills/baton/SKILL.md"), "USER\n");
      const again = await initProject(cwd, { tools: ["claude"], env });
      assert.equal(fs.readFileSync(path.join(cwd, ".claude/skills/baton/SKILL.md"), "utf8"), "USER\n");
      assert.ok(again.skipped.some((f) => f.includes(".claude")));

      await initProject(cwd, { force: true, tools: ["claude"], env });
      assert.match(fs.readFileSync(path.join(cwd, ".claude/skills/baton/SKILL.md"), "utf8"), /You are the director/);
    });
  });

  it("appends a baton pointer to an existing AGENTS.md without rewriting it", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Mine\n\nKeep this.\n");
      await initProject(cwd, { tools: ["cursor"], env });
      const text = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
      assert.match(text, /# Mine/);
      assert.match(text, /Keep this/);
      assert.match(text, /<!-- baton -->/);
    });
  });
});

describe("updateProject", () => {
  it("migrates legacy generated benchmark cards into aliases and preserves custom cards", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { tools: ["codex"], env });
      fs.writeFileSync(path.join(home, ".baton", "config.toml"), `[director]
max_concurrent = 4
max_depth = 1

[[models]]
id = "mimo-v2.5"
strengths = "AA Terminal-Bench v2.1 legacy"

[[models]]
id = "k3"
route_id = "kimi/k3[1m]"
reasoning_effort = "max"
strengths = "AA Terminal-Bench v2.1 legacy"

[[models]]
id = "my-reviewer"
route_id = "xai/grok-4.6"
strengths = "my custom review policy"
`);
      updateProject(cwd, { env });
      const cfg = loadConfig(cwd, { env });
      assert.equal(cfg.models.some((card) => card.id === "mimo-v2.5"), false);
      assert.equal(cfg.models.find((card) => card.id === "k3")?.strengths, "large-context complex repository work");
      assert.equal(cfg.models.find((card) => card.id === "my-reviewer")?.strengths, "my custom review policy");
    });
  });

  it("fills missing builtin routes without overwriting user card values", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { tools: ["codex"], env });
      const cfgPath = path.join(home, ".baton", "config.toml");
      const old = fs.readFileSync(cfgPath, "utf8").replace(/\nroute_id = "kimi\/k3\[1m\]"\nreasoning_effort = "max"/, "");
      fs.writeFileSync(cfgPath, old);
      updateProject(cwd, { env });
      const cfg = loadConfig(cwd, { env });
      assert.equal(cfg.models.find((card) => card.id === "k3")?.route_id, "kimi/k3[1m]");
      assert.equal(cfg.models.find((card) => card.id === "k3")?.reasoning_effort, "max");
    });
  });

  it("refreshes SKILL and director defaults but never clobbers user cards", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { tools: ["grok"], env });
      const cfgPath = path.join(home, ".baton", "config.toml");
      fs.writeFileSync(
        cfgPath,
        `[director]\nmax_concurrent = 2\nmax_depth = 1\n\n[[models]]\nid = "opus"\nstrengths = "hard reasoning"\n`,
      );
      fs.writeFileSync(path.join(home, ".grok/skills/baton/SKILL.md"), "OLD\n");
      const result = updateProject(cwd, { env });
      const cfg = loadConfig(cwd, { env });
      assert.equal(cfg.models.length, 1);
      assert.equal(cfg.models[0].id, "opus");
      assert.equal(cfg.director.max_concurrent, 2);
      assert.match(fs.readFileSync(path.join(home, ".baton", "SKILL.md"), "utf8"), /You are the director/);
      assert.match(fs.readFileSync(path.join(home, ".grok/skills/baton/SKILL.md"), "utf8"), /You are the director/);
      assert.ok(result.actions.some((a) => /cards kept/.test(a)));
      assert.ok(!fs.existsSync(path.join(cwd, ".claude/skills/baton/SKILL.md")));
      assertNoProjectHostDirs(cwd);
    });
  });
});
