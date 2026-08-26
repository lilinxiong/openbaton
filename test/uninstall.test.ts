import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runUninstall } from "../src/commands/uninstall.js";
import { batonCodexHookEntries, codexHooksPath } from "../src/lib/codex-hooks.js";
import { batonClaudeHookEntries, claudeSettingsPath } from "../src/lib/claude-hooks.js";
import { batonGrokHookDocument, grokHooksPath } from "../src/lib/grok-hooks.js";
import { buildInstallManifest, installManifestPath, legacyOwnsSkill, readInstallManifest, writeInstallManifest } from "../src/lib/install-manifest.js";
import { buildUninstallPlan, applyUninstallPlan } from "../src/lib/uninstall.js";
import { batonHomeDir, skillPath, spawnsDir } from "../src/lib/paths.js";
import { HOST_IDS, hostSkillDest, skillTemplatePath } from "../src/lib/hosts.js";
import { fakeEnv } from "./home.js";

function copySkill(host: "codex" | "claude" | "grok", cwd: string, env: NodeJS.ProcessEnv): string {
  const destination = hostSkillDest(host, { cwd, env });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(skillTemplatePath(host), destination);
  return destination;
}

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

describe("uninstall plan and ownership", () => {
  it("recognizes only exact canonical skill bytes from recorded releases", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-legacy-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-legacy-cwd-"));
    const fixtures = [
      ["be2b53f", null, "SKILL.md"],
      ["be2b53f", "codex", "templates/hosts/codex/SKILL.md"],
      ["be2b53f", "claude", "templates/hosts/claude/SKILL.md"],
      ["be2b53f", "grok", "templates/hosts/grok/SKILL.md"],
      ["be2b53f", "cursor", "templates/hosts/cursor/SKILL.md"],
      ["f6033b3", "codex", "templates/hosts/codex/SKILL.md"],
    ] as const;
    for (const [commit, host, source] of fixtures) {
      const destination = host ? hostSkillDest(host, { cwd, env }) : skillPath(cwd, { env });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, execFileSync("git", ["show", `${commit}:${source}`], { cwd: process.cwd() }));
      assert.equal(legacyOwnsSkill(host, destination, cwd, env), true, `${commit}:${source}`);
      fs.appendFileSync(destination, "\nuser change\n");
      assert.equal(legacyOwnsSkill(host, destination, cwd, env), false, `${commit}:${source} modified`);
    }
  });

  it("writes and strictly reads a versioned non-secret manifest", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-manifest-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-manifest-cwd-"));
    copySkill("codex", cwd, env);
    const manifest = buildInstallManifest(cwd, ["codex"], env);
    writeInstallManifest(manifest, env);
    assert.deepEqual(readInstallManifest(env), manifest);
    assert.match(fs.readFileSync(installManifestPath(env), "utf8"), /"fingerprint"/);
    fs.writeFileSync(installManifestPath(env), "{\"schema\":999}\n");
    assert.throws(() => readInstallManifest(env), /INSTALL_MANIFEST_INVALID/);
  });

  it("removes canonical skill and Baton hook entries but preserves mixed user hooks", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-default-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-default-cwd-"));
    const skill = copySkill("codex", cwd, env);
    const sharedSkill = skillPath(cwd, { env });
    fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), "SKILL.md"), sharedSkill);
    const hookFile = codexHooksPath({ cwd, env });
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, JSON.stringify({
      description: "keep",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo keep" }] },
          ...batonCodexHookEntries("baton guard hook").PreToolUse,
        ],
      },
    }, null, 2) + "\n");
    const plan = buildUninstallPlan({ cwd, env, hosts: ["codex"] });
    assert.equal(plan.targets.some((item) => item.action === "remove" && item.path.includes("SKILL.md")), true);
    assert.equal(plan.targets.some((item) => item.action === "update-entry"), true);
    applyUninstallPlan(plan, { env });
    assert.equal(fs.existsSync(skill), false);
    assert.equal(fs.existsSync(sharedSkill), false);
    const remaining = JSON.parse(fs.readFileSync(hookFile, "utf8"));
    assert.equal(remaining.description, "keep");
    assert.equal(remaining.hooks.PreToolUse[0].hooks[0].command, "echo keep");
    const second = buildUninstallPlan({ cwd, env, hosts: ["codex"] });
    assert.equal(second.targets.some((item) => item.action === "remove"), false);
  });

  it("preserves modified skills and reports canonical Grok file removal safely", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-grok-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-grok-cwd-"));
    const skill = copySkill("grok", cwd, env);
    fs.appendFileSync(skill, "\nuser change\n");
    const grokFile = grokHooksPath({ cwd, env });
    fs.mkdirSync(path.dirname(grokFile), { recursive: true });
    fs.writeFileSync(grokFile, `${JSON.stringify(batonGrokHookDocument(), null, 2)}\n`);
    const plan = buildUninstallPlan({ cwd, env, hosts: ["grok"] });
    assert.equal(plan.targets.some((item) => item.action === "conflict" && item.path.includes("SKILL.md")), true);
    assert.equal(plan.targets.some((item) => item.action === "remove" && item.path.includes("baton.json")), true);
    applyUninstallPlan(plan, { env });
    assert.equal(fs.existsSync(skill), true);
    assert.equal(fs.existsSync(grokFile), false);
  });

  it("clean dry-run does not mutate and active/corrupt tickets fail closed before mutation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-clean-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-clean-cwd-"));
    const config = path.join(batonHomeDir(env), "config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, "keep = true\n");
    const dry = buildUninstallPlan({ cwd, env, hosts: ["codex"], clean: true, dry_run: true });
    applyUninstallPlan(dry, { env });
    assert.equal(fs.existsSync(config), true);
    const ticketDir = spawnsDir(cwd, env);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, "active.json"), JSON.stringify({ id: "spn-active", status: "running", host: "codex" }));
    assert.throws(() => buildUninstallPlan({ cwd, env, hosts: ["codex"], clean: true }), (error: unknown) => (error as Error & { code?: string }).code === "UNINSTALL_ACTIVE_TICKETS");
    assert.equal(fs.existsSync(config), true);
    fs.writeFileSync(path.join(ticketDir, "active.json"), "not-json\n");
    assert.throws(() => buildUninstallPlan({ cwd, env, hosts: ["codex"], clean: true }), (error: unknown) => (error as Error & { code?: string }).code === "UNINSTALL_STATE_INVALID");
    assert.equal(fs.existsSync(config), true);
    const surgical = buildUninstallPlan({ cwd, env, hosts: ["codex"] });
    assert.deepEqual(surgical.active_tickets, []);
    assert.equal(fs.existsSync(path.join(ticketDir, "active.json")), true);
  });

  it("requires confirmation for clean and supports dry-run without confirmation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-cli-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-cli-cwd-"));
    const executable = path.join(home, "bin", "baton");
    const unrelatedHomeFile = path.join(home, "keep.txt");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "package executable\n");
    fs.writeFileSync(unrelatedHomeFile, "user data\n");
    const dryOut = capture();
    assert.equal(await runUninstall(["--clean", "--dry-run", "--json"], { cwd, env, stdout: dryOut }), 0);
    assert.match(dryOut.text(), /constraints/);
    const noConfirmOut = capture();
    await assert.rejects(() => runUninstall(["--clean"], { cwd, env, stdout: noConfirmOut }), /UNINSTALL_CONFIRMATION_REQUIRED/);
    const confirmedOut = capture();
    assert.equal(await runUninstall(["--clean"], { cwd, env, stdout: confirmedOut, confirm: () => true }), 0);
    assert.equal(fs.existsSync(path.join(home, ".baton", "config.toml")), false);
    assert.equal(fs.existsSync(path.join(home, ".baton", "workspaces")), false);
    // No package-manager executable or arbitrary HOME content is targeted.
    assert.equal(fs.existsSync(executable), true);
    assert.equal(fs.existsSync(unrelatedHomeFile), true);
    assert.equal(fs.existsSync(home), true);
  });

  it("resolves the invoking host when surgical --host is omitted", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-host-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-host-cwd-"));
    const env = fakeEnv(home, { CODEX_SANDBOX: "1", BATON_HOST: "" });
    copySkill("codex", cwd, env);
    const output = capture();
    assert.equal(await runUninstall(["--dry-run", "--json"], { cwd, env, stdout: output }), 0);
    assert.deepEqual(JSON.parse(output.text()).hosts, ["codex"]);
    await assert.rejects(
      () => runUninstall(["--host", "--dry-run"], { cwd, env, stdout: capture() }),
      /--host requires a value/,
    );
  });

  it("allows clean without --host and refuses malformed runtime state", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-clean-no-host-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-clean-no-host-cwd-"));
    const runtimeRuns = path.join(batonHomeDir(env), "workspaces", "legacy-workspace", "runs");
    fs.mkdirSync(runtimeRuns, { recursive: true });
    fs.writeFileSync(path.join(runtimeRuns, "dispatch.json"), "not-json\n");
    await assert.rejects(
      () => runUninstall(["--clean", "--yes"], { cwd, env, stdout: capture() }),
      (error: unknown) => (error as Error & { code?: string }).code === "UNINSTALL_STATE_INVALID",
    );
    fs.rmSync(path.join(runtimeRuns, "dispatch.json"));
    assert.equal(await runUninstall(["--clean", "--yes", "--dry-run", "--json"], { cwd, env, stdout: capture() }), 0);
    await assert.rejects(
      () => runUninstall(["--clean", "--yes", "--host", "codex"], { cwd, env, stdout: capture() }),
      /UNINSTALL_CLEAN_HOST_INVALID/,
    );
  });

  it("reports active dry-run tickets before confirmation and reads selection.host", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-active-dry-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-active-dry-cwd-"));
    const ticketDir = spawnsDir(cwd, env);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, "selection.json"), JSON.stringify({ id: "spn-selection", status: "active", selection: { host: "codex" } }));
    const plan = buildUninstallPlan({ cwd, env, hosts: ["codex"], clean: true, dry_run: true });
    assert.deepEqual([...plan.hosts].sort(), [...HOST_IDS].sort());
    assert.deepEqual(plan.active_tickets.map((ticket) => ticket.ticket_id), ["spn-selection"]);
    assert.ok(plan.constraints.some((constraint) => constraint.includes("active dispatch tickets")));
    let confirmed = false;
    const output = capture();
    assert.equal(await runUninstall(["--clean", "--dry-run", "--json"], {
      cwd, env, stdout: output, confirm: () => { confirmed = true; return true; },
    }), 0);
    assert.equal(confirmed, false);
    assert.match(output.text(), /spn-selection/);
    await assert.rejects(
      () => runUninstall(["--clean", "--yes"], { cwd, env, stdout: capture(), confirm: () => { confirmed = true; return true; } }),
      (error: unknown) => (error as Error & { code?: string }).code === "UNINSTALL_ACTIVE_TICKETS",
    );
    assert.equal(confirmed, false);
  });

  it("re-scans under the global reservation locks after clean confirmation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-confirm-race-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-confirm-race-cwd-"));
    const config = path.join(batonHomeDir(env), "config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, "marker = true\n");

    await assert.rejects(
      () => runUninstall(["--clean"], {
        cwd,
        env,
        stdout: capture(),
        interactive: true,
        confirm: () => {
          const directory = spawnsDir(cwd, env);
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, "late.json"), JSON.stringify({
            id: "spn-late",
            status: "dispatching",
            target_host: "codex",
          }));
          return true;
        },
      }),
      (error: unknown) => (error as Error & { code?: string }).code === "UNINSTALL_ACTIVE_TICKETS",
    );
    assert.equal(fs.existsSync(config), true);
  });

  it("does not record skipped user skills and records hook entries, not file ownership hashes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-manifest-ownership-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-manifest-ownership-cwd-"));
    const skill = hostSkillDest("codex", { cwd, env });
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, "name: baton\nuser-owned content\n");
    const hookFile = codexHooksPath({ cwd, env });
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, JSON.stringify({ hooks: batonCodexHookEntries("baton guard hook") }));
    const manifest = buildInstallManifest(cwd, ["codex", "cursor"], env);
    assert.equal(manifest.files.some((entry) => entry.host === "codex"), false);
    assert.equal(manifest.hooks.some((entry) => entry.host === "cursor"), false);
    assert.equal(manifest.hooks[0]?.entries[0]?.command, "baton guard hook");
    assert.equal(manifest.hooks[0]?.signature, undefined);
  });

  it("revalidates every mutation before applying and handles custom Claude settings", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-toctou-home-"));
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-claude-config-"));
    const env = fakeEnv(home, { CLAUDE_CONFIG_DIR: configHome });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-toctou-cwd-"));
    const skill = copySkill("codex", cwd, env);
    const claudeFile = claudeSettingsPath({ cwd, env });
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, JSON.stringify({ hooks: batonClaudeHookEntries() }, null, 2) + "\n", { mode: 0o640 });
    const plan = buildUninstallPlan({ cwd, env, hosts: ["codex", "claude"] });
    fs.appendFileSync(skill, "\nchanged after planning\n");
    assert.throws(() => applyUninstallPlan(plan, { env }), (error: unknown) => (error as Error & { code?: string }).code === "UNINSTALL_PLAN_STALE");
    assert.equal(fs.existsSync(skill), true);
    assert.equal(fs.existsSync(claudeFile), true);
    const fresh = buildUninstallPlan({ cwd, env, hosts: ["claude"] });
    const claudeTarget = fresh.targets.find((target) => target.host === "claude");
    assert.equal(claudeTarget?.path, claudeFile);
    applyUninstallPlan(fresh, { env });
    assert.equal(fs.existsSync(claudeFile), false);
  });
});
