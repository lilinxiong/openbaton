import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSelectionUnit } from "../src/lib/selection.js";
import { markRouteExhausted } from "../src/lib/model-availability.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { withHome } from "./home.js";

const scores = (coding: number) => ({
  source: "artificial-analysis" as const,
  ranked: true,
  unranked: false,
  reason: null,
  intelligence_index: null,
  coding_index: coding,
  agentic_index: null,
  cost_per_task: null,
  output_tokens_per_second: null,
  time_to_first_answer_seconds: null,
});

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-coding-routing-"));
}

function cards() {
  return [
    { id: "spark@low", route_id: "spark", reasoning_effort: "low", strengths: "coding", executable: true, capability: scores(1) },
    { id: "luna@low", route_id: "luna", reasoning_effort: "low", strengths: "coding", executable: true, capability: scores(50) },
    { id: "mini@low", route_id: "mini", reasoning_effort: "low", strengths: "coding", executable: true, capability: scores(100) },
  ];
}

function publish(cwd: string, contextWindow = 262_144): void {
  publishRouteSnapshot(cwd, { models: [
    { id: "spark", supportedReasoningEfforts: [{ id: "low" }], contextWindow, description: "coding" },
    { id: "luna", supportedReasoningEfforts: [{ id: "low" }], contextWindow, description: "coding" },
    { id: "mini", supportedReasoningEfforts: [{ id: "low" }], contextWindow, description: "coding" },
  ] }, new Date("2026-08-26T00:00:00Z"), { cli: "codex", host: "codex" });
}

describe("ordered Coding routing", () => {
  it("treats an explicit empty Coding list as zero candidates", () => withHome(() => {
    const cwd = workspace();
    publish(cwd);
    const unit = buildSelectionUnit({
      cwd, host: "codex", key: "empty", description: "implement a simple coding fix", prompt: "implement a simple coding fix",
      cards: cards(), automaticCards: cards(), codingModels: [],
    });
    assert.equal(unit.candidates.length, 0);
    assert.equal(unit.recommended_model_id, null);
    assert.equal(unit.recommendation_reason, "CODING_MODELS_EXHAUSTED");
  }));

  it("uses coding_models order before advisory scores", () => withHome(() => {
    const cwd = workspace();
    publish(cwd, 1_000_000);
    const unit = buildSelectionUnit({
      cwd, host: "codex", key: "simple", description: "implement a simple coding fix", prompt: "implement a simple coding fix",
      cards: cards(), automaticCards: cards(), codingModels: ["spark", "luna", "mini"],
    });
    assert.equal(unit.recommended_model_id, "spark@low");
    assert.equal(unit.recommendation_reason, "CODING_PRIORITY");
    assert.deepEqual(unit.candidates.map((candidate) => candidate.route_id), ["spark", "luna", "mini"]);
  }));

  it("keeps Coding priority authoritative even without ranked advisory evidence", () => withHome(() => {
    const cwd = workspace();
    publish(cwd);
    const unranked = cards().map((card) => ({
      ...card,
      capability: { ...card.capability!, ranked: false, unranked: true },
    }));
    const unit = buildSelectionUnit({
      cwd, host: "codex", key: "unranked", description: "implement a simple coding fix", prompt: "implement a simple coding fix",
      cards: unranked, automaticCards: unranked, codingModels: ["spark", "luna", "mini"],
    });
    assert.equal(unit.recommended_model_id, "spark@low");
    assert.equal(unit.recommendation_reason, "CODING_PRIORITY");
  }));

  it("skips a priority route that cannot satisfy context", () => withHome(() => {
    const cwd = workspace();
    publish(cwd, 128_000);
    const unit = buildSelectionUnit({
      cwd, host: "codex", key: "large", description: "implement this coding task with context=1m", prompt: "implement this coding task with context=1m",
      cards: cards(), automaticCards: cards(), codingModels: ["spark", "luna", "mini"],
    });
    assert.equal(unit.recommended_model_id, null);
    assert.equal(unit.recommendation_reason, "CODING_MODELS_EXHAUSTED");
    assert.ok(unit.candidates.every((candidate) => candidate.selection_code === "CONTEXT_WINDOW_INSUFFICIENT"));
  }));

  it("treats insufficient reasoning effort as a hard gate", () => withHome(() => {
    const cwd = workspace();
    publish(cwd, 1_000_000);
    const unit = buildSelectionUnit({
      cwd, host: "codex", key: "complex", description: "implement a complex repository migration", prompt: "implement a complex repository migration",
      cards: cards(), automaticCards: cards(), codingModels: ["spark", "luna", "mini"],
    });
    assert.equal(unit.recommended_model_id, null);
    assert.equal(unit.recommendation_reason, "CODING_MODELS_EXHAUSTED");
    assert.ok(unit.candidates.every((candidate) => candidate.selection_code === "REASONING_EFFORT_UNSUPPORTED"));
  }));

  it("keeps durable exhausted routes out of later sessions", () => withHome(() => {
    const cwd = workspace();
    publish(cwd);
    markRouteExhausted(cwd, { host: "codex", routeId: "spark" }, { now: new Date("2026-08-26T00:00:00Z") });
    const unit = buildSelectionUnit({
      cwd, host: "codex", key: "fallback", description: "implement a simple coding fix", prompt: "implement a simple coding fix",
      cards: cards(), automaticCards: cards(), codingModels: ["spark", "luna", "mini"],
    });
    assert.equal(unit.recommended_model_id, "luna@low");
    assert.equal(unit.candidates.find((candidate) => candidate.route_id === "spark")?.selection_code, "DURABLE_QUOTA_EXHAUSTED");
  }));
});
