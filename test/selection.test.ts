import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { buildSelectionUnit, createSelectionProposal, readSelectionProposal, selectionSourceFingerprint, writeSelectionProposal } from "../src/lib/selection.js";
import { SUBAGENT_MODEL_FAMILY_FORBIDDEN, SUBAGENT_MODEL_POLICY_ID } from "../src/lib/model-policy.js";
import { normalizeProviderQuotas, writeHostCapabilitySnapshot } from "../src/lib/host-capabilities.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { artificialAnalysisDbPath, receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { writeCapabilitySnapshot } from "../src/lib/capabilities/store.js";
import { withHome, fakeEnv } from "./home.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

function card(id: string, route: string, provider: string, coding: number, agentic: number, relative: number) {
  return {
    id, route_id: route, provider, executable: true, source: "dynamic" as const,
    reasoning_effort: id.includes("@") ? id.slice(id.lastIndexOf("@") + 1) : undefined,
    strengths: `AA-derived inference: coding=${coding}, agentic=${agentic}`,
    positioning: relative >= 0.75 ? ["strong-coding", "strong-agentic"] : ["balanced"],
    capability: {
      source: "artificial-analysis" as const, ranked: true, unranked: false, reason: null,
      intelligence_index: 50, coding_index: coding, agentic_index: agentic,
      cost_per_task: 1, output_tokens_per_second: 50, time_to_first_answer_seconds: 10,
      relative: { intelligence: relative, coding: relative, agentic: relative, cost_efficiency: 0.5, throughput: 0.5, latency: 0.5 },
    },
  };
}

