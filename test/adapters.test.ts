import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverAdapterManifests } from "../src/adapters/sdk.js";
import { getCliAdapter, listCliAdapters } from "../src/adapters/registry.js";
import { fixtureAdapterEnv, FIXTURE_ALPHA, FIXTURE_BETA } from "./home.js";

describe("manifest adapter registry", () => {
  it("discovers alpha/beta deterministically", () => {
    const env = fixtureAdapterEnv();
    assert.deepEqual(discoverAdapterManifests(env).map((m) => m.adapter.id), ["alpha", "beta"]);
    const adapters = listCliAdapters(env);
    assert.deepEqual(adapters.map((a) => a.id), ["alpha", "beta"]);
    assert.equal(adapters[0].host.executionHandleKind, "alpha-task");
    assert.equal(adapters[1].host.defaultMaxConcurrent, 5);
    assert.strictEqual(getCliAdapter("alpha", env).id, "alpha");
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
});
