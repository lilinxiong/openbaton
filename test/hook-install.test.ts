import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { codexHooksPath } from "../src/lib/codex-hooks.js";
import { claudeSettingsPath } from "../src/lib/claude-hooks.js";
import { withHome, fakeEnv } from "./home.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

describe("Codex guard CLI", () => {
  it("reports the required trust step and installs without replacing user hooks", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-cli-"));
      const env = fakeEnv(home);
      const first = capture();
      assert.equal(await run(["guard", "install", "--json"], { cwd, env, stdout: first, stderr: first }), 0, first.text());
      const status = JSON.parse(first.text());
      assert.equal(status.installed, true);
      assert.equal(status.trust_command, "/hooks");
      assert.equal(status.specialized_tool_paths_may_opt_out, true);
      assert.equal(fs.existsSync(codexHooksPath({ env })), true);

      const out = capture();
      assert.equal(await run(["guard", "status"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      assert.match(out.text(), /\/hooks/);
      assert.match(out.text(), /specialized tool paths may opt out/i);
    });
  });

  it("serves official PreToolUse JSON from injected stdin", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-hook-"));
      const env = fakeEnv(home);
      const out = capture();
      const input = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        cwd,
      });
      assert.equal(await run(["guard", "hook"], { cwd, env, stdin: input, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(result.hookSpecificOutput.permissionDecisionReason, "BATON_GUARD_NOT_INITIALIZED");
    });
  });
});

describe("Claude Code guard CLI", () => {
  it("installs into user settings and reports that no trust prompt is required", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-guard-cli-"));
      const env = fakeEnv(home);
      const first = capture();
      assert.equal(await run(["guard", "install", "--host", "claude", "--json"], { cwd, env, stdout: first, stderr: first }), 0, first.text());
      const status = JSON.parse(first.text());
      assert.equal(status.installed, true);
      assert.equal(status.trust_required, false);
      assert.equal(status.subagent_start_cannot_cancel, true);
      assert.match(status.command, /guard hook --host claude/);
      assert.equal(fs.existsSync(claudeSettingsPath({ env })), true);
      // Installing the Claude guard must not create the Codex hooks file.
      assert.equal(fs.existsSync(codexHooksPath({ env })), false);

      const out = capture();
      assert.equal(await run(["guard", "status", "--host", "claude"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      assert.match(out.text(), /Claude Code Baton guard/);
      assert.match(out.text(), /trust: not required/);
      assert.match(out.text(), /SubagentStart cannot cancel a child/);
    });
  });

  it("serves the Claude hook payload and rejects an unsupported guard host", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-guard-hook-"));
      const env = fakeEnv(home);
      const out = capture();
      const input = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { prompt: "run a ticket" },
        cwd,
      });
      assert.equal(await run(["guard", "hook", "--host", "claude"], { cwd, env, stdin: input, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(result.hookSpecificOutput.permissionDecisionReason, "BATON_GUARD_NOT_INITIALIZED");

      // Grok has no hook surface, so it is not a valid guard host.
      const bad = capture();
      assert.equal(await run(["guard", "status", "--host", "grok"], { cwd, env, stdout: bad, stderr: bad }), 1);
      assert.match(bad.text(), /invalid guard host/);
    });
  });
});
