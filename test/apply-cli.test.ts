import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { withHome, fakeEnv } from "./home.js";
import { configureCodex } from "./configure.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); return true; }, text() { return chunks.join(""); } };
}

async function command(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(argv, { ...options, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function gitRepo(cwd: string): void {
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "baton@test"], { cwd });
  execFileSync("git", ["config", "user.name", "Baton Test"], { cwd });
  fs.writeFileSync(path.join(cwd, "README.md"), "demo\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "init"], { cwd });
}

describe("baton apply waves", () => {
  it("plans without tickets; scoped dispatch writes only director paths", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-cli-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      gitRepo(cwd);
      configureCodex(cwd, env, ["kimi/k3[1m]"]);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] }, new Date(), { cli: "codex", host: "codex" });
      const changeDir = path.join(cwd, "openspec", "changes", "wave-demo");
      fs.mkdirSync(changeDir, { recursive: true });
      const tasksPath = path.join(changeDir, "tasks.md");
      const original = `# Wave demo

## 1. Config schema

- [ ] 1.1 implement src/lib/config.ts types
- [ ] 1.2 implement src/lib/hosts.ts detection

## 2. Host resolution

- [ ] 2.1 implement src/cli.ts help
`;
      fs.writeFileSync(tasksPath, original);

      const planned = await command(["apply", "wave-demo", "--host", "codex", "--json"], { cwd, env });
      assert.equal(planned.code, 0, planned.stderr || planned.stdout);
      const plan = JSON.parse(planned.stdout);
      assert.deepEqual(plan.ready_wave.task_ids, ["1.1", "1.2"]);
      assert.equal(plan.ready_wave.parallel, true);
      assert.equal(fs.existsSync(spawnsDir(cwd)), false);

      const unscoped = await command(["apply", "wave-demo", "--host", "codex", "--dispatch", "--json"], { cwd, env });
      assert.equal(unscoped.code, 1);
      assert.match(unscoped.stderr, /TASK_SCOPE_REQUIRED/);
      assert.equal(fs.existsSync(spawnsDir(cwd)), false);

      const result = await command([
        "apply", "wave-demo", "--host", "codex", "--dispatch", "--json", "--capacity", "4",
        "--unit", "1.1", "--write-path", "src/lib/config.ts",
        "--unit", "1.2", "--write-path", "src/lib/hosts.ts",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(body.ready_wave.task_ids, ["1.1", "1.2"]);
      assert.deepEqual(body.waves[1].task_ids, ["2.1"]);
      const ticketFiles = fs.readdirSync(spawnsDir(cwd)).filter((name) => name.endsWith(".json"));
      assert.equal(ticketFiles.length, 2);
      assert.equal(body.reserved.length, 2);
      assert.equal(fs.readFileSync(tasksPath, "utf8"), original);
      for (const name of ticketFiles) {
        const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), name), "utf8"));
        assert.equal(ticket.mode, "write");
        assert.equal(ticket.read_only, false);
        assert.equal(ticket.work_unit.kind, "concrete");
        const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${ticket.receipt_id}.json`), "utf8"));
        assert.equal(receipt.execution.mode, "write");
        assert.ok(receipt.scope.write_allowlist.length);
      }
    });
  });

  it("dispatches Unify tasks as write when the director supplies paths", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-unify-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      gitRepo(cwd);
      configureCodex(cwd, env, ["kimi/k3[1m]"]);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] }, new Date(), { cli: "codex", host: "codex" });
      const changeDir = path.join(cwd, "openspec", "changes", "unify-demo");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Unify

## 1. Shared host guard

- [ ] 1.1 Unify Codex, Grok, and Claude PreToolUse on ticket presence
`);
      const result = await command([
        "apply", "unify-demo", "--host", "codex", "--dispatch", "--json",
        "--unit", "1.1", "--write-path", "src/lib/host-guard.ts",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.equal(body.tickets[0].work_unit.kind, "concrete");
      assert.equal(body.tickets[0].mode, "write");
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${body.tickets[0].receipt_id}.json`), "utf8"));
      assert.deepEqual(receipt.scope.write_allowlist, ["src/lib/host-guard.ts"]);
    });
  });

  it("keeps director --read-only tickets off the write allowlist", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-apply-ro-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      configureCodex(cwd, env, ["kimi/k3[1m]"]);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] }, new Date(), { cli: "codex", host: "codex" });
      const changeDir = path.join(cwd, "openspec", "changes", "ro-demo");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), `# Ro

## 1. Inspect

- [ ] 1.1 review src/lib/host-guard.ts
`);
      const result = await command([
        "apply", "ro-demo", "--host", "codex", "--dispatch", "--json",
        "--unit", "1.1", "--read-only",
      ], { cwd, env });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.equal(body.tickets[0].mode, "read-only");
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${body.tickets[0].receipt_id}.json`), "utf8"));
      assert.deepEqual(receipt.scope.write_allowlist, []);
      assert.deepEqual(receipt.scope.allowed_operations, ["read"]);
    });
  });
});
