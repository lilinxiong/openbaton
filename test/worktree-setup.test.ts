import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worktreeExecutionRootPath } from "../src/lib/paths.js";
import { setupDetachedWorktree } from "../src/lib/worktree/setup.js";
import { readPersistedWorktreeRecord } from "../src/lib/worktree-execution.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(prefix: string): { root: string; repo: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  return { root, repo, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

function indexChecksum(repo: string): string {
  const bytes = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: repo });
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

describe("detached worktree setup", () => {
  it("materializes an immutable commit without moving caller refs, HEAD, index, or dirty files", async () => {
    const f = fixture("baton-setup-clean-");
    fs.writeFileSync(path.join(f.repo, "tracked.txt"), "caller dirty\n");
    fs.writeFileSync(path.join(f.repo, "staged.txt"), "staged\n");
    git(f.repo, ["add", "staged.txt"]);
    const commonRaw = git(f.repo, ["rev-parse", "--git-common-dir"]);
    const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(f.repo, commonRaw));
    const status = git(f.repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const before = {
      head: git(f.repo, ["rev-parse", "HEAD"]),
      branch: git(f.repo, ["symbolic-ref", "HEAD"]),
      refs: git(f.repo, ["show-ref"]),
      index: indexChecksum(f.repo),
      status,
    };
    const run = "run-clean";
    const execution = worktreeExecutionRootPath(f.repo, run, "unit-clean", "attempt-clean", f.env);
    const result = await setupDetachedWorktree({
      repository_root: f.repo,
      repository_id: "a".repeat(64),
      git_common_dir: common,
      git_common_dir_identity: "b".repeat(64),
      execution_root: execution,
      run_id: run,
      unit_key: "unit-clean",
      unit_version: 1,
      attempt_id: "attempt-clean",
      env: f.env,
    });
    assert.equal(result.record.setup_state, "verified");
    assert.equal(result.base_commit, before.head);
    assert.equal(git(execution, ["branch", "--show-current"]), "");
    assert.equal(fs.readFileSync(path.join(execution, "tracked.txt"), "utf8"), "one\n");
    assert.equal(fs.existsSync(path.join(execution, "staged.txt")), false);
    assert.deepEqual({
      head: git(f.repo, ["rev-parse", "HEAD"]),
      branch: git(f.repo, ["symbolic-ref", "HEAD"]),
      refs: git(f.repo, ["show-ref"]),
      index: indexChecksum(f.repo),
      status: git(f.repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    }, before);
    assert.equal(result.caller_before_fingerprint, result.caller_after_fingerprint);
  });

  it("accepts an immutable tree object as the detached base", async () => {
    const f = fixture("baton-setup-tree-");
    const commonRaw = git(f.repo, ["rev-parse", "--git-common-dir"]);
    const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(f.repo, commonRaw));
    const tree = git(f.repo, ["rev-parse", "HEAD^{tree}"]);
    const execution = worktreeExecutionRootPath(f.repo, "run-tree", "unit-tree", "attempt-tree", f.env);
    const result = await setupDetachedWorktree({
      repository_root: f.repo,
      repository_id: "e".repeat(64),
      git_common_dir: common,
      git_common_dir_identity: "f".repeat(64),
      execution_root: execution,
      run_id: "run-tree",
      unit_key: "unit-tree",
      unit_version: 1,
      attempt_id: "attempt-tree",
      base: tree,
      env: f.env,
    });
    assert.equal(result.base_tree, tree);
    assert.equal(result.record.setup_state, "verified");
    assert.equal(git(execution, ["branch", "--show-current"]), "");
  });

  it("persists an exact diagnostic for a partially registered setup failure", async () => {
    const f = fixture("baton-setup-partial-");
    const actualCommonRaw = git(f.repo, ["rev-parse", "--git-common-dir"]);
    const actualCommon = fs.realpathSync(path.isAbsolute(actualCommonRaw) ? actualCommonRaw : path.resolve(f.repo, actualCommonRaw));
    const execution = worktreeExecutionRootPath(f.repo, "run-partial", "unit-partial", "attempt-partial", f.env);
    await assert.rejects(setupDetachedWorktree({
      repository_root: f.repo,
      repository_id: "7".repeat(64),
      git_common_dir: path.join(f.root, "home"),
      git_common_dir_identity: "8".repeat(64),
      execution_root: execution,
      run_id: "run-partial",
      unit_key: "unit-partial",
      unit_version: 1,
      attempt_id: "attempt-partial",
      env: f.env,
    }), (error: unknown) => (error as { code?: string }).code === "WORKTREE_MATERIALIZATION_MISMATCH");
    const record = readPersistedWorktreeRecord(f.repo, "run-partial", "unit-partial", "attempt-partial", f.env);
    assert.equal(record.setup_state, "failed");
    assert.equal(record.setup_failure?.code, "WORKTREE_MATERIALIZATION_MISMATCH");
    assert.equal(record.setup_failure?.stage, "materialization");
    assert.equal(record.setup_failure?.execution_root_state, "directory");
    assert.equal(record.setup_failure?.registration_present, true);
    assert.match(record.setup_failure?.message ?? "", /materialization does not match/);
    assert.notEqual(actualCommon, record.git_common_dir);
  });
});
