import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { withHome, fakeEnv } from "./home.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function capture() {
  const chunks = [];
  return {
    chunks,
    write(s) {
      chunks.push(String(s));
    },
    text() {
      return chunks.join("");
    },
  };
}

describe("cli run()", () => {
  it("init + match + spawn in a temp cwd; no-match is blocked", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-"));
      const env = fakeEnv(home);
      const out = capture();
      const err = capture();

      const initCode = await run(["init", "--tools", "claude,grok"], { cwd, stdout: out, stderr: err, env });
      assert.equal(initCode, 0);
      assert.ok(fs.existsSync(path.join(home, ".baton", "config.toml")));
      assert.ok(fs.existsSync(path.join(cwd, ".claude/skills/baton/SKILL.md")));
      assert.ok(fs.existsSync(path.join(home, ".grok/skills/baton/SKILL.md")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));
      assert.ok(!fs.existsSync(path.join(cwd, ".grok")));

      const hitOut = capture();
      const hit = await run(["match", "code completion routine feature development"], { cwd, stdout: hitOut, stderr: capture(), env });
      assert.equal(hit, 0);
      assert.match(hitOut.text(), /kimi-for-coding/);

      const missOut = capture();
      const miss = await run(["match", "paint the barn purple"], { cwd, stdout: missOut, stderr: capture(), env });
      assert.equal(miss, 1);
      assert.match(missOut.text(), /blocked:/);

      const spawnOut = capture();
      const spawned = await run(["spawn", "code completion routine feature development"], { cwd, stdout: spawnOut, stderr: capture(), env });
      assert.equal(spawned, 0);
      assert.match(spawnOut.text(), /spawn spn-0001/);
      assert.match(spawnOut.text(), /kimi-for-coding/);
      assert.ok(fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));

      const addRoute = await run([
        "cards", "add", "--id", "reviewer", "--strengths", "review code",
        "--route", "xai/grok-4.6", "--reasoning-effort", "high",
      ], { cwd, stdout: capture(), stderr: capture(), env });
      assert.equal(addRoute, 0);
      const config = fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8");
      assert.match(config, /id = "reviewer"[\s\S]*route_id = "xai\/grok-4\.6"[\s\S]*reasoning_effort = "high"/);
    });
  });

  it("accumulates repeated --write-path and --write-ops flags instead of collapsing them", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-"));
      const env = fakeEnv(home);
      git(cwd, "init", "-q");
      git(cwd, "config", "user.email", "validation@example.invalid");
      git(cwd, "config", "user.name", "Validation");
      fs.writeFileSync(path.join(cwd, "a.txt"), "A\n");
      fs.writeFileSync(path.join(cwd, "b.txt"), "B\n");
      fs.writeFileSync(path.join(cwd, "c.txt"), "C\n");
      git(cwd, "add", "a.txt", "b.txt", "c.txt");
      git(cwd, "commit", "-q", "-m", "baseline");

      assert.equal(await run(["init", "--tools", "codex"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      const out = capture();
      const code = await run([
        "spawn", "implement the multi file unit", "--model", "k3",
        "--write-path", "a.txt", "--write-path", "b.txt,c.txt",
        "--write-ops", "write", "--write-ops", "delete,rename",
      ], { cwd, stdout: out, stderr: out, env });
      assert.equal(code, 0, out.text());
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), "rcpt-spn-0001-a1.json"), "utf8"));
      assert.deepEqual(receipt.scope.write_allowlist, ["a.txt", "b.txt", "c.txt"]);
      assert.deepEqual(receipt.scope.allowed_operations, ["write", "delete", "rename"]);
    });
  });
});
