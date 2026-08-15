import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { HOST_SKILL_REL, HOST_IDS } from "../src/lib/hosts.js";
import { loadConfig } from "../src/lib/config.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-"));
}

describe("initProject", () => {
  it("writes .baton/config.toml + SKILL and default host skill paths", () => {
    const cwd = tmp();
    const result = initProject(cwd);
    assert.ok(fs.existsSync(path.join(cwd, ".baton", "config.toml")));
    assert.ok(fs.existsSync(path.join(cwd, ".baton", "SKILL.md")));
    for (const id of HOST_IDS) {
      assert.ok(fs.existsSync(path.join(cwd, HOST_SKILL_REL[id])), id);
    }
    assert.ok(fs.existsSync(path.join(cwd, "AGENTS.md")));
    assert.match(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), /baton/);
    assert.ok(result.created.includes(path.join(".baton", "config.toml")) || result.created.some((f) => f.endsWith("config.toml")));
  });

  it("honors --tools and does not clobber without --force", () => {
    const cwd = tmp();
    initProject(cwd, { tools: ["claude"] });
    assert.ok(fs.existsSync(path.join(cwd, ".claude/skills/baton/SKILL.md")));
    assert.ok(!fs.existsSync(path.join(cwd, ".cursor/skills/baton/SKILL.md")));
    assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.md")));

    fs.writeFileSync(path.join(cwd, ".claude/skills/baton/SKILL.md"), "USER\n");
    const again = initProject(cwd, { tools: ["claude"] });
    assert.equal(fs.readFileSync(path.join(cwd, ".claude/skills/baton/SKILL.md"), "utf8"), "USER\n");
    assert.ok(again.skipped.some((f) => f.includes(".claude")));

    initProject(cwd, { force: true, tools: ["claude"] });
    assert.match(fs.readFileSync(path.join(cwd, ".claude/skills/baton/SKILL.md"), "utf8"), /You are the director/);
  });

  it("appends a baton pointer to an existing AGENTS.md without rewriting it", () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Mine\n\nKeep this.\n");
    initProject(cwd, { tools: ["cursor"] });
    const text = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
    assert.match(text, /# Mine/);
    assert.match(text, /Keep this/);
    assert.match(text, /<!-- baton -->/);
  });
});

describe("updateProject", () => {
  it("refreshes SKILL and director defaults but never clobbers user cards", () => {
    const cwd = tmp();
    initProject(cwd, { tools: ["grok"] });
    const cfgPath = path.join(cwd, ".baton", "config.toml");
    fs.writeFileSync(
      cfgPath,
      `[director]\nmax_concurrent = 2\nmax_depth = 1\n\n[[models]]\nid = "opus"\nstrengths = "hard reasoning"\n`,
    );
    fs.writeFileSync(path.join(cwd, ".grok/skills/baton/SKILL.md"), "OLD\n");
    const result = updateProject(cwd);
    const cfg = loadConfig(cwd);
    assert.equal(cfg.models.length, 1);
    assert.equal(cfg.models[0].id, "opus");
    assert.equal(cfg.director.max_concurrent, 2);
    assert.match(fs.readFileSync(path.join(cwd, ".baton", "SKILL.md"), "utf8"), /You are the director/);
    assert.match(fs.readFileSync(path.join(cwd, ".grok/skills/baton/SKILL.md"), "utf8"), /You are the director/);
    assert.ok(result.actions.some((a) => /cards kept/.test(a)));
    assert.ok(!fs.existsSync(path.join(cwd, ".claude/skills/baton/SKILL.md")));
  });
});
