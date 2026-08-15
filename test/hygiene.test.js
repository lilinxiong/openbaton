import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeConclusion, directorMayRun, MAX_CONCLUSION_CHARS } from "../src/lib/hygiene.js";

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

describe("directorMayRun", () => {
  it("is true only for tiny rename/typo-style units", () => {
    assert.equal(directorMayRun("rename helper to formatDate"), true);
    assert.equal(directorMayRun("typo in README title"), true);
  });

  it("is false for implement/explore", () => {
    assert.equal(directorMayRun("implement the auth module"), false);
    assert.equal(directorMayRun("explore why CI is red"), false);
  });
});
