import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runUninstall } from "../src/commands/uninstall.js";
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

  it("does not record skipped user skills or file ownership hashes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-manifest-ownership-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-manifest-ownership-cwd-"));
    const skill = hostSkillDest("codex", { cwd, env });
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, "name: baton\nuser-owned content\n");
    const manifest = buildInstallManifest(cwd, ["codex", "cursor"], env);
    assert.equal(manifest.files.some((entry) => entry.host === "codex"), false);
    assert.equal(manifest.hooks, undefined);
  });

  it("revalidates every mutation before applying", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-toctou-home-"));
    const env = fakeEnv(home);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-uninstall-toctou-cwd-"));
    const skill = copySkill("codex", cwd, env);
    const plan = buildUninstallPlan({ cwd, env, hosts: ["codex"] });
    fs.appendFileSync(skill, "\nchanged after planning\n");
    assert.throws(() => applyUninstallPlan(plan, { env }), (error: unknown) => (error as Error & { code?: string }).code === "UNINSTALL_PLAN_STALE");
    assert.equal(fs.existsSync(skill), true);
  });
});
