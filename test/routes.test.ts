import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRouteCandidates, normalizeRouteCatalog, publishRouteSnapshot, readRouteSnapshot, routeSnapshotSchemaVersion } from "../src/lib/routes.js";
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
      { id: "model-a", provider: "provider-a" },
      { id: "model-a", provider: "provider-b" },
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
        { routeId: "provider-a/model-a", profile: "high", aaSlug: "aa-model-a" },
        { routeId: "provider-b/model-a", profile: "low", aaSlug: "aa-model-a" },
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
});
