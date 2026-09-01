import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { renderWorktreeWorkerPolicy } from "../src/lib/prompt.js";

const repoRoot = process.cwd();
const runtimeSkills = [
  path.join(repoRoot, "adapters", "codex", "runtime", "SKILL.md"),
  path.join(repoRoot, "adapters", "grok", "runtime", "SKILL.md"),
];

function isolatedPolicy(): string {
  return renderWorktreeWorkerPolicy({
    worktree_mode: "isolated-worktree",
    repository_id: "a".repeat(64),
    git_common_dir_identity: "b".repeat(64),
    execution_root: "/private/tmp/baton/worktrees/run-a/unit-a/attempt-a",
    base_tree: "c".repeat(40),
    worktree_record_id: "record-run-a-unit-a-attempt-a",
    patch_instructions: "Edit only src/a.ts; keep the supplied algorithm byte-for-byte.",
    permitted_validation: ["bun test test/a.test.ts", "npm run check"],
  });
}

describe("worktree worker prompt policy", () => {
  it("binds isolated execution to exactly one root and excludes caller and sibling roots", () => {
    const policy = isolatedPolicy();
    assert.match(policy, /execution_root: \/private\/tmp\/baton\/worktrees\/run-a\/unit-a\/attempt-a/);
    assert.match(policy, /only workspace boundary/);
    assert.match(policy, /caller checkout or any sibling execution root/);
    assert.match(policy, /symlink and repository-indirection escapes/);
    assert.match(policy, /validation is not additional read or write authority/);
  });

  it("forbids worker-owned control-plane, repository, delegation, and integration work", () => {
    const policy = isolatedPolicy();
    for (const forbidden of [
      /Do not run Git/,
      /staging, commits, branch operations, ref operations/,
      /OpenSpec artifacts, task sources, task ledgers/,
      /manage worktrees/,
      /spawn descendants/,
      /replan, redesign, change dependencies/,
      /expand or narrow scope/,
      /create or apply bundles/,
      /integrate results, resolve conflicts/,
      /PLAN_INSUFFICIENT/,
    ]) assert.match(policy, forbidden);
  });

  it("keeps Codex and Grok runtime policies aligned with the exact-root contract", () => {
    for (const file of runtimeSkills) {
      const skill = fs.readFileSync(file, "utf8");
      assert.match(skill, /exact canonical\s+`execution_root`/);
      assert.match(skill, /patch instructions unchanged/);
      assert.match(skill, /complete\s+`permitted_validation` list/);
      assert.match(skill, /caller\s+checkout or any sibling execution root/);
      assert.match(skill, /must not run Git or stage, commit/);
      assert.match(skill, /edit OpenSpec artifacts, task sources, task\s+ledgers/);
      assert.match(skill, /manage worktrees; spawn descendants; replan/);
      assert.match(skill, /create or apply bundles; integrate results; or resolve\s+conflicts/);
      assert.match(skill, /explicitly selected `shared-worktree` reservation remains a legacy\/manual\s+compatibility path/);
      assert.match(skill, /Never\s+silently convert between shared and isolated execution/);
    }
  });
});
