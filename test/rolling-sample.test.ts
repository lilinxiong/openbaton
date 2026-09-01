import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { startRollingControl } from "../src/lib/rolling-control.js";
import { deriveTaskKey, parsePlanDelta, parseTaskSourceDescriptor } from "../src/lib/rolling-plan.js";
import { readRollingExecutionRun } from "../src/lib/rolling-run.js";

const ROOT = path.resolve(import.meta.dir, "..");

describe("published rolling worktree sample", () => {
  it("uses the discovered stable task key and starts with isolated writing defaults", async () => {
    const source = parseTaskSourceDescriptor(fs.readFileSync(
      path.join(ROOT, "samples", "rolling-worktree", "source.json"),
      "utf8",
    ));
    const delta = parsePlanDelta(fs.readFileSync(
      path.join(ROOT, "samples", "rolling-worktree", "delta.json"),
      "utf8",
    ));
    const taskKey = deriveTaskKey("director", "sample-1");
    assert.deepEqual(delta.unit_versions[0]!.task_keys, [taskKey]);
    assert.equal(delta.task_coverage[0]!.task_key, taskKey);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-sample-cwd-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-sample-home-"));
    const env = { ...process.env, HOME: home, BATON_SESSION_ID: "rolling-sample-test" };
    await startRollingControl({
      cwd,
      env,
      host: "codex",
      run_id: "rolling-sample",
      source,
      delta,
      dispatch: false,
      now: "2026-09-01T00:00:00.000Z",
    });

    const run = readRollingExecutionRun(cwd, "rolling-sample", { env });
    assert.equal(run.identity.execution_mode, "isolated-worktree");
    assert.equal(run.accepted_deltas[0]!.unit_versions[0]!.worktree_mode, "isolated-worktree");
  });
});
