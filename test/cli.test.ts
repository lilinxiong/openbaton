import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { artificialAnalysisDbPath } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { writeCapabilitySnapshot } from "../src/lib/capabilities/store.js";
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

      publishRouteSnapshot(cwd, { models: [{ id: "kimi-k2.7-code-highspeed", provider: "kimi" }] });
      writeCapabilitySnapshot({
        dbPath: artificialAnalysisDbPath(cwd),
        metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-19T00:00:00Z" },
        models: [{
          id: "aa-k2", slug: "kimi-k2-7-code", name: "Kimi K2.7 Code",
          evaluations: {
            artificial_analysis_intelligence_index: 43,
            artificial_analysis_coding_index: 60.8,
            artificial_analysis_agentic_index: 30.3,
          },
          pricing: {}, performance: {}, cost: {},
        }],
        mappings: [{ routeId: "kimi/kimi-k2.7-code-highspeed", aaSlug: "kimi-k2-7-code" }],
      });

      const hitOut = capture();
      const hit = await run(["match", "code completion routine feature development"], { cwd, stdout: hitOut, stderr: capture(), env });
      assert.equal(hit, 0);
      assert.match(hitOut.text(), /kimi-for-coding/);

      const matchJson = capture();
      assert.equal(await run(["match", "code completion routine feature development", "--json"], { cwd, stdout: matchJson, stderr: capture(), env }), 0);
      const matched = JSON.parse(matchJson.text());
      assert.equal(matched.card.capability.ranked, true);
      assert.equal(matched.card.capability.source, "artificial-analysis");

      const cardsJson = capture();
      assert.equal(await run(["cards", "--ranked", "--json"], { cwd, stdout: cardsJson, stderr: capture(), env }), 0);
      const rankedCards = JSON.parse(cardsJson.text());
      assert.ok(rankedCards.length >= 1);
      assert.ok(rankedCards.every((card) => card.capability.ranked));

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
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
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

  it("prints the schema-v2 host lifecycle after OpenSpec apply, never legacy conclude", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-openspec-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init", "--tools", "codex"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      const changeDir = path.join(cwd, "openspec", "changes", "demo");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), "## 1. Work\n\n- [ ] 1.1 implement a complex repository migration\n");
      publishRouteSnapshot(cwd, {
        models: [{
          id: "grok-4.6", provider: "xai", namespaced: "xai/grok-4.6", disabled: false,
          reasoningEfforts: ["high"],
        }],
      });
      writeCapabilitySnapshot({
        dbPath: artificialAnalysisDbPath(cwd),
        metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-19T00:00:00Z" },
        models: [{
          id: "aa-grok", slug: "grok-4-6", name: "Grok 4.6",
          evaluations: {
            artificial_analysis_intelligence_index: 80,
            artificial_analysis_coding_index: 90,
            artificial_analysis_agentic_index: 85,
          },
          pricing: {}, performance: {}, cost: {},
        }],
        mappings: [{ routeId: "xai/grok-4.6", profile: "high", aaSlug: "grok-4-6" }],
      });

      const out = capture();
      const err = capture();
      const code = await run(["apply", "demo"], { cwd, stdout: out, stderr: err, env });
      assert.equal(code, 0, err.text());
      assert.match(out.text(), /Schema-v3 tickets require the host lifecycle/);
      assert.match(out.text(), /baton dispatch next/);
      assert.doesNotMatch(out.text(), /baton conclude/);
    });
  });
});
