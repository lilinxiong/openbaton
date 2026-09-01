import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worktreeExecutionRootPath } from "../src/lib/paths.js";
import { setupDetachedWorktree } from "../src/lib/worktree-setup.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function indexHash(repo: string): string {
  return crypto.createHash("sha256").update(execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: repo })).digest("hex");
}

describe("dirty baseline snapshots", () => {
  it("preserves staged, unstaged, untracked, binary, rename/delete, executable, and symlink materialization", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-snapshot-"));
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(repo, "modify.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "rename.txt"), "rename\n");
    fs.writeFileSync(path.join(repo, "delete.txt"), "delete\n");
    fs.writeFileSync(path.join(repo, "mode.sh"), "#!/bin/sh\nexit 0\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "initial"]);

    fs.writeFileSync(path.join(repo, "modify.txt"), "staged\n");
    git(repo, ["add", "modify.txt"]);
    fs.writeFileSync(path.join(repo, "modify.txt"), "unstaged over staged\n");
    fs.renameSync(path.join(repo, "rename.txt"), path.join(repo, "renamed.txt"));
    fs.unlinkSync(path.join(repo, "delete.txt"));
    fs.chmodSync(path.join(repo, "mode.sh"), 0o755);
    fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 255, 1, 254, 2]));
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");
    fs.symlinkSync("modify.txt", path.join(repo, "link"));

    const commonRaw = git(repo, ["rev-parse", "--git-common-dir"]);
    const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repo, commonRaw));
    const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const callerIndexHash = indexHash(repo);
    const run = "run-dirty";
    const execution = worktreeExecutionRootPath(repo, run, "unit-dirty", "attempt-dirty", env);
    const result = await setupDetachedWorktree({
      repository_root: repo,
      repository_id: "c".repeat(64),
      git_common_dir: common,
      git_common_dir_identity: "d".repeat(64),
      execution_root: execution,
      run_id: run,
      unit_key: "unit-dirty",
      unit_version: 1,
      attempt_id: "attempt-dirty",
      include_dirty_baseline: true,
      dirty_baseline_authorized: true,
      dirty_baseline_paths: ["modify.txt", "rename.txt", "renamed.txt", "delete.txt", "mode.sh", "binary.bin", "untracked.txt", "link"],
      env,
    });

    assert.equal(result.record.setup_state, "verified");
    assert.ok(result.snapshot);
    assert.equal(fs.readFileSync(path.join(execution, "modify.txt"), "utf8"), "unstaged over staged\n");
    assert.equal(fs.readFileSync(path.join(execution, "renamed.txt"), "utf8"), "rename\n");
    assert.equal(fs.existsSync(path.join(execution, "rename.txt")), false);
    assert.equal(fs.existsSync(path.join(execution, "delete.txt")), false);
    assert.deepEqual(fs.readFileSync(path.join(execution, "binary.bin")), Buffer.from([0, 255, 1, 254, 2]));
    assert.equal(fs.readFileSync(path.join(execution, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(fs.readlinkSync(path.join(execution, "link")), "modify.txt");
    assert.ok((fs.statSync(path.join(execution, "mode.sh")).mode & 0o111) !== 0);
    assert.equal(indexHash(repo), callerIndexHash);
    assert.equal(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]), status);
    assert.equal(result.caller_before_fingerprint, result.caller_after_fingerprint);

    const replay = await setupDetachedWorktree({
      repository_root: repo,
      repository_id: "c".repeat(64),
      git_common_dir: common,
      git_common_dir_identity: "d".repeat(64),
      execution_root: execution,
      run_id: run,
      unit_key: "unit-dirty",
      unit_version: 1,
      attempt_id: "attempt-dirty",
      include_dirty_baseline: true,
      dirty_baseline_authorized: true,
      dirty_baseline_paths: ["modify.txt", "rename.txt", "renamed.txt", "delete.txt", "mode.sh", "binary.bin", "untracked.txt", "link"],
      env,
    });
    assert.equal(replay.recovered, true);
    assert.equal(replay.record.fingerprint, result.record.fingerprint);

    fs.writeFileSync(path.join(repo, "untracked.txt"), "changed without changing HEAD or index\n");
    await assert.rejects(setupDetachedWorktree({
      repository_root: repo,
      repository_id: "c".repeat(64),
      git_common_dir: common,
      git_common_dir_identity: "d".repeat(64),
      execution_root: execution,
      run_id: run,
      unit_key: "unit-dirty",
      unit_version: 1,
      attempt_id: "attempt-dirty",
      include_dirty_baseline: true,
      dirty_baseline_authorized: true,
      dirty_baseline_paths: ["modify.txt", "rename.txt", "renamed.txt", "delete.txt", "mode.sh", "binary.bin", "untracked.txt", "link"],
      env,
    }), (error: unknown) => (error as { code?: string }).code === "WORKTREE_SNAPSHOT_REPLAY_MISMATCH");
  });

  it("rejects unauthorized and ambiguous dirty paths before creating a worktree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-snapshot-auth-"));
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(repo, "source.txt"), "source\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "initial"]);
    fs.renameSync(path.join(repo, "source.txt"), path.join(repo, "destination.txt"));
    git(repo, ["add", "-A"]);
    const commonRaw = git(repo, ["rev-parse", "--git-common-dir"]);
    const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repo, commonRaw));
    const base = {
      repository_root: repo,
      repository_id: "1".repeat(64),
      git_common_dir: common,
      git_common_dir_identity: "2".repeat(64),
      unit_version: 1,
      include_dirty_baseline: true,
      dirty_baseline_authorized: true,
      env,
    } as const;
    const unauthorizedRoot = worktreeExecutionRootPath(repo, "run-auth", "unit-auth", "attempt-auth", env);
    await assert.rejects(
      setupDetachedWorktree({ ...base, execution_root: unauthorizedRoot, run_id: "run-auth", unit_key: "unit-auth", attempt_id: "attempt-auth", dirty_baseline_paths: ["destination.txt"] }),
      (error: unknown) => (error as { code?: string; paths?: string[] }).code === "WORKTREE_DIRTY_PATH_UNAUTHORIZED"
        && (error as { paths: string[] }).paths.includes("source.txt"),
    );
    assert.equal(fs.existsSync(unauthorizedRoot), false);

    const ambiguousRoot = worktreeExecutionRootPath(repo, "run-ambiguous", "unit-ambiguous", "attempt-ambiguous", env);
    await assert.rejects(
      setupDetachedWorktree({ ...base, execution_root: ambiguousRoot, run_id: "run-ambiguous", unit_key: "unit-ambiguous", attempt_id: "attempt-ambiguous", dirty_baseline_paths: ["source.txt", "folder/../destination.txt"] }),
      (error: unknown) => (error as { code?: string }).code === "WORKTREE_DIRTY_PATH_INVALID",
    );
    assert.equal(fs.existsSync(ambiguousRoot), false);
  });

  it("materializes a practical large dirty index through the alternate index", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-snapshot-large-"));
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "initial"]);
    const paths: string[] = [];
    fs.mkdirSync(path.join(repo, "many"));
    for (let index = 0; index < 1200; index += 1) {
      const relative = `many/file-${String(index).padStart(4, "0")}.txt`;
      paths.push(relative);
      fs.writeFileSync(path.join(repo, relative), `${index}\n`);
    }
    const commonRaw = git(repo, ["rev-parse", "--git-common-dir"]);
    const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repo, commonRaw));
    const execution = worktreeExecutionRootPath(repo, "run-large", "unit-large", "attempt-large", env);
    const result = await setupDetachedWorktree({
      repository_root: repo,
      repository_id: "3".repeat(64),
      git_common_dir: common,
      git_common_dir_identity: "4".repeat(64),
      execution_root: execution,
      run_id: "run-large",
      unit_key: "unit-large",
      unit_version: 1,
      attempt_id: "attempt-large",
      include_dirty_baseline: true,
      dirty_baseline_authorized: true,
      dirty_baseline_paths: paths,
      env,
    });
    assert.equal(result.snapshot?.manifest.included_paths.length, paths.length);
    assert.equal(fs.readFileSync(path.join(execution, paths.at(-1)!), "utf8"), "1199\n");
  });
});
