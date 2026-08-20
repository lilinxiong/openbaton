import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_SUBAGENT_MODEL_FAMILIES,
  SUBAGENT_MODEL_FAMILY_FORBIDDEN,
  assertSubagentModelAllowed,
  subagentModelPolicy,
  summarizeSubagentModelPolicyExclusions,
} from "../src/lib/model-policy.js";

describe("built-in subagent model-family policy", () => {
  it("forbids gpt-5.5, sol and terra across bare routes, providers, variants and reasoning profiles", () => {
    for (const id of [
      "gpt-5.5",
      "gpt-5.5@high",
      "cursor/gpt-5.5@medium",
      "provider/gpt-5.5-extra@high",
      "provider/gpt-5.5/coding@xhigh",
      "gpt-5.6-sol",
      "gpt-5.6-sol@max",
      "cursor/gpt-5.6-sol@high",
      "provider/gpt-5.6-sol-coding@low",
      "provider/gpt-5.6-sol/fast@high",
      "gpt-5.6-terra",
      "gpt-5.6-terra@medium",
      "cursor/gpt-5.6-terra@xhigh",
      "provider/gpt-5.6-terra-fast",
      "provider/gpt-5.6-terra/long-context@max",
    ]) {
      const decision = subagentModelPolicy(id, id);
      assert.equal(decision.allowed, false, id);
      assert.equal(decision.code, SUBAGENT_MODEL_FAMILY_FORBIDDEN, id);
      assert.throws(() => assertSubagentModelAllowed(id, id), new RegExp(SUBAGENT_MODEL_FAMILY_FORBIDDEN));
    }
    for (const id of ["gpt-5.6-luna@max", "gpt-5.4@high", "alibaba-token-plan/glm-5.2", "gpt-5.6-solar", "gpt-5.50"]) {
      assert.equal(subagentModelPolicy(id, id).allowed, true, id);
    }
  });

  it("summarizes only executable forbidden cards while leaving the catalog inspectable", () => {
    const exclusions = summarizeSubagentModelPolicyExclusions([
      { id: "gpt-5.5", route_id: "gpt-5.5", strengths: "", executable: true },
      { id: "provider/gpt-5.5-extra@high", route_id: "provider/gpt-5.5-extra", reasoning_effort: "high", strengths: "", executable: true },
      { id: "gpt-5.6-sol", route_id: "gpt-5.6-sol", strengths: "", executable: true },
      { id: "gpt-5.6-sol@max", route_id: "gpt-5.6-sol", reasoning_effort: "max", strengths: "", executable: true },
      { id: "cursor/gpt-5.6-terra@high", route_id: "cursor/gpt-5.6-terra", reasoning_effort: "high", strengths: "", executable: true },
      { id: "disabled/gpt-5.6-terra", route_id: "disabled/gpt-5.6-terra", strengths: "", executable: false },
      { id: "gpt-5.6-luna", route_id: "gpt-5.6-luna", strengths: "", executable: true },
    ]);
    assert.deepEqual(exclusions.map((item) => item.family), [...FORBIDDEN_SUBAGENT_MODEL_FAMILIES]);
    assert.deepEqual(exclusions.map((item) => item.card_count), [2, 2, 1]);
    assert.deepEqual(exclusions[0].routes, ["gpt-5.5", "provider/gpt-5.5-extra"]);
    assert.deepEqual(exclusions[1].routes, ["gpt-5.6-sol"]);
    assert.deepEqual(exclusions[2].routes, ["cursor/gpt-5.6-terra"]);
  });

  it("always discloses every built-in exclusion even when the current catalog has no matching route", () => {
    const exclusions = summarizeSubagentModelPolicyExclusions([
      { id: "gpt-5.6-luna", route_id: "gpt-5.6-luna", strengths: "", executable: true },
    ]);
    assert.deepEqual(exclusions.map((item) => item.family), [...FORBIDDEN_SUBAGENT_MODEL_FAMILIES]);
    assert.deepEqual(exclusions.map((item) => item.card_count), [0, 0, 0]);
    assert.deepEqual(exclusions.map((item) => item.routes), [[], [], []]);
  });
});
