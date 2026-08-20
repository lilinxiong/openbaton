import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRouteCandidates, capabilityRouteId, normalizeRouteCatalog, publishRouteSnapshot, readRouteSnapshot, routeSnapshotSchemaVersion, servingBaseCapabilityIds } from "../src/lib/routes.js";
import { ensureRouteSnapshotFresh, runRoutes } from "../src/commands/routes.js";
import { routeSnapshotPath } from "../src/lib/paths.js";
import { isolatedHome } from "./home.js";
import { writeCapabilitySnapshot } from "../src/lib/capabilities/store.js";

isolatedHome("baton-routes-home-");

function cwd(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "baton-routes-")); }
function sink() { const chunks: string[] = []; return { write(value: string) { chunks.push(value); }, text() { return chunks.join(""); } }; }

describe("OpenCodex Route Snapshot", () => {
  it("normalizes, fingerprints, and increments generation only on catalog change", () => {
    const root = cwd();
    const first = publishRouteSnapshot(root, { models: [{ id: "kimi/k3-256k", provider: "kimi" }, "xai/grok-4.6"] }, new Date("2026-08-19T00:00:00Z"));
    assert.equal(first.changed, true);
    assert.equal(first.snapshot.generation, 1);
    const same = publishRouteSnapshot(root, { models: ["xai/grok-4.6", { id: "kimi/k3-256k", provider: "kimi" }] }, new Date("2026-08-20T00:00:00Z"));
    assert.equal(same.changed, false);
    assert.equal(same.snapshot.generation, 1);
    const changed = publishRouteSnapshot(root, { models: ["kimi/k3-256k"] });
    assert.equal(changed.snapshot.generation, 2);
    assert.equal(readRouteSnapshot(root)?.routes.length, 1);
    assert.ok(routeSnapshotPath(root).includes(path.join(".baton", "cache")));
    assert.ok(!fs.existsSync(path.join(root, ".baton")));
  });

  it("refreshes from injectable OpenCodex and keeps unavailable cards non-executable", () => {
    const root = cwd();
    const stdout = sink();
    const code = runRoutes(["refresh"], {
      cwd: root,
      stdout,
      resolve: () => ({ source: "path", command: "/fake/ocx", prefixArgs: [] }),
      runner: ({ args }) => ({
        status: 0,
        stdout: args[0] === "--version" ? "opencodex 2.26.0\n" : JSON.stringify({ liveModels: ["kimi/k3-256k"] }),
        stderr: "",
        error: null,
      }),
    });
    assert.equal(code, 0);
    const refreshed = JSON.parse(stdout.text()).snapshot;
    assert.equal(refreshed.schema_version, 2);
    assert.equal(refreshed.engine_version, "opencodex 2.26.0");
    assert.equal(refreshed.routes[0].id, "kimi/k3-256k");
    const candidates = buildRouteCandidates(root, path.join(root, "missing.sqlite3"));
    assert.equal(candidates.find((item) => item.card.id === "kimi/k3-256k")?.executable, true);
    assert.equal(candidates.find((item) => item.card.id === "kimi/k3-256k")?.capability?.unranked, true);
  });

  it("rejects malformed catalogs", () => {
    assert.throws(() => normalizeRouteCatalog({ nope: true }), /model catalog/);
  });

  it("joins provider plus bare catalog id to a namespaced spawn route", () => {
    const root = cwd();
    publishRouteSnapshot(root, { models: [{ id: "k3[1m]", provider: "kimi" }] });
    const [candidate] = buildRouteCandidates(root, path.join(root, "missing.sqlite3"));
    assert.equal(candidate.executable, true);
    assert.equal(candidate.card.id, "kimi/k3[1m]");
  });

  it("preserves exact OpenCodex route ids and makes disabled routes visible but unavailable", () => {
    const root = cwd();
    const dbPath = path.join(root, "aa.sqlite3");
    publishRouteSnapshot(root, [
      {
        provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", native: true, disabled: false,
        reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low",
      },
      {
        provider: "cursor", id: "gpt-5.6-sol", namespaced: "cursor/gpt-5.6-sol", disabled: true,
        reasoningEfforts: ["low", "high", "max"],
      },
      { provider: "openai", id: "gpt-5.4", namespaced: "gpt-5.4", native: true, disabled: true },
    ]);
    writeCapabilitySnapshot({
      dbPath,
      metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-19T00:00:00Z" },
      models: [{
        id: "aa-sol", slug: "gpt-5-6-sol-high", name: "GPT-5.6 Sol high",
        evaluations: { artificial_analysis_intelligence_index: 80, artificial_analysis_coding_index: 90 },
        pricing: {}, performance: {}, cost: {},
      }],
      // The cache intentionally has no mappings: the committed mapping file
      // must take effect without a remote AA refresh.
      mappings: [],
    });

    const snapshot = readRouteSnapshot(root)!;
    assert.equal(snapshot.routes.find((route) => route.provider === "openai" && route.id === "gpt-5.6-sol")?.route_id, "gpt-5.6-sol");
    assert.equal(snapshot.routes.find((route) => route.provider === "cursor")?.route_id, "cursor/gpt-5.6-sol");

    const candidates = buildRouteCandidates(root, dbPath);
    assert.equal(candidates.some((item) => item.card.id === "gpt-5.6-sol@high" && item.executable), true);
    assert.equal(candidates.some((item) => item.card.id === "gpt-5.6-sol@max"), false, "unsupported native profile");
    assert.equal(candidates.some((item) => item.card.id === "cursor/gpt-5.6-sol@high" && !item.executable), true);
    assert.equal(candidates.some((item) => item.card.id === "gpt-5.4" && !item.executable), true);
  });

  it("uses a provider-neutral capability identity while preserving exact execution routes", () => {
    const root = cwd();
    const dbPath = path.join(root, "aa.sqlite3");
    publishRouteSnapshot(root, [
      { provider: "cursor", id: "claude-opus-5", namespaced: "cursor/claude-opus-5", reasoningEfforts: ["high"] },
      { provider: "mimo", id: "mimo-v2.5-pro", namespaced: "mimo/mimo-v2.5-pro" },
    ]);
    writeCapabilitySnapshot({
      dbPath,
      metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-19T00:00:00Z" },
      models: [{
        id: "aa-opus", slug: "claude-opus-5-high", name: "Claude Opus 5 high",
        evaluations: { artificial_analysis_intelligence_index: 80 },
        pricing: {}, performance: {}, cost: {},
      }, {
        id: "aa-mimo", slug: "mimo-v2-5-pro", name: "MiMo V2.5 Pro",
        evaluations: { artificial_analysis_intelligence_index: 70 },
        pricing: {}, performance: {}, cost: {},
      }],
      mappings: [],
    });

    const snapshot = readRouteSnapshot(root)!;
    assert.deepEqual(snapshot.routes.map(capabilityRouteId), ["claude-opus-5", "mimo-v2.5-pro"]);
    const candidates = buildRouteCandidates(root, dbPath);
    const opus = candidates.find((item) => item.card.id === "cursor/claude-opus-5@high");
    const mimo = candidates.find((item) => item.card.id === "mimo/mimo-v2.5-pro");
    assert.equal(opus?.card.route_id, "cursor/claude-opus-5");
    assert.equal(opus?.card.capability?.aa_slug, "claude-opus-5-high");
    assert.equal(opus?.card.capability?.mapping_source, "normalized-model-id");
    assert.equal(mimo?.card.route_id, "mimo/mimo-v2.5-pro");
    assert.equal(mimo?.card.capability?.aa_slug, "mimo-v2-5-pro");
    assert.ok(opus?.capability?.ranked && mimo?.capability?.ranked);
  });

  it("discloses base-profile, serving-variant, and partial-AA evidence as reference only", () => {
    const root = cwd();
    const dbPath = path.join(root, "aa.sqlite3");
    publishRouteSnapshot(root, [
      { provider: "cursor", id: "grok-4.6-fast", namespaced: "cursor/grok-4.6-fast", reasoningEfforts: ["low"] },
      { provider: "cursor", id: "claude-fable-5", namespaced: "cursor/claude-fable-5", reasoningEfforts: ["low"] },
      { provider: "cursor", id: "claude-sonnet-5", namespaced: "cursor/claude-sonnet-5", reasoningEfforts: ["high"] },
    ]);
    writeCapabilitySnapshot({
      dbPath,
      metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-20T00:00:00Z" },
      models: [{
        id: "aa-grok", slug: "grok-4-6", name: "Grok 4.6",
        evaluations: {
          artificial_analysis_intelligence_index: 70,
          artificial_analysis_coding_index: 80,
          artificial_analysis_agentic_index: 60,
        },
        pricing: {}, performance: {}, cost: {},
      }, {
        id: "aa-fable", slug: "claude-fable-5", name: "Claude Fable 5",
        evaluations: {
          artificial_analysis_intelligence_index: 65,
          artificial_analysis_coding_index: 75,
          artificial_analysis_agentic_index: 55,
        },
        pricing: {}, performance: {}, cost: {},
      }, {
        id: "aa-sonnet-high", slug: "claude-sonnet-5-high", name: "Claude Sonnet 5 high",
        evaluations: {
          artificial_analysis_intelligence_index: null,
          artificial_analysis_coding_index: null,
          artificial_analysis_agentic_index: null,
        },
        pricing: { price_1m_input_tokens: 2, price_1m_output_tokens: 10 },
        performance: { median_output_tokens_per_second: 64.08, median_time_to_first_answer_token_seconds: 7.89 },
        cost: {},
      }],
      mappings: [],
    });

    assert.deepEqual(servingBaseCapabilityIds("grok-4.6-fast-highspeed"), ["grok-4.6-fast", "grok-4.6"]);
    const candidates = buildRouteCandidates(root, dbPath);
    const fast = candidates.find((item) => item.card.id === "cursor/grok-4.6-fast");
    assert.equal(fast?.card.capability?.ranked, true);
    assert.equal(fast?.card.capability?.reference_only, true);
    assert.deepEqual(fast?.card.capability?.reference_reasons, ["SERVING_VARIANT_BASE_MODEL_REFERENCE"]);
    assert.equal(fast?.card.capability?.aa_slug, "grok-4-6");
    assert.equal(fast?.card.capability?.reference_route_id, "grok-4.6");

    const fastLow = candidates.find((item) => item.card.id === "cursor/grok-4.6-fast@low");
    assert.equal(fastLow?.card.capability?.ranked, true);
    assert.deepEqual(fastLow?.card.capability?.reference_reasons, [
      "SERVING_VARIANT_BASE_MODEL_REFERENCE",
      "BASE_PROFILE_REFERENCE",
    ]);
    assert.equal(fastLow?.card.capability?.reference_profile, "");

    const fableLow = candidates.find((item) => item.card.id === "cursor/claude-fable-5@low");
    assert.equal(fableLow?.card.capability?.ranked, true);
    assert.equal(fableLow?.card.capability?.reference_only, true);
    assert.deepEqual(fableLow?.card.capability?.reference_reasons, ["BASE_PROFILE_REFERENCE"]);
    assert.equal(fableLow?.card.capability?.reference_route_id, "claude-fable-5");

    const sonnetHigh = candidates.find((item) => item.card.id === "cursor/claude-sonnet-5@high");
    assert.equal(sonnetHigh?.card.capability?.ranked, false);
    assert.equal(sonnetHigh?.card.capability?.reference_only, true);
    assert.deepEqual(sonnetHigh?.card.capability?.reference_reasons, ["AA_RANKING_METRICS_MISSING"]);
    assert.equal(sonnetHigh?.card.capability?.aa_data?.pricing.price_1m_input_tokens, 2);
    assert.equal(sonnetHigh?.card.capability?.aa_data?.performance.median_output_tokens_per_second, 64.08);
    assert.match(sonnetHigh?.card.strengths || "", /AA partial reference only/);
  });

  it("rejects legacy snapshots instead of reconstructing route ids", () => {
    const root = cwd();
    const file = routeSnapshotPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, generation: 1, routes: [{ id: "gpt-5.6-sol", provider: "openai" }] }));
    assert.equal(routeSnapshotSchemaVersion(root), 1);
    assert.equal(readRouteSnapshot(root), null);
  });

  it("refreshes an existing snapshot when the OpenCodex runtime version changes", () => {
    const root = cwd();
    publishRouteSnapshot(root, [{ provider: "kimi", id: "k3", namespaced: "kimi/k3" }], new Date("2026-08-19T00:00:00Z"), {
      engineVersion: "opencodex 2.25.0",
    });
    const calls: string[][] = [];
    ensureRouteSnapshotFresh({
      cwd: root,
      stdout: sink(),
      resolve: () => ({ source: "path", command: "/fake/ocx", prefixArgs: [] }),
      runner: ({ args }) => {
        calls.push(args);
        return {
          status: 0,
          stdout: args[0] === "--version"
            ? "opencodex 2.26.0\n"
            : JSON.stringify([{ provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", native: true }]),
          stderr: "",
          error: null,
        };
      },
    });
    assert.deepEqual(calls, [["--version"], ["--version"], ["models", "live", "--json"]]);
    assert.equal(readRouteSnapshot(root)?.engine_version, "opencodex 2.26.0");
    assert.equal(readRouteSnapshot(root)?.routes[0].route_id, "gpt-5.6-sol");
  });

  it("generates ranked profile cards from AA and keeps unmapped live routes visible", () => {
    const root = cwd();
    const dbPath = path.join(root, "aa.sqlite3");
    publishRouteSnapshot(root, { models: [
      { id: "model-a", provider: "provider-a", reasoningEfforts: ["high"] },
      { id: "model-a", provider: "provider-b", reasoningEfforts: ["low"] },
      { id: "unmapped", provider: "provider-c" },
    ] });
    writeCapabilitySnapshot({
      dbPath,
      metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-19T00:00:00Z" },
      models: [{
        id: "aa-a", slug: "aa-model-a", name: "AA Model A",
        evaluations: {
          artificial_analysis_intelligence_index: 70,
          artificial_analysis_coding_index: 80,
          artificial_analysis_agentic_index: 60,
        },
        pricing: {}, performance: {}, cost: {},
      }],
      mappings: [
        { routeId: "model-a", profile: "high", aaSlug: "aa-model-a" },
        { routeId: "model-a", profile: "low", aaSlug: "aa-model-a" },
        { routeId: "model-a", profile: "max", aaSlug: "aa-model-a" },
      ],
    });
    const candidates = buildRouteCandidates(root, dbPath);
    assert.equal(candidates.some((item) => item.card.id === "provider-a/model-a@high" && item.card.capability?.ranked), true);
    assert.equal(candidates.some((item) => item.card.id === "provider-b/model-a@low" && item.card.capability?.ranked), true);
    assert.equal(candidates.some((item) => item.card.id.endsWith("model-a@max")), false);
    assert.equal(candidates.some((item) => item.card.id === "provider-c/unmapped" && item.card.capability?.unranked), true);
    assert.equal(candidates.filter((item) => item.card.route_id?.endsWith("/model-a")).length, 4);
  });

  it("does not let capability mappings expand an OpenCodex route with no supported profiles", () => {
    const root = cwd();
    const dbPath = path.join(root, "aa.sqlite3");
    publishRouteSnapshot(root, { models: [{
      id: "k3-256k", provider: "kimi", namespaced: "kimi/k3-256k", reasoningEfforts: [],
    }] });
    writeCapabilitySnapshot({
      dbPath,
      metadata: { provider: "aa", tier: "free", fetchedAt: "2026-08-19T00:00:00Z" },
      models: [{
        id: "aa-k3", slug: "kimi-k3", name: "Kimi K3",
        evaluations: { artificial_analysis_intelligence_index: 70 },
        pricing: {}, performance: {}, cost: {},
      }],
      mappings: [
        { routeId: "kimi/k3-256k", profile: "low", aaSlug: "kimi-k3" },
        { routeId: "kimi/k3-256k", profile: "max", aaSlug: "kimi-k3" },
      ],
    });

    assert.deepEqual(buildRouteCandidates(root, dbPath).map((item) => item.card.id), ["kimi/k3-256k"]);
  });

  it("returns only exact OpenCodex route ids", () => {
    const root = cwd();
    publishRouteSnapshot(root, { models: [
      { id: "one", provider: "provider" },
      { id: "two", provider: "provider" },
    ] });
    const candidates = buildRouteCandidates(root, path.join(root, "missing.sqlite3"));
    assert.deepEqual(candidates.map((item) => item.card.id), ["provider/one", "provider/two"]);
    assert.ok(candidates.every((item) => item.card.source === "dynamic"));
  });

  it("keeps every OpenCodex-supported profile visible when AA has no mapping", () => {
    const root = cwd();
    publishRouteSnapshot(root, { models: [{
      id: "model-a", provider: "provider", namespaced: "provider/model-a",
      reasoningEfforts: ["low", "high"],
    }] });
    const candidates = buildRouteCandidates(root, path.join(root, "missing.sqlite3"));
    assert.deepEqual(candidates.map((item) => item.card.id), [
      "provider/model-a",
      "provider/model-a@high",
      "provider/model-a@low",
    ]);
    assert.ok(candidates.every((item) => item.executable && item.card.capability?.unranked));
  });
});
