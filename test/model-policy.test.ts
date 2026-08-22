import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_SUBAGENT_MODEL_FAMILIES,
  SUBAGENT_MODEL_POLICY_ID,
  isSubagentModelAllowed,
  subagentModelPolicy,
  summarizeSubagentModelPolicyExclusions,
} from "../src/lib/model-policy.js";

describe("configured CLI subagent policy", () => {
  it("has no hard-coded model family bans", () => {
    assert.equal(SUBAGENT_MODEL_POLICY_ID, "configured-cli-subagent-allowlist-v1");
    assert.deepEqual(FORBIDDEN_SUBAGENT_MODEL_FAMILIES, []);
    for (const id of [
      "gpt-5.6-sol",
      "gpt-5.6-terra@max",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]) {
      assert.equal(subagentModelPolicy(id, id).allowed, true, id);
      assert.equal(isSubagentModelAllowed({ id, route_id: id.split("@")[0] }), true, id);
    }
  });

  it("leaves exclusion enforcement to the active CLI allowlist", () => {
    assert.deepEqual(summarizeSubagentModelPolicyExclusions([
      { id: "gpt-5.4-mini", route_id: "gpt-5.4-mini", strengths: "", executable: true },
      { id: "gpt-5.3-codex-spark", route_id: "gpt-5.3-codex-spark", strengths: "", executable: true },
    ]), []);
  });
});