describe("mandatory model selection disclosure", () => {
  it("converts OpenCodex used percentages into explicit remaining quota windows", () => {
    const quotas = normalizeProviderQuotas({ reports: [
      { provider: "kimi", source: "kimi:usages", quota: { fiveHourPercent: 5, fiveHourResetAt: 1_800_000_000_000, weeklyPercent: 9 } },
      { provider: "cursor", reverseEngineered: true, quota: { monthlyPercent: 22.4896, customWindows: [{ label: "API usage", percent: 93.72 }] } },
    ] }, "2026-08-19T00:00:00.000Z");
    const kimi = quotas.find((item) => item.provider === "kimi")!;
    assert.deepEqual(kimi.windows.map((item) => [item.name, item.remaining_percent]), [["five_hour", 95], ["weekly", 91]]);
    const cursor = quotas.find((item) => item.provider === "cursor")!;
    assert.equal(cursor.windows.find((item) => item.label === "API usage")?.remaining_percent, 6.280000000000001);
    assert.equal(cursor.reverse_engineered, true);
  });

  it("recommends only from the OpenCodex/Codex intersection and discloses unavailable providers and unknown quota", () => withHome(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-selection-"));
    publishRouteSnapshot(cwd, { models: [
      { id: "strong", provider: "openai", namespaced: "openai/strong" },
      { id: "cheap", provider: "alibaba-token-plan", namespaced: "alibaba-token-plan/cheap" },
      { id: "k3", provider: "kimi", namespaced: "kimi/k3" },
    ] });
    const host = writeHostCapabilitySnapshot(cwd, {
      advertisedModels: ["openai/strong", "alibaba-token-plan/cheap", "gpt-5.5", "gpt-5.6-sol", "cursor/gpt-5.6-terra"],
      advertisedProfiles: {
        "openai/strong": ["high"], "alibaba-token-plan/cheap": ["low"],
        "gpt-5.5": ["high"], "gpt-5.6-sol": ["max"], "cursor/gpt-5.6-terra": ["high"],
      },
      quotaCatalog: { reports: [{ provider: "openai", source: "chatgpt:wham", quota: { weeklyPercent: 87 } }] },
    });
    const cards = [
      card("openai/strong@high", "openai/strong", "openai", 95, 92, 1),
      card("openai/strong@ultra", "openai/strong", "openai", 98, 97, 1),
      card("alibaba-token-plan/cheap@low", "alibaba-token-plan/cheap", "alibaba-token-plan", 55, 45, 0.3),
      card("kimi/k3@max", "kimi/k3", "kimi", 99, 99, 1),
      card("gpt-5.5@high", "gpt-5.5", "openai", 100, 100, 1),
      card("gpt-5.6-sol@max", "gpt-5.6-sol", "openai", 100, 100, 1),
      card("cursor/gpt-5.6-terra@high", "cursor/gpt-5.6-terra", "cursor", 100, 100, 1),
    ];
    const unit = buildSelectionUnit({
      cwd, key: "standalone", description: "implement complex multi-file migration",
      prompt: "implement complex multi-file migration", cards, automaticCards: cards, host,
    });
    assert.equal(unit.recommended_model_id, "openai/strong@high");
    assert.deepEqual(unit.candidates.filter((item) => item.selectable).map((item) => item.model_id), [
      "openai/strong@high", "alibaba-token-plan/cheap@low",
    ]);
    assert.equal(unit.candidates.find((item) => item.model_id === "kimi/k3@max")?.host.code, "HOST_ROUTE_UNAVAILABLE");
    assert.equal(unit.candidates.find((item) => item.model_id === "openai/strong@ultra")?.host.code, "HOST_PROFILE_UNAVAILABLE");
    assert.equal(unit.candidates.some((item) => /gpt-(?:5\.5|5\.6-(?:sol|terra))/.test(item.model_id)), false);
    assert.deepEqual(unit.policy_exclusions.map((item) => item.family), ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"]);
    assert.equal(unit.candidates.find((item) => item.provider === "openai")?.quota.windows[0].remaining_percent, 13);
    assert.equal(unit.candidates.find((item) => item.provider === "alibaba-token-plan")?.quota.reason, "PROVIDER_QUOTA_NOT_REPORTED");
    const proposal = createSelectionProposal(cwd, {
      source: "standalone", units: [unit], sourceFingerprint: selectionSourceFingerprint({ description: unit.description }),
      payload: { description: unit.description },
    });
    assert.deepEqual(proposal.unavailable_by_provider.map((item) => item.provider), ["kimi", "openai"]);
    assert.equal(proposal.unavailable_by_provider.find((item) => item.provider === "openai")?.code, "HOST_PROFILE_UNAVAILABLE");
    assert.equal(readSelectionProposal(cwd, proposal.id).status, "pending_confirmation");
    assert.equal(proposal.model_policy_id, SUBAGENT_MODEL_POLICY_ID);
    assert.deepEqual(proposal.policy_exclusions.map((item) => item.family), ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"]);
    assert.throws(() => buildSelectionUnit({
      cwd, key: "blocked", description: "implement", prompt: "implement", cards, host,
      requestedModelId: "gpt-5.5@high",
    }), new RegExp(SUBAGENT_MODEL_FAMILY_FORBIDDEN));
  }));

  it("discloses a reference score and AA data without making it automatically eligible", () => withHome(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-selection-reference-"));
    publishRouteSnapshot(cwd, { models: [
      { id: "exact", provider: "provider", namespaced: "provider/exact" },
      { id: "fast", provider: "provider", namespaced: "provider/fast" },
    ] });
    const host = writeHostCapabilitySnapshot(cwd, {
      advertisedModels: ["provider/exact", "provider/fast"],
      quotaCatalog: { reports: [] },
    });
    const exact = card("provider/exact", "provider/exact", "provider", 60, 60, 0.5);
    const reference = card("provider/fast", "provider/fast", "provider", 99, 99, 1);
    reference.capability.reference_only = true;
    reference.capability.reference_reasons = ["SERVING_VARIANT_BASE_MODEL_REFERENCE"];
    reference.capability.reference_route_id = "provider/base";
    reference.capability.reference_profile = "";
    reference.capability.aa_slug = "base";
    reference.capability.aa_data = {
      evaluations: { artificial_analysis_coding_index: 99 },
      pricing: { price_1m_input_tokens: 1 },
      performance: { median_output_tokens_per_second: 100 },
      cost: {},
    };
    reference.strengths += "; reference only (SERVING_VARIANT_BASE_MODEL_REFERENCE)";

    const unit = buildSelectionUnit({
      cwd,
      key: "standalone",
      description: "implement a repository migration",
      prompt: "implement a repository migration",
      cards: [exact, reference],
      automaticCards: [exact, reference],
      host,
    });
    const disclosed = unit.candidates.find((candidate) => candidate.model_id === reference.id)!;
    assert.equal(unit.recommended_model_id, exact.id);
    assert.equal(disclosed.selectable, true);
    assert.equal(disclosed.automatic_eligible, false);
    assert.equal(disclosed.reference_only, true);
    assert.equal(disclosed.reference_route_id, "provider/base");
    assert.equal(disclosed.reference_profile, "");
    assert.equal(disclosed.aa_slug, "base");
    assert.ok((disclosed.task_score || 0) > 0, "base-model reference task score remains visible");
    assert.equal(disclosed.aa_data?.pricing.price_1m_input_tokens, 1);
  }));

  it("requires confirmation, permits an exact user override, and binds the approval into ticket and Receipt", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-selection-cli-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      publishRouteSnapshot(cwd, { models: [
        { id: "strong", provider: "provider-a", namespaced: "provider-a/strong", reasoningEfforts: ["high"] },
        { id: "cheap", provider: "provider-b", namespaced: "provider-b/cheap", reasoningEfforts: ["low"] },
      ] });
      writeCapabilitySnapshot({
        dbPath: artificialAnalysisDbPath(cwd),
        metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-19T00:00:00Z" },
        models: [
          { id: "aa-strong", slug: "aa-strong", name: "Strong", evaluations: { artificial_analysis_intelligence_index: 90, artificial_analysis_coding_index: 95, artificial_analysis_agentic_index: 90 }, pricing: {}, performance: {}, cost: {} },
          { id: "aa-cheap", slug: "aa-cheap", name: "Cheap", evaluations: { artificial_analysis_intelligence_index: 40, artificial_analysis_coding_index: 50, artificial_analysis_agentic_index: 30 }, pricing: {}, performance: {}, cost: {} },
        ],
        mappings: [
          { routeId: "strong", profile: "high", aaSlug: "aa-strong" },
          { routeId: "cheap", profile: "low", aaSlug: "aa-cheap" },
        ],
      });
      writeHostCapabilitySnapshot(cwd, {
        advertisedModels: ["provider-a/strong", "provider-b/cheap"],
        advertisedProfiles: { "provider-a/strong": ["high"], "provider-b/cheap": ["low"] },
        quotaCatalog: { reports: [] },
      });
      const proposedOut = capture();
      assert.equal(await run(["spawn", "implement a complex multi-file repository migration", "--json"], { cwd, env, stdout: proposedOut, stderr: capture() }), 0);
      const proposal = JSON.parse(proposedOut.text());
      assert.equal(proposal.units[0].recommended_model_id, "provider-a/strong@high");
      assert.equal(fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")), false);

      const disclosed = capture();
      assert.equal(await run(["selection", "show", proposal.id], { cwd, env, stdout: disclosed, stderr: disclosed }), 0);
      assert.match(disclosed.text(), /\[confirmation required\]/);
      assert.match(disclosed.text(), /preferred: provider-a\/strong@high/);
      assert.match(disclosed.text(), /candidates:/);
      assert.match(disclosed.text(), /\| Candidate \| Preferred \| Provider \| Evidence \| Task score \| AA I\/C\/A \|/);
      assert.match(disclosed.text(), /\| provider-a\/strong@high \| yes \| provider-a \| exact \| \d+ \| 90\/95\/90 \|/);
      assert.match(disclosed.text(), /\| Provider \| Status \| Source \| Remaining\/reset or unknown reason \| Observed at \|/);
      assert.match(disclosed.text(), /PROVIDER_QUOTA_NOT_REPORTED/);
      assert.match(disclosed.text(), /AVAILABLE/);
      assert.match(disclosed.text(), /No ticket exists yet/);

      const forbidden = capture();
      assert.equal(await run(["selection", "approve", proposal.id, "--confirm", "--model", "gpt-5.6-terra@max"], { cwd, env, stdout: forbidden, stderr: forbidden }), 1);
      assert.match(forbidden.text(), new RegExp(SUBAGENT_MODEL_FAMILY_FORBIDDEN));
      assert.equal(fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")), false);

      const stored = readSelectionProposal(cwd, proposal.id);
      stored.model_policy_id = "legacy-policy";
      writeSelectionProposal(cwd, stored);
      const stalePolicy = capture();
      assert.equal(await run(["selection", "approve", proposal.id, "--confirm"], { cwd, env, stdout: stalePolicy, stderr: stalePolicy }), 1);
      assert.match(stalePolicy.text(), /MODEL_POLICY_CHANGED/);
      stored.model_policy_id = SUBAGENT_MODEL_POLICY_ID;
      writeSelectionProposal(cwd, stored);

      const blocked = capture();
      assert.equal(await run(["selection", "approve", proposal.id], { cwd, env, stdout: blocked, stderr: blocked }), 1);
      assert.match(blocked.text(), /MODEL_SELECTION_NOT_CONFIRMED/);

      const approved = capture();
      assert.equal(await run(["selection", "approve", proposal.id, "--confirm", "--model", "provider-b/cheap@low", "--json"], { cwd, env, stdout: approved, stderr: approved }), 0, approved.text());
      const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0001.json"), "utf8"));
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${ticket.receipt_id}.json`), "utf8"));
      assert.equal(ticket.model_id, "provider-b/cheap@low");
      assert.equal(ticket.selection.confirmed_by, "user");
      assert.equal(ticket.selection.changed_by_user, true);
      assert.deepEqual(receipt.selection, ticket.selection);
      const dispatch = capture();
      assert.equal(await run(["dispatch", "next", "--capacity", "1", "--json"], { cwd, env, stdout: dispatch, stderr: dispatch }), 0);
      assert.equal(JSON.parse(dispatch.text()).reserved[0].selection.approval_id, ticket.selection.approval_id);
    });
  });

  it("invalidates a pending proposal when the Codex host snapshot changes", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-selection-stale-"));
      const env = fakeEnv(home);
      await run(["init"], { cwd, env, stdout: capture(), stderr: capture() });
      publishRouteSnapshot(cwd, { models: [{ id: "k3", provider: "kimi", namespaced: "kimi/k3" }] });
      writeHostCapabilitySnapshot(cwd, { advertisedModels: ["kimi/k3"], quotaCatalog: { reports: [] } });
      const out = capture();
      assert.equal(await run(["spawn", "implement the repository migration", "--model", "kimi/k3", "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const proposal = JSON.parse(out.text());
      writeHostCapabilitySnapshot(cwd, { advertisedModels: ["kimi/k3"], quotaCatalog: { reports: [] } });
      const approval = capture();
      assert.equal(await run(["selection", "approve", proposal.id, "--confirm"], { cwd, env, stdout: approval, stderr: approval }), 1);
      assert.match(approval.text(), /HOST_CAPABILITIES_STALE/);
      assert.equal(fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")), false);
    });
  });

  it("syncs the host route intersection and sanitized quota through the CLI", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-sync-"));
      const env = fakeEnv(home);
      publishRouteSnapshot(cwd, { models: [{ id: "sol", provider: "openai", namespaced: "openai/sol", reasoningEfforts: ["low", "high"] }] });
      const out = capture();
      const runner = (input) => ({
        status: 0,
        stdout: input.args[0] === "provider" ? JSON.stringify({ reports: [{ provider: "openai", quota: { weeklyPercent: 25 } }] }) : "",
        stderr: "",
        error: null,
      });
      const resolve = () => ({ source: "path" as const, command: "ocx", prefixArgs: [] });
      assert.equal(await run(["host", "sync", "--model", "openai/sol", "--profile", "openai/sol=low,high", "--model", "kimi/k3"], { cwd, env, stdout: out, stderr: out, runner, resolve }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.deepEqual(result.effective_models, ["openai/sol"]);
      assert.deepEqual(result.host_only_models, ["kimi/k3"]);
      assert.deepEqual(result.effective_profiles, { "openai/sol": ["high", "low"] });
      assert.equal(result.snapshot.provider_quotas[0].windows[0].remaining_percent, 75);
    });
  });

  it("uses sanitized CodexBar quota only for a provider OpenCodex did not report", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-codexbar-"));
      const env = fakeEnv(home);
      publishRouteSnapshot(cwd, { models: [
        { id: "strong", provider: "openai", namespaced: "openai/strong" },
        { id: "glm-5.2", provider: "alibaba-token-plan", namespaced: "alibaba-token-plan/glm-5.2" },
      ] });
      const out = capture();
      const runner = () => ({
        status: 0,
        stdout: JSON.stringify({ reports: [{ provider: "openai", source: "chatgpt:wham", quota: { weeklyPercent: 20 } }] }),
        stderr: "",
        error: null,
      });
      const resolve = () => ({ source: "path" as const, command: "ocx", prefixArgs: [] });
      const queried = [];
      const codexBarRunner = (input) => {
        queried.push(input.args[input.args.indexOf("--provider") + 1]);
        return {
          status: 0,
          stdout: JSON.stringify([{ provider: "alibabatokenplan", source: "web", usage: {
            updatedAt: "2026-08-20T00:00:00Z",
            accountEmail: "must-not-persist@example.invalid",
            primary: { usedPercent: 25, windowMinutes: 10_080, resetsAt: "2026-08-24T00:00:00Z" },
          } }]),
          stderr: "",
          error: null,
        };
      };
      assert.equal(await run([
        "host", "sync",
        "--model", "openai/strong",
        "--model", "alibaba-token-plan/glm-5.2",
      ], {
        cwd, env, stdout: out, stderr: out, runner, resolve,
        codexBarResolve: () => "/Applications/CodexBarCLI",
        codexBarRunner,
      }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.deepEqual(queried, ["alibaba-token-plan"], "OpenCodex-reported openai quota must not be queried or overwritten");
      const openai = result.snapshot.provider_quotas.find((item) => item.provider === "openai");
      const alibaba = result.snapshot.provider_quotas.find((item) => item.provider === "alibaba-token-plan");
      assert.equal(openai.source, "chatgpt:wham");
      assert.equal(openai.windows[0].remaining_percent, 80);
      assert.equal(alibaba.source, "codexbar:alibaba-token-plan:web");
      assert.equal(alibaba.windows[0].remaining_percent, 75);
      assert.doesNotMatch(JSON.stringify(result.snapshot), /must-not-persist@example\.invalid/);
    });
  });

  it("keeps missing quota fail-soft when CodexBar is not installed or callable", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-no-codexbar-"));
      const env = fakeEnv(home);
      publishRouteSnapshot(cwd, { models: [
        { id: "glm-5.2", provider: "alibaba-token-plan", namespaced: "alibaba-token-plan/glm-5.2" },
      ] });
      let called = false;
      const out = capture();
      assert.equal(await run(["host", "sync", "--model", "alibaba-token-plan/glm-5.2"], {
        cwd, env, stdout: out, stderr: out,
        resolve: () => ({ source: "path" as const, command: "ocx", prefixArgs: [] }),
        runner: () => ({ status: 0, stdout: JSON.stringify({ reports: [] }), stderr: "", error: null }),
        codexBarResolve: () => null,
        codexBarRunner: () => {
          called = true;
          return { status: 0, stdout: "[]", stderr: "", error: null };
        },
      }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(called, false);
      assert.deepEqual(result.snapshot.provider_quotas, []);
    });
  });
});
