import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { HOST_SKILL_REL } from "../src/lib/hosts.js";
import { emptyConfig, loadConfig } from "../src/lib/config.js";
import { withHome, fakeEnv } from "./home.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-"));
}

describe("Codex-only init/update", () => {
  it("installs only Baton global state and the Codex skill", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      const result = await initProject(cwd, { env });
      assert.equal(result.dir, "~/.baton");
      assert.deepEqual(result.tools, ["codex"]);
      assert.ok(fs.existsSync(path.join(home, ".baton", "config.toml")));
      assert.ok(fs.existsSync(path.join(home, ".baton", "SKILL.md")));
      assert.ok(fs.existsSync(path.join(home, HOST_SKILL_REL.codex)));
      const directorSkill = fs.readFileSync(path.join(home, ".baton", "SKILL.md"), "utf8");
      const hostSkill = fs.readFileSync(path.join(home, HOST_SKILL_REL.codex), "utf8");
      for (const skill of [directorSkill, hostSkill]) {
        assert.match(skill, /^description: .*mechanical ops including build, test, lint, typecheck/m);
        assert.match(skill, /## Entry routing/);
        assert.match(skill, /baton spawn <unchanged-request>/);
        assert.match(skill, /current-conversation inline-only/i);
        assert.match(skill, /Never open.*browser.*file:\/\//i);
      }
      assert.deepEqual(loadConfig(cwd, { env }), emptyConfig());
      for (const dir of [".baton", ".codex", ".claude", ".cursor", ".agents"]) {
        assert.ok(!fs.existsSync(path.join(cwd, dir)), dir);
      }
      assert.ok(!fs.existsSync(path.join(cwd, "AGENTS.md")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton.toml")));
    });
  });

  it("does not clobber the Codex skill without force", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const skill = path.join(home, HOST_SKILL_REL.codex);
      fs.writeFileSync(skill, "USER\n");
      const kept = await initProject(cwd, { env });
      assert.equal(fs.readFileSync(skill, "utf8"), "USER\n");
      assert.ok(kept.skipped.some((item) => item.includes(".codex")));
      await initProject(cwd, { env, force: true });
      assert.match(fs.readFileSync(skill, "utf8"), /Baton supports Codex only/);
      assert.match(fs.readFileSync(skill, "utf8"), /current-conversation inline-only/i);
    });
  });

  it("update removes legacy local model tables and refreshes Codex policy", async () => {
    await withHome(async (home) => {
      const cwd = tmp();
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const config = path.join(home, ".baton", "config.toml");
      fs.writeFileSync(config, `[director]\nmax_concurrent = 2\nmax_depth = 1\n\n[ops.runner]\nroute = "mimo/mimo-v2.5-pro"\nactions = ["test", "build", "lint", "typecheck"]\n\n[ops.longctx]\nroute = ""\nmin_context_tokens = 1048576\nactions = ["search", "digest", "git-summarize", "git-commit"]\n\n[[models]]\nid = "legacy"\nroute_id = "provider/model"\nstrengths = "legacy alias"\n`);
      const skill = path.join(home, HOST_SKILL_REL.codex);
      fs.writeFileSync(skill, "OLD\n");
      const result = updateProject(cwd, { env });
      assert.deepEqual(loadConfig(cwd, { env }), {
        director: { max_concurrent: 2, max_depth: 1 },
        ops: {
          runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
          longctx: {
            route: "",
            min_context_tokens: 1048576,
            actions: ["search", "digest", "git-summarize", "git-commit"],
          },
        },
      });
      assert.doesNotMatch(fs.readFileSync(config, "utf8"), /\[\[models\]\]|legacy|route_id/);
      assert.match(fs.readFileSync(skill, "utf8"), /Baton supports Codex only/);
      assert.ok(result.actions.some((item) => /all routes come from OpenCodex/.test(item)));
    });
  });
});
