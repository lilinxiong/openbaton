import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRouteCandidates, normalizeRouteCatalog, publishRouteSnapshot, readRouteSnapshot } from "../src/lib/routes.js";
import { runRoutes } from "../src/commands/routes.js";
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
      runner: () => ({ status: 0, stdout: JSON.stringify({ liveModels: ["kimi/k3-256k"] }), stderr: "", error: null }),
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout.text()).snapshot.routes[0].id, "kimi/k3-256k");
    const candidates = buildRouteCandidates(root, [
      { id: "k3", strengths: "", route_id: "kimi/k3-256k" },
      { id: "grok", strengths: "", route_id: "xai/grok-4.6" },
    ], path.join(root, "missing.sqlite3"));
    assert.equal(candidates.find((item) => item.card.id === "k3")?.executable, true);
    assert.equal(candidates.find((item) => item.card.id === "grok")?.executable, false);
    assert.equal(candidates.find((item) => item.card.id === "k3")?.capability?.unranked, true);
  });

  it("rejects malformed catalogs", () => {
    assert.throws(() => normalizeRouteCatalog({ nope: true }), /model catalog/);
  });

  it("joins provider plus bare catalog id to a namespaced spawn route", () => {
    const root = cwd();
    publishRouteSnapshot(root, { models: [{ id: "k3[1m]", provider: "kimi" }] });
    const [candidate] = buildRouteCandidates(root, [{ id: "k3", strengths: "", route_id: "kimi/k3[1m]", reasoning_effort: "max" }], path.join(root, "missing.sqlite3"));
    assert.equal(candidate.executable, true);
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
    const candidates = buildRouteCandidates(root, [], dbPath);
    assert.equal(candidates.some((item) => item.card.id === "provider-a/model-a@high" && item.card.capability?.ranked), true);
    assert.equal(candidates.some((item) => item.card.id === "provider-b/model-a@low" && item.card.capability?.ranked), true);
    assert.equal(candidates.some((item) => item.card.id.endsWith("model-a@max")), false);
    assert.equal(candidates.some((item) => item.card.id === "provider-c/unmapped" && item.card.capability?.unranked), true);
    assert.equal(candidates.filter((item) => item.card.route_id?.endsWith("/model-a")).length, 4);
  });

  it("layers aliases and exclusions over generated cards", () => {
    const root = cwd();
    publishRouteSnapshot(root, { models: [
      { id: "one", provider: "provider" },
      { id: "two", provider: "provider" },
    ] });
    const candidates = buildRouteCandidates(root, [
      { id: "friendly", strengths: "user hint", route_id: "provider/one" },
      { id: "provider/two", strengths: "", route_id: "provider/two", enabled: false },
    ], path.join(root, "missing.sqlite3"));
    assert.equal(candidates.some((item) => item.card.id === "friendly" && item.card.source === "override"), true);
    assert.equal(candidates.some((item) => item.card.route_id === "provider/two"), false);
  });

  it("rejects an unnamespaced alias when the same id exists behind multiple providers", () => {
    const root = cwd();
    publishRouteSnapshot(root, { models: [
      { id: "shared", provider: "provider-a" },
      { id: "shared", provider: "provider-b" },
    ] });
    const candidates = buildRouteCandidates(root, [
      { id: "friendly", strengths: "", route_id: "shared" },
    ], path.join(root, "missing.sqlite3"));
    const friendly = candidates.find((item) => item.card.id === "friendly");
    assert.equal(friendly?.executable, false);
    assert.match(friendly?.card.strengths || "", /ambiguous provider/);
  });
});
