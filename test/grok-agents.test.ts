import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { addCard } from "../src/commands/cards.js";
import { loadConfig } from "../src/lib/config.js";
import { withHome, fakeEnv } from "./home.js";

const DEFAULT_IDS = [
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "k3",
  "k3-256k",
];

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-"));
}

function readAgent(home, id) {
  return fs.readFileSync(path.join(home, ".grok", "agents", `${id}.md`), "utf8");
}

describe("Grok card agents", () => {
  it("init with grok writes ~/.grok/agents/<id>.md for the four default aliases", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["grok"], env });
      const cards = loadConfig(cwd, { env }).models;
      assert.deepEqual(cards.map((c) => c.id), DEFAULT_IDS);
      for (const id of DEFAULT_IDS) {
        const text = readAgent(home, id);
        assert.match(text, /^---\n/);
        assert.match(text, new RegExp(`^name: ${id.replace(/[.+]/g, "\\$&")}$`, "m"));
        assert.match(text, new RegExp(`^model: ${id.replace(/[.+]/g, "\\$&")}$`, "m"));
        assert.doesNotMatch(text, /^model: inherit$/m);
      }
      const skill = fs.readFileSync(path.join(home, ".grok", "skills", "baton", "SKILL.md"), "utf8");
      assert.match(skill, /`?subagent_type`?\s*=\s*card id/);
      assert.match(skill, /Never spawn `general-purpose` \/ `explore` \/ `plan`/);
      assert.match(skill, /do not inherit the parent model/i);
      assert.match(skill, /grok -p/);
      assert.ok(!fs.existsSync(path.join(cwd, ".grok")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));
    });
  });

  it("does not write Grok agents when the grok host is not installed", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["claude"], env });
      assert.ok(!fs.existsSync(path.join(home, ".grok")));
      assert.ok(!fs.existsSync(path.join(cwd, ".grok")));
      addCard(cwd, { id: "k3", strengths: "flagship", env });
      assert.ok(!fs.existsSync(path.join(home, ".grok", "agents", "k3.md")));
    });
  });

  it("cards add refreshes the Grok agent for that id when the grok skill is installed", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["grok"], env });
      addCard(cwd, { id: "opus-card", strengths: "hard reasoning, long refactors", env });
      const text = readAgent(home, "opus-card");
      assert.match(text, /^name: opus-card$/m);
      assert.match(text, /^model: opus-card$/m);
      addCard(cwd, { id: "opus-card", enabled: false, env });
      assert.ok(!fs.existsSync(path.join(home, ".grok", "agents", "opus-card.md")));
      addCard(cwd, { id: "k3", strengths: "updated k3 strengths", env });
      const k3 = readAgent(home, "k3");
      assert.match(k3, /^model: k3$/m);
      assert.match(k3, /^name: k3$/m);
    });
  });

  it("update refreshes Grok agents from current cards and drops stale baton agents", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["grok"], env });
      fs.writeFileSync(
        path.join(home, ".baton", "config.toml"),
        `[director]\nmax_concurrent = 2\nmax_depth = 1\n\n[[models]]\nid = "opus"\nstrengths = "hard reasoning"\n`,
      );
      updateProject(cwd, { env });
      const opus = readAgent(home, "opus");
      assert.match(opus, /^model: opus$/m);
      assert.ok(!fs.existsSync(path.join(home, ".grok", "agents", "k3.md")));
      assert.ok(!fs.existsSync(path.join(cwd, ".grok")));
    });
  });

  it("does not emit a Grok home agent for grok-* cards", () => {
    withHome((home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      initProject(cwd, { tools: ["grok"], env });
      addCard(cwd, { id: "grok-4.6", strengths: "xai flagship", env });
      addCard(cwd, { id: "grok-build", strengths: "build", env });
      assert.ok(!fs.existsSync(path.join(home, ".grok", "agents", "grok-4.6.md")));
      assert.ok(!fs.existsSync(path.join(home, ".grok", "agents", "grok-build.md")));
      const cfg = fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8");
      assert.match(cfg, /grok-4.6/);
      assert.ok(!fs.existsSync(path.join(home, ".grok", "config.toml")));
    });
  });
});
