import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BATON_CLAUDE_PRETOOLUSE_MATCHER,
  batonClaudeHookEntries,
  claudeHooksStatus,
  claudeSettingsPath,
  installClaudeHooks,
  isBatonClaudeHookHandler,
  mergeBatonClaudeHooks,
  removeBatonClaudeHooks,
  resolveClaudeHookCommand,
} from "../src/lib/claude-hooks.js";
import { withHome, fakeEnv } from "./home.js";

const COMMAND = "/usr/local/bin/baton guard hook --host claude";

/** A real executable named `baton`, so command validation has something usable. */
function fakeBaton(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-fake-bin-"));
  const file = path.join(dir, "baton");
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

function handlerAt(value: unknown, event: string, index: number): Record<string, unknown> {
  const groups = (value as Record<string, Record<string, unknown[]>>).hooks[event];
  const group = groups[index] as Record<string, unknown>;
  return (group.hooks as Array<Record<string, unknown>>)[0];
}

describe("Claude Code hook settings path", () => {
  it("honors CLAUDE_CONFIG_DIR and an explicit override", () => {
    assert.equal(
      claudeSettingsPath({ env: { HOME: "/home/user" } }),
      path.join("/home/user", ".claude", "settings.json"),
    );
    assert.equal(
      claudeSettingsPath({ env: { HOME: "/home/user", CLAUDE_CONFIG_DIR: "/custom/claude" } }),
      path.join("/custom/claude", "settings.json"),
    );
    assert.equal(claudeSettingsPath({ settingsPath: "/tmp/other.json" }), "/tmp/other.json");
  });
});

describe("Claude Code hook command resolution", () => {
  it("rejects shell composition and unusable executables", () => {
    assert.throws(
      () => resolveClaudeHookCommand({ command: "baton guard hook --host claude; rm -rf /", env: {} }),
      /CLAUDE_HOOK_COMMAND_UNAVAILABLE/,
    );
    assert.throws(
      () => resolveClaudeHookCommand({ command: "/definitely/not/here/baton guard hook --host claude", env: {} }),
      /CLAUDE_HOOK_COMMAND_UNAVAILABLE/,
    );
  });

  it("accepts an explicitly injected usable command", () => {
    const baton = fakeBaton();
    assert.equal(
      resolveClaudeHookCommand({ command: `${baton} guard hook --host claude`, env: {} }),
      `${baton} guard hook --host claude`,
    );
  });
});

describe("Claude Code hook entry matching", () => {
  it("matches only Baton claude-host commands", () => {
    assert.equal(isBatonClaudeHookHandler({ type: "command", command: COMMAND }), true);
    assert.equal(isBatonClaudeHookHandler({ type: "command", command: "baton guard hook --host claude" }), true);
    // A Codex-scoped Baton hook belongs to the other guard, not this one.
    assert.equal(isBatonClaudeHookHandler({ type: "command", command: "baton guard hook" }), false);
    // An unrelated user script that merely mentions baton is retained.
    assert.equal(isBatonClaudeHookHandler({ type: "command", command: "/usr/bin/my-baton-audit.sh" }), false);
    assert.equal(isBatonClaudeHookHandler({ type: "command", command: "echo baton guard hook --host claude" }), false);
    assert.equal(isBatonClaudeHookHandler({ type: "other", command: COMMAND }), false);
  });

  it("declares the matcher for the tool names the hook boundary reports", () => {
    const entries = batonClaudeHookEntries(COMMAND);
    assert.equal(entries.PreToolUse[0].matcher, BATON_CLAUDE_PRETOOLUSE_MATCHER);
    // The native child-agent call surfaces as `Agent` at the hook boundary.
    assert.match(BATON_CLAUDE_PRETOOLUSE_MATCHER, /\bAgent\b/);
    assert.match(BATON_CLAUDE_PRETOOLUSE_MATCHER, /\bNotebookEdit\b/);
    assert.equal(entries.SubagentStart[0].matcher, "");
  });
});

describe("Claude Code hook merge", () => {
  it("preserves unrelated settings, hooks, and events", () => {
    const merged = mergeBatonClaudeHooks({
      env: { EXAMPLE: "1" },
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo mine" }] }],
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo after" }] }],
      },
    }, COMMAND);
    assert.deepEqual((merged as Record<string, unknown>).env, { EXAMPLE: "1" });
    assert.deepEqual((merged as Record<string, unknown>).permissions, { allow: ["Bash(git status)"] });
    assert.equal(handlerAt(merged, "PostToolUse", 0).command, "echo after");
    assert.equal(handlerAt(merged, "PreToolUse", 0).command, "echo mine");
    assert.equal(handlerAt(merged, "PreToolUse", 1).command, COMMAND);
  });

  it("replaces its own entry in place so repeated merges are idempotent", () => {
    const once = mergeBatonClaudeHooks({}, COMMAND);
    const twice = mergeBatonClaudeHooks(once, COMMAND);
    assert.deepEqual(twice, once);
    // A stale Baton command is replaced, not duplicated.
    const stale = mergeBatonClaudeHooks({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/old/baton guard hook --host claude" }] }] },
    }, COMMAND);
    const pre = (stale.hooks as Record<string, unknown[]>).PreToolUse;
    assert.equal(pre.length, 1);
    assert.equal(handlerAt(stale, "PreToolUse", 0).command, COMMAND);
  });

  it("keeps an unrelated handler that shares a group with a Baton handler", () => {
    const merged = mergeBatonClaudeHooks({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [
            { type: "command", command: "/old/baton guard hook --host claude" },
            { type: "command", command: "echo keep-me" },
          ],
        }],
      },
    }, COMMAND);
    const pre = (merged.hooks as Record<string, unknown[]>).PreToolUse;
    assert.equal(pre.length, 2);
    assert.equal(handlerAt(merged, "PreToolUse", 0).command, "echo keep-me");
    assert.equal(handlerAt(merged, "PreToolUse", 1).command, COMMAND);
  });

  it("fails closed on a malformed hooks event", () => {
    assert.throws(
      () => mergeBatonClaudeHooks({ hooks: { PreToolUse: "not-an-array" } }, COMMAND),
      /CLAUDE_SETTINGS_INVALID_EVENT/,
    );
  });

  it("removes current and legacy Baton handlers while retaining mixed groups", () => {
    const removed = removeBatonClaudeHooks({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [
          { type: "command", command: COMMAND },
          { type: "command", command: "echo keep" },
        ] }],
        SubagentStart: [{ matcher: "", hooks: [{ type: "command", command: COMMAND }] }],
      },
      permissions: { allow: ["Bash(git status)"] },
    });
    assert.deepEqual((removed as Record<string, unknown>).permissions, { allow: ["Bash(git status)"] });
    assert.equal((removed.hooks as Record<string, unknown>).SubagentStart, undefined);
    assert.equal(handlerAt(removed, "PreToolUse", 0).command, "echo keep");
  });
});

