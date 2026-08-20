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
import { writeHostCapabilitySnapshot } from "../src/lib/host-capabilities.js";
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
  it("rejects legacy host selection because Baton is Codex-only", async () => {
    await withHome(async (home) => {
      const out = capture();
      const code = await run(["init", "--tools", "cursor"], {
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-")),
        stdout: out,
        stderr: out,
        env: fakeEnv(home),
      });
      assert.equal(code, 1);
      assert.match(out.text(), /Codex-only/);
    });
  });

  it("init + match + spawn in a temp cwd; no-match is blocked", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-"));
      const env = fakeEnv(home);
      const out = capture();
      const err = capture();

      const initCode = await run(["init"], { cwd, stdout: out, stderr: err, env });
      assert.equal(initCode, 0);
      assert.ok(fs.existsSync(path.join(home, ".baton", "config.toml")));
      assert.ok(fs.existsSync(path.join(home, ".codex/skills/baton/SKILL.md")));
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
      writeHostCapabilitySnapshot(cwd, {
        advertisedModels: ["kimi/kimi-k2.7-code-highspeed"],
        quotaCatalog: { reports: [{ provider: "kimi", label: "Kimi", source: "kimi:usages", quota: { fiveHourPercent: 5, weeklyPercent: 9, updatedAt: Date.now() } }] },
      });

      const hitOut = capture();
      const hit = await run(["match", "code completion routine feature development"], { cwd, stdout: hitOut, stderr: capture(), env });
      assert.equal(hit, 0);
      assert.match(hitOut.text(), /kimi\/kimi-k2\.7-code-highspeed/);

      const matchJson = capture();
      assert.equal(await run(["match", "code completion routine feature development", "--json"], { cwd, stdout: matchJson, stderr: capture(), env }), 0);
      const matched = JSON.parse(matchJson.text());
      assert.equal(matched.candidates[0].ranked, true);
      assert.equal(matched.candidates[0].aa_scores.coding, 60.8);

      const cardsJson = capture();
      assert.equal(await run(["cards", "--ranked", "--json"], { cwd, stdout: cardsJson, stderr: capture(), env }), 0);
      const rankedCards = JSON.parse(cardsJson.text());
      assert.ok(rankedCards.length >= 1);
      assert.ok(rankedCards.every((card) => card.capability.ranked));

      const missOut = capture();
      const miss = await run(["match", "paint the barn purple"], { cwd, stdout: missOut, stderr: capture(), env });
      assert.equal(miss, 0);
      assert.match(missOut.text(), /preferred: none/);

      const spawnOut = capture();
      const spawned = await run(["spawn", "code completion routine feature development", "--json"], { cwd, stdout: spawnOut, stderr: capture(), env });
      assert.equal(spawned, 0);
      const proposal = JSON.parse(spawnOut.text());
      assert.equal(proposal.status, "pending_confirmation");
      assert.equal(proposal.units[0].recommended_model_id, "kimi/kimi-k2.7-code-highspeed");
      assert.equal(proposal.units[0].candidates[0].quota.windows[0].remaining_percent, 95);
      assert.ok(!fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")));
      const unconfirmed = capture();
      assert.equal(await run(["selection", "approve", proposal.id], { cwd, stdout: unconfirmed, stderr: unconfirmed, env }), 1);
      assert.match(unconfirmed.text(), /MODEL_SELECTION_NOT_CONFIRMED/);
      assert.equal(await run(["selection", "approve", proposal.id, "--confirm", "--json"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      assert.ok(fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));

      const addRoute = await run(["cards", "add", "--id", "reviewer"], { cwd, stdout: capture(), stderr: capture(), env });
      assert.equal(addRoute, 1);
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

      assert.equal(await run(["init"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      writeHostCapabilitySnapshot(cwd, { advertisedModels: ["kimi/k3[1m]"], quotaCatalog: { reports: [] } });
      const out = capture();
      const code = await run([
        "spawn", "implement the multi file unit", "--model", "kimi/k3[1m]",
        "--write-path", "a.txt", "--write-path", "b.txt,c.txt",
        "--write-ops", "write", "--write-ops", "delete,rename", "--json",
      ], { cwd, stdout: out, stderr: out, env });
      assert.equal(code, 0, out.text());
      const proposal = JSON.parse(out.text());
      assert.equal(await run(["selection", "approve", proposal.id, "--confirm", "--json"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), "rcpt-spn-0001-a1.json"), "utf8"));
      assert.deepEqual(receipt.scope.write_allowlist, ["a.txt", "b.txt", "c.txt"]);
      assert.deepEqual(receipt.scope.allowed_operations, ["write", "delete", "rename"]);
    });
  });

  it("prints the current host lifecycle after OpenSpec apply, never legacy conclude", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-openspec-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
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
      writeHostCapabilitySnapshot(cwd, {
        advertisedModels: ["xai/grok-4.6"],
        advertisedProfiles: { "xai/grok-4.6": ["high"] },
        quotaCatalog: { reports: [{ provider: "xai", quota: { weeklyPercent: 4, weeklyResetAt: Date.now() + 60_000 } }] },
      });

      const out = capture();
      const err = capture();
      const code = await run(["apply", "demo", "--route", "1.1=xai/grok-4.6@high", "--json"], { cwd, stdout: out, stderr: err, env });
      assert.equal(code, 0, err.text());
      const proposal = JSON.parse(out.text());
      assert.equal(proposal.status, "pending_confirmation");
      assert.equal(proposal.units[0].requested_model_id, "xai/grok-4.6@high");
      assert.ok(!fs.existsSync(path.join(spawnsDir(cwd), "os-0001.json")));
      const approved = capture();
      assert.equal(await run(["selection", "approve", proposal.id, "--confirm", "--json"], { cwd, stdout: approved, stderr: err, env }), 0, err.text());
      const body = JSON.parse(approved.text());
      assert.equal(body.tickets[0].selection.confirmed_by, "user");
      assert.equal(body.tickets[0].schema_version, 4);
    });
  });
});
