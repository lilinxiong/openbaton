import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  CommitBaselineError,
  auditCommitOutcome,
  auditPreparedCommit,
  auditWorktree,
  captureBaseline,
  captureCommitBaseline,
  pathAllowed,
} from "../src/lib/safety.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-safety-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "validation@example.invalid");
  git(cwd, "config", "user.name", "Validation");
  fs.writeFileSync(path.join(cwd, "allowed.txt"), "BASE_ALLOWED\n");
  fs.writeFileSync(path.join(cwd, "denied.txt"), "BASE_DENIED\n");
  git(cwd, "add", "allowed.txt", "denied.txt");
  git(cwd, "commit", "-q", "-m", "baseline");
  return cwd;
}

describe("parent shared-worktree safety gate", () => {
  it("accepts an allowlisted tracked write", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
    const verdict = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(verdict.accepted, true);
    assert.deepEqual(verdict.changes.map((item) => [item.path, item.operation]), [["allowed.txt", "write"]]);
  });

  it("reproduces V-06 and rejects allowed plus denied writes", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
    fs.appendFileSync(path.join(cwd, "denied.txt"), "WORKER_OUT_OF_SCOPE\n");
    const verdict = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_OUT_OF_SCOPE_PATH" && item.path === "denied.txt"));
  });

  it("rejects untracked creation, rename, index mutation, and HEAD mutation", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
    git(cwd, "mv", "allowed.txt", "renamed.txt");
    const verdict = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt", "renamed.txt"], allowed_operations: ["write"] });
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_INDEX_MUTATION"));
    assert.ok(verdict.violations.some((item) => item.code === "E_OUT_OF_SCOPE_PATH" && item.path === "new.txt"));
    assert.ok(verdict.violations.some((item) => item.code === "E_OUT_OF_SCOPE_OP" && item.operation === "rename"));

    git(cwd, "commit", "-q", "-m", "worker commit");
    const afterCommit = auditWorktree(cwd, baseline, { write_allowlist: ["**"], allowed_operations: ["write", "create", "rename"] });
    assert.ok(afterCommit.violations.some((item) => item.code === "E_HEAD_MUTATION"));
  });

  it("rejects dirty baselines and unsafe allowlist paths", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "PREEXISTING\n");
    const baseline = captureBaseline(cwd);
    const verdict = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.ok(verdict.violations.some((item) => item.code === "E_DIRTY_BASELINE"));
    assert.equal(pathAllowed("allowed.txt", ["allowed.txt"]), true);
    assert.equal(pathAllowed("allowed.txt.bak", ["allowed.txt"]), false);
    assert.equal(pathAllowed("../outside", ["**"]), false);
    assert.throws(() => pathAllowed("allowed.txt", ["../**"]), /invalid write allowlist/);
  });

  it("treats project-local .baton as ordinary worktree dirt because runtime is global", () => {
    const cwd = fixture();
    fs.mkdirSync(path.join(cwd, ".baton", "receipts"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".baton", "spawns"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".baton", "receipts", "rcpt-spn-0001-a1.json"), "{}\n");
    fs.writeFileSync(path.join(cwd, ".baton", "spawns", "spn-0001.json"), "{}\n");
    const baseline = captureBaseline(cwd);
    assert.ok(baseline.dirty_entries.some((entry) => entry.path.startsWith(".baton/")));
    const verdict = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_DIRTY_BASELINE"));
  });

  it("classifies executable mode changes as chmod rather than write", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    fs.chmodSync(path.join(cwd, "allowed.txt"), 0o755);
    const rejected = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.ok(rejected.violations.some((item) => item.code === "E_OUT_OF_SCOPE_OP" && item.operation === "chmod"));
    const accepted = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["chmod"] });
    assert.equal(accepted.accepted, true);
  });
});

describe("commit-only safety gate", () => {
  it("accepts exactly one commit with the frozen parent and staged tree", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    assert.equal(auditPreparedCommit(cwd, baseline).accepted, true);

    git(cwd, "commit", "-q", "-m", "feat: authorized commit");
    const verdict = auditCommitOutcome(cwd, baseline);
    assert.equal(verdict.accepted, true);
    assert.equal(verdict.committed, true);
    assert.equal(verdict.commit?.parent, baseline.head);
    assert.equal(verdict.commit?.tree, baseline.staged_tree);
    assert.equal(verdict.commit?.subject, "feat: authorized commit");
  });

  it("requires a non-empty index and rejects unrelated unstaged or untracked state", () => {
    const empty = fixture();
    assert.throws(
      () => captureCommitBaseline(empty),
      (error) => error instanceof CommitBaselineError && error.code === "STAGED_DIFF_REQUIRED",
    );

    const dirty = fixture();
    fs.appendFileSync(path.join(dirty, "allowed.txt"), "STAGED\n");
    git(dirty, "add", "allowed.txt");
    fs.appendFileSync(path.join(dirty, "denied.txt"), "UNSTAGED\n");
    assert.throws(
      () => captureCommitBaseline(dirty),
      (error) => error instanceof CommitBaselineError && error.code === "COMMIT_BASELINE_NOT_STAGED_ONLY",
    );
  });

  it("detects a stale staged tree before dispatch", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    fs.appendFileSync(path.join(cwd, "denied.txt"), "LATE\n");
    git(cwd, "add", "denied.txt");
    const verdict = auditPreparedCommit(cwd, baseline);
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_INDEX_TREE_MUTATION"));
  });

  it("requires a commit only on successful completion", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    const completed = auditCommitOutcome(cwd, baseline);
    assert.equal(completed.accepted, false);
    assert.ok(completed.violations.some((item) => item.code === "E_COMMIT_MISSING"));
    assert.equal(auditCommitOutcome(cwd, baseline, { requireCommit: false }).accepted, true);
  });

  it("rejects a commit whose tree includes anything beyond the frozen index", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    fs.appendFileSync(path.join(cwd, "denied.txt"), "EXTRA\n");
    git(cwd, "add", "denied.txt");
    git(cwd, "commit", "-q", "-m", "worker widened commit");
    const verdict = auditCommitOutcome(cwd, baseline);
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_COMMIT_TREE_MISMATCH"));
  });

  it("rejects more than one HEAD/ref update", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    git(cwd, "commit", "-q", "-m", "first commit");
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "SECOND\n");
    git(cwd, "add", "allowed.txt");
    git(cwd, "commit", "-q", "-m", "second commit");
    const verdict = auditCommitOutcome(cwd, baseline);
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_COMMIT_PARENT_MISMATCH"));
    assert.ok(verdict.violations.some((item) => item.code === "E_HEAD_REFLOG_MUTATION"));
  });
});
