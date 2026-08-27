import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { buildRouteCandidates, publishRouteSnapshot } from "../src/lib/routes.js";
import {
  buildSelectionUnit,
  createSelectionProposal,
  estimateTaskComplexity,
  readSelectionProposal,
  selectionSourceFingerprint,
} from "../src/lib/selection.js";
import { artificialAnalysisDbPath, modelAvailabilityPath, receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { availabilityForRoute, readModelAvailability } from "../src/lib/model-availability.js";
import { configureCodex } from "./configure.js";
import { withHome, fakeEnv } from "./home.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

const MODELS = [
  {
    id: "gpt-5.6-sol",
    displayName: "5.6 Sol",
    description: "Most capable model for complex repository architecture and migration work",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    additionalSpeedTiers: ["fast"],
    serviceTiers: [{ id: "priority", name: "Fast" }],
  },
  {
    id: "gpt-5.6-luna",
    displayName: "5.6 Luna",
    description: "Fast balanced coding model",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    displayName: "5.4 Mini",
    description: "Small fast cost-efficient coding model for simpler fixes",
    supportedReasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "low",
    additionalSpeedTiers: ["fast"],
  },
  {
    id: "gpt-5.3-codex-spark",
    displayName: "5.3 Codex Spark",
    description: "Ultra-fast coding model",
    supportedReasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "low",
  },
];

function setup(cwd: string, env: NodeJS.ProcessEnv) {
  publishRouteSnapshot(cwd, { models: MODELS }, new Date(), { cli: "codex", engineVersion: "test" });
  configureCodex(cwd, env, ["gpt-5.3-codex-spark", "gpt-5.6-luna", "gpt-5.4-mini"]);
  return buildRouteCandidates(cwd, artificialAnalysisDbPath(cwd)).map((candidate) => candidate.card);
}

describe("automatic configured-model selection", () => {
  it("fails closed when durable availability state is damaged", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-select-damaged-availability-"));
    const env = fakeEnv(home);
    const file = modelAvailabilityPath(cwd, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, records: [{
      host: "codex", account_scope: "scope", route_id: "gpt-5.3-codex-spark", status: "exhausted",
      reason: "quota", observed_at: "not-a-timestamp", reset_at: null, next_probe_at: null,
      probe_attempts: 1, probe_lease_owner: null, probe_lease_until: null,
    }] }), "utf8");
    assert.throws(() => readModelAvailability(cwd, env), (error: unknown) => (error as NodeJS.ErrnoException).code === "MODEL_AVAILABILITY_INVALID");
    assert.throws(() => availabilityForRoute(cwd, { host: "codex", routeId: "gpt-5.3-codex-spark" }, new Date(), env), (error: unknown) => (error as NodeJS.ErrnoException).code === "MODEL_AVAILABILITY_INVALID");
  }));

  it("maps explicit speed/simple work to low effort and complex work to max", () => {
    assert.deepEqual(estimateTaskComplexity("implement a quick small coding fix"), { effort: "low", reason: "simple" });
    assert.deepEqual(estimateTaskComplexity("implement a complex repository-wide architecture migration"), { effort: "max", reason: "very-complex" });
  });

  it("selects Mini at low effort for small fast work without benchmark data", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-select-fast-"));
    const env = fakeEnv(home);
    const cards = setup(cwd, env);
    const text = "implement a quick small coding fix";
    const unit = buildSelectionUnit({
      cwd,
      key: "fast",
      description: text,
      prompt: text,
      cards,
      automaticCards: cards,
    });
    assert.equal(unit.target_reasoning_effort, "low");
    assert.equal(unit.recommended_model_id, "gpt-5.4-mini@low");
    const mini = unit.candidates.find((candidate) => candidate.model_id === "gpt-5.4-mini@low")!;
    assert.equal(mini.automatic_eligible, true);
    assert.equal(mini.ranked, false);
    assert.equal(mini.speed_optimized, true);
    assert.equal(mini.service_tier, "fast");
    assert.deepEqual(mini.speed_signals, ["catalog-description", "service-tier"]);
    const sol = unit.candidates.find((candidate) => candidate.model_id === "gpt-5.6-sol@low")!;
    assert.equal(sol.service_tier, "priority");
    assert.deepEqual(sol.speed_signals, ["service-tier"]);
    assert.ok(unit.candidates.some((candidate) => candidate.model_id === "gpt-5.3-codex-spark@low"));
  }));

  it("chooses one best-fit effort per model before comparing benchmark scores", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-select-profile-first-"));
    const env = fakeEnv(home);
    publishRouteSnapshot(cwd, { models: [
      {
        id: "strong-default",
        description: "Strong coding model",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "quick-model",
        description: "Small fast coding model",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ] }, new Date(), { cli: "codex", engineVersion: "test" });
    configureCodex(cwd, env, ["strong-default", "quick-model"]);
    const capability = (coding: number) => ({
      source: "artificial-analysis" as const,
      ranked: true,
      unranked: false,
      reason: "ranked",
      reference_only: false,
      reference_reasons: [],
      intelligence_index: null,
      coding_index: coding,
      agentic_index: null,
      cost_per_task: null,
      output_tokens_per_second: null,
      time_to_first_answer_seconds: null,
    });
    const cards = [
      { id: "strong-default", route_id: "strong-default", strengths: "coding", executable: true, capability: capability(100) },
      { id: "strong-default@low", route_id: "strong-default", reasoning_effort: "low", strengths: "coding", executable: true, capability: capability(10) },
      { id: "strong-default@medium", route_id: "strong-default", reasoning_effort: "medium", strengths: "coding", executable: true, capability: capability(100) },
      { id: "strong-default@high", route_id: "strong-default", reasoning_effort: "high", strengths: "coding", executable: true, capability: capability(100) },
      { id: "quick-model", route_id: "quick-model", strengths: "fast coding", executable: true, capability: capability(90) },
      { id: "quick-model@low", route_id: "quick-model", reasoning_effort: "low", strengths: "fast coding", executable: true, capability: capability(50) },
      { id: "quick-model@medium", route_id: "quick-model", reasoning_effort: "medium", strengths: "fast coding", executable: true, capability: capability(90) },
      { id: "quick-model@high", route_id: "quick-model", reasoning_effort: "high", strengths: "fast coding", executable: true, capability: capability(90) },
    ];
    const text = "implement a quick small coding fix";
    const unit = buildSelectionUnit({ cwd, key: "one", description: text, prompt: text, cards, automaticCards: cards });
    assert.equal(unit.target_reasoning_effort, "low");
    assert.equal(unit.recommended_model_id, "quick-model@low");
    assert.deepEqual(
      unit.candidates.filter((candidate) => candidate.automatic_eligible).map((candidate) => candidate.model_id).sort(),
      ["quick-model@low", "strong-default@low"],
    );
    assert.equal(unit.candidates.find((candidate) => candidate.model_id === "strong-default")?.automatic_eligible, false);
  }));

  it("selects the strongest configured model at a CLI-supported max effort", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-select-complex-"));
    const env = fakeEnv(home);
    const cards = setup(cwd, env);
    const text = "implement a complex repository-wide architecture migration";
    const unit = buildSelectionUnit({
      cwd,
      key: "complex",
      description: text,
      prompt: text,
      cards,
      automaticCards: cards,
    });
    assert.equal(unit.target_reasoning_effort, "max");
    assert.equal(unit.recommended_model_id, "gpt-5.6-sol@max");
    assert.equal(unit.requires_manual_choice, false);
  }));

  it("persists the full automatic decision as audit evidence", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-select-audit-"));
    const env = fakeEnv(home);
    const cards = setup(cwd, env);
    const text = "implement a quick small coding fix";
    const unit = buildSelectionUnit({ cwd, key: "one", description: text, prompt: text, cards, automaticCards: cards });
    const proposal = createSelectionProposal(cwd, {
      source: "standalone",
      units: [unit],
      sourceFingerprint: selectionSourceFingerprint({
        source_shape: "multi-unit-v1",
        description: text,
        units: [{ key: "one", description: text }],
        write_paths: [],
        write_operations: [],
      }),
      payload: {
        source_shape: "multi-unit-v1",
        description: text,
        units: [{ key: "one", description: text }],
      },
    });
    const stored = readSelectionProposal(cwd, proposal.id);
    assert.equal(stored.units[0].recommended_model_id, "gpt-5.4-mini@low");
    assert.ok(stored.units[0].candidates.some((candidate) => candidate.model_id === "gpt-5.3-codex-spark@low"));
  }));

  it("spawn auto-approves and creates a ticket without model confirmation", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-select-spawn-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      setup(cwd, env);
      const out = capture();
      assert.equal(await run(["spawn", "implement a quick small coding fix", "--host", "codex", "--classification", "implementation", "--json"], {
        cwd,
        env,
        stdout: out,
        stderr: out,
      }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.selection_mode, "baton-recommendation");
      assert.equal(result.status, "approved");
      assert.equal(result.approvals[0].selected_model_id, "gpt-5.3-codex-spark@low");
      assert.equal(result.approvals[0].confirmed_by, "baton-recommendation");
      assert.equal(result.approvals[0].service_tier, null);
      assert.equal(result.tickets[0].service_tier, null);

      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
      execFileSync("git", ["config", "user.name", "Selection Test"], { cwd });
      fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
      execFileSync("git", ["add", "seed.txt"], { cwd });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd });
      const writeOut = capture();
      assert.equal(await run(["spawn", "implement a scoped coding fix", "--host", "codex", "--classification", "implementation", "--write-path", "src/cli.ts", "--json"], {
        cwd, env, stdout: writeOut, stderr: writeOut,
      }), 0, writeOut.text());
      const writeResult = JSON.parse(writeOut.text());
      const writeTicket = writeResult.tickets[0];
      const writeReceipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${writeTicket.receipt_id}.json`), "utf8"));
      assert.equal(writeReceipt.baseline.index_control_algorithm, "git-index-control-framed-sha256-v2");
      assert.equal(typeof writeReceipt.baseline.index_control_entry_count, "number");

      const audit = capture();
      assert.equal(await run(["selection", "show", result.proposal_id, "--host", "codex", "--json"], {
        cwd, env, stdout: audit, stderr: audit,
      }), 0, audit.text());
      assert.equal(JSON.parse(audit.text()).status, "approved");

      for (const action of ["render", "approve", "render-bundle"]) {
        const removed = capture();
        assert.equal(await run(["selection", action, result.proposal_id, "--host", "codex"], {
          cwd, env, stdout: removed, stderr: removed,
        }), 1);
        assert.match(removed.text(), /MODEL_SELECTION_REMOVED/);
      }

      const explicit = capture();
      assert.equal(await run(["spawn", "implement a change", "--host", "codex", "--classification", "implementation", "--model", "gpt-5.3-codex-spark"], {
        cwd,
        env,
        stdout: explicit,
        stderr: explicit,
      }), 1);
      assert.match(explicit.text(), /MODEL_SELECTION_REMOVED/);
    });
  });

  it("allows disjoint standalone units to carry independent write scopes", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-select-multi-write-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      setup(cwd, env);
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
      execFileSync("git", ["config", "user.name", "Selection Test"], { cwd });
      fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n");
      execFileSync("git", ["add", "seed.txt"], { cwd });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd });
      const out = capture();
      const code = await run([
        "spawn", "implement two files", "--host", "codex", "--classification", "implementation",
        "--unit", "one=implement one", "--write-path", "one.txt", "--write-ops", "write",
        "--unit", "two=implement two", "--write-path", "two.txt", "--write-ops", "create", "--json",
      ], { cwd, env, stdout: out, stderr: out });
      assert.equal(code, 0, out.text());
      const body = JSON.parse(out.text());
      assert.equal(body.tickets.length, 2);
      const receipts = body.tickets.map((ticket: { receipt_id: string }) => JSON.parse(
        fs.readFileSync(path.join(receiptsDir(cwd), `${ticket.receipt_id}.json`), "utf8"),
      ));
      assert.deepEqual(receipts.map((receipt: { scope: { write_allowlist: string[] } }) => receipt.scope.write_allowlist), [["one.txt"], ["two.txt"]]);
      assert.deepEqual(receipts.map((receipt: { scope: { allowed_operations: string[] } }) => receipt.scope.allowed_operations), [["write"], ["create"]]);

      const retainedPath = path.join(spawnsDir(cwd), `${body.tickets[0].id}.json`);
      const retainedTicket = JSON.parse(fs.readFileSync(retainedPath, "utf8"));
      retainedTicket.status = "completed";
      delete retainedTicket.slot_released_at;
      fs.writeFileSync(retainedPath, `${JSON.stringify(retainedTicket)}\n`);
      const blocked = capture();
      assert.equal(await run([
        "spawn", "implement one again", "--host", "codex", "--classification", "implementation",
        "--write-path", "one.txt", "--write-ops", "write", "--json",
      ], { cwd, env, stdout: blocked, stderr: blocked }), 1);
      assert.match(blocked.text(), /WRITE_SCOPE_CONFLICT/);
    });
  });
});
