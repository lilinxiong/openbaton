import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { addCard } from "../src/commands/cards.js";
import { loadConfig } from "../src/lib/config.js";

const DEFAULT_IDS = [
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "k3",
  "k3-256k",
];

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-"));
}

function readAgent(cwd, id) {
  return fs.readFileSync(path.join(cwd, ".grok", "agents", `${id}.md`), "utf8");
}

describe("Grok card agents", () => {
  it("init with grok writes .grok/agents/<id>.md with model: <id> for the six default cards", () => {
    const cwd = tmp();
    initProject(cwd, { tools: ["grok"] });
    const cards = loadConfig(cwd).models;
    assert.deepEqual(cards.map((c) => c.id), DEFAULT_IDS);
    for (const id of DEFAULT_IDS) {
      const text = readAgent(cwd, id);
      assert.match(text, /^---\n/);
      assert.match(text, new RegExp(`^name: ${id.replace(/[.+]/g, "\\$&")}$`, "m"));
      assert.match(text, new RegExp(`^model: ${id.replace(/[.+]/g, "\\$&")}$`, "m"));
      assert.doesNotMatch(text, /^model: inherit$/m);
    }
    const skill = fs.readFileSync(path.join(cwd, ".grok", "skills", "baton", "SKILL.md"), "utf8");
    assert.match(skill, /`?subagent_type`?\s*=\s*card id/);
    assert.match(skill, /Never spawn `general-purpose` \/ `explore` \/ `plan`/);
    assert.match(skill, /do not inherit the parent model/i);
    assert.match(skill, /grok -p/);
  });

  it("does not write Grok agents when the grok host is not installed", () => {
    const cwd = tmp();
    initProject(cwd, { tools: ["claude"] });
    assert.ok(!fs.existsSync(path.join(cwd, ".grok", "agents")));
    addCard(cwd, { id: "k3", strengths: "flagship" });
    assert.ok(!fs.existsSync(path.join(cwd, ".grok", "agents", "k3.md")));
  });

  it("cards add refreshes the Grok agent for that id when the grok skill is installed", () => {
    const cwd = tmp();
    initProject(cwd, { tools: ["grok"] });
    addCard(cwd, { id: "opus-card", strengths: "hard reasoning, long refactors" });
    const text = readAgent(cwd, "opus-card");
    assert.match(text, /^name: opus-card$/m);
    assert.match(text, /^model: opus-card$/m);
    addCard(cwd, { id: "k3", strengths: "updated k3 strengths" });
    const k3 = readAgent(cwd, "k3");
    assert.match(k3, /^model: k3$/m);
    assert.match(k3, /^name: k3$/m);
  });

  it("update refreshes Grok agents from current cards and drops stale baton agents", () => {
    const cwd = tmp();
    initProject(cwd, { tools: ["grok"] });
    fs.writeFileSync(
      path.join(cwd, ".baton", "config.toml"),
      `[director]\nmax_concurrent = 2\nmax_depth = 1\n\n[[models]]\nid = "opus"\nstrengths = "hard reasoning"\n`,
    );
    updateProject(cwd);
    const opus = readAgent(cwd, "opus");
    assert.match(opus, /^model: opus$/m);
    assert.ok(!fs.existsSync(path.join(cwd, ".grok", "agents", "k3.md")));
  });
});
