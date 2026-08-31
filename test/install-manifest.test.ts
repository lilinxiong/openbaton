import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { initProject } from "../src/commands/init.js";
import { hostSkillDest } from "../src/lib/hosts.js";
import {
  fileFingerprint,
  readInstallManifest,
} from "../src/lib/install-manifest.js";
import { applyUninstallPlan, buildUninstallPlan } from "../src/lib/uninstall.js";

function isolatedEnv(): { home: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-install-manifest-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-install-manifest-cwd-"));
  const env = { ...process.env, HOME: home };
  delete env.BATON_ADAPTER_PATHS;
  return { home, cwd, env };
}

function companionHostSkill(cwd: string, env: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(hostSkillDest("codex", { cwd, env })), "agents", "openai.yaml");
}

describe("install manifest ownership", () => {
  it("keeps the prior fingerprint when init skips a user-modified host skill", async () => {
    const { cwd, env } = isolatedEnv();
    const first = await initProject(cwd, { env });
    assert.ok(first.created.some((line) => line.includes("openai.yaml")));

    const dest = companionHostSkill(cwd, env);
    const owned = readInstallManifest(env)?.files.find((entry) =>
      entry.kind === "host-skill" && entry.host === "codex" && entry.path === path.resolve(dest));
    assert.ok(owned);
    const originalFingerprint = owned.fingerprint;

    fs.appendFileSync(dest, "# user-modified host skill\n");
    const userContent = fs.readFileSync(dest, "utf8");
    assert.notEqual(fileFingerprint(dest), originalFingerprint);

    const second = await initProject(cwd, { env });
    assert.ok(second.skipped.some((line) => line.includes("openai.yaml")));
    assert.equal(fs.readFileSync(dest, "utf8"), userContent);

    const after = readInstallManifest(env)?.files.find((entry) =>
      entry.kind === "host-skill" && entry.host === "codex" && entry.path === path.resolve(dest));
    assert.equal(after?.fingerprint, originalFingerprint);
    assert.notEqual(after?.fingerprint, fileFingerprint(dest));

    const plan = buildUninstallPlan({ cwd, env, hosts: ["codex"] });
    const target = plan.targets.find((item) => item.path.endsWith("/.codex/skills/baton/agents/openai.yaml"));
    assert.equal(target?.action, "conflict");
    applyUninstallPlan(plan, { env });
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.readFileSync(dest, "utf8"), userContent);
  });

  it("does not claim a skipped host skill that was never owned", async () => {
    const { home, cwd, env } = isolatedEnv();
    const dest = path.join(home, ".codex", "skills", "baton", "agents", "openai.yaml");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "user placed companion skill\n");

    const result = await initProject(cwd, { env });
    assert.ok(result.skipped.some((line) => line.includes("openai.yaml")));
    assert.equal(fs.readFileSync(dest, "utf8"), "user placed companion skill\n");
    assert.equal(
      readInstallManifest(env)?.files.some((entry) => entry.path === path.resolve(dest)),
      false,
    );

    const plan = buildUninstallPlan({ cwd, env, hosts: ["codex"] });
    assert.equal(plan.targets.some((item) => item.path.endsWith("/.codex/skills/baton/agents/openai.yaml")), false);
    applyUninstallPlan(plan, { env });
    assert.equal(fs.readFileSync(dest, "utf8"), "user placed companion skill\n");
  });
});
