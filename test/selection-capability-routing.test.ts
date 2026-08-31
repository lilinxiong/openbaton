import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSelectionUnit,
  createSelectionProposal,
  deriveMinimumModelRequirements,
  readSelectionProposal,
  type MinimumModelRequirementsInput,
} from "../src/lib/selection.js";
import { markRouteExhausted } from "../src/lib/model-availability.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import type { ModelCard } from "../src/types.js";
import { fakeEnv, withHome } from "./home.js";

const HOST = "alpha";
const SPARK = "gpt-5.3-codex-spark";
const LUNA = "gpt-5.6-luna";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-selection-capability-"));
}

function routeModels(overrides: Record<string, Record<string, unknown>> = {}) {
  return [
    {
      id: SPARK,
      route_id: SPARK,
      provider: "codex",
      description: "Ultra-fast coding model",
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "low",
      contextWindow: 1_000_000,
      ...overrides[SPARK],
    },
    {
      id: LUNA,
      route_id: LUNA,
      provider: "codex",
      description: "Agentic coding model",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "high",
      contextWindow: 1_000_000,
      ...overrides[LUNA],
    },
  ];
}

function card(route: string, effort?: string, extra: Record<string, unknown> = {}): ModelCard {
  return {
    id: effort ? `${route}@${effort}` : route,
    route_id: route,
    ...(effort ? { reasoning_effort: effort } : {}),
    strengths: route === SPARK ? "ultra-fast coding" : "agentic coding",
    provider: "codex",
    executable: true,
    ...extra,
  } as ModelCard;
}

function cards(extra: Record<string, Record<string, unknown>> = {}): ModelCard[] {
  return [
    card(SPARK, undefined, extra[SPARK]),
    card(SPARK, "low", extra[SPARK]),
    card(SPARK, "high", extra[SPARK]),
    card(LUNA, undefined, extra[LUNA]),
    card(LUNA, "high", extra[LUNA]),
  ];
}

function setup(cwd: string, env: NodeJS.ProcessEnv, overrides: Record<string, Record<string, unknown>> = {}): void {
  publishRouteSnapshot(cwd, { models: routeModels(overrides) }, new Date("2026-08-31T00:00:00.000Z"), { cli: HOST, host: HOST, env });
}

function unit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  allCards: ModelCard[],
  automaticCards: ModelCard[] = allCards,
  overrides: Partial<Parameters<typeof buildSelectionUnit>[0]> = {},
) {
  return buildSelectionUnit({
    cwd,
    host: HOST,
    key: "selection",
    description: "simple fix",
    prompt: "simple fix",
    cards: allCards,
    automaticCards,
    codingModels: [SPARK, LUNA],
    env,
    ...overrides,
  });
}

