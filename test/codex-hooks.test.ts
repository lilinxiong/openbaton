import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BATON_CODEX_HOOK_COMMAND,
  BATON_CODEX_PRETOOLUSE_MATCHER,
  batonCodexHookEntries,
  codexHooksPath,
  codexHooksStatus,
  installCodexHooks,
  mergeBatonCodexHooks,
  resolveCodexHookCommand,
} from "../src/lib/codex-hooks.js";
import { fakeEnv, withHome } from "./home.js";
import { recordHookObservation } from "../src/lib/hook-observation.js";

describe("Codex Baton hook manifest", () => {
  it("merges the guard while preserving unrelated user hooks and is idempotent", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-"));
      const env = fakeEnv(home);
      const codexHome = path.join(home, ".codex");
      fs.mkdirSync(codexHome, { recursive: true });
      const file = path.join(codexHome, "hooks.json");
      const unrelated = {
        description: "keep me",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "custom-stop" }] }],
          PreToolUse: [{ matcher: "MCP", hooks: [
            { type: "command", command: "custom-mcp" },
            { type: "command", command: "echo baton guard hook" },
          ] }],
        },
      };
      fs.writeFileSync(file, `${JSON.stringify(unrelated, null, 2)}\n`);

      const first = installCodexHooks({ cwd, env, command: BATON_CODEX_HOOK_COMMAND });
      assert.equal(first.changed, true);
      assert.equal(first.installed, true);
      assert.equal(first.guard_mode, "enforce");
      assert.equal(first.core_dispatch_ready, "unknown");
      assert.equal(first.recent_hook_observation, false);
      assert.deepEqual(first.events, ["PreToolUse"]);
      const merged = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(merged.description, "keep me");
      assert.equal(merged.hooks.Stop[0].hooks[0].command, "custom-stop");
      assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, "custom-mcp");
      assert.equal(merged.hooks.PreToolUse[0].hooks[1].command, "echo baton guard hook");
      assert.equal(merged.hooks.PreToolUse.at(-1).hooks[0].command, BATON_CODEX_HOOK_COMMAND);
      assert.equal(merged.hooks.PreToolUse.at(-1).matcher, BATON_CODEX_PRETOOLUSE_MATCHER);

      const second = installCodexHooks({ cwd, env, command: BATON_CODEX_HOOK_COMMAND });
      assert.equal(second.changed, false);
      assert.equal(second.action, "kept");
      assert.equal(codexHooksStatus({ cwd, env }).baton_entries, 1);
    });
  });

  it("replaces only stale Baton entries and retains unrelated top-level fields", () => {
    const result = mergeBatonCodexHooks({
      plugin: { enabled: true },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [
            { type: "command", command: "baton guard hook" },
            { type: "command", command: "keep-in-same-group" },
          ] },
          { matcher: "MCP", hooks: [{ type: "command", command: "keep" }] },
        ],
        SubagentStart: [{ hooks: [{ type: "command", command: "baton guard hook", timeout: 1 }] }],
      },
    });
    assert.deepEqual(result.plugin, { enabled: true });
    assert.equal((result.hooks!.PreToolUse as unknown[]).length, 3);
    assert.equal(result.hooks!.SubagentStart, undefined);
    const preToolUse = result.hooks!.PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
    assert.equal(preToolUse[0].hooks[0].command, "keep-in-same-group");
    assert.equal(preToolUse[2].hooks[0].command, BATON_CODEX_HOOK_COMMAND);
  });

  it("matches only the scoped mutation tools and never native child spawn", () => {
    for (const tool of ["Bash", "apply_patch", "Edit", "Write"]) {
      assert.match(tool, new RegExp(BATON_CODEX_PRETOOLUSE_MATCHER));
    }
    for (const tool of ["Agent", "spawn_agent", "functions.collaboration.spawn_agent"]) {
      assert.doesNotMatch(tool, new RegExp(BATON_CODEX_PRETOOLUSE_MATCHER));
    }
  });

  it("removes all Baton entries and leaves zero Codex hooks in guard-off mode", () => {
    const result = mergeBatonCodexHooks({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: BATON_CODEX_HOOK_COMMAND }] }],
        SubagentStart: [{ matcher: ".*", hooks: [{ type: "command", command: BATON_CODEX_HOOK_COMMAND }] }],
      },
    }, BATON_CODEX_HOOK_COMMAND, "off");
    assert.equal(result.hooks!.PreToolUse, undefined);
    assert.equal(result.hooks!.SubagentStart, undefined);
  });

  it("makes guard-off an explicit audit-only zero-hook posture", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-off-"));
    const env = { HOME: fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-off-home-")), PATH: "" };
    const result = installCodexHooks({ cwd, env, guardMode: "off" });
    assert.equal(result.guard_mode, "off");
    assert.equal(result.audit_only, true);
    assert.equal(result.trust_required, false);
    assert.equal(result.operational, true);
    assert.equal(result.hook_configured, false);
    assert.equal(result.coverage, "none");
    assert.equal(result.recent_hook_observation, false);
    assert.equal(fs.existsSync(codexHooksPath({ env })), false);
  });

  it("reports a missing enforced hook as an explicit operational error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-missing-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-missing-cwd-"));
    const status = codexHooksStatus({ cwd, env: { HOME: home, PATH: "" }, guardMode: "enforce" });
    assert.equal(status.hook_configured, false);
    assert.equal(status.operational, false);
    assert.match(status.operational_error || "", /not configured/);
  });

  it("removes a Baton-only file on off and preserves mixed user content", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-off-inverse-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-off-inverse-home-"));
    const env = { HOME: home, PATH: "" };
    const file = codexHooksPath({ cwd, env });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks: batonCodexHookEntries("baton guard hook") }));
    assert.equal(installCodexHooks({ cwd, env, guardMode: "off" }).changed, true);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, JSON.stringify({ description: "keep", hooks: batonCodexHookEntries("baton guard hook") }));
    installCodexHooks({ cwd, env, guardMode: "off" });
    const retained = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(retained.description, "keep");
    assert.deepEqual(retained.hooks, {});
  });

  it("fails closed instead of overwriting malformed user hook JSON", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-invalid-"));
      const env = fakeEnv(home);
      const file = path.join(home, ".codex", "hooks.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{not-json");
      assert.throws(() => installCodexHooks({ cwd, env }), /CODEX_HOOKS_INVALID_JSON/);
      assert.equal(fs.readFileSync(file, "utf8"), "{not-json");
    });
  });

  it("requires a usable injected command and resolves an executable path deterministically", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-command-"));
      const env = { ...fakeEnv(home), PATH: "" };
      assert.throws(
        () => installCodexHooks({ cwd, env, command: "missing-baton guard hook" }),
        /CODEX_HOOK_COMMAND_UNAVAILABLE/,
      );
      const commandPath = path.join(cwd, "baton");
      fs.writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(commandPath, 0o755);
      assert.equal(resolveCodexHookCommand({ cwd, env, executablePath: commandPath }), commandPath + " guard hook");
      const result = installCodexHooks({ cwd, env, executablePath: commandPath });
      assert.equal(result.installed, true);
      const merged = JSON.parse(fs.readFileSync(codexHooksPath({ env }), "utf8"));
      assert.equal(merged.hooks.PreToolUse.at(-1).hooks[0].command, commandPath + " guard hook");
    });
  });

  it("prefers an explicit current runtime and entry over a stale PATH target", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-current-"));
    const runtime = path.join(cwd, "runtime");
    const entry = path.join(cwd, "bin", "baton.ts");
    const staleDir = path.join(cwd, "stale");
    const stale = path.join(staleDir, "baton");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(runtime, 0o755);
    fs.writeFileSync(entry, "export {}\n");
    fs.writeFileSync(stale, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(stale, 0o755);
    const env = { PATH: staleDir };
    assert.equal(
      resolveCodexHookCommand({ cwd, env, runtimePath: runtime, entryPath: entry }),
      runtime + " " + entry + " guard hook",
    );
    assert.throws(
      () => resolveCodexHookCommand({ cwd, env, runtimePath: path.join(cwd, "missing-runtime"), entryPath: entry }),
      /runtime path is not usable/,
    );
    assert.throws(
      () => resolveCodexHookCommand({ cwd, env, runtimePath: runtime, entryPath: path.join(cwd, "missing-entry") }),
      /entry path is not usable/,
    );
    const resolvedCurrent = resolveCodexHookCommand({ cwd, env });
    assert.doesNotMatch(resolvedCurrent, /stale/);
    assert.match(resolvedCurrent, /baton\.(?:ts|js) guard hook$/);
  });

  it("reports configured stale hooks as non-operational", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-status-"));
    const env = { HOME: home, PATH: "" };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-status-cwd-"));
    const file = codexHooksPath({ env });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/tmp/stale/baton guard hook" }] }],
      },
    }, null, 2) + "\n");
    const status = codexHooksStatus({ cwd, env });
    assert.equal(status.configured, true);
    assert.equal(status.installed, true);
    assert.equal(status.operational, false);
    assert.equal(status.command_usable, false);
    assert.match(status.operational_error || "", /not usable/);
  });

  it("reports the last real hook observation when workspace context is available", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-observed-home-"));
    const env = { HOME: home, PATH: "" };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hooks-observed-cwd-"));
    recordHookObservation(cwd, "codex", "PreToolUse", new Date(), env);
    const status = codexHooksStatus({ cwd, env });
    assert.equal(status.recent_hook_observation, true);
    assert.ok(status.last_observed_at);
  });
});
