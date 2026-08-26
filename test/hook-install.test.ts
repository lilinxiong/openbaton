import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { GUARD_HOSTS } from "../src/commands/guard.js";
import { CLI_ADAPTERS } from "../src/adapters/index.js";
import { codexHooksPath } from "../src/lib/codex-hooks.js";
import { issueGuardClaim } from "../src/lib/guard-claims.js";
import { claudeSettingsPath } from "../src/lib/claude-hooks.js";
import { emptyConfig, saveConfig } from "../src/lib/config.js";
import { runActivation } from "../src/lib/activation.js";
import { projectSettingsPath } from "../src/lib/paths.js";
import { withHome, fakeEnv } from "./home.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

describe("Codex guard CLI", () => {
  function configureEnforce(cwd: string, env: NodeJS.ProcessEnv): void {
    const config = emptyConfig();
    config.cli.codex = {
      enabled: true,
      runner: "test-runner",
      longctx: "test-runner",
      coding_models: [],
      guard_mode: "enforce",
    };
    saveConfig(cwd, config, { env });
  }

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

  it("keeps enforce allow and deny responses as JSON", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-hook-contract-"));
      const env = fakeEnv(home);
      configureEnforce(cwd, env);

      const allowed = capture();
      const allowInput = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        cwd,
      });
      assert.equal(await run(["guard", "hook"], { cwd, env, stdin: allowInput, stdout: allowed, stderr: allowed }), 0);
      const allowResult = JSON.parse(allowed.text());
      assert.equal(allowResult.hookSpecificOutput.permissionDecision, "allow");

      const denied = capture();
      const denyInput = JSON.stringify({ hook_event_name: "PreToolUse", cwd });
      assert.equal(await run(["guard", "hook"], { cwd, env, stdin: denyInput, stdout: denied, stderr: denied }), 0);
      const denyResult = JSON.parse(denied.text());
      assert.equal(denyResult.hookSpecificOutput.permissionDecision, "deny");
    });
  });

  it("emits strict empty stdout for idle activation bypass and guard-off stale hooks", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-hook-bypass-"));
      const env = fakeEnv(home);
      configureEnforce(cwd, env);
      runActivation(["disable", "curproject", "--host", "codex"], { cwd, env, stdout: capture() });
      const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf src" }, cwd });
      const bypass = capture();
      assert.equal(await run(["guard", "hook"], { cwd, env, stdin: input, stdout: bypass, stderr: bypass }), 0);
      assert.equal(bypass.text(), "");

      const offConfig = emptyConfig();
      offConfig.cli.codex = { ...offConfig.cli.codex, enabled: true, guard_mode: "off" };
      saveConfig(cwd, offConfig, { env });
      const stale = capture();
      assert.equal(await run(["guard", "hook"], { cwd, env, stdin: input, stdout: stale, stderr: stale }), 0);
      assert.equal(stale.text(), "");
    });
  });

  it("fails closed with deny JSON when activation is invalid", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-hook-invalid-"));
      const env = fakeEnv(home);
      configureEnforce(cwd, env);
      fs.mkdirSync(path.dirname(projectSettingsPath(cwd, env)), { recursive: true });
      fs.writeFileSync(projectSettingsPath(cwd, env), "[cli.codex]\nenabled = \"yes\"\n", "utf8");
      const out = capture();
      const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, cwd });
      assert.equal(await run(["guard", "hook"], { cwd, env, stdin: input, stdout: out, stderr: out }), 0);
      const result = JSON.parse(out.text());
      assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
    });
  });

  it("exposes a first-class Codex claim control-plane entry", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claim-cli-"));
      const env = fakeEnv(home);
      const issued = issueGuardClaim({ cwd, ticket_id: "spn-cli-claim", attempt: 1, host: "codex", env });
      const out = capture();
      assert.equal(await run([
        "guard", "claim", "--token", issued.token, "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.ok, true);
      assert.equal(result.binding, false);
      assert.equal(await run([
        "guard", "claim", "--token", issued.token, "--turn-id", "turn-cli", "--json",
      ], { cwd, env, stdout: capture(), stderr: capture() }), 1);
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
    assert.match(out.text(), new RegExp(`baton guard status\\|install\\|claim\\|continuation\\|hook \\[--host ${GUARD_HOSTS.join("\\|")}\\]`));
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
