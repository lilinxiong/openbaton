import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { discoverAdapterManifests, validateAdapterManifest } from "../src/adapters/sdk.js";
import { createCliAdapterRegistrySnapshot, getCliAdapter, listCliAdapters } from "../src/adapters/registry.js";
import { fixtureAdapterEnv, FIXTURE_ALPHA, FIXTURE_BETA } from "./home.js";

describe("manifest adapter registry", () => {
  it("discovers alpha/beta deterministically", () => {
    const env = fixtureAdapterEnv();
    assert.deepEqual(discoverAdapterManifests(env).map((m) => m.adapter.id), ["alpha", "beta"]);
    const adapters = listCliAdapters(env);
    assert.deepEqual(adapters.map((a) => a.id), ["alpha", "beta"]);
    assert.equal(adapters[0].host.executionHandleKind, "alpha-task");
    assert.equal(discoverAdapterManifests(fixtureAdapterEnv())[0].quota.max_concurrent_subagents, 2);
    assert.strictEqual(getCliAdapter("alpha", env).id, "alpha");
  });
  it("accepts the legacy manifest quota spelling but returns only the canonical field", () => {
    const manifest = JSON.parse(fs.readFileSync(`${FIXTURE_ALPHA}/adapter.json`, "utf8")) as Record<string, unknown>;
    const quota = { ...(manifest.quota as Record<string, unknown>) };
    delete quota.max_concurrent_subagents;
    quota.max_concurrent = 2;
    const normalized = validateAdapterManifest({ ...manifest, quota }, FIXTURE_ALPHA);
    assert.deepEqual(normalized.quota, { max_concurrent_subagents: 2, max_depth: 3 });
    assert.throws(() => validateAdapterManifest({ ...manifest, quota: { ...quota, max_concurrent_subagents: 3 } }, FIXTURE_ALPHA), /aliases conflict/);
  });
  it("rejects duplicate and malformed manifests", () => {
    assert.throws(() => discoverAdapterManifests({ ...fixtureAdapterEnv(), BATON_ADAPTER_PATHS: [FIXTURE_ALPHA, FIXTURE_ALPHA].join(":" ) }), /ADAPTER_DUPLICATE/);
    assert.throws(() => discoverAdapterManifests({ ...fixtureAdapterEnv(), BATON_ADAPTER_PATHS: FIXTURE_BETA + "/missing" }), /ADAPTER_MANIFEST_INVALID/);
  });
  it("runs catalogs independently with exact metadata", async () => {
    const env = fixtureAdapterEnv();
    const alpha = await getCliAdapter("alpha", env).discoverModels({ env });
    const beta = await getCliAdapter("beta", env).discoverModels({ env });
    assert.equal(alpha.adapter_id, "alpha");
    assert.equal(alpha.models[0].id, "alpha-model");
    assert.equal(beta.adapter_id, "beta");
    assert.equal(beta.models[0].service_tiers[0].id, "standard");
  });
  it("builds one reusable registry snapshot without rescanning manifests", () => {
    const env = fixtureAdapterEnv();
    const mutableFs = fs as typeof fs & { readFileSync: (...args: any[]) => any };
    const originalReadFileSync = mutableFs.readFileSync;
    let manifestReads = 0;
    mutableFs.readFileSync = (...args: any[]) => {
      if (String(args[0]).endsWith("adapter.json")) manifestReads += 1;
      return originalReadFileSync(...args);
    };
    try {
      const snapshot = createCliAdapterRegistrySnapshot(env);
      assert.deepEqual(snapshot.adapters.map((adapter) => adapter.id), ["alpha", "beta"]);
      assert.strictEqual(getCliAdapter("alpha", env, snapshot), snapshot.adapters[0]);
      assert.strictEqual(listCliAdapters(env, snapshot), snapshot.adapters);
      assert.equal(manifestReads, 2);
    } finally {
      mutableFs.readFileSync = originalReadFileSync;
    }
  });
});
