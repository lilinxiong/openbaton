import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 被测实现尚不存在（AA capability cache 待实现），导入失败即本文件整体失败。
import {
  fetchArtificialAnalysisModels,
  normalizeArtificialAnalysisModel,
} from "../src/lib/capabilities/aa.js";
import {
  normalizedAaSlug,
  writeCapabilitySnapshot,
  queryRouteCapability,
  readCapabilityStatus,
} from "../src/lib/capabilities/store.js";

const API_KEY = "test-aa-key-SECRET";
const DEFAULT_BASE = "https://artificialanalysis.ai";

function rawModel(overrides = {}) {
  return {
    id: 42,
    slug: "kimi-k3",
    name: "Kimi K3",
    release_date: "2026-08-01",
    model_creator: { slug: "moonshot", name: "Moonshot AI" },
    evaluations: { intelligence_index: 52.4, coding_index: null },
    pricing: { price_1m_input_tokens: 0.6, price_1m_output_tokens: 2.5 },
    performance: { median_output_tokens_per_second: 68.1, median_time_to_first_token_seconds: null },
    cost: { cost_1m_blended_3_to_1: 1.08 },
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function pagedFetch(pages) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const page = Number(new URL(String(url)).searchParams.get("page"));
    return jsonResponse(200, pages[page]);
  };
  return { calls, fetchImpl };
}

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-caps-"));
  return path.join(dir, "capabilities.sqlite");
}

describe("fetchArtificialAnalysisModels", () => {
  it("walks pagination.has_more across two pages and sends x-api-key on every request", async () => {
    const { calls, fetchImpl } = pagedFetch({
      1: {
        data: [rawModel({ slug: "kimi-k3" })],
        pagination: { has_more: true, next_page: 2 },
      },
      2: {
        data: [rawModel({ id: 43, slug: "gpt-5.2", name: "GPT-5.2" })],
        pagination: { has_more: false },
      },
    });

    const result = await fetchArtificialAnalysisModels({ apiKey: API_KEY, fetchImpl });

    assert.equal(calls.length, 2);
    for (const [i, call] of calls.entries()) {
      const url = new URL(call.url);
      assert.equal(url.origin, DEFAULT_BASE);
      assert.equal(url.pathname, "/api/v2/language/models/free");
      assert.equal(url.searchParams.get("page"), String(i + 1));
      assert.equal(call.init.headers["x-api-key"], API_KEY);
    }
    assert.equal(result.models.length, 2);
    assert.deepEqual(
      result.models.map((m) => m.slug),
      ["kimi-k3", "gpt-5.2"],
    );
    assert.equal(result.metadata.source, "artificialanalysis");
    assert.equal(typeof result.metadata.indexVersion, "string");
    assert.equal(typeof result.metadata.fetchedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(result.metadata.fetchedAt)));
  });

  it("honors a custom baseUrl", async () => {
    const { calls, fetchImpl } = pagedFetch({
      1: { data: [], pagination: { has_more: false } },
    });
    await fetchArtificialAnalysisModels({
      apiKey: API_KEY,
      fetchImpl,
      baseUrl: "https://aa-proxy.internal/",
    });
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).origin, "https://aa-proxy.internal");
  });

  it("deduplicates identical records repeated across pages", async () => {
    const model = rawModel();
    const { fetchImpl } = pagedFetch({
      1: { data: [model], pagination: { has_more: true } },
      2: { data: [structuredClone(model)], pagination: { has_more: false } },
    });
    const result = await fetchArtificialAnalysisModels({ apiKey: API_KEY, fetchImpl });
    assert.equal(result.models.length, 1);
  });

  it("keeps the first page when duplicate identity has metric drift", async () => {
    const { fetchImpl } = pagedFetch({
      1: { data: [rawModel()], pagination: { has_more: true } },
      2: { data: [rawModel({ evaluations: { intelligence_index: 99 } })], pagination: { has_more: false } },
    });
    const result = await fetchArtificialAnalysisModels({ apiKey: API_KEY, fetchImpl });
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].evaluations.intelligence_index, 52.4);
    assert.equal(result.metadata.duplicateRecords, 1);
  });

  it("fails closed when one slug has conflicting identity", async () => {
    const { fetchImpl } = pagedFetch({
      1: { data: [rawModel()], pagination: { has_more: true } },
      2: { data: [rawModel({ id: 99, name: "Different identity" })], pagination: { has_more: false } },
    });
    await assert.rejects(fetchArtificialAnalysisModels({ apiKey: API_KEY, fetchImpl }), (error) => {
      assert.equal(error.code, "AA_CONFLICTING_MODEL");
      return true;
    });
  });

  it("fails closed without an apiKey and never calls fetch", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      throw new Error("must not be called");
    };
    await assert.rejects(
      fetchArtificialAnalysisModels({ apiKey: undefined, fetchImpl }),
      (err) => {
        assert.equal(err.code, "AA_API_KEY_MISSING");
        return true;
      },
    );
    assert.equal(called, false);
  });

  for (const [status, code] of [
    [401, "AA_UNAUTHORIZED"],
    [403, "AA_FORBIDDEN"],
    [429, "AA_RATE_LIMITED"],
  ]) {
    it(`classifies HTTP ${status} as ${code} and never leaks the api key`, async () => {
      const fetchImpl = async () => jsonResponse(status, { error: "denied" });
      await assert.rejects(
        fetchArtificialAnalysisModels({ apiKey: API_KEY, fetchImpl }),
        (err) => {
          assert.equal(err.code, code);
          assert.ok(!String(err.message).includes(API_KEY));
          assert.ok(!String(err.stack || "").includes(API_KEY));
          return true;
        },
      );
    });
  }

  it("does not leak the api key on unexpected fetch failures", async () => {
    const fetchImpl = async () => {
      throw new Error(`upstream refused key=${API_KEY} at socket`);
    };
    await assert.rejects(
      fetchArtificialAnalysisModels({ apiKey: API_KEY, fetchImpl }),
      (err) => {
        assert.ok(!String(err.message).includes(API_KEY));
        return true;
      },
    );
  });
});

