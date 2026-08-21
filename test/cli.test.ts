import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { artificialAnalysisDbPath } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { normalizeProviderQuotas } from "../src/lib/provider-quotas.js";
import { writeCapabilitySnapshot } from "../src/lib/capabilities/store.js";
import { withHome, fakeEnv } from "./home.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  it("lets large disclosures flush instead of forcing process exit", () => {
    const entry = fs.readFileSync(path.join(root, "bin", "baton.ts"), "utf8");
    assert.match(entry, /process\.exitCode = code/);
    assert.doesNotMatch(entry, /process\.exit\(code\)/);
  });

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

      publishRouteSnapshot(cwd, { models: [{ id: "kimi-k2.7-code-highspeed", provider: "kimi" }] }, new Date(), {
        providerQuotas: normalizeProviderQuotas({ reports: [{
          provider: "kimi", label: "Kimi", source: "kimi:usages",
          quota: { fiveHourPercent: 5, weeklyPercent: 9, updatedAt: Date.now() },
        }] }),
      });
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
      assert.match(missOut.text(), /preferred: kimi\/kimi-k2\.7-code-highspeed \(GENERAL_CAPABILITY_FALLBACK\)/);

      const spawnOut = capture();
      const spawned = await run(["spawn", "code completion routine feature development", "--json"], { cwd, stdout: spawnOut, stderr: capture(), env });
      assert.equal(spawned, 0);
      const approval = JSON.parse(spawnOut.text());
      assert.equal(approval.selection_mode, "baton-recommendation");
      assert.equal(approval.status, "approved");
      assert.equal(approval.approvals[0].selected_model_id, "kimi/kimi-k2.7-code-highspeed");
      assert.equal(approval.approvals[0].confirmed_by, "baton-recommendation");
      assert.equal(approval.tickets[0].selection.confirmed_by, "baton-recommendation");
      assert.ok(fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));

      const dispatchOut = capture();
      assert.equal(await run(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], {
        cwd, stdout: dispatchOut, stderr: dispatchOut, env,
      }), 0, dispatchOut.text());
      assert.deepEqual(JSON.parse(dispatchOut.text()).reserved.map((item) => item.ticket_id), ["spn-0001"]);

      const addRoute = await run(["cards", "add", "--id", "reviewer"], { cwd, stdout: capture(), stderr: capture(), env });
      assert.equal(addRoute, 1);
    });
  });

  it("keeps all tiny multi-unit work local without creating a selection proposal", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-local-units-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, stdout: capture(), stderr: capture(), env }), 0);

      const out = capture();
      assert.equal(await run([
        "spawn", "handle these tiny housekeeping notes",
        "--unit", "status=status current state",
        "--unit", "typo=typo in summary",
        "--json",
      ], { cwd, stdout: out, stderr: out, env }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.proposal, null);
      assert.deepEqual(result.director_local.map((item) => item.key), ["status", "typo"]);
      assert.ok(!fs.existsSync(spawnsDir(cwd)));
    });
  });

  it("fails closed before proposal or ticket creation when no ranked recommendation exists", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-no-ranked-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      publishRouteSnapshot(cwd, { models: [{ id: "unknown-model", provider: "unknown" }] });

      const out = capture();
      assert.equal(await run(["spawn", "implement a repository migration", "--json"], {
        cwd, stdout: out, stderr: out, env,
      }), 1);
      assert.match(out.text(), /MODEL_RECOMMENDATION_UNAVAILABLE/);
      assert.ok(!fs.existsSync(spawnsDir(cwd)));
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
      assert.equal(await run(["config", "model-selection", "on"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
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

  it("keeps OpenSpec model selection off by default and auto-approves the recommendation", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-openspec-auto-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      const switchOut = capture();
      assert.equal(await run(["config", "model-selection", "status", "--json"], { cwd, stdout: switchOut, stderr: switchOut, env }), 0);
      assert.deepEqual(JSON.parse(switchOut.text()), { model_selection: false });
      const changeDir = path.join(cwd, "openspec", "changes", "auto-demo");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), "## 1. Work\n\n- [ ] 1.1 implement a complex repository migration\n");
      publishRouteSnapshot(cwd, { models: [{
        id: "grok-4.6", provider: "xai", namespaced: "xai/grok-4.6", disabled: false,
        reasoningEfforts: ["high"], contextWindow: 1_000_000,
      }] });
      writeCapabilitySnapshot({
        dbPath: artificialAnalysisDbPath(cwd),
        metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-21T00:00:00Z" },
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

      const rejected = capture();
      assert.equal(await run(["apply", "auto-demo", "--route", "1.1=xai/grok-4.6@high"], { cwd, stdout: rejected, stderr: rejected, env }), 1);
      assert.match(rejected.text(), /MODEL_SELECTION_DISABLED/);
      assert.ok(!fs.existsSync(path.join(spawnsDir(cwd), "os-0001.json")));

      const out = capture();
      assert.equal(await run(["apply", "auto-demo", "--json"], { cwd, stdout: out, stderr: out, env }), 0, out.text());
      const approval = JSON.parse(out.text());
      assert.equal(approval.selection_mode, "baton-recommendation");
      assert.equal(approval.status, "approved");
      assert.equal(approval.confirmation.confirmed_by, "baton-recommendation");
      assert.equal(approval.approvals[0].selected_model_id, "xai/grok-4.6@high");
      assert.equal(approval.tickets[0].selection.confirmed_by, "baton-recommendation");
      assert.equal(approval.tickets[0].selection.changed_by_user, false);
      assert.ok(fs.existsSync(path.join(spawnsDir(cwd), "os-0001.json")));
    });
  });

  it("prints the current host lifecycle after OpenSpec apply, never legacy conclude", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-openspec-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      assert.equal(await run(["config", "model-selection", "on"], { cwd, stdout: capture(), stderr: capture(), env }), 0);
      const changeDir = path.join(cwd, "openspec", "changes", "demo");
      fs.mkdirSync(changeDir, { recursive: true });
      fs.writeFileSync(path.join(changeDir, "tasks.md"), "## 1. Work\n\n- [ ] 1.1 implement a complex repository migration\n");
      publishRouteSnapshot(cwd, {
        models: [{
          id: "grok-4.6", provider: "xai", namespaced: "xai/grok-4.6", disabled: false,
          reasoningEfforts: ["high"],
        }],
      }, new Date(), {
        providerQuotas: normalizeProviderQuotas({ reports: [{
          provider: "xai", quota: { weeklyPercent: 4, weeklyResetAt: Date.now() + 60_000 },
        }] }),
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
      assert.equal(body.tickets[0].schema_version, 6);
    });
  });
});