describe("Claude Code hook install", () => {
  it("reports installed, updated, and kept without rewriting an unchanged file", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-hooks-"));
      const env = fakeEnv(home);
      const command = `${fakeBaton()} guard hook --host claude`;
      const first = installClaudeHooks({ cwd, env, command });
      assert.equal(first.action, "installed");
      assert.equal(first.changed, true);
      assert.equal(first.installed, true);
      assert.deepEqual(first.events, ["PreToolUse", "SubagentStart"]);

      const second = installClaudeHooks({ cwd, env, command });
      assert.equal(second.action, "kept");
      assert.equal(second.changed, false);

      const status = claudeHooksStatus({ cwd, env });
      assert.equal(status.configured, true);
      assert.equal(status.operational, true);
      assert.equal(status.operational_error, null);
      assert.equal(status.trust_required, false);
    });
  });

  it("flags a configured but unusable hook command instead of claiming protection", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-hooks-broken-"));
      const env = fakeEnv(home);
      const file = claudeSettingsPath({ env });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: BATON_CLAUDE_PRETOOLUSE_MATCHER,
            hooks: [{ type: "command", command: "/definitely/not/here/baton guard hook --host claude" }],
          }],
        },
      }, null, 2)}\n`);
      const status = claudeHooksStatus({ cwd, env });
      assert.equal(status.configured, true);
      assert.equal(status.operational, false);
      assert.match(status.operational_error || "", /not usable/);
    });
  });

  it("refuses to guess when the settings file is not valid JSON", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-hooks-bad-"));
      const env = fakeEnv(home);
      const file = claudeSettingsPath({ env });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{ not json\n");
      assert.throws(() => claudeHooksStatus({ cwd, env }), /CLAUDE_SETTINGS_INVALID_JSON/);
    });
  });
});
