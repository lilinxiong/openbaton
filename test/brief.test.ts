import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatBrief, parseBrief } from "../src/lib/brief.js";

describe("worker briefs", () => {
  it("parses and formats complete bounded worker context", () => {
    const brief = parseBrief({
      goal: "Add the parser",
      decisions: ["Keep the API pure"],
      scope: ["src/lib", "test"],
      acceptance: ["The focused test passes"],
      context: ["The repository uses TypeScript"],
      constraints: ["Do not edit the CLI"],
      mode: "write",
      handoff: { existingChanges: "No changes", checks: "npm test", unresolvedIssues: "None" },
    });
    assert.equal(brief.mode, "write");
    const prompt = formatBrief(brief);
    assert.match(prompt, /complete task context/);
    assert.match(prompt, /Execute the decisions already made/);
    assert.match(prompt, /Return any decision outside this brief's boundary to the root agent/);
    assert.match(prompt, /Do not commit or push/);
    assert.match(prompt, /Existing changes: No changes/);
  });

  it("defaults omitted optional fields to a read-only brief", () => {
    assert.deepEqual(parseBrief({ goal: "Review", acceptance: ["Report findings"] }), {
      goal: "Review",
      decisions: [],
      scope: [],
      acceptance: ["Report findings"],
      context: [],
      constraints: [],
      mode: "read-only",
    });
  });

  it("rejects missing required fields and invalid scoped writes", () => {
    assert.throws(() => parseBrief({ goal: "Review", acceptance: ["Done"], constaints: ["do not write"] }), /not a supported field/);
    assert.throws(() => parseBrief({ goal: "Review", acceptance: ["Done"], handoff: { check: "passed" } }), /not a supported field/);
    for (const scope of ["\\\\server\\share", "C:relative", "src\0file"]) {
      assert.throws(() => parseBrief({ goal: "Review", acceptance: ["Done"], scope: [scope] }), /relative module or directory path/);
    }
    assert.throws(() => parseBrief({ acceptance: ["Done"] }), /goal is required/);
    assert.throws(() => parseBrief({ goal: "Write", acceptance: [] }), /acceptance must not be empty/);
    assert.throws(() => parseBrief({ goal: "Write", acceptance: ["Done"], mode: "write" }), /scope is required/);
    assert.throws(() => parseBrief({ goal: "Review", acceptance: ["Done"], scope: ["../private"] }), /must not contain '\.\.'/);
    assert.throws(() => parseBrief({ goal: "Review", acceptance: ["Done"], scope: ["/private"] }), /relative module or directory path/);
    assert.throws(() => parseBrief({ goal: "Review", acceptance: ["Done"], decisions: "one" }), /decisions must be an array/);
  });
});
