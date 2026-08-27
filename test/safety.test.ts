import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  CommitBaselineError,
  type AsyncSafetyOptions,
  auditCommitOutcome,
  auditCommitOutcomeAsync,
  auditPreparedCommit,
  auditPreparedCommitAsync,
  auditWorktree,
  auditWorktreeAsync,
  captureBaseline,
  captureBaselineAsync,
  captureCommitBaseline,
  captureCommitBaselineAsync,
  pathAllowed,
} from "../src/lib/safety.js";
import { collectGitSafetyFacts, deriveGitSafetyStabilityToken, type GitSafetyFacts } from "../src/lib/git-safety-facts.js";

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

function createInternalTurnDiffRef(cwd: string, runtime = "baton", name = "worker"): void {
  git(cwd, "update-ref", `refs/${runtime}/turn-diffs/${name}`, "HEAD");
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

  it("ignores a read-only stat-cache refresh when the staged tree is unchanged", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    const beforeIndex = fs.readFileSync(baseline.index_path);
    const touchedAt = new Date(Date.now() + 2_000);
    fs.utimesSync(path.join(cwd, "allowed.txt"), touchedAt, touchedAt);
    git(cwd, "status", "--porcelain=v1", "--untracked-files=all");
    assert.notDeepEqual(fs.readFileSync(baseline.index_path), beforeIndex);
    assert.equal(git(cwd, "write-tree").trim(), baseline.index_tree);

    const verdict = auditWorktree(cwd, baseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(verdict.accepted, true);
    assert.ok(!verdict.violations.some((item) => item.code === "E_INDEX_MUTATION"));
  });

  it("rejects a real staged index mutation even when the write path is allowlisted", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    fs.appendFileSync(path.join(cwd, "denied.txt"), "STAGED_OUT_OF_SCOPE\n");
    git(cwd, "add", "denied.txt");

    const verdict = auditWorktree(cwd, baseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_INDEX_MUTATION"));
  });

  it("rejects index control-flag mutations while tolerating stat-cache refreshes", () => {
    for (const [flag, clear] of [["--assume-unchanged", "--no-assume-unchanged"], ["--skip-worktree", "--no-skip-worktree"]] as const) {
      const cwd = fixture();
      const baseline = captureBaseline(cwd);
      git(cwd, "update-index", flag, "allowed.txt");
      const verdict = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
      assert.equal(verdict.accepted, false, flag);
      assert.ok(verdict.violations.some((item) => item.code === "E_INDEX_MUTATION"), flag);
      git(cwd, "update-index", clear, "allowed.txt");
    }

    const intent = fixture();
    const baseline = captureBaseline(intent);
    fs.writeFileSync(path.join(intent, "intent.txt"), "intent\n");
    git(intent, "add", "-N", "intent.txt");
    const verdict = auditWorktree(intent, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(verdict.accepted, false, "intent-to-add");
    assert.ok(verdict.violations.some((item) => item.code === "E_INDEX_MUTATION"), "intent-to-add");
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

  it("rejects ordinary worker ref and reflog mutations even when files stay unchanged", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    git(cwd, "tag", "worker-tag");
    const verdict = auditWorktree(cwd, baseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_REFS_MUTATION"));
  });

  it("ignores runtime turn-diff refs without ignoring similarly named Git refs", () => {
    for (const runtime of ["baton", "alpha", "custom-runtime"]) {
      const cwd = fixture();
      const baseline = captureBaseline(cwd);
      createInternalTurnDiffRef(cwd, runtime);
      const verdict = auditWorktree(cwd, baseline, { write_allowlist: [], allowed_operations: [] });
      assert.equal(verdict.accepted, true, runtime);
      assert.ok(!verdict.violations.some((item) => item.code === "E_REFS_MUTATION"), runtime);
    }

    for (const ref of [
      "refs/heads/turn-diffs/branch",
      "refs/tags/turn-diffs/tag",
      "refs/remotes/turn-diffs/remote",
      "refs/notes/turn-diffs/note",
      "refs/custom/turn-diffs-extra/keep",
    ]) {
      const cwd = fixture();
      const baseline = captureBaseline(cwd);
      git(cwd, "update-ref", ref, "HEAD");
      const verdict = auditWorktree(cwd, baseline, { write_allowlist: [], allowed_operations: [] });
      assert.equal(verdict.accepted, false, ref);
      assert.ok(verdict.violations.some((item) => item.code === "E_REFS_MUTATION"), ref);
    }
  });

  it("allows incremental writes on a dirty allowlisted file and freezes unrelated dirt", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "PREEXISTING\n");
    fs.appendFileSync(path.join(cwd, "denied.txt"), "PREEXISTING_DENIED\n");
    const baseline = captureBaseline(cwd);
    assert.ok(baseline.dirty_entries.length > 0);
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
    const accepted = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(accepted.accepted, true);
    fs.appendFileSync(path.join(cwd, "denied.txt"), "WORKER_TOUCHED\n");
    const rejected = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(rejected.accepted, false);
    assert.ok(rejected.violations.some((item) => item.code === "E_OUT_OF_SCOPE_PATH" && item.path === "denied.txt"));
    assert.equal(pathAllowed("allowed.txt", ["allowed.txt"]), true);
    assert.equal(pathAllowed("allowed.txt.bak", ["allowed.txt"]), false);
    assert.equal(pathAllowed("../outside", ["**"]), false);
    assert.throws(() => pathAllowed("allowed.txt", ["../**"]), /invalid write allowlist/);
  });

  it("keeps pre-existing project-local .baton dirt out of an allowlisted write", () => {
    const cwd = fixture();
    fs.mkdirSync(path.join(cwd, ".baton", "receipts"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".baton", "spawns"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".baton", "receipts", "rcpt-spn-0001-a1.json"), "{}\n");
    fs.writeFileSync(path.join(cwd, ".baton", "spawns", "spn-0001.json"), "{}\n");
    const baseline = captureBaseline(cwd);
    assert.ok(baseline.dirty_entries.some((entry) => entry.path.startsWith(".baton/")));
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
    const verdict = auditWorktree(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(verdict.accepted, true);
  });

  it("ignores sibling write-ticket paths while still rejecting unaffiliated dirt", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
    fs.writeFileSync(path.join(cwd, "sibling.txt"), "PEER\n");
    fs.appendFileSync(path.join(cwd, "denied.txt"), "UNRELATED\n");
    const accepted = auditWorktree(cwd, baseline, {
      write_allowlist: ["allowed.txt"],
      allowed_operations: ["write", "create"],
      peer_write_allowlists: [["sibling.txt"]],
    });
    assert.equal(accepted.accepted, false);
    assert.ok(!accepted.violations.some((item) => item.path === "sibling.txt"));
    assert.ok(accepted.violations.some((item) => item.code === "E_OUT_OF_SCOPE_PATH" && item.path === "denied.txt"));

    const peersOnly = auditWorktree(cwd, baseline, {
      write_allowlist: ["allowed.txt"],
      allowed_operations: ["write", "create"],
      peer_write_allowlists: [["sibling.txt"], ["denied.txt"]],
    });
    assert.equal(peersOnly.accepted, true);
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

  it("ignores runtime turn-diff refs before commit dispatch", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    createInternalTurnDiffRef(cwd, "alpha");
    const verdict = auditPreparedCommit(cwd, baseline);
    assert.equal(verdict.accepted, true);
    assert.ok(!verdict.violations.some((item) => item.code === "E_REFS_MUTATION"));
  });

  it("still rejects non-internal ref mutations before commit dispatch", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    git(cwd, "tag", "worker-tag");
    const verdict = auditPreparedCommit(cwd, baseline);
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_REFS_MUTATION"));
  });

  it("rejects commit-only index control-flag changes even when the tree is unchanged", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    git(cwd, "update-index", "--skip-worktree", "allowed.txt");
    const verdict = auditPreparedCommit(cwd, baseline);
    assert.equal(verdict.accepted, false);
    assert.ok(verdict.violations.some((item) => item.code === "E_INDEX_CONTROL_MUTATION"));
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

  it("rejects unknown or incomplete index-control metadata before comparison", () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    const unknown = { ...baseline, index_control_algorithm: "future-v3" };
    const unknownVerdict = auditWorktree(cwd, unknown, { write_allowlist: [], allowed_operations: [] });
    assert.ok(unknownVerdict.violations.some((item) => item.code === "INDEX_CONTROL_ALGORITHM_UNSUPPORTED"));
    assert.ok(!unknownVerdict.violations.some((item) => item.code === "E_INDEX_MUTATION"));
    const incomplete = { ...baseline, index_control_algorithm: "git-index-control-framed-sha256-v2", index_control_checksum: undefined, index_control_entry_count: 1 };
    const incompleteVerdict = auditWorktree(cwd, incomplete, { write_allowlist: [], allowed_operations: [] });
    assert.ok(incompleteVerdict.violations.some((item) => item.code === "INDEX_CONTROL_BASELINE_INVALID"));
    assert.ok(!incompleteVerdict.violations.some((item) => item.code === "E_INDEX_MUTATION"));
  });

  it("rejects invalid commit baseline metadata before index comparison", () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = captureCommitBaseline(cwd);
    const invalid = { ...baseline, staged_index_control_entry_count: undefined };
    const verdict = auditPreparedCommit(cwd, invalid);
    assert.ok(verdict.violations.some((item) => item.code === "INDEX_CONTROL_BASELINE_INVALID"));
    assert.ok(!verdict.violations.some((item) => item.code === "E_INDEX_CONTROL_MUTATION"));
  });
});

