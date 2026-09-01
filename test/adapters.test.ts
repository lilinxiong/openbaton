import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { discoverAdapterManifests, normalizeExactExecutionRootIdentity, validateAdapterManifest } from "../src/adapters/sdk.js";
import { getCliAdapter, listCliAdapters } from "../src/adapters/registry.js";
import { normalizeCliRuntimeCapabilities } from "../src/adapters/shared.js";
import { fixtureAdapterEnv, FIXTURE_ALPHA, FIXTURE_BETA } from "./home.js";

describe("manifest adapter registry", () => {
  it("normalizes only complete canonical exact-root identities", () => {
    const identity = {
      repository_id: "a".repeat(64),
      git_common_dir_identity: "b".repeat(64),
      execution_root: "/tmp/baton/worktrees/run/unit/attempt",
      base_tree: "c".repeat(40),
      worktree_record_id: "worktree-run-unit-attempt",
    };
    assert.deepEqual(normalizeExactExecutionRootIdentity(identity), identity);
    assert.throws(() => normalizeExactExecutionRootIdentity({ ...identity, base_tree: undefined }), /BASE_TREE_INVALID/);
    assert.throws(() => normalizeExactExecutionRootIdentity({ ...identity, execution_root: "/tmp/baton/../caller" }), /PATH_NONCANONICAL/);
    assert.throws(() => normalizeExactExecutionRootIdentity({ ...identity, provider: "codex" }), /UNKNOWN_FIELD/);
  });
  it("discovers alpha/beta deterministically", () => {
    const env = fixtureAdapterEnv();
    assert.deepEqual(discoverAdapterManifests(env).map((m) => m.adapter.id), ["alpha", "beta"]);
    const adapters = listCliAdapters(env);
    assert.deepEqual(adapters.map((a) => a.id), ["alpha", "beta"]);
    assert.equal(adapters[0].host.executionHandleKind, "alpha-task");
    assert.equal(adapters[1].host.defaultMaxConcurrent, 5);
    assert.equal(discoverAdapterManifests(fixtureAdapterEnv())[0].quota.max_concurrent_subagents, 2);
    assert.strictEqual(getCliAdapter("alpha", env).id, "alpha");
  });
  it("normalizes legacy capability spellings to per-tree subagents", () => {
    assert.deepEqual(normalizeCliRuntimeCapabilities({ capabilities: {
      max_concurrent: 4,
      maxConcurrentSubagents: 3,
      max_depth: 2,
    } }), { max_concurrent_subagents: 3, max_depth: 2 });
    assert.deepEqual(normalizeCliRuntimeCapabilities({ maxConcurrent: 2 }), { max_concurrent_subagents: 2 });
    assert.deepEqual(normalizeCliRuntimeCapabilities({ max_concurrent_subagents: 1, maxConcurrent: 4 }), { max_concurrent_subagents: 1 });
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
  it("validates the optional exact-root native capability without provider fields", () => {
    const manifest = JSON.parse(fs.readFileSync(`${FIXTURE_ALPHA}/adapter.json`, "utf8")) as Record<string, unknown>;
    const native = { ...(manifest.native as Record<string, unknown>), exact_execution_root: true };
    assert.equal(validateAdapterManifest({ ...manifest, native }, FIXTURE_ALPHA).native.exact_execution_root, true);
    assert.throws(() => validateAdapterManifest({ ...manifest, native: { ...native, exact_execution_root: "yes" } }, FIXTURE_ALPHA), /must be boolean/);
    assert.throws(() => validateAdapterManifest({ ...manifest, native: { ...native, provider_workspace: true } }, FIXTURE_ALPHA), /unknown native field/);
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
