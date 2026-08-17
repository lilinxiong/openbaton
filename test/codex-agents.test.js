import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { addCard } from "../src/commands/cards.js";
import { withHome, fakeEnv } from "./home.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-codex-"));
}

describe("Codex card agents", () => {
  it("init with codex writes ~/.codex/agents/<id>.toml with model = card id", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["codex"], env });
      const k3 = fs.readFileSync(path.join(home, ".codex", "agents", "k3.toml"), "utf8");
      assert.match(k3, /name = "k3"/);
      assert.match(k3, /model = "k3"/);
      assert.match(k3, /# baton-card/);
      const skill = fs.readFileSync(path.join(home, ".codex", "skills", "baton", "SKILL.md"), "utf8");
      assert.match(skill, /agent_type/);
      assert.match(skill, /fork_turns/);
      assert.match(skill, /default/);
      assert.match(skill, /agents\.default_subagent_model/);
      assert.ok(!fs.existsSync(path.join(cwd, ".codex")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));
    });
  });

  it("cards add writes a home Codex agent when the skill is installed", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["codex"], env });
      addCard(cwd, { id: "opus-card", strengths: "hard reasoning", env });
      const text = fs.readFileSync(path.join(home, ".codex", "agents", "opus-card.toml"), "utf8");
      assert.match(text, /name = "opus-card"/);
      assert.match(text, /model = "opus-card"/);
    });
  });

  it("update prunes stale baton-marked Codex home agents", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["codex"], env });
      fs.writeFileSync(
        path.join(home, ".baton", "config.toml"),
        `[director]\nmax_concurrent = 2\nmax_depth = 1\n\n[[models]]\nid = "opus"\nstrengths = "hard reasoning"\n`,
      );
      updateProject(cwd, { env });
      const opus = fs.readFileSync(path.join(home, ".codex", "agents", "opus.toml"), "utf8");
      assert.match(opus, /model = "opus"/);
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "k3.toml")));
    });
  });

  it("does not emit a Codex home agent for ChatGPT native cards", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["codex"], env });
      addCard(cwd, { id: "gpt-5", strengths: "openai flagship", env });
      addCard(cwd, { id: "o3-mini", strengths: "reasoning", env });
      addCard(cwd, { id: "chatgpt", strengths: "chat", env });
      addCard(cwd, { id: "codex-mini", strengths: "mini", env });
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "gpt-5.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "o3-mini.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "chatgpt.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "codex-mini.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "config.toml")));
    });
  });
});
