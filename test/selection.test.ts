import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSelectionUnit } from "../src/lib/selection.js";
import { buildRouteCandidates, publishRouteSnapshot } from "../src/lib/routes.js";
import type { ModelCard } from "../src/types.js";
import { withHome } from "./home.js";

const HOST = "selection-fixture";

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-selection-"));
  publishRouteSnapshot(cwd, {
    models: [
      {
        id: "alpha/model",
        context_window: 64_000,
        reasoning_efforts: ["low", "medium", "high"],
        default_reasoning_effort: "medium",
      },
      {
        id: "beta/model",
        context_window: 256_000,
        reasoning_efforts: ["low", "medium", "high"],
        default_reasoning_effort: "medium",
      },
      {
        id: "gamma/model",
        context_window: 1_000_000,
        reasoning_efforts: ["high"],
        default_reasoning_effort: "high",
      },
    ],
  }, new Date("2026-09-07T00:00:00.000Z"), { host: HOST });
  const cards = buildRouteCandidates(cwd, { host: HOST }).map((item) => item.card);
  const build = (overrides: Partial<Parameters<typeof buildSelectionUnit>[0]> = {}) => buildSelectionUnit({
    cwd,
    host: HOST,
    key: "unit",
    description: "selection fixture",
    prompt: "selection fixture",
    cards,
    automaticCards: cards,
    codingModels: ["alpha/model", "beta/model"],
    ...overrides,
  });
  return { cards, build };
}

function candidate(unit: ReturnType<typeof buildSelectionUnit>, id: string) {
  const value = unit.candidates.find((item) => item.model_id === id);
  assert.ok(value, `missing candidate ${id}`);
  return value;
}

describe("selection work requirements", () => {
  it("does not infer maximum effort or a large context requirement from prompt keywords", () => withHome(() => {
    const { build } = fixture();
    const unit = build({ prompt: "Migrate this entire monorepo across many modules" });

    assert.equal(unit.work_mode, "implementation");
    assert.equal(unit.target_reasoning_effort, "medium");
    assert.equal(unit.estimated_context_tokens, 0);
    assert.equal(unit.context_estimate_reason, "unspecified");
    assert.equal(candidate(unit, "alpha/model@medium").selectable, true);
  }));

  it("uses work mode defaults and lets an explicit effort override them", () => withHome(() => {
    const { build } = fixture();

    assert.equal(build({ workMode: "execution" }).target_reasoning_effort, "low");
    assert.equal(build({ workMode: "implementation" }).target_reasoning_effort, "medium");
    assert.equal(build({ workMode: "investigation" }).target_reasoning_effort, "high");
    assert.equal(build({ workMode: "execution", reasoningEffort: "high" }).target_reasoning_effort, "high");
  }));

  it("applies an explicit context requirement but leaves an unspecified context unconstrained", () => withHome(() => {
    const { build } = fixture();
    const unspecified = build();
    const explicit = build({ contextTokens: 128_000 });

    assert.equal(candidate(unspecified, "alpha/model@medium").selectable, true);
    assert.equal(candidate(explicit, "alpha/model@medium").selection_code, "CONTEXT_WINDOW_INSUFFICIENT");
    assert.equal(candidate(explicit, "beta/model@medium").selectable, true);
  }));

  it("uses per-mode preferences only within the enabled coding model allowlist", () => withHome(() => {
    const { build } = fixture();
    const unit = build({
      workMode: "investigation",
      modelPreferences: { investigation: ["gamma/model", "beta/model"] },
    });

    assert.equal(unit.recommended_model_id, "beta/model@high");
    assert.equal(unit.candidates.some((item) => item.route_id === "gamma/model"), false);
  }));

  it("makes a requested base route the recommendation and resolves its explicit effort profile", () => withHome(() => {
    const { build } = fixture();
    const unit = build({
      requestedModelId: "beta/model",
      reasoningEffort: "low",
    });

    assert.equal(unit.recommendation_reason, "REQUESTED_MODEL");
    assert.equal(unit.requested_model_id, "beta/model@low");
    assert.equal(unit.recommended_model_id, "beta/model@low");
    assert.equal(unit.default_model_id, "beta/model@low");
    assert.equal(unit.candidates[0]?.model_id, "beta/model@low");
  }));

  it("resolves a requested base route to the work-mode effort profile", () => withHome(() => {
    const { build } = fixture();
    const unit = build({ requestedModelId: "alpha/model", workMode: "investigation" });

    assert.equal(unit.target_reasoning_effort, "high");
    assert.equal(unit.requested_model_id, "alpha/model@high");
    assert.equal(unit.default_model_id, "alpha/model@high");
  }));

  it("requires an exact supported profile when effort is explicit", () => withHome(() => {
    const { build } = fixture();
    const unit = build({
      codingModels: ["gamma/model"],
      reasoningEffort: "medium",
    });

    assert.equal(unit.recommended_model_id, null);
    assert.equal(candidate(unit, "gamma/model@high").selection_code, "REASONING_EFFORT_UNSUPPORTED");
  }));

  it("rejects invalid requirements and unavailable requested profiles", () => withHome(() => {
    const { build } = fixture();

    assert.throws(() => build({ reasoningEffort: "extreme" }), /REASONING_EFFORT_INVALID/);
    assert.throws(() => build({ contextTokens: -1 }), /CONTEXT_TOKENS_INVALID/);
    assert.throws(
      () => build({ requestedModelId: "alpha/model", reasoningEffort: "xhigh" }),
      /REASONING_EFFORT_UNSUPPORTED/,
    );
    assert.throws(
      () => build({ requestedModelId: "alpha/model@high", reasoningEffort: "low" }),
      /REQUESTED_MODEL_EFFORT_CONFLICT/,
    );
  }));
});
