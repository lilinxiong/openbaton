import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRouteCandidates, normalizeRouteCatalog, publishRouteSnapshot, readRouteSnapshot } from "../src/lib/routes.js";
import { runRoutes } from "../src/commands/routes.js";

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
    assert.equal(candidates[0].executable, true);
    assert.equal(candidates[1].executable, false);
    assert.equal(candidates[0].capability?.unranked, true);
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
});
