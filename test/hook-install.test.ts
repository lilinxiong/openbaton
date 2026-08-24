import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { GUARD_HOSTS } from "../src/commands/guard.js";
import { CLI_ADAPTERS } from "../src/adapters/index.js";
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
        tool_input: { command: "bun test" },
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

      const missing = capture();
      assert.equal(await run(["guard", "status", "--host", "cursor"], { cwd, env, stdout: missing, stderr: missing }), 1);
      assert.match(missing.text(), /invalid guard host/);
    });
  });

  it("lists guard hosts from the adapter registry in usage", async () => {
    assert.deepEqual(
      GUARD_HOSTS,
      CLI_ADAPTERS.filter((adapter) => adapter.host.guard).map((adapter) => adapter.host.id),
    );
    const out = capture();
    assert.equal(await run(["help"], { stdout: out, stderr: out }), 0);
    assert.match(out.text(), new RegExp(`baton guard status\\|install\\|hook \\[--host ${GUARD_HOSTS.join("\\|")}\\]`));
  });
});

describe("Grok guard CLI", () => {
  it("installs a dedicated global hook file without a trust prompt", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-guard-cli-"));
      const env = fakeEnv(home);
      const first = capture();
      assert.equal(await run(["guard", "install", "--host", "grok", "--json"], { cwd, env, stdout: first, stderr: first }), 0, first.text());
      const status = JSON.parse(first.text());
      assert.equal(status.installed, true);
      assert.equal(status.trust_required, false);
      assert.match(status.command, /guard hook --host grok/);
      assert.equal(fs.existsSync(path.join(home, ".grok", "hooks", "baton.json")), true);
      assert.equal(fs.existsSync(codexHooksPath({ env })), false);
    });
  });

  it("does not block ordinary Grok edits before Baton init and allows standalone baton apply", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-guard-hook-"));
      const env = fakeEnv(home);
      const edit = capture();
      const input = JSON.stringify({
        hookEventName: "pre_tool_use",
        toolName: "search_replace",
        toolInput: { old_string: "a", new_string: "b" },
        cwd,
      });
      assert.equal(await run(["guard", "hook", "--host", "grok"], { cwd, env, stdin: input, stdout: edit, stderr: edit }), 0, edit.text());
      const result = JSON.parse(edit.text());
      assert.equal(result.decision, "allow");
      assert.equal(result.hookSpecificOutput.permissionDecision, "allow");

      const allowed = capture();
      const apply = JSON.stringify({
        hookEventName: "pre_tool_use",
        toolName: "run_terminal_command",
        toolInput: { command: "baton apply remove-cli-active --host grok --dispatch --json" },
        cwd,
      });
      assert.equal(await run(["guard", "hook", "--host", "grok"], { cwd, env, stdin: apply, stdout: allowed, stderr: allowed }), 0, allowed.text());
      const applyResult = JSON.parse(allowed.text());
      assert.equal(applyResult.decision, "allow");
    });
  });
});
