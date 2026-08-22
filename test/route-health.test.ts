import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireCardId } from "../src/lib/cards.js";
import {
  cardsForAutomaticSelection,
  isCardAutoEligible,
  readRouteHealth,
  recordRouteHealth,
} from "../src/lib/route-health.js";
import { routeHealthPath } from "../src/lib/paths.js";
import { isolatedHome } from "./home.js";

isolatedHome("baton-route-health-home-");

function cwd(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "baton-route-health-")); }

const xai = {
  id: "xai/grok-4.6@high", strengths: "strong coding", route_id: "xai/grok-4.6", reasoning_effort: "high",
  executable: true, capability: {
    source: "artificial-analysis" as const, ranked: true, unranked: false, reason: null,
    intelligence_index: 80, coding_index: 90, agentic_index: 80,
    cost_per_task: 1, output_tokens_per_second: 30, time_to_first_answer_seconds: 10,
  },
};
const native = { ...xai, id: "gpt-5.6-sol@high", route_id: "gpt-5.6-sol" };
const gpt55 = { ...xai, id: "gpt-5.5-extra@high", route_id: "gpt-5.5-extra" };
const luna = { ...xai, id: "gpt-5.6-luna@high", route_id: "gpt-5.6-luna" };

describe("route health", () => {
  it("cools down only the failed host/route/profile/task-shape and keeps the card audit-addressable", () => {
    const root = cwd();
    const now = new Date();
    const record = recordRouteHealth(root, {
      routeId: "xai/grok-4.6", profile: "high", host: "codex",
      taskText: "implement a complex repository migration", terminalStatus: "timed_out",
      errorCode: "AGENT_TIMEOUT", message: "no agent terminal state", now,
    });
    assert.equal(record?.failure_kind, "HOST_NO_TERMINAL");
    assert.equal(isCardAutoEligible(root, xai, "implement a complex repository migration", { now }), false);
    assert.equal(isCardAutoEligible(root, xai, "quick cheap routine batch fix", { now }), true, "different task shape");
    assert.equal(isCardAutoEligible(root, native, "implement a complex repository migration", { now }), true);
    assert.equal(isCardAutoEligible(root, gpt55, "implement a complex repository migration", { now }), true);
    assert.deepEqual(cardsForAutomaticSelection(root, [xai, native, gpt55, luna], "implement a complex repository migration"), [native, gpt55, luna]);
    assert.equal(requireCardId("xai/grok-4.6@high", [xai]).route_id, "xai/grok-4.6", "health filtering does not erase catalog evidence");
  });

  it("success clears the cooldown and persists the global cache with mode 0600", () => {
    const root = cwd();
    recordRouteHealth(root, {
      routeId: "xai/grok-4.6", profile: "high", taskText: "implement a complex repository migration",
      terminalStatus: "errored", errorCode: "UPSTREAM_429", message: "rate limited",
      now: new Date("2026-08-19T00:00:00Z"),
    });
    recordRouteHealth(root, {
      routeId: "xai/grok-4.6", profile: "high", taskText: "implement a complex repository migration",
      terminalStatus: "completed", now: new Date("2026-08-19T00:01:00Z"),
    });
    assert.equal(readRouteHealth(root).records[0].status, "healthy");
    const file = routeHealthPath(root);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(root, ".baton")));
  });
});
