import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { codexHooksPath } from "../src/lib/codex-hooks.js";
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
});
