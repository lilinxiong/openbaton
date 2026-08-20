import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, matchModelCard, requireCardId, CardMatchError } from "../src/lib/cards.js";

const cards = [
  { id: "example-coder", strengths: "write code, implement, fix tests, grind on a repo" },
  { id: "example-explorer", strengths: "explore, research, short plans, do not think forever" },
];

describe("matchModelCard", () => {
  it("hits a single matching card", () => {
    const hit = matchModelCard("implement the login form", cards);
    assert.equal(hit.model_id, "example-coder");
    assert.ok(hit.score > 0);
  });

  it("blocks when no cards are configured", () => {
    assert.throws(() => matchModelCard("implement anything", []), (err) => {
      assert.ok(err instanceof CardMatchError);
      assert.equal(err.code, "NO_CARDS");
      return true;
    });
  });

  it("blocks when nothing matches — never a silent default", () => {
    assert.throws(() => matchModelCard("paint the barn purple", cards), (err) => {
      assert.ok(err instanceof CardMatchError);
      assert.equal(err.code, "NO_CARD_MATCH");
      return true;
    });
  });

  it("blocks an ambiguous tie — never a silent default", () => {
    const twins = [
      { id: "alpha", strengths: "implement code" },
      { id: "beta", strengths: "implement code" },
    ];
    assert.throws(() => matchModelCard("implement code", twins), (err) => {
      assert.ok(err instanceof CardMatchError);
      assert.equal(err.code, "AMBIGUOUS_CARD");
      assert.deepEqual(err.candidates, ["alpha", "beta"]);
      return true;
    });
  });

  it("uses structured AA capability dimensions as the primary dynamic signal", () => {
    const dynamic = [
      {
        id: "provider/strong-coder@high", strengths: "", route_id: "provider/strong-coder", reasoning_effort: "high",
        source: "dynamic", executable: true,
        capability: {
          source: "artificial-analysis", ranked: true, unranked: false, reason: null,
          intelligence_index: 70, coding_index: 90, agentic_index: 85,
          cost_per_task: 1, output_tokens_per_second: 50, time_to_first_answer_seconds: 20,
          relative: { intelligence: 0.8, coding: 1, agentic: 1, cost_efficiency: 0.1, throughput: 0.4, latency: 0.4 },
        },
      },
      {
        id: "provider/fast-cheap", strengths: "", route_id: "provider/fast-cheap",
        source: "dynamic", executable: true,
        capability: {
          source: "artificial-analysis", ranked: true, unranked: false, reason: null,
          intelligence_index: 40, coding_index: 55, agentic_index: 30,
          cost_per_task: 0.01, output_tokens_per_second: 180, time_to_first_answer_seconds: 2,
          relative: { intelligence: 0.3, coding: 0.4, agentic: 0.2, cost_efficiency: 1, throughput: 1, latency: 1 },
        },
      },
    ];
    assert.equal(matchModelCard("implement a complex multi-file repository migration", dynamic).model_id, "provider/strong-coder@high");
    assert.equal(matchModelCard("quick cheap routine batch fix", dynamic).model_id, "provider/fast-cheap");
  });

  it("keeps unranked routes visible for explicit selection but excludes them from automatic matching", () => {
    const unranked = {
      id: "provider/unmapped", strengths: "unranked", route_id: "provider/unmapped",
      source: "dynamic", executable: true,
      capability: {
        source: "artificial-analysis", ranked: false, unranked: true, reason: "no_canonical_mapping",
        intelligence_index: null, coding_index: null, agentic_index: null,
        cost_per_task: null, output_tokens_per_second: null, time_to_first_answer_seconds: null,
      },
    };
    assert.throws(() => matchModelCard("implement code", [unranked]), (err) => err instanceof CardMatchError && err.code === "NO_CARDS");
    assert.equal(requireCardId("provider/unmapped", [unranked]).route_id, "provider/unmapped");
    assert.throws(
      () => requireCardId("unmapped", [unranked]),
      (error) => error instanceof CardMatchError && error.code === "UNKNOWN_CARD",
    );
  });

  it("never auto-matches any built-in forbidden family even when it scores highest", () => {
    const forbidden = {
      id: "provider/gpt-5.6-sol-max@high", route_id: "provider/gpt-5.6-sol-max", reasoning_effort: "high",
      strengths: "implement code repository migration", executable: true,
    };
    const forbidden55 = {
      id: "provider/gpt-5.5-extra@high", route_id: "provider/gpt-5.5-extra", reasoning_effort: "high",
      strengths: "implement code repository migration", executable: true,
    };
    const allowed = {
      id: "gpt-5.6-luna@low", route_id: "gpt-5.6-luna", reasoning_effort: "low",
      strengths: "implement code", executable: true,
    };
    assert.equal(matchModelCard("implement code repository migration", [forbidden, forbidden55, allowed]).model_id, allowed.id);
    assert.equal(requireCardId(forbidden.id, [forbidden]).route_id, forbidden.route_id, "catalog lookup remains inspectable");
    assert.equal(requireCardId(forbidden55.id, [forbidden55]).route_id, forbidden55.route_id, "gpt-5.5 stays catalog-inspectable");
  });

  it("classifies verification/report work and Chinese task language instead of producing a zero signal", () => {
    assert.ok(classifyTask("verify and report the incident audit with evidence").intelligence >= 4);
    const chinese = classifyTask("分析仓库并验证修复结果，尽快给出报告");
    assert.ok(chinese.intelligence >= 3);
    assert.ok(chinese.agentic >= 1);
    assert.ok(chinese.coding >= 1);
    assert.ok(chinese.speed >= 1);
  });
});