describe("normalizeArtificialAnalysisModel", () => {
  it("keeps identity fields and numeric evaluation/pricing/performance/cost fields", () => {
    const m = normalizeArtificialAnalysisModel(rawModel());
    assert.equal(m.id, 42);
    assert.equal(m.slug, "kimi-k3");
    assert.equal(m.name, "Kimi K3");
    assert.equal(m.release_date, "2026-08-01");
    assert.deepEqual(m.model_creator, { slug: "moonshot", name: "Moonshot AI" });
    assert.equal(m.evaluations.intelligence_index, 52.4);
    assert.equal(m.pricing.price_1m_input_tokens, 0.6);
    assert.equal(m.pricing.price_1m_output_tokens, 2.5);
    assert.equal(m.performance.median_output_tokens_per_second, 68.1);
    assert.equal(m.cost.cost_1m_blended_3_to_1, 1.08);
  });

  it("keeps null as null — never coerces to 0", () => {
    const m = normalizeArtificialAnalysisModel(rawModel());
    assert.strictEqual(m.evaluations.coding_index, null);
    assert.strictEqual(m.performance.median_time_to_first_token_seconds, null);
    assert.ok(Object.hasOwn(m.evaluations, "coding_index"));
    assert.ok(Object.hasOwn(m.performance, "median_time_to_first_token_seconds"));
  });

  it("tolerates missing metric groups without inventing values", () => {
    const m = normalizeArtificialAnalysisModel({
      id: 7,
      slug: "bare",
      name: "Bare",
      release_date: null,
      model_creator: null,
    });
    assert.equal(m.slug, "bare");
    assert.strictEqual(m.release_date, null);
    assert.strictEqual(m.model_creator, null);
    for (const group of ["evaluations", "pricing", "performance", "cost"]) {
      const value = m[group];
      assert.ok(value === null || (typeof value === "object" && !Array.isArray(value)));
      if (value && typeof value === "object") {
        for (const v of Object.values(value)) {
          assert.ok(v === null || typeof v === "number", `${group} must stay null-or-number`);
        }
      }
    }
  });
});