describe("capability-routed selection", () => {
  it("selects Spark first and chooses its minimal exact reasoning variant", () => withHome((home) => {
    const cwd = workspace();
    const env = fakeEnv(home);
    setup(cwd, env);
    const result = unit(cwd, env, cards());
    assert.equal(result.recommended_model_id, `${SPARK}@low`);
    assert.equal(result.qualification_status, "qualified");
    assert.equal(result.no_qualified_result, null);
  }));

  it("silently falls back when Spark lacks a required capability", () => withHome((home) => {
    const cwd = workspace();
    const env = fakeEnv(home);
    setup(cwd, env);
    const all = cards({
      [SPARK]: { execution_capabilities: ["native-execution"] },
      [LUNA]: { execution_capabilities: ["native-execution", "tool-use"] },
    });
    const result = unit(cwd, env, all);
    assert.equal(result.recommended_model_id, `${LUNA}@high`);
    assert.equal(result.candidates.find((item) => item.route_id === SPARK)?.diagnostic_code, "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED");
  }));

  it("silently falls back when Spark is exhausted in this Baton session", () => withHome((home) => {
    const cwd = workspace();
    const env = fakeEnv(home, { BATON_SESSION_ID: "selection-quota-session" });
    setup(cwd, env);
    markRouteExhausted(cwd, { host: HOST, routeId: SPARK }, {
      reason: "MODEL_QUOTA_EXHAUSTED",
      resetAt: "2026-09-01T00:00:00.000Z",
      now: "2026-08-31T00:01:00.000Z",
      env,
    });
    const result = unit(cwd, env, cards());
    assert.equal(result.recommended_model_id, `${LUNA}@high`);
    const spark = result.candidates.find((item) => item.route_id === SPARK);
    assert.equal(spark?.diagnostic_code, "CURRENT_SESSION_QUOTA_EXHAUSTED");
    assert.equal(spark?.selection_code, "DURABLE_QUOTA_EXHAUSTED");
  }));

  it("keeps unconfigured catalog routes out of the candidate set", () => withHome((home) => {
    const cwd = workspace();
    const env = fakeEnv(home);
    setup(cwd, env);
    const extra = card("unconfigured-route", undefined, { is_default: true, strengths: "best coding model" });
    const result = unit(cwd, env, [...cards(), extra]);
    assert.equal(result.candidates.some((item) => item.route_id === "unconfigured-route"), false);
    assert.equal(result.recommended_model_id, `${SPARK}@low`);
  }));

  it("retains every configured route and complete exclusion diagnostics", () => withHome((home) => {
    const cwd = workspace();
    const env = fakeEnv(home, { BATON_SESSION_ID: "selection-diagnostics-session" });
    setup(cwd, env, {
      [SPARK]: { supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low", contextWindow: 1_000 },
      [LUNA]: { supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low", contextWindow: 1_000 },
    });
    const all = cards({
      [SPARK]: { execution_capabilities: ["native-execution"] },
      [LUNA]: { execution_capabilities: ["native-execution"] },
    });
    const result = unit(cwd, env, all, all.filter((item) => item.route_id !== SPARK), {
      prompt: "complex implementation with context=10M",
      description: "complex implementation with context=10M",
      codingModels: [SPARK, LUNA, "missing-route"],
    });
    assert.equal(result.recommended_model_id, null);
    assert.equal(result.qualification_status, "no-qualified-candidate");
    assert.deepEqual(result.no_qualified_result?.configured_route_ids, [SPARK, LUNA, "missing-route"]);
    assert.deepEqual(new Set(result.no_qualified_result?.exclusions.flatMap((item) => item.codes)), new Set([
      "CURRENT_SESSION_UNCALLABLE",
      "REASONING_CAPABILITY_INSUFFICIENT",
      "CONTEXT_WINDOW_INSUFFICIENT",
      "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED",
      "ROUTE_ABSENT_FROM_ACTIVE_CATALOG",
    ]));
    const repeat = unit(cwd, env, all, all.filter((item) => item.route_id !== SPARK), {
      prompt: "complex implementation with context=10M",
      description: "complex implementation with context=10M",
      codingModels: [SPARK, LUNA, "missing-route"],
    });
    assert.deepEqual(result.no_qualified_result, repeat.no_qualified_result);
  }));

  it("rejects insufficient context and execution capabilities", () => withHome((home) => {
    const cwd = workspace();
    const env = fakeEnv(home);
    setup(cwd, env, { [SPARK]: { contextWindow: 1_000 }, [LUNA]: { contextWindow: 1_000 } });
    const all = cards({
      [SPARK]: { execution_capabilities: ["native-execution"] },
      [LUNA]: { execution_capabilities: ["native-execution"] },
    });
    const result = unit(cwd, env, all, all, {
      prompt: "implement one-file fix with context=2M",
      description: "implement one-file fix with context=2M",
    });
    assert.equal(result.recommended_model_id, null);
    assert.ok(result.candidates.every((item) => item.diagnostics.some((diagnostic) => diagnostic.code === "CONTEXT_WINDOW_INSUFFICIENT")));
    assert.ok(result.candidates.some((item) => item.diagnostics.some((diagnostic) => diagnostic.code === "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED")));
    assert.ok(result.candidates.some((item) => item.diagnostics.some((diagnostic) => diagnostic.code === "CONTEXT_WINDOW_INSUFFICIENT")));
  }));

  it("derives and persists stable minimum requirements with explicit evidence", () => withHome((home) => {
    const cwd = workspace();
    const env = fakeEnv(home);
    setup(cwd, env);
    const input: MinimumModelRequirementsInput = {
      code_scope: "multi-file",
      native_execution: true,
      tool: true,
      other_execution_requirements: ["network", "network"],
      estimated_context_tokens: 500_000,
    };
    const first = deriveMinimumModelRequirements("complex implementation", input);
    const second = deriveMinimumModelRequirements("complex implementation", input);
    assert.deepEqual(first, second);
    assert.equal(first.code_scope, "multi-file");
    assert.equal(first.estimated_context_tokens, 500_000);
    assert.ok(first.evidence.some((item) => item.field === "code_scope"));
    const result = unit(cwd, env, cards(), cards(), { minimumRequirements: input });
    const proposal = createSelectionProposal(cwd, {
      source: "standalone",
      host: HOST,
      units: [result],
      sourceFingerprint: "stable-source",
      payload: { source_shape: "multi-unit-v1", units: [{ key: "selection", description: "simple fix" }] },
      now: "2026-08-31T00:02:00.000Z",
      env,
    });
    const persisted = readSelectionProposal(cwd, proposal.id, env);
    assert.deepEqual(persisted.minimum_requirements.selection, result.minimum_requirements);
  }));
});
