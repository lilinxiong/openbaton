import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { addCard } from "../src/commands/cards.js";
import { withHome, fakeEnv } from "./home.js";
import { isCodexSpawnableCard, isChatGptNativeModel, BATON_CARD_MARK } from "../src/lib/codex-agents.js";

const DEFAULT_IDS = [
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "k3",
  "k3-256k",
];

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-codex-"));
}

describe("Codex card agents", () => {
  it("init with codex writes ~/.baton + skill, not ~/.codex/agents card files", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["codex"], env });
      assert.ok(fs.existsSync(path.join(home, ".baton", "config.toml")));
      const skill = fs.readFileSync(path.join(home, ".codex", "skills", "baton", "SKILL.md"), "utf8");
      assert.match(skill, /director-only/i);
      assert.match(skill, /spawn `k3`/);
      assert.match(skill, /not inherit/i);
      assert.match(skill, /No match on this host → blocked/);
      assert.match(skill, /agents\.default_subagent_model/);
      assert.doesNotMatch(skill, /spawn with `agent_type` = card id/);
      for (const id of DEFAULT_IDS) {
        assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", `${id}.toml`)), id);
      }
      assert.ok(!fs.existsSync(path.join(cwd, ".codex")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));
    });
  });

  it("cards add does not write a Codex agent for non-native cards", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["codex"], env });
      addCard(cwd, { id: "opus-card", strengths: "hard reasoning", env });
      addCard(cwd, { id: "k3", strengths: "flagship", env });
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "opus-card.toml")));
      assert.ok(!fs.existsSync(path.join(home, ".codex", "agents", "k3.toml")));
    });
  });

  it("update prunes stale baton-marked Codex home agents", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["codex"], env });
      const agentsDir = path.join(home, ".codex", "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, "k3.toml"),
        `${BATON_CARD_MARK}\nname = "k3"\nmodel = "k3"\n`,
      );
      fs.writeFileSync(path.join(agentsDir, "user.toml"), 'name = "user"\nmodel = "gpt-5"\n');
      fs.writeFileSync(
        path.join(home, ".baton", "config.toml"),
        `[director]\nmax_concurrent = 2\nmax_depth = 1\n\n[[models]]\nid = "opus"\nstrengths = "hard reasoning"\n`,
      );
      updateProject(cwd, { env });
      assert.ok(!fs.existsSync(path.join(agentsDir, "k3.toml")));
      assert.ok(!fs.existsSync(path.join(agentsDir, "opus.toml")));
      assert.ok(fs.existsSync(path.join(agentsDir, "user.toml")));
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

  it("isCodexSpawnableCard is false for defaults and ChatGPT-native ids", () => {
    for (const id of DEFAULT_IDS) {
      assert.equal(isCodexSpawnableCard(id), false, id);
    }
    assert.equal(isCodexSpawnableCard("opus-card"), false);
    assert.equal(isChatGptNativeModel("gpt-5"), true);
    assert.equal(isCodexSpawnableCard("gpt-5"), false);
    assert.equal(isCodexSpawnableCard("o3-mini"), false);
    assert.equal(isCodexSpawnableCard("chatgpt"), false);
    assert.equal(isCodexSpawnableCard("codex-mini"), false);
  });
});
