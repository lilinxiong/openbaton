import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CardMatchError, classifyTask, matchModelCard, requireCardId } from "../src/lib/cards.js";

describe("configured model cards", () => {
  it("selects the strongest text match", () => {
    const cards = [
      { id: "gpt-5.4-mini", strengths: "small fast coding fixes", executable: true },
      { id: "gpt-5.6-sol", strengths: "complex repository architecture migration", executable: true },
    ];
    assert.equal(matchModelCard("complex repository architecture migration", cards).model_id, "gpt-5.6-sol");
    assert.equal(matchModelCard("small fast coding fix", cards).model_id, "gpt-5.4-mini");
  });

  it("blocks only when the enabled CLI candidate set is empty", () => {
    assert.throws(() => matchModelCard("implement anything", []), (error) => {
      assert.ok(error instanceof CardMatchError);
      assert.equal(error.code, "NO_CARDS");
      return true;
    });
  });

  it("resolves zero-score and tie cases deterministically without a selector", () => {
    const cards = [
      { id: "beta", strengths: "coding", executable: true },
      { id: "alpha", strengths: "coding", executable: true, is_default: true },
    ];
    assert.equal(matchModelCard("paint the barn purple", cards).model_id, "alpha");
    assert.equal(matchModelCard("coding", cards).model_id, "alpha");
  });

  it("allows unranked, reference-only, Mini, Spark and all returned families", () => {
    const cards = [
      {
        id: "gpt-5.4-mini", route_id: "gpt-5.4-mini", strengths: "small fast coding",
        executable: true,
        capability: { source: "artificial-analysis" as const, ranked: false, unranked: true, reason: "missing" },
      },
      {
        id: "gpt-5.3-codex-spark", route_id: "gpt-5.3-codex-spark", strengths: "ultra-fast coding",
        executable: true,
      },
      { id: "gpt-5.6-sol", route_id: "gpt-5.6-sol", strengths: "complex migration", executable: true },
      { id: "gpt-5.5", route_id: "gpt-5.5", strengths: "general coding", executable: true },
    ];
    assert.equal(matchModelCard("ultra-fast coding", cards).model_id, "gpt-5.3-codex-spark");
    assert.equal(matchModelCard("small fast coding", [cards[0]]).model_id, "gpt-5.4-mini");
    assert.equal(requireCardId("gpt-5.6-sol", cards).route_id, "gpt-5.6-sol");
    assert.equal(requireCardId("gpt-5.5", cards).route_id, "gpt-5.5");
  });

  it("rejects ids outside the configured candidate set", () => {
    assert.throws(
      () => requireCardId("gpt-5.4", [{ id: "gpt-5.4-mini", strengths: "" }]),
      (error) => error instanceof CardMatchError && error.code === "UNKNOWN_CARD",
    );
  });

  it("classifies complexity, cost and speed in English and Chinese", () => {
    const complex = classifyTask("implement and verify a complex repository migration with evidence");
    assert.ok(complex.coding >= 1);
    assert.ok(complex.agentic >= 1);
    assert.ok(complex.intelligence >= 2);
    const chinese = classifyTask("快速实现小型修复并验证结果");
    assert.ok(chinese.coding >= 1);
    assert.ok(chinese.speed >= 1);
  });
});
