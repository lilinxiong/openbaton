import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookObservationPath, latestHookObservation, recordHookObservation } from "../src/lib/hook-observation.js";

describe("host hook observations", () => {
  it("records host/event atomically and reports the latest observation", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-hook-observation-"));
    const env = { HOME: fs.mkdtempSync(path.join(os.tmpdir(), "baton-hook-observation-home-")) };
    recordHookObservation(cwd, "codex", "PreToolUse", "2026-08-26T00:00:00.000Z", env);
    recordHookObservation(cwd, "codex", "PreToolUse", "2026-08-26T00:00:01.000Z", env);
    recordHookObservation(cwd, "claude", "SubagentStart", "2026-08-26T00:00:02.000Z", env);
    assert.equal(latestHookObservation(cwd, "codex", env)?.last_observed_at, "2026-08-26T00:00:01.000Z");
    assert.equal(latestHookObservation(cwd, "claude", env)?.event, "subagentstart");
    assert.equal(fs.existsSync(hookObservationPath(cwd, env)), true);
  });
});
