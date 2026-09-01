import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worktreeExecutionRootPath } from "../src/lib/paths.js";
import { transitionPersistedWorktreeRecord, type WorktreeRecord } from "../src/lib/worktree-execution.js";
import { setupDetachedWorktree } from "../src/lib/worktree-setup.js";
import { auditTerminalWorktree, type WorktreeAuditReceipt } from "../src/lib/worktree-audit.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(name: string): Promise<{ root: string; repo: string; execution: string; env: NodeJS.ProcessEnv; record: WorktreeRecord; receipt: WorktreeAuditReceipt }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `baton-audit-${name}-`));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repo, "text.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 0, 3]));
  fs.writeFileSync(path.join(repo, "rename.txt"), "rename-content\n");
  fs.writeFileSync(path.join(repo, "copy-source.txt"), "copy-content\n");
  fs.writeFileSync(path.join(repo, "delete.txt"), "delete-content\n");
  fs.writeFileSync(path.join(repo, "mode.sh"), "#!/bin/sh\nexit 0\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const commonRaw = git(repo, ["rev-parse", "--git-common-dir"]);
  const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repo, commonRaw));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = `run-${name}`;
  const unit = `unit-${name}`;
  const attempt = `attempt-${name}`;
  const execution = worktreeExecutionRootPath(repo, run, unit, attempt, env);
  const setup = await setupDetachedWorktree({
    repository_root: repo,
    repository_id: "a".repeat(64),
    git_common_dir: common,
    git_common_dir_identity: "b".repeat(64),
    execution_root: execution,
    run_id: run,
    unit_key: unit,
    unit_version: 1,
    attempt_id: attempt,
    env,
  });
  transitionPersistedWorktreeRecord(repo, run, unit, attempt, {
    idempotency_key: "native-active",
    phase: "native_execution",
    to_state: "worker_active",
    native_handle: `handle-${name}`,
    retention_reasons: ["live_native_handle"],
    recorded_at: "2026-09-01T00:00:01.000Z",
  }, env);
  const record = transitionPersistedWorktreeRecord(repo, run, unit, attempt, {
    idempotency_key: "native-terminal",
    phase: "native_execution",
    to_state: "terminal_awaiting_audit",
    native_handle: null,
    retention_reasons: ["pending_audit"],
    recorded_at: "2026-09-01T00:00:02.000Z",
  }, env);
  return {
    root, repo, execution, env, record,
    receipt: {
      receipt_id: `receipt-${name}`,
      repository_id: record.repository_id,
      git_common_dir_identity: record.git_common_dir_identity,
      execution_root: execution,
      base_tree: setup.base_tree,
      worktree_record_id: record.record_id,
      run_id: run,
      unit_key: unit,
      unit_version: 1,
      attempt_id: attempt,
      write_allowlist: ["**"],
      allowed_operations: ["write", "create", "delete", "rename", "copy", "chmod"],
    },
  };
}

describe("terminal isolated-worktree audit", () => {
  it("freezes text, binary, add/delete/rename/copy, mode, and symlink facts", async () => {
    const f = await fixture("complete");
    fs.writeFileSync(path.join(f.execution, "text.txt"), "changed\n");
    fs.writeFileSync(path.join(f.execution, "binary.bin"), Buffer.from([0, 255, 0, 254]));
    fs.renameSync(path.join(f.execution, "rename.txt"), path.join(f.execution, "renamed.txt"));
    fs.copyFileSync(path.join(f.execution, "copy-source.txt"), path.join(f.execution, "copied.txt"));
    fs.unlinkSync(path.join(f.execution, "delete.txt"));
    fs.chmodSync(path.join(f.execution, "mode.sh"), 0o755);
    fs.symlinkSync("text.txt", path.join(f.execution, "link"));

    const audit = await auditTerminalWorktree({ record: f.record, receipt: f.receipt });
    assert.equal(audit.accepted, true, JSON.stringify(audit.violations));
    assert.notEqual(audit.result_tree, audit.base_tree);
    assert.deepEqual(audit.operations, ["write", "create", "delete", "rename", "copy", "chmod"]);
    assert.ok(audit.non_text_facts?.binary_paths.includes("binary.bin"));
    assert.ok(audit.non_text_facts?.renames.some((item) => item.source === "rename.txt" && item.target === "renamed.txt"));
    assert.ok(audit.non_text_facts?.copies.some((item) => item.source === "copy-source.txt" && item.target === "copied.txt"));
    assert.ok(audit.non_text_facts?.mode_changes.some((item) => item.path === "mode.sh"));
    assert.equal(audit.non_text_facts?.symlinks.find((item) => item.path === "link")?.target, "text.txt");
  });

  it("rejects false-success no-op, scope, operation, symlink, and staged-control violations with bounded evidence", async () => {
    const noop = await fixture("noop");
    const empty = await auditTerminalWorktree({ record: noop.record, receipt: noop.receipt });
    assert.equal(empty.accepted, false);
    assert.ok(empty.violations.some((item) => item.code === "E_EMPTY_RESULT"));
    const authorizedEmpty = await auditTerminalWorktree({ record: noop.record, receipt: { ...noop.receipt, allow_noop: true } });
    assert.equal(authorizedEmpty.accepted, true, JSON.stringify(authorizedEmpty.violations));
    assert.deepEqual(authorizedEmpty.operations, []);

    const unsafe = await fixture("unsafe");
    fs.writeFileSync(path.join(unsafe.execution, "text.txt"), "changed\n");
    fs.symlinkSync("../outside", path.join(unsafe.execution, "escape"));
    git(unsafe.execution, ["add", "text.txt"]);
    const audit = await auditTerminalWorktree({
      record: unsafe.record,
      receipt: { ...unsafe.receipt, write_allowlist: ["text.txt", "escape"], allowed_operations: ["create"] },
      max_diagnostics: 2,
    });
    assert.equal(audit.accepted, false);
    assert.ok(audit.total_violation_count >= 3);
    assert.equal(audit.violations.length, 2);
    assert.equal(audit.diagnostics_truncated, true);
  });

  it("rejects a nested repository as a literal repository escape", async () => {
    const f = await fixture("nested");
    const nested = path.join(f.execution, "nested");
    fs.mkdirSync(nested);
    git(nested, ["init", "-q"]);
    fs.writeFileSync(path.join(nested, "inside.txt"), "nested\n");
    git(nested, ["add", "."]);
    git(nested, ["config", "user.name", "Test"]);
    git(nested, ["config", "user.email", "test@example.invalid"]);
    git(nested, ["commit", "-qm", "nested"]);
    const audit = await auditTerminalWorktree({ record: f.record, receipt: f.receipt });
    assert.equal(audit.accepted, false);
    assert.ok(audit.violations.some((item) => item.code === "E_REPOSITORY_ESCAPE"));
  });
});
