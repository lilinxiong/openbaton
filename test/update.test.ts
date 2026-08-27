import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { legacyHookPath } from "../src/lib/legacy-hook-cleanup.js";
import { fakeEnv, withHome } from "./home.js";

describe("Baton update director integration", () => {
  it("refreshes the active director skill without installing hooks", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-update-skill-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const installed = path.join(home, ".baton", "SKILL.md");
      fs.writeFileSync(installed, "stale skill\n", "utf8");

      const result = updateProject(cwd, { env });
      assert.ok(result.actions.some((item) => item.includes("updated ~/.baton/SKILL.md")));
      assert.equal(fs.readFileSync(installed, "utf8"), fs.readFileSync(path.join(process.cwd(), "SKILL.md"), "utf8"));
      assert.equal(fs.existsSync(path.join(home, ".codex", "hooks.json")), false);
      assert.equal(fs.existsSync(path.join(home, ".grok", "hooks", "baton.json")), false);
      assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
    });
  });

  it("removes the empty legacy hooks container while preserving host settings", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-update-hooks-"));
      const env = fakeEnv(home);
      const hookFile = legacyHookPath("codex", env);
      fs.mkdirSync(path.dirname(hookFile), { recursive: true });
      fs.writeFileSync(hookFile, JSON.stringify({
        permissions: { allow: ["Bash"], deny: [] },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "baton guard hook --host codex" }] }],
        },
      }, null, 2) + "\n");

      const result = updateProject(cwd, { env });
      assert.ok(result.actions.some((item) => item.includes("codex legacy hook cleanup: updated")));
      assert.deepEqual(JSON.parse(fs.readFileSync(hookFile, "utf8")), {
        permissions: { allow: ["Bash"], deny: [] },
      });
    });
  });
});