describe("capability store", () => {
  const MODELS = [
    { slug: "kimi-k3", name: "Kimi K3", intelligence_index: 52.4, blended_cost_1m: 1.08 },
    { slug: "gpt-5.2", name: "GPT-5.2", intelligence_index: 61.0, blended_cost_1m: 3.2 },
  ];
  const METADATA = {
    tier: "free",
    indexVersion: "2026-08-19",
    fetchedAt: "2026-08-19T02:00:00.000Z",
    source: "artificialanalysis",
  };

  function seed(dbPath, { models = MODELS, metadata = METADATA, mappings = [] } = {}) {
    return writeCapabilitySnapshot({ dbPath, models, metadata, mappings });
  }

  it("exact mapping returns ranked:true with model metrics", () => {
    const dbPath = tmpDbPath();
    seed(dbPath, { mappings: [{ routeId: "codex:kimi/k3-256k", aaSlug: "kimi-k3" }] });
    const hit = queryRouteCapability({ dbPath, routeId: "codex:kimi/k3-256k" });
    assert.equal(hit.ranked, true);
    assert.notEqual(hit.unranked, true);
    assert.equal(hit.model.slug, "kimi-k3");
    assert.equal(hit.model.intelligence_index, 52.4);
    assert.equal(hit.model.blended_cost_1m, 1.08);
  });

  it("resolves a deterministic normalized model/profile slug without a provider-specific mapping", () => {
    const dbPath = tmpDbPath();
    seed(dbPath, {
      models: [{ slug: "claude-opus-5-high", name: "Claude Opus 5 high", intelligence_index: 80 }],
    });
    assert.equal(normalizedAaSlug("claude-opus-5", "high"), "claude-opus-5-high");
    assert.equal(normalizedAaSlug("mimo-v2.5-pro"), "mimo-v2-5-pro");
    const hit = queryRouteCapability({ dbPath, routeId: "claude-opus-5", profile: "high" });
    assert.equal(hit.ranked, true);
    if (!hit.ranked) return;
    assert.equal(hit.aaSlug, "claude-opus-5-high");
    assert.equal(hit.mappingSource, "normalized-model-id");
  });

  it("does not inherit a default mapping into an unmapped reasoning profile", () => {
    const dbPath = tmpDbPath();
    seed(dbPath, { mappings: [{ routeId: "model-a", aaSlug: "kimi-k3" }] });
    const miss = queryRouteCapability({ dbPath, routeId: "model-a", profile: "high" });
    assert.equal(miss.ranked, false);
    assert.equal(miss.unranked, true);
    assert.equal(miss.reason, "no_canonical_mapping");
  });

  it("unknown route returns ranked:false, unranked:true and never a silent default", () => {
    const dbPath = tmpDbPath();
    seed(dbPath, { mappings: [{ routeId: "codex:kimi/k3-256k", aaSlug: "kimi-k3" }] });
    const miss = queryRouteCapability({ dbPath, routeId: "codex:gpt/unknown" });
    assert.equal(miss.ranked, false);
    assert.equal(miss.unranked, true);
    assert.ok(!("model" in miss) || miss.model == null);
  });

  it("mapping whose target slug is absent from the snapshot stays unranked", () => {
    const dbPath = tmpDbPath();
    seed(dbPath, { mappings: [{ routeId: "codex:claude/opus", aaSlug: "claude-opus-4.6" }] });
    const miss = queryRouteCapability({ dbPath, routeId: "codex:claude/opus" });
    assert.equal(miss.ranked, false);
    assert.equal(miss.unranked, true);
  });

  it("a second snapshot atomically replaces models, mappings and metadata", () => {
    const dbPath = tmpDbPath();
    seed(dbPath, { mappings: [{ routeId: "r1", aaSlug: "kimi-k3" }] });
    seed(dbPath, {
      models: [{ slug: "new-model", name: "New", intelligence_index: 99.0, blended_cost_1m: 0.1 }],
      metadata: { ...METADATA, indexVersion: "2026-08-20" },
      mappings: [{ routeId: "r2", aaSlug: "new-model" }],
    });

    const oldRoute = queryRouteCapability({ dbPath, routeId: "r1" });
    assert.equal(oldRoute.ranked, false);
    assert.equal(oldRoute.unranked, true);

    const oldSlug = queryRouteCapability({ dbPath, routeId: "r2" });
    assert.equal(oldSlug.ranked, true);
    assert.equal(oldSlug.model.slug, "new-model");
    assert.equal(oldSlug.model.intelligence_index, 99.0);

    const status = readCapabilityStatus({ dbPath });
    assert.equal(status.metadata.indexVersion, "2026-08-20");
  });

  it("preserves the last-known-good database when a replacement snapshot is invalid", () => {
    const dbPath = tmpDbPath();
    seed(dbPath, { mappings: [{ routeId: "r1", aaSlug: "kimi-k3" }] });
    assert.throws(() => seed(dbPath, {
      models: [
        { id: "one", slug: "conflict", name: "First", intelligence_index: 1 },
        { id: "two", slug: "conflict", name: "Second", intelligence_index: 2 },
      ],
      mappings: [],
    }), /conflicting duplicate capability model identity/);
    const stillThere = queryRouteCapability({ dbPath, routeId: "r1" });
    assert.equal(stillThere.ranked, true);
    assert.equal(stillThere.model.slug, "kimi-k3");
  });

  it("readCapabilityStatus exposes the stored metadata", () => {
    const dbPath = tmpDbPath();
    seed(dbPath);
    const status = readCapabilityStatus({ dbPath });
    assert.equal(status.metadata.tier, "free");
    assert.equal(status.metadata.indexVersion, "2026-08-19");
    assert.equal(status.metadata.fetchedAt, "2026-08-19T02:00:00.000Z");
    assert.equal(status.metadata.source, "artificialanalysis");
  });

  it("readCapabilityStatus on a missing db reports empty instead of throwing", () => {
    const status = readCapabilityStatus({ dbPath: path.join(os.tmpdir(), "baton-caps-no-such-db.sqlite") });
    assert.ok(status == null || status.metadata == null || status.empty === true);
  });
});
