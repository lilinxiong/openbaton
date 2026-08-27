import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeConclusion, sanitizeProgress, MAX_CONCLUSION_CHARS, MAX_PROGRESS_CHARS } from "../src/lib/hygiene.js";

describe("sanitizeConclusion", () => {
  it("rejects a tool dump", () => {
    const r = sanitizeConclusion('tool_call result: {"ok":true}\nfunction_call dump');
    assert.equal(r.ok, false);
    assert.match(r.error, /tool dump/i);
  });

  it("truncates long text", () => {
    const r = sanitizeConclusion("outcome " + "x".repeat(2000));
    assert.equal(r.ok, true);
    assert.ok(r.conclusion.length <= MAX_CONCLUSION_CHARS);
    assert.ok(r.conclusion.endsWith("…"));
  });
});

describe("sanitizeProgress", () => {
  it("keeps checkpoints short and rejects tool dumps", () => {
    const short = sanitizeProgress("mapped lifecycle; next checking recovery");
    assert.equal(short.ok, true);
    const long = sanitizeProgress("x".repeat(1000));
    assert.equal(long.ok, true);
    assert.ok(long.conclusion.length <= MAX_PROGRESS_CHARS);
    assert.equal(sanitizeProgress("tool_result: noisy trace").ok, false);
  });
});