describe("stable asynchronous safety observations", () => {
  function assertV2Baseline(baseline: { index_control_algorithm?: string; index_control_entry_count?: number }): void {
    assert.equal(baseline.index_control_algorithm, "git-index-control-framed-sha256-v2");
    assert.equal(typeof baseline.index_control_entry_count, "number");
    assert.ok((baseline.index_control_entry_count ?? -1) >= 0);
  }

  function assertV2CommitBaseline(baseline: { staged_index_control_algorithm?: string; staged_index_control_entry_count?: number }): void {
    assert.equal(baseline.staged_index_control_algorithm, "git-index-control-framed-sha256-v2");
    assert.equal(typeof baseline.staged_index_control_entry_count, "number");
    assert.ok((baseline.staged_index_control_entry_count ?? -1) >= 0);
  }

  it("rechecks v2 index controls, cache refreshes, refs, dirt, peers, chmod, and symlink escapes", async () => {
    for (const [flag, clear] of [["--assume-unchanged", "--no-assume-unchanged"], ["--skip-worktree", "--no-skip-worktree"]] as const) {
      const cwd = fixture();
      const baseline = await captureBaselineAsync(cwd);
      assertV2Baseline(baseline);
      git(cwd, "update-index", flag, "allowed.txt");
      const verdict = await auditWorktreeAsync(cwd, baseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
      assert.equal(verdict.accepted, false, flag);
      assert.ok(verdict.violations.some((item) => item.code === "E_INDEX_MUTATION"), flag);
      git(cwd, "update-index", clear, "allowed.txt");
    }

    const intent = fixture();
    const intentBaseline = await captureBaselineAsync(intent);
    assertV2Baseline(intentBaseline);
    fs.writeFileSync(path.join(intent, "intent.txt"), "intent\n");
    git(intent, "add", "-N", "intent.txt");
    const intentVerdict = await auditWorktreeAsync(intent, intentBaseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(intentVerdict.accepted, false, "intent-to-add");
    assert.ok(intentVerdict.violations.some((item) => item.code === "E_INDEX_MUTATION"), "intent-to-add");

    const cache = fixture();
    const cacheBaseline = await captureBaselineAsync(cache);
    assertV2Baseline(cacheBaseline);
    const beforeTree = cacheBaseline.index_tree;
    const beforeIndex = fs.readFileSync(cacheBaseline.index_path);
    fs.utimesSync(path.join(cache, "allowed.txt"), new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    git(cache, "status", "--porcelain=v1", "--untracked-files=all");
    assert.notDeepEqual(fs.readFileSync(cacheBaseline.index_path), beforeIndex, "status must materialize a stat-cache-only index rewrite");
    const cacheVerdict = await auditWorktreeAsync(cache, cacheBaseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(cacheVerdict.accepted, true);
    assert.equal(git(cache, "write-tree").trim(), beforeTree);
    assert.ok(!cacheVerdict.violations.some((item) => item.code === "E_INDEX_MUTATION"));

    const fsmonitor = fixture();
    const fsmonitorBaseline = await captureBaselineAsync(fsmonitor);
    assertV2Baseline(fsmonitorBaseline);
    const fsmonitorDebugBefore = git(fsmonitor, "ls-files", "--debug");
    const fsmonitorIndexBefore = fs.readFileSync(fsmonitorBaseline.index_path);
    try {
      git(fsmonitor, "update-index", "--fsmonitor-valid", "allowed.txt");
    } catch (error) {
      assert.fail(`git 2.55 fsmonitor-valid mutation unavailable: ${String(error)}`);
    }
    const fsmonitorDebugAfter = git(fsmonitor, "ls-files", "--debug");
    const fsmonitorIndexAfter = fs.readFileSync(fsmonitorBaseline.index_path);
    assert.ok(fsmonitorDebugAfter !== fsmonitorDebugBefore || !fsmonitorIndexAfter.equals(fsmonitorIndexBefore), "--fsmonitor-valid must change raw index/debug state");
    const fsmonitorVerdict = await auditWorktreeAsync(fsmonitor, fsmonitorBaseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(fsmonitorVerdict.accepted, true, "fsmonitor-valid is a masked cache bit");
    assert.ok(!fsmonitorVerdict.violations.some((item) => item.code === "E_INDEX_MUTATION"));
    const fsmonitorFacts = await collectGitSafetyFacts(fsmonitor);
    assert.equal(fsmonitorFacts.indexControl.checksum, fsmonitorBaseline.index_control_checksum);
    assert.equal(fsmonitorFacts.indexControl.entryCount, fsmonitorBaseline.index_control_entry_count);

    const refs = fixture();
    const refsBaseline = await captureBaselineAsync(refs);
    assertV2Baseline(refsBaseline);
    git(refs, "tag", "async-worker-tag");
    const refsVerdict = await auditWorktreeAsync(refs, refsBaseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(refsVerdict.accepted, false);
    assert.ok(refsVerdict.violations.some((item) => item.code === "E_REFS_MUTATION"));

    const reflog = fixture();
    const reflogBaseline = await captureBaselineAsync(reflog);
    assertV2Baseline(reflogBaseline);
    git(reflog, "commit", "--allow-empty", "-q", "-m", "async reflog mutation");
    const reflogVerdict = await auditWorktreeAsync(reflog, reflogBaseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(reflogVerdict.accepted, false);
    assert.ok(reflogVerdict.violations.some((item) => item.code === "E_HEAD_MUTATION"));
    assert.ok(reflogVerdict.violations.some((item) => item.code === "E_HEAD_REFLOG_MUTATION"));

    const staged = fixture();
    const stagedBaseline = await captureBaselineAsync(staged);
    assertV2Baseline(stagedBaseline);
    fs.appendFileSync(path.join(staged, "denied.txt"), "STAGED_OUT_OF_SCOPE\n");
    git(staged, "add", "denied.txt");
    const stagedVerdict = await auditWorktreeAsync(staged, stagedBaseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(stagedVerdict.accepted, false);
    assert.ok(stagedVerdict.violations.some((item) => item.code === "E_INDEX_MUTATION"));

    const dirt = fixture();
    fs.appendFileSync(path.join(dirt, "allowed.txt"), "PREEXISTING\n");
    fs.appendFileSync(path.join(dirt, "denied.txt"), "PREEXISTING_DENIED\n");
    const dirtBaseline = await captureBaselineAsync(dirt);
    assertV2Baseline(dirtBaseline);
    fs.appendFileSync(path.join(dirt, "allowed.txt"), "INCREMENTAL\n");
    const dirtAccepted = await auditWorktreeAsync(dirt, dirtBaseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(dirtAccepted.accepted, true);
    fs.appendFileSync(path.join(dirt, "denied.txt"), "UNAFFILIATED\n");
    const dirtRejected = await auditWorktreeAsync(dirt, dirtBaseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.equal(dirtRejected.accepted, false);
    assert.ok(dirtRejected.violations.some((item) => item.code === "E_OUT_OF_SCOPE_PATH" && item.path === "denied.txt"));

    const peers = fixture();
    const peersBaseline = await captureBaselineAsync(peers);
    assertV2Baseline(peersBaseline);
    fs.appendFileSync(path.join(peers, "allowed.txt"), "WORKER\n");
    fs.writeFileSync(path.join(peers, "sibling.txt"), "PEER\n");
    fs.writeFileSync(path.join(peers, "unaffiliated.txt"), "NOPE\n");
    const peerVerdict = await auditWorktreeAsync(peers, peersBaseline, {
      write_allowlist: ["allowed.txt"], allowed_operations: ["write", "create"], peer_write_allowlists: [["sibling.txt"]],
    });
    assert.equal(peerVerdict.accepted, false);
    assert.ok(!peerVerdict.violations.some((item) => item.path === "sibling.txt"));
    assert.ok(peerVerdict.violations.some((item) => item.code === "E_OUT_OF_SCOPE_PATH" && item.path === "unaffiliated.txt"));
    fs.unlinkSync(path.join(peers, "unaffiliated.txt"));
    const peerOnlyVerdict = await auditWorktreeAsync(peers, peersBaseline, {
      write_allowlist: ["allowed.txt"], allowed_operations: ["write", "create"], peer_write_allowlists: [["sibling.txt"]],
    });
    assert.equal(peerOnlyVerdict.accepted, true);

    const mode = fixture();
    const modeBaseline = await captureBaselineAsync(mode);
    assertV2Baseline(modeBaseline);
    fs.chmodSync(path.join(mode, "allowed.txt"), 0o755);
    const modeRejected = await auditWorktreeAsync(mode, modeBaseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["write"] });
    assert.ok(modeRejected.violations.some((item) => item.code === "E_OUT_OF_SCOPE_OP" && item.operation === "chmod"));
    const modeAccepted = await auditWorktreeAsync(mode, modeBaseline, { write_allowlist: ["allowed.txt"], allowed_operations: ["chmod"] });
    assert.equal(modeAccepted.accepted, true);

    const symlink = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "baton-safety-outside-"));
    fs.writeFileSync(path.join(outside, "target.txt"), "outside\n");
    const symlinkBaseline = await captureBaselineAsync(symlink);
    assertV2Baseline(symlinkBaseline);
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(symlink, "escape.txt"));
    const symlinkVerdict = await auditWorktreeAsync(symlink, symlinkBaseline, { write_allowlist: ["escape.txt"], allowed_operations: ["create"] });
    assert.equal(symlinkVerdict.accepted, false);
    assert.ok(symlinkVerdict.violations.some((item) => item.code === "E_SYMLINK_ESCAPE"));
  });

  it("audits all required v2 commit-only outcomes with exact verdict codes", async () => {
    const valid = fixture();
    fs.appendFileSync(path.join(valid, "allowed.txt"), "STAGED\n");
    git(valid, "add", "allowed.txt");
    const validBaseline = await captureCommitBaselineAsync(valid);
    assertV2CommitBaseline(validBaseline);
    assert.equal((await auditPreparedCommitAsync(valid, validBaseline)).accepted, true);
    git(valid, "commit", "-q", "-m", "async valid");
    assert.equal((await auditCommitOutcomeAsync(valid, validBaseline)).accepted, true);

    const missing = fixture();
    fs.appendFileSync(path.join(missing, "allowed.txt"), "STAGED\n");
    git(missing, "add", "allowed.txt");
    const missingBaseline = await captureCommitBaselineAsync(missing);
    assertV2CommitBaseline(missingBaseline);
    const missingVerdict = await auditCommitOutcomeAsync(missing, missingBaseline);
    assert.equal(missingVerdict.accepted, false);
    assert.ok(missingVerdict.violations.some((item) => item.code === "E_COMMIT_MISSING"));

    const widened = fixture();
    fs.appendFileSync(path.join(widened, "allowed.txt"), "STAGED\n");
    git(widened, "add", "allowed.txt");
    const widenedBaseline = await captureCommitBaselineAsync(widened);
    assertV2CommitBaseline(widenedBaseline);
    fs.appendFileSync(path.join(widened, "denied.txt"), "EXTRA\n");
    git(widened, "add", "denied.txt");
    git(widened, "commit", "-q", "-m", "widened");
    const widenedVerdict = await auditCommitOutcomeAsync(widened, widenedBaseline);
    assert.ok(widenedVerdict.violations.some((item) => item.code === "E_COMMIT_TREE_MISMATCH"));

    const control = fixture();
    fs.appendFileSync(path.join(control, "allowed.txt"), "STAGED\n");
    git(control, "add", "allowed.txt");
    const controlBaseline = await captureCommitBaselineAsync(control);
    assertV2CommitBaseline(controlBaseline);
    git(control, "update-index", "--skip-worktree", "allowed.txt");
    const controlVerdict = await auditPreparedCommitAsync(control, controlBaseline);
    assert.ok(controlVerdict.violations.some((item) => item.code === "E_INDEX_CONTROL_MUTATION"));

    const multiple = fixture();
    fs.appendFileSync(path.join(multiple, "allowed.txt"), "ONE\n");
    git(multiple, "add", "allowed.txt");
    const multipleBaseline = await captureCommitBaselineAsync(multiple);
    assertV2CommitBaseline(multipleBaseline);
    git(multiple, "commit", "-q", "-m", "first");
    fs.appendFileSync(path.join(multiple, "allowed.txt"), "TWO\n");
    git(multiple, "add", "allowed.txt");
    git(multiple, "commit", "-q", "-m", "second");
    git(multiple, "tag", "extra-ref");
    const multipleVerdict = await auditCommitOutcomeAsync(multiple, multipleBaseline);
    assert.ok(multipleVerdict.violations.some((item) => item.code === "E_REFS_MUTATION"));
    assert.ok(multipleVerdict.violations.some((item) => item.code === "E_HEAD_REFLOG_MUTATION"));
  });

  it("sanitizes runtime selector fields and forces v2 for both baseline captures", async () => {
    const cwd = fixture();
    const seen: unknown[] = [];
    const baselineFacts = await collectGitSafetyFacts(cwd);
    const staleRuntimeOptions = {

      indexControlAlgorithm: "git-index-control-framed-sha256-v2",
      collectFacts: async (_root: string, passOptions: { indexControlAlgorithm?: string }): Promise<GitSafetyFacts> => {
        seen.push(passOptions.indexControlAlgorithm);
        return baselineFacts;
      },
      collectToken: async (_root: string, passOptions: { indexControlAlgorithm?: string }) => {
        seen.push(passOptions.indexControlAlgorithm);
        return deriveGitSafetyStabilityToken(baselineFacts);
      },
    } as unknown as AsyncSafetyOptions;

    const baseline = await captureBaselineAsync(cwd, new Date("2026-01-01T00:00:00.000Z"), staleRuntimeOptions);
    assert.equal(baseline.index_control_algorithm, "git-index-control-framed-sha256-v2");
    assert.deepEqual(seen, ["git-index-control-framed-sha256-v2", "git-index-control-framed-sha256-v2"]);

    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const commitFacts = await collectGitSafetyFacts(cwd);
    seen.length = 0;
    const commitOptions = {

      indexControlAlgorithm: "git-index-control-framed-sha256-v2",
      collectFacts: async (_root: string, passOptions: { indexControlAlgorithm?: string }): Promise<GitSafetyFacts> => {
        seen.push(passOptions.indexControlAlgorithm);
        return commitFacts;
      },
      collectToken: async (_root: string, passOptions: { indexControlAlgorithm?: string }) => {
        seen.push(passOptions.indexControlAlgorithm);
        return deriveGitSafetyStabilityToken(commitFacts);
      },
    } as unknown as AsyncSafetyOptions;
    const commitBaseline = await captureCommitBaselineAsync(cwd, new Date(), commitOptions);
    assert.equal(commitBaseline.staged_index_control_algorithm, "git-index-control-framed-sha256-v2");
    assert.deepEqual(seen, ["git-index-control-framed-sha256-v2", "git-index-control-framed-sha256-v2"]);
  });

  it("captures a v2 baseline and preserves worktree verdict parity with the sync baseline", async () => {
    const cwd = fixture();
    const syncBaseline = captureBaseline(cwd);
    const asyncBaseline = await captureBaselineAsync(cwd, new Date("2026-01-01T00:00:00.000Z"));
    assert.equal(asyncBaseline.index_control_algorithm, "git-index-control-framed-sha256-v2");
    assert.equal(typeof asyncBaseline.index_control_entry_count, "number");
    assert.equal(asyncBaseline.index_tree, syncBaseline.index_tree);
    assert.deepEqual(asyncBaseline.dirty_entries, syncBaseline.dirty_entries);
    assert.deepEqual(asyncBaseline.refs, syncBaseline.refs);
    const policy = { write_allowlist: [], allowed_operations: [] };
    assert.deepEqual(await auditWorktreeAsync(cwd, syncBaseline, policy), auditWorktree(cwd, syncBaseline, policy));
  });

  it("keeps sync and async snapshots aligned for runtime turn-diff refs", async () => {
    const cwd = fixture();
    const syncBaseline = captureBaseline(cwd);
    const asyncBaseline = await captureBaselineAsync(cwd);
    assert.deepEqual(asyncBaseline.refs, syncBaseline.refs);

    createInternalTurnDiffRef(cwd, "alpha", "native");
    const policy = { write_allowlist: [], allowed_operations: [] };
    assert.equal(auditWorktree(cwd, syncBaseline, policy).accepted, true);
    assert.equal((await auditWorktreeAsync(cwd, asyncBaseline, policy)).accepted, true);

    git(cwd, "update-ref", "refs/tags/turn-diffs/should-be-audited", "HEAD");
    assert.equal(auditWorktree(cwd, syncBaseline, policy).accepted, false);
    assert.equal((await auditWorktreeAsync(cwd, asyncBaseline, policy)).accepted, false);
  });

  it("audits v2 commit baselines and keeps prepared/outcome semantics", async () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = await captureCommitBaselineAsync(cwd);
    assert.equal(baseline.staged_index_control_algorithm, "git-index-control-framed-sha256-v2");
    assert.equal((await auditPreparedCommitAsync(cwd, baseline)).accepted, true);
    git(cwd, "commit", "-q", "-m", "async commit");
    const verdict = await auditCommitOutcomeAsync(cwd, baseline);
    assert.equal(verdict.accepted, true);
    assert.equal(verdict.committed, true);
    assert.equal(verdict.commit?.parent, baseline.head);
    assert.equal(verdict.commit?.tree, baseline.staged_tree);
    assert.deepEqual(Object.keys(verdict.commit ?? {}).sort(), ["id", "parent", "subject", "tree"]);
  });

  it("rejects a merge parent count while exposing only the public commit fields", async () => {
    const cwd = fixture();
    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const baseline = await captureCommitBaselineAsync(cwd);
    const sourceFacts = await collectGitSafetyFacts(cwd);
    const mergeHead = "e".repeat(40);
    const mergeFacts: GitSafetyFacts = {
      ...sourceFacts,
      head: mergeHead,
      refs: sourceFacts.refs.map((item) => item.startsWith(`${baseline.branch_ref}\0`)
        ? `${baseline.branch_ref}\0${mergeHead}` : item),
      reflog: { count: baseline.head_reflog_count + 1, checksum: "f".repeat(64) },
      reflogFirst: `${mergeHead}\0merge commit`,
      reflogPriorChecksum: baseline.head_reflog_checksum,
      commit: {
        id: mergeHead,
        parent: baseline.head,
        parentCount: 2,
        tree: baseline.staged_tree,
        subject: "merge commit",
      },
    };
    const verdict = await auditCommitOutcomeAsync(cwd, baseline, {
      collectFacts: async () => mergeFacts,
      collectToken: async () => deriveGitSafetyStabilityToken(mergeFacts),
    });
    assert.equal(verdict.committed, true);
    assert.ok(verdict.violations.some((item) => item.code === "E_COMMIT_PARENT_MISMATCH"));
    assert.deepEqual(Object.keys(verdict.commit ?? {}).sort(), ["id", "parent", "subject", "tree"]);
  });

  it("uses v2 index verification and returns stable typed races", async () => {
    const cwd = fixture();
    const baseline = captureBaseline(cwd);
    const v2Verdict = await auditWorktreeAsync(cwd, baseline, { write_allowlist: [], allowed_operations: [] });
    assert.equal(v2Verdict.accepted, true);

    const facts = await collectGitSafetyFacts(cwd);
    const raced = deriveGitSafetyStabilityToken(facts);
    raced.head = "f".repeat(40);
    await assert.rejects(
      auditWorktreeAsync(cwd, baseline, { write_allowlist: [], allowed_operations: [] }, {
        collectFacts: async (): Promise<GitSafetyFacts> => facts,
        collectToken: async () => raced,
      }),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code?: string }).code === "GIT_AUDIT_RACED",
    );
  });

  it("keeps unknown and incomplete async metadata as verdicts instead of collector errors", async () => {
    const cwd = fixture();
    const writeBaseline = captureBaseline(cwd);
    const unknownWrite = { ...writeBaseline, index_control_algorithm: "future-v3" };
    const incompleteWrite = { ...writeBaseline, index_control_algorithm: "git-index-control-framed-sha256-v2", index_control_checksum: undefined, index_control_entry_count: 1 };
    for (const candidate of [unknownWrite, incompleteWrite]) {
      const verdict = await auditWorktreeAsync(cwd, candidate, { write_allowlist: [], allowed_operations: [] });
      assert.equal(verdict.accepted, false);
      assert.ok(verdict.violations.some((item) => item.code.startsWith("INDEX_CONTROL_")));
      assert.ok(!verdict.violations.some((item) => item.code === "E_INDEX_CONTROL_MUTATION"));
    }

    fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
    git(cwd, "add", "allowed.txt");
    const commitBaseline = await captureCommitBaselineAsync(cwd);
    const unknownCommit = { ...commitBaseline, staged_index_control_algorithm: "future-v3" };
    const incompleteCommit = { ...commitBaseline, staged_index_control_algorithm: "git-index-control-framed-sha256-v2", staged_index_control_checksum: undefined, staged_index_control_entry_count: 1 };
    for (const candidate of [unknownCommit, incompleteCommit]) {
      const verdict = await auditPreparedCommitAsync(cwd, candidate);
      assert.equal(verdict.accepted, false);
      assert.ok(verdict.violations.some((item) => item.code.startsWith("INDEX_CONTROL_")));
      assert.ok(!verdict.violations.some((item) => item.code === "E_INDEX_CONTROL_MUTATION"));
      const outcome = await auditCommitOutcomeAsync(cwd, candidate, { requireCommit: false });
      assert.ok(outcome.violations.some((item) => item.code.startsWith("INDEX_CONTROL_")));
      assert.ok(!outcome.violations.some((item) => item.code === "E_INDEX_CONTROL_MUTATION"));
    }
  });
});
