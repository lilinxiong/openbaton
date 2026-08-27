import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DispatchQueue, START, ENQUEUE } from "../src/lib/queue.js";

describe("DispatchQueue", () => {
  it("uses director planning metadata and queues the rest — never refuses", () => {
    const q = new DispatchQueue(4);
    const decisions = q.plan(12);
    assert.equal(decisions.length, 12);
    assert.equal(decisions.filter((d) => d === START).length, 4);
    assert.equal(decisions.filter((d) => d === ENQUEUE).length, 8);
    assert.equal(q.running, 4);
    assert.equal(q.queued, 8);
    const snap = q.snapshot();
    assert.equal(snap.scope, "director-planning");
    assert.equal(snap.planning_max_concurrent, 4);
    assert.equal(Object.hasOwn(snap, "max_concurrent"), false);
    assert.equal(snap.running + snap.queued, 12);
  });
});
