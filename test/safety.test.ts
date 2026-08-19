import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { auditWorktree, captureBaseline, pathAllowed } from "../src/lib/safety.js";

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
});
