import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatBrief, inspectBrief, parseBrief, prepareBrief } from "../src/lib/brief.js";

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
    assert.match(prompt, /Use this brief, not parent history/);
    assert.match(prompt, /Follow settled decisions/);
    assert.match(prompt, /escalate out-of-scope decisions/);
    assert.match(prompt, /No commit or push/);
    assert.match(prompt, /status completed\|blocked\|failed/);
    assert.match(prompt, /changed locations/);
    assert.match(prompt, /check evidence/);
    assert.match(prompt, /detailed logs: file refs/);
    assert.match(prompt, /Existing changes: No changes/);
  });

  it("inspects code-point prompt size and ranks field contributions without enforcing a budget", () => {
    const brief = parseBrief({
      goal: "Plan 😀",
      decisions: ["Keep it short", "Use code points"],
      scope: ["src"],
      acceptance: ["Report the result"],
    });
    const promptChars = [...formatBrief(brief)].length;
    const inspection = inspectBrief(brief, promptChars);
    assert.equal(inspection.prompt_chars, Array.from(formatBrief(brief)).length);
    assert.equal(inspection.budget_chars, promptChars);
    assert.equal(inspection.over_budget, false);
    assert.equal(inspection.largest_fields[0].field, "decisions");
    assert.equal(inspection.largest_fields.find((item) => item.field === "goal")?.chars, 6);
    assert.deepEqual(
      inspection.largest_fields.map((item) => item.chars),
      [...inspection.largest_fields.map((item) => item.chars)].sort((left, right) => right - left),
    );
    assert.equal(inspectBrief(brief, promptChars - 1).over_budget, true);
    assert.deepEqual(prepareBrief(brief, promptChars), { prompt: formatBrief(brief) });
    assert.deepEqual(prepareBrief(brief, promptChars - 1), {
      prompt: formatBrief(brief), diagnostics: inspectBrief(brief, promptChars - 1),
    });
    for (const budget of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      assert.throws(() => inspectBrief(brief, budget), /BRIEF_BUDGET_INVALID/);
    }
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
