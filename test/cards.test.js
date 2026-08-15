import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchModelCard, CardMatchError } from "../src/lib/cards.js";

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
});
