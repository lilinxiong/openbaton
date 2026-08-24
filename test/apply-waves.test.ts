import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractMentionedPaths, planApplyWaves } from "../src/lib/apply-waves.js";
import type { OpenSpecTask } from "../src/lib/openspec.js";

function task(partial: Partial<OpenSpecTask> & { number: string; description: string }): OpenSpecTask {
  return {
    section: partial.section || "",
    number: partial.number,
    description: partial.description,
    status: partial.status || "pending",
    line_index: partial.line_index ?? Number(partial.number.split(".")[0] || 0),
  };
}

describe("apply wave overlay", () => {
  it("extracts file paths and ignores dotted config keys", () => {
    assert.deepEqual(extractMentionedPaths("edit `src/lib/config.ts` and templates/config.toml"), [
      "src/lib/config.ts",
      "templates/config.toml",
    ]);
    assert.deepEqual(extractMentionedPaths("ignore cli.active and enabled flags"), []);
    assert.deepEqual(extractMentionedPaths("reserved/dispatching/running worker tickets"), []);
  });

  it("runs disjoint paths in one section together", () => {
    const plan = planApplyWaves([
      task({ section: "Config", number: "1.1", description: "change src/lib/config.ts types" }),
      task({ section: "Config", number: "1.2", description: "change src/lib/hosts.ts detection" }),
    ]);
    assert.equal(plan.waves.length, 1);
    assert.equal(plan.ready?.parallel, true);
    assert.deepEqual(plan.ready?.task_ids, ["1.1", "1.2"]);
    assert.deepEqual(plan.order_ready?.task_ids, ["1.1", "1.2"]);
    assert.equal(plan.order_ready?.waves.length, 1);
    assert.equal(plan.order_ready?.section, "Config");
  });

  it("keeps shared or missing paths serial", () => {
    const shared = planApplyWaves([
      task({ section: "Config", number: "1.1", description: "remove active from src/lib/config.ts" }),
      task({ section: "Config", number: "1.2", description: "stop copying routes in src/lib/config.ts" }),
    ]);
    assert.equal(shared.waves.length, 2);
    assert.equal(shared.ready?.parallel, false);
    assert.deepEqual(shared.ready?.task_ids, ["1.1"]);
    assert.deepEqual(shared.order_ready?.task_ids, ["1.1", "1.2"]);
    assert.equal(shared.order_ready?.section, "Config");
    assert.equal(shared.order_ready?.waves.length, 2);

    const missing = planApplyWaves([
      task({ section: "Config", number: "1.1", description: "remove the global default CLI" }),
      task({ section: "Config", number: "1.2", description: "stop copying privileged routes" }),
    ]);
    assert.equal(missing.waves.length, 2);
    assert.deepEqual(missing.waves.map((wave) => wave.task_ids), [["1.1"], ["1.2"]]);
  });

  it("holds later sections until the earlier pending wave is gone", () => {
    const plan = planApplyWaves([
      task({ section: "1. Config schema", number: "1.1", description: "edit src/lib/config.ts" }),
      task({ section: "2. Host resolution", number: "2.1", description: "edit src/lib/hosts.ts" }),
    ]);
    assert.equal(plan.ready?.section, "1. Config schema");
    assert.deepEqual(plan.ready?.task_ids, ["1.1"]);
    assert.deepEqual(plan.waves[1]?.task_ids, ["2.1"]);
    assert.deepEqual(plan.order_ready?.task_ids, ["1.1"]);
    assert.equal(plan.order_ready?.section, "1. Config schema");
    assert.equal(plan.order_ready?.waves.length, 1);
    assert.ok(plan.waves.some((wave) => wave.section === "2. Host resolution"));
  });
});
