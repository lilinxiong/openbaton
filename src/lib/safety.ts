import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fingerprintGitIndexControlRecords, GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM } from "./git-index-control.js";
import {
  captureStableSafetyFacts,
  type GitSafetyFacts,
  type StableGitSafetyFacts,
  type StableGitSafetyFactsOptions,
} from "./git-safety-facts.js";
import { isRuntimeTurnDiffRef } from "./git-record-consumers.js";
import { collectGitScalar, type GitProcessOptions } from "./git-safety-process.js";
import { sha256Hex } from "./json-utils.js";

export type SafetyOperation = "write" | "create" | "delete" | "rename" | "chmod";

export interface GitBaseline {
  repo_root: string;
  head: string;
  branch: string;
  /** Attached branch ref, when the baseline was captured on a branch. */
  branch_ref: string;
  index_path: string;
  /** Semantic tree represented by the staged index. */
  index_tree: string;
  /** Semantic index-entry control flags; stat-cache bytes are deliberately omitted. */
  index_control_checksum: string;
  /** Optional version marker for the framed index-control fingerprint. */
  index_control_algorithm: string;
  /** Number of index-control records covered by the versioned fingerprint. */
  index_control_entry_count?: number;
  /** Complete refs and HEAD reflog captured for ordinary worker audits. */
  refs: string[];
  head_reflog_count: number;
  head_reflog_checksum: string;
  dirty_entries: StatusEntry[];
  /** Content fingerprint of each dirty path so incremental writes can keep pre-existing dirt. */
  dirty_checksums: Record<string, string>;
  captured_at: string;
}

export interface CommitBaseline {
  repo_root: string;
  head: string;
  branch: string;
  branch_ref: string;
  staged_tree: string;
  /** Semantic index-entry control flags; stat-cache bytes are deliberately omitted. */
  staged_index_control_checksum: string;
  /** Optional version marker for the framed index-control fingerprint. */
  staged_index_control_algorithm: string;
  /** Number of index-control records covered by the versioned fingerprint. */
  staged_index_control_entry_count?: number;
  staged_paths: string[];
  refs: string[];
  head_reflog_count: number;
  head_reflog_checksum: string;
  captured_at: string;
}

export interface StatusEntry {
  code: string;
  path: string;
  original_path?: string;
}

export interface SafetyPolicy {
  write_allowlist: string[];
  allowed_operations: SafetyOperation[];
  /** Allowlists of overlapping write tickets. Dirt on those paths is their audit, not this one. */
  peer_write_allowlists?: string[][];
  /**
   * Linked isolated roots share one common refs namespace with the parent.
   * Parent-owned integration may advance it while this root remains active;
   * root-local HEAD, branch, reflog, index, and path checks stay strict.
   */
  shared_refs?: "strict" | "parent-owned";
}

export interface SafetyViolation {
  code: string;
  path?: string;
  original_path?: string;
  operation?: SafetyOperation | "copy";
  message: string;
}

export interface SafetyVerdict {
  accepted: boolean;
  changes: Array<StatusEntry & { operation: SafetyOperation }>;
  violations: SafetyViolation[];
}

export interface CommitSafetyViolation {
  code: string;
  message: string;
}

export interface CommitSafetyVerdict {
  accepted: boolean;
  committed: boolean;
  commit: {
    id: string;
    parent: string;
    tree: string;
    subject: string;
  } | null;
  violations: CommitSafetyViolation[];
}

/** Narrow injection surface for Promise-based stable safety APIs. */
export interface AsyncSafetyOptions {
  spawn?: GitProcessOptions["spawn"];
  collectFacts?: StableGitSafetyFactsOptions["collectFacts"];
  collectToken?: StableGitSafetyFactsOptions["collectToken"];
}

export class CommitBaselineError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CommitBaselineError";
    this.code = code;
  }
}

export type IndexControlBaselineErrorCode =
  | "INDEX_CONTROL_ALGORITHM_UNSUPPORTED"
  | "INDEX_CONTROL_BASELINE_INVALID";

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Validate the current framed index-control metadata. Old baseline shapes are
 * intentionally rejected so they cannot silently weaken an audit.
 */
export function validateIndexControlBaselineMetadata(
  baseline: {
    index_control_algorithm?: unknown;
    index_control_checksum?: unknown;
    index_control_entry_count?: unknown;
  },
  prefix = "index_control",
): IndexControlBaselineErrorCode | null {
  const algorithm = baseline.index_control_algorithm;
  const checksum = baseline.index_control_checksum;
  const entryCount = baseline.index_control_entry_count;
  if (algorithm !== GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM) {
    return "INDEX_CONTROL_ALGORITHM_UNSUPPORTED";
  }
  if (typeof checksum !== "string" || !HEX_SHA256.test(checksum)
    || typeof entryCount !== "number" || !Number.isSafeInteger(entryCount) || entryCount < 0) {
    return "INDEX_CONTROL_BASELINE_INVALID";
  }
  void prefix;
  return null;
}

function indexControlBaselineViolation(
  baseline: { index_control_algorithm?: unknown; index_control_checksum?: unknown; index_control_entry_count?: unknown },
  prefix = "index_control",
): { code: IndexControlBaselineErrorCode; message: string } | null {
  const code = validateIndexControlBaselineMetadata(baseline, prefix);
  return code ? { code, message: `${prefix} baseline metadata is invalid` } : null;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git safety command failed: git ${args.join(" ")}: ${message}`);
  }
}

function checksumFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return sha256Hex(fs.readFileSync(file));
}

function checksumWorktreePath(root: string, rel: string): string {
  const absolute = path.join(root, rel);
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(absolute)}`;
    if (stat.isDirectory()) return `dir:${stat.mode}`;
    return checksumFile(absolute) || "missing";
  } catch {
    return "missing";
  }
}

function checksumValue(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

function gitExitZero(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch (cause) {
    if (Number((cause as { status?: number }).status) === 1) return false;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git safety command failed: git ${args.join(" ")}: ${message}`);
  }
}

function gitOptional(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    if (Number((cause as { status?: number }).status) === 1) return null;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git safety command failed: git ${args.join(" ")}: ${message}`);
  }
}

function localGitPath(repoRoot: string, name: string): string {
  const value = git(repoRoot, ["rev-parse", "--git-path", name]).trim();
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function gitOperationInProgress(repoRoot: string): string | null {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer"]) {
    if (fs.existsSync(localGitPath(repoRoot, name))) return name;
  }
  return null;
}

function stagedPaths(repoRoot: string): string[] {
  return git(repoRoot, ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
}

function stagedTree(repoRoot: string): string {
  return git(repoRoot, ["write-tree"]).trim();
}

/**
 * Return a stable fingerprint of the index metadata that affects Git's
 * interpretation of an entry.  `git ls-files --debug` also prints ctime,
 * mtime, device, inode, uid, gid, and size; those are stat-cache fields and
 * are intentionally excluded so a read-only `git status` refresh remains
 * tolerated.  The flags value includes assume-unchanged, skip-worktree,
 * intent-to-add, and future extended entry flags; only fsmonitor-valid is
 * masked as a volatile cache bit.
 */
function indexControlChecksum(repoRoot: string): string {
  const output = execFileSync("git", ["ls-files", "--debug", "-z"], { cwd: repoRoot }) as Buffer;
  const entries: Array<{ pathname: Buffer; maskedFlags: number }> = [];
  let cursor = 0;
  while (cursor < output.length) {
    const nul = output.indexOf(0, cursor);
    if (nul < 0) break;
    const file = output.slice(cursor, nul);
    const tail = output.slice(nul + 1);
    // `--debug -z` NUL-terminates the pathname, then appends the debug block;
    // the next pathname starts immediately after the flags line.
    const match = tail.toString("ascii").match(/(?:^|\n)[^\n]*\bflags:[ \t]*([0-9A-Fa-f]+)[ \t]*(?:\n|$)/);
    if (!match) throw new Error(`git ls-files --debug omitted flags for ${file}`);
    // The fsmonitor-valid bit is a volatile cache hint, not a worker-visible
    // index mutation. Keep semantic controls (assume-unchanged,
    // skip-worktree, intent-to-add, and future non-cache bits) in the
    // fingerprint while masking only CE_FSMONITOR_VALID (0x80000000).
    const flags = Number.parseInt(match[1], 16) >>> 0;
    entries.push({ pathname: file, maskedFlags: flags & 0x7fffffff });
    cursor = nul + 1 + match.index + match[0].length;
  }
  return fingerprintGitIndexControlRecords(entries).checksum;
}

function indexControlEntryCount(repoRoot: string): number {
  const output = git(repoRoot, ["ls-files", "--debug", "-z"]);
  return (output.match(/\0/g) || []).length;
}

function refsSnapshot(repoRoot: string): string[] {
  return git(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"])
    .split("\n")
    .filter(Boolean)
    .filter((entry) => !isRuntimeTurnDiffRef(entry));
}

function headReflog(repoRoot: string): string[] {
  return git(repoRoot, ["reflog", "show", "--format=%H%x00%gs", "HEAD"])
    .split("\n")
    .filter(Boolean);
}

function hasUnstagedOrUntracked(repoRoot: string): boolean {
  if (!gitExitZero(repoRoot, ["diff", "--quiet"])) return true;
  return Boolean(git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function splitRefSnapshotEntry(entry: string): { ref: string; object: string } | null {
  const separator = entry.indexOf("\0");
  if (separator <= 0 || separator === entry.length - 1 || entry.indexOf("\0", separator + 1) !== -1) return null;
  const ref = entry.slice(0, separator);
  const object = entry.slice(separator + 1);
  if (!ref.startsWith("refs/") || !/^[0-9a-f]+$/u.test(object)) return null;
  return { ref, object };
}

/**
 * Isolated workers share the repository ref namespace with the parent.  The
 * parent may add refs or advance an existing ref, but it may not delete or
 * rewrite a baseline ref while the worker is being audited.
 */
function parentOwnedRefsPreserved(repoRoot: string, observed: string[], baseline: string[]): boolean {
  const observedRefs = new Map<string, string>();
  for (const entry of observed) {
    const parsed = splitRefSnapshotEntry(entry);
    if (!parsed || observedRefs.has(parsed.ref)) return false;
    observedRefs.set(parsed.ref, parsed.object);
  }
  for (const entry of baseline) {
    const parsed = splitRefSnapshotEntry(entry);
    if (!parsed) return false;
    const current = observedRefs.get(parsed.ref);
    if (!current) return false;
    if (current === parsed.object) continue;
    try {
      if (!gitExitZero(repoRoot, ["merge-base", "--is-ancestor", parsed.object, current])) return false;
    } catch {
      // Captured or deserialized ref objects may be missing or invalid.  An
      // audit converts every such ancestry failure into a ref violation.
      return false;
    }
  }
  return true;
}

export function parsePorcelainV1Z(output: string): StatusEntry[] {
  const tokens = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4) throw new Error("invalid git porcelain record");
    const code = token.slice(0, 2);
    const item: StatusEntry = { code, path: token.slice(3) };
    if (code.includes("R") || code.includes("C")) {
      const original = tokens[index + 1];
      if (!original) throw new Error("rename record missing original path");
      item.original_path = original;
      index += 1;
    }
    entries.push(item);
  }
  return entries;
}

export function captureBaseline(worktree: string, now: Date = new Date()): GitBaseline {
  const repoRoot = git(worktree, ["rev-parse", "--show-toplevel"]).trim();
  const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const branch = git(repoRoot, ["branch", "--show-current"]).trim();
  const branchRef = gitOptional(repoRoot, ["symbolic-ref", "-q", "HEAD"])?.trim() || "";
  const refs = refsSnapshot(repoRoot);
  const reflog = headReflog(repoRoot);
  const indexRelative = git(repoRoot, ["rev-parse", "--git-path", "index"]).trim();
  const indexPath = path.isAbsolute(indexRelative) ? indexRelative : path.join(repoRoot, indexRelative);
  const dirtyEntries = parsePorcelainV1Z(git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const resolvedRoot = fs.realpathSync(repoRoot);
  const dirtyChecksums: Record<string, string> = {};
  for (const entry of dirtyEntries) {
    dirtyChecksums[entry.path] = checksumWorktreePath(resolvedRoot, entry.path);
    if (entry.original_path) dirtyChecksums[entry.original_path] = checksumWorktreePath(resolvedRoot, entry.original_path);
  }
  return {
    repo_root: resolvedRoot,
    head,
    branch,
    branch_ref: branchRef,
    index_path: indexPath,
    index_tree: stagedTree(repoRoot),
    index_control_checksum: indexControlChecksum(repoRoot),
    index_control_algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
    index_control_entry_count: indexControlEntryCount(repoRoot),
    refs,
    head_reflog_count: reflog.length,
    head_reflog_checksum: checksumValue(reflog),
    dirty_entries: dirtyEntries,
    dirty_checksums: dirtyChecksums,
    captured_at: now.toISOString(),
  };
}

async function resolveRepoRootAsync(worktree: string, spawn?: GitProcessOptions["spawn"]): Promise<string> {
  const resolved = await collectGitScalar({ cwd: worktree, args: ["rev-parse", "--show-toplevel"], spawn });
  return fs.realpathSync(resolved.trim());
}

function indexMetadata(fingerprint: GitSafetyFacts["indexControl"]): {
  checksum: string;
  algorithm: string;
  entryCount: number;
} {
  return { checksum: fingerprint.checksum, algorithm: fingerprint.algorithm, entryCount: fingerprint.entryCount };
}

/** Select only a known collector algorithm; malformed metadata is reported by
 * the verdict mapper rather than being passed to the collector as a string. */
function selectAuditIndexControlAlgorithm(baseline: {
  index_control_algorithm?: unknown;
  index_control_checksum?: unknown;
  index_control_entry_count?: unknown;
}): typeof GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM {
  return GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM;
}

function stableObservationOptions(
  options: AsyncSafetyOptions,
  purpose: "baseline" | "audit",
  indexControlAlgorithm: typeof GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
): StableGitSafetyFactsOptions {
  // Pick fields explicitly so callers cannot smuggle an arbitrary algorithm.
  return {
    purpose,
    spawn: options.spawn,
    collectFacts: options.collectFacts,
    collectToken: options.collectToken,
    indexControlAlgorithm,
  };
}

function factsHaveUnstagedOrUntracked(facts: GitSafetyFacts): boolean {
  return facts.untrackedExists || facts.dirtyEntries.some((entry) => entry.code === "??" || entry.code[1] !== " ");
}

function dirtyChecksumsFromFacts(root: string, entries: StatusEntry[]): Record<string, string> {
  const dirtyChecksums: Record<string, string> = {};
  for (const entry of entries) {
    dirtyChecksums[entry.path] = checksumWorktreePath(root, entry.path);
    if (entry.original_path) dirtyChecksums[entry.original_path] = checksumWorktreePath(root, entry.original_path);
  }
  return dirtyChecksums;
}

/**
 * Promise-based baseline capture. The complete facts pass is accepted only
 * after its independent stability token agrees, so no Receipt should be
 * materialized from a mixed-time repository observation.
 */
export async function captureBaselineAsync(
  worktree: string,
  now: Date = new Date(),
  options: AsyncSafetyOptions = {},
): Promise<GitBaseline> {
  const root = await resolveRepoRootAsync(worktree, options.spawn);
  const facts = await captureStableSafetyFacts(
    root,
    stableObservationOptions(options, "baseline", GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM),
  );
  const metadata = indexMetadata(facts.indexControl);
  return {
    repo_root: root,
    head: facts.head,
    branch: facts.branch,
    branch_ref: facts.branchRef,
    index_path: facts.indexPath || path.join(root, ".git", "index"),
    index_tree: facts.stagedTree,
    index_control_checksum: metadata.checksum,
    index_control_algorithm: metadata.algorithm,
    index_control_entry_count: metadata.entryCount,
    refs: facts.refs,
    head_reflog_count: facts.reflog.count,
    head_reflog_checksum: facts.reflog.checksum,
    dirty_entries: facts.dirtyEntries,
    dirty_checksums: dirtyChecksumsFromFacts(root, facts.dirtyEntries),
    captured_at: now.toISOString(),
  };
}

/**
 * Freeze an already-staged, otherwise-clean commit candidate. The worker may
 * consume this exact index tree with one commit, but may not stage or edit it.
 */
export function captureCommitBaseline(worktree: string, now: Date = new Date()): CommitBaseline {
  const repoRoot = fs.realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]).trim());
  if (gitExitZero(repoRoot, ["diff", "--cached", "--quiet"])) {
    throw new CommitBaselineError("commit-only dispatch requires a non-empty staged diff", "STAGED_DIFF_REQUIRED");
  }
  if (hasUnstagedOrUntracked(repoRoot)) {
    throw new CommitBaselineError(
      "commit-only dispatch requires an otherwise clean worktree; stage the complete intended change and keep unrelated changes out",
      "COMMIT_BASELINE_NOT_STAGED_ONLY",
    );
  }
  const operation = gitOperationInProgress(repoRoot);
  if (operation) {
    throw new CommitBaselineError(`commit-only dispatch is blocked while ${operation} exists`, "GIT_OPERATION_IN_PROGRESS");
  }
  const branchRef = gitOptional(repoRoot, ["symbolic-ref", "-q", "HEAD"])?.trim() || "";
  if (!branchRef.startsWith("refs/heads/")) {
    throw new CommitBaselineError("commit-only dispatch requires an attached local branch", "ATTACHED_BRANCH_REQUIRED");
  }
  const refs = refsSnapshot(repoRoot);
  if (!refs.some((item) => item.startsWith(`${branchRef}\0`))) {
    throw new CommitBaselineError("current branch ref is missing from the Git ref snapshot", "BRANCH_REF_MISSING");
  }
  const reflog = headReflog(repoRoot);
  if (!reflog.length) {
    throw new CommitBaselineError("commit-only dispatch requires an enabled HEAD reflog", "HEAD_REFLOG_REQUIRED");
  }
  return {
    repo_root: repoRoot,
    head: git(repoRoot, ["rev-parse", "HEAD"]).trim(),
    branch: git(repoRoot, ["branch", "--show-current"]).trim(),
    branch_ref: branchRef,
    staged_tree: git(repoRoot, ["write-tree"]).trim(),
    staged_index_control_checksum: indexControlChecksum(repoRoot),
    staged_index_control_algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
    staged_index_control_entry_count: indexControlEntryCount(repoRoot),
    staged_paths: stagedPaths(repoRoot),
    refs,
    head_reflog_count: reflog.length,
    head_reflog_checksum: checksumValue(reflog),
    captured_at: now.toISOString(),
  };
}

/** Promise-based stable capture for an already-staged commit-only candidate. */
export async function captureCommitBaselineAsync(
  worktree: string,
  now: Date = new Date(),
  options: AsyncSafetyOptions = {},
): Promise<CommitBaseline> {
  const root = await resolveRepoRootAsync(worktree, options.spawn);
  const facts = await captureStableSafetyFacts(
    root,
    stableObservationOptions(options, "baseline", GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM),
  );
  if (!facts.stagedPaths.length) {
    throw new CommitBaselineError("commit-only dispatch requires a non-empty staged diff", "STAGED_DIFF_REQUIRED");
  }
  if (factsHaveUnstagedOrUntracked(facts)) {
    throw new CommitBaselineError(
      "commit-only dispatch requires an otherwise clean worktree; stage the complete intended change and keep unrelated changes out",
      "COMMIT_BASELINE_NOT_STAGED_ONLY",
    );
  }
  if (facts.gitOperation) {
    throw new CommitBaselineError(`commit-only dispatch is blocked while ${facts.gitOperation} exists`, "GIT_OPERATION_IN_PROGRESS");
  }
  if (!facts.branchRef.startsWith("refs/heads/")) {
    throw new CommitBaselineError("commit-only dispatch requires an attached local branch", "ATTACHED_BRANCH_REQUIRED");
  }
  if (!facts.refs.some((item) => item.startsWith(`${facts.branchRef}\0`))) {
    throw new CommitBaselineError("current branch ref is missing from the Git ref snapshot", "BRANCH_REF_MISSING");
  }
  if (!facts.reflog.count) {
    throw new CommitBaselineError("commit-only dispatch requires an enabled HEAD reflog", "HEAD_REFLOG_REQUIRED");
  }
  const metadata = indexMetadata(facts.indexControl);
  return {
    repo_root: root,
    head: facts.head,
    branch: facts.branch,
    branch_ref: facts.branchRef,
    staged_tree: facts.stagedTree,
    staged_index_control_checksum: metadata.checksum,
    staged_index_control_algorithm: metadata.algorithm,
    staged_index_control_entry_count: metadata.entryCount,
    staged_paths: facts.stagedPaths,
    refs: facts.refs,
    head_reflog_count: facts.reflog.count,
    head_reflog_checksum: facts.reflog.checksum,
    captured_at: now.toISOString(),
  };
}

function commitViolation(violations: CommitSafetyViolation[], code: string, message: string): void {
  violations.push({ code, message });
}

/** Verify that nothing changed between Receipt creation and host reservation. */
export function auditPreparedCommit(worktree: string, baseline: CommitBaseline): CommitSafetyVerdict {
  const root = fs.realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]).trim());
  const violations: CommitSafetyViolation[] = [];
  const metadataError = indexControlBaselineViolation({
    index_control_algorithm: baseline.staged_index_control_algorithm,
    index_control_checksum: baseline.staged_index_control_checksum,
    index_control_entry_count: baseline.staged_index_control_entry_count,
  }, "staged_index_control");
  if (metadataError) commitViolation(violations, metadataError.code, metadataError.message);
  if (root !== baseline.repo_root) commitViolation(violations, "E_BASELINE_REPO_MISMATCH", "baseline belongs to another repository");
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head !== baseline.head) commitViolation(violations, "E_HEAD_MUTATION", "HEAD changed after commit authorization");
  const branchRef = gitOptional(root, ["symbolic-ref", "-q", "HEAD"])?.trim() || "";
  if (branchRef !== baseline.branch_ref) commitViolation(violations, "E_BRANCH_MUTATION", "current branch changed after commit authorization");
  if (!sameList(refsSnapshot(root), baseline.refs)) commitViolation(violations, "E_REFS_MUTATION", "Git refs changed after commit authorization");
  const reflog = headReflog(root);
  if (reflog.length !== baseline.head_reflog_count || checksumValue(reflog) !== baseline.head_reflog_checksum) {
    commitViolation(violations, "E_HEAD_REFLOG_MUTATION", "HEAD reflog changed after commit authorization");
  }
  const indexTree = git(root, ["write-tree"]).trim();
  if (indexTree !== baseline.staged_tree) commitViolation(violations, "E_INDEX_TREE_MUTATION", "staged tree changed after commit authorization");
  if (!metadataError && indexControlChecksum(root) !== baseline.staged_index_control_checksum) {
    commitViolation(violations, "E_INDEX_CONTROL_MUTATION", "index control metadata changed after commit authorization");
  }
  if (!sameList(stagedPaths(root), baseline.staged_paths)) commitViolation(violations, "E_STAGED_PATH_MUTATION", "staged paths changed after commit authorization");
  if (gitExitZero(root, ["diff", "--cached", "--quiet"])) commitViolation(violations, "E_STAGED_DIFF_MISSING", "authorized staged diff is no longer present");
  if (hasUnstagedOrUntracked(root)) commitViolation(violations, "E_WORKTREE_MUTATION", "worktree gained unstaged or untracked changes");
  const operation = gitOperationInProgress(root);
  if (operation) commitViolation(violations, "E_GIT_OPERATION", `unexpected Git operation state: ${operation}`);
  return { accepted: violations.length === 0, committed: false, commit: null, violations };
}

function auditPreparedCommitFromFacts(root: string, facts: StableGitSafetyFacts, baseline: CommitBaseline): CommitSafetyVerdict {
  const violations: CommitSafetyViolation[] = [];
  const metadataError = indexControlBaselineViolation({
    index_control_algorithm: baseline.staged_index_control_algorithm,
    index_control_checksum: baseline.staged_index_control_checksum,
    index_control_entry_count: baseline.staged_index_control_entry_count,
  }, "staged_index_control");
  if (metadataError) commitViolation(violations, metadataError.code, metadataError.message);
  if (root !== baseline.repo_root) commitViolation(violations, "E_BASELINE_REPO_MISMATCH", "baseline belongs to another repository");
  if (facts.head !== baseline.head) commitViolation(violations, "E_HEAD_MUTATION", "HEAD changed after commit authorization");
  if (facts.branchRef !== baseline.branch_ref) commitViolation(violations, "E_BRANCH_MUTATION", "current branch changed after commit authorization");
  if (!sameList(facts.refs, baseline.refs)) commitViolation(violations, "E_REFS_MUTATION", "Git refs changed after commit authorization");
  if (facts.reflog.count !== baseline.head_reflog_count || facts.reflog.checksum !== baseline.head_reflog_checksum) {
    commitViolation(violations, "E_HEAD_REFLOG_MUTATION", "HEAD reflog changed after commit authorization");
  }
  if (facts.stagedTree !== baseline.staged_tree) commitViolation(violations, "E_INDEX_TREE_MUTATION", "staged tree changed after commit authorization");
  if (!metadataError && (facts.indexControl.checksum !== baseline.staged_index_control_checksum
    || facts.indexControl.algorithm !== baseline.staged_index_control_algorithm
    || facts.indexControl.entryCount !== baseline.staged_index_control_entry_count)) {
    commitViolation(violations, "E_INDEX_CONTROL_MUTATION", "index control metadata changed after commit authorization");
  }
  if (!sameList(facts.stagedPaths, baseline.staged_paths)) commitViolation(violations, "E_STAGED_PATH_MUTATION", "staged paths changed after commit authorization");
  if (!facts.stagedPaths.length) commitViolation(violations, "E_STAGED_DIFF_MISSING", "authorized staged diff is no longer present");
  if (factsHaveUnstagedOrUntracked(facts)) commitViolation(violations, "E_WORKTREE_MUTATION", "worktree gained unstaged or untracked changes");
  if (facts.gitOperation) commitViolation(violations, "E_GIT_OPERATION", `unexpected Git operation state: ${facts.gitOperation}`);
  return { accepted: violations.length === 0, committed: false, commit: null, violations };
}

/** Promise-based prepared-commit audit over one stable complete facts pass. */
export async function auditPreparedCommitAsync(
  worktree: string,
  baseline: CommitBaseline,
  options: AsyncSafetyOptions = {},
): Promise<CommitSafetyVerdict> {
  const root = await resolveRepoRootAsync(worktree, options.spawn);
  const indexControlAlgorithm = selectAuditIndexControlAlgorithm({
    index_control_algorithm: baseline.staged_index_control_algorithm,
    index_control_checksum: baseline.staged_index_control_checksum,
    index_control_entry_count: baseline.staged_index_control_entry_count,
  });
  const facts = await captureStableSafetyFacts(root, stableObservationOptions(options, "audit", indexControlAlgorithm));
  return auditPreparedCommitFromFacts(root, facts, baseline);
}

/**
 * Audit the terminal state of a commit-only worker. Success requires exactly
 * one new commit whose only parent and tree match the frozen authorization.
 * Failed/closed workers may leave the original prepared state untouched.
 */
export function auditCommitOutcome(
  worktree: string,
  baseline: CommitBaseline,
  { requireCommit = true }: { requireCommit?: boolean } = {},
): CommitSafetyVerdict {
  const root = fs.realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]).trim());
  const metadataError = indexControlBaselineViolation({
    index_control_algorithm: baseline.staged_index_control_algorithm,
    index_control_checksum: baseline.staged_index_control_checksum,
    index_control_entry_count: baseline.staged_index_control_entry_count,
  }, "staged_index_control");
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head === baseline.head) {
    const prepared = auditPreparedCommit(root, baseline);
    if (requireCommit) commitViolation(prepared.violations, "E_COMMIT_MISSING", "worker completed without creating the authorized commit");
    prepared.accepted = prepared.violations.length === 0;
    return prepared;
  }

  const violations: CommitSafetyViolation[] = [];
  if (metadataError) commitViolation(violations, metadataError.code, metadataError.message);
  if (root !== baseline.repo_root) commitViolation(violations, "E_BASELINE_REPO_MISMATCH", "baseline belongs to another repository");
  const branchRef = gitOptional(root, ["symbolic-ref", "-q", "HEAD"])?.trim() || "";
  if (branchRef !== baseline.branch_ref) commitViolation(violations, "E_BRANCH_MUTATION", "commit changed or detached the authorized branch");

  const fields = git(root, ["show", "-s", "--format=%H%x00%P%x00%T%x00%s", "HEAD"]).trimEnd().split("\0");
  const parents = (fields[1] || "").split(" ").filter(Boolean);
  const commit = {
    id: fields[0] || head,
    parent: parents[0] || "",
    tree: fields[2] || "",
    subject: fields[3] || "",
  };
  if (parents.length !== 1 || parents[0] !== baseline.head) {
    commitViolation(violations, "E_COMMIT_PARENT_MISMATCH", "authorized commit must have exactly the frozen HEAD as its only parent");
  }
  if (commit.tree !== baseline.staged_tree) {
    commitViolation(violations, "E_COMMIT_TREE_MISMATCH", "commit tree does not match the frozen staged tree");
  }

  const expectedRefs = baseline.refs.map((item) => item.startsWith(`${baseline.branch_ref}\0`)
    ? `${baseline.branch_ref}\0${head}`
    : item);
  if (!sameList(refsSnapshot(root), expectedRefs)) commitViolation(violations, "E_REFS_MUTATION", "refs changed outside the authorized branch commit");
  const reflog = headReflog(root);
  const priorReflog = reflog.slice(1);
  if (reflog.length !== baseline.head_reflog_count + 1
    || !reflog[0]?.startsWith(`${head}\0`)
    || checksumValue(priorReflog) !== baseline.head_reflog_checksum) {
    commitViolation(violations, "E_HEAD_REFLOG_MUTATION", "HEAD did not advance through exactly one reflog entry");
  }
  if (git(root, ["write-tree"]).trim() !== baseline.staged_tree) {
    commitViolation(violations, "E_INDEX_TREE_MUTATION", "index does not match the authorized committed tree");
  }
  if (!metadataError && indexControlChecksum(root) !== baseline.staged_index_control_checksum) {
    commitViolation(violations, "E_INDEX_CONTROL_MUTATION", "index control metadata does not match the authorized committed state");
  }
  const status = parsePorcelainV1Z(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  if (status.length) commitViolation(violations, "E_WORKTREE_MUTATION", "commit-only worker left tracked or untracked worktree changes");
  const operation = gitOperationInProgress(root);
  if (operation) commitViolation(violations, "E_GIT_OPERATION", `unexpected Git operation state: ${operation}`);
  return { accepted: violations.length === 0, committed: true, commit, violations };
}

function auditCommitOutcomeFromFacts(
  root: string,
  facts: StableGitSafetyFacts,
  baseline: CommitBaseline,
  { requireCommit = true }: { requireCommit?: boolean } = {},
): CommitSafetyVerdict {
  if (facts.head === baseline.head) {
    const prepared = auditPreparedCommitFromFacts(root, facts, baseline);
    if (requireCommit) commitViolation(prepared.violations, "E_COMMIT_MISSING", "worker completed without creating the authorized commit");
    prepared.accepted = prepared.violations.length === 0;
    return prepared;
  }
  const violations: CommitSafetyViolation[] = [];
  const metadataError = indexControlBaselineViolation({
    index_control_algorithm: baseline.staged_index_control_algorithm,
    index_control_checksum: baseline.staged_index_control_checksum,
    index_control_entry_count: baseline.staged_index_control_entry_count,
  }, "staged_index_control");
  if (metadataError) commitViolation(violations, metadataError.code, metadataError.message);
  if (root !== baseline.repo_root) commitViolation(violations, "E_BASELINE_REPO_MISMATCH", "baseline belongs to another repository");
  if (facts.branchRef !== baseline.branch_ref) commitViolation(violations, "E_BRANCH_MUTATION", "commit changed or detached the authorized branch");
  const observedCommit = facts.commit || { id: facts.head, parent: "", parentCount: 0, tree: "", subject: "" };
  if (observedCommit.parentCount !== undefined
    ? observedCommit.parentCount !== 1 || observedCommit.parent !== baseline.head
    : observedCommit.parent !== baseline.head) {
    commitViolation(violations, "E_COMMIT_PARENT_MISMATCH", "authorized commit must have exactly the frozen HEAD as its only parent");
  }
  if (observedCommit.tree !== baseline.staged_tree) commitViolation(violations, "E_COMMIT_TREE_MISMATCH", "commit tree does not match the frozen staged tree");
  const expectedRefs = baseline.refs.map((item) => item.startsWith(`${baseline.branch_ref}\0`)
    ? `${baseline.branch_ref}\0${facts.head}` : item);
  if (!sameList(facts.refs, expectedRefs)) commitViolation(violations, "E_REFS_MUTATION", "refs changed outside the authorized branch commit");
  if (facts.reflog.count !== baseline.head_reflog_count + 1
    || !facts.reflogFirst?.startsWith(`${facts.head}\0`)
    || facts.reflogPriorChecksum !== baseline.head_reflog_checksum) {
    commitViolation(violations, "E_HEAD_REFLOG_MUTATION", "HEAD did not advance through exactly one reflog entry");
  }
  if (facts.stagedTree !== baseline.staged_tree) commitViolation(violations, "E_INDEX_TREE_MUTATION", "index does not match the authorized committed tree");
  if (!metadataError && (facts.indexControl.checksum !== baseline.staged_index_control_checksum
    || facts.indexControl.algorithm !== baseline.staged_index_control_algorithm
    || facts.indexControl.entryCount !== baseline.staged_index_control_entry_count)) {
    commitViolation(violations, "E_INDEX_CONTROL_MUTATION", "index control metadata does not match the authorized committed state");
  }
  if (facts.dirtyEntries.length) commitViolation(violations, "E_WORKTREE_MUTATION", "commit-only worker left tracked or untracked worktree changes");
  if (facts.gitOperation) commitViolation(violations, "E_GIT_OPERATION", `unexpected Git operation state: ${facts.gitOperation}`);
  return {
    accepted: violations.length === 0,
    committed: true,
    commit: {
      id: observedCommit.id,
      parent: observedCommit.parent,
      tree: observedCommit.tree,
      subject: observedCommit.subject,
    },
    violations,
  };
}

/** Promise-based commit-outcome audit over one stable complete facts pass. */
export async function auditCommitOutcomeAsync(
  worktree: string,
  baseline: CommitBaseline,
  options: { requireCommit?: boolean } & AsyncSafetyOptions = {},
): Promise<CommitSafetyVerdict> {
  const root = await resolveRepoRootAsync(worktree, options.spawn);
  const { requireCommit = true, ...factsOptions } = options;
  const indexControlAlgorithm = selectAuditIndexControlAlgorithm({
    index_control_algorithm: baseline.staged_index_control_algorithm,
    index_control_checksum: baseline.staged_index_control_checksum,
    index_control_entry_count: baseline.staged_index_control_entry_count,
  });
  const facts = await captureStableSafetyFacts(root, stableObservationOptions(factsOptions, "audit", indexControlAlgorithm));
  return auditCommitOutcomeFromFacts(root, facts, baseline, { requireCommit });
}

function globPattern(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`invalid write allowlist entry: ${pattern}`);
  }
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (normalized.endsWith("/")) source += ".*";
  return new RegExp(`^${source}$`);
}

export function pathAllowed(candidate: string, allowlist: string[]): boolean {
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..") || normalized === ".git" || normalized.startsWith(".git/")) return false;
  return allowlist.some((entry) => globPattern(entry).test(normalized));
}

function coveredByPeers(candidate: string, original: string | undefined, peers?: string[][]): boolean {
  if (!peers?.length) return false;
  if (!peers.some((list) => pathAllowed(candidate, list))) return false;
  if (!original) return true;
  return peers.some((list) => pathAllowed(original, list));
}

function operationOf(entry: StatusEntry): SafetyOperation {
  if (entry.code === "??" || entry.code.includes("A")) return "create";
  if (entry.code.includes("R") || entry.code.includes("C")) return "rename";
  if (entry.code.includes("D")) return "delete";
  if (entry.code.includes("T")) return "chmod";
  return "write";
}

export function auditWorktree(worktree: string, baseline: GitBaseline, policy: SafetyPolicy): SafetyVerdict {
  const root = fs.realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]).trim());
  const violations: SafetyViolation[] = [];
  const metadataError = indexControlBaselineViolation(baseline);
  if (metadataError) violations.push({ code: metadataError.code, message: metadataError.message });
  const currentFormat = typeof baseline.branch_ref === "string"
    && typeof baseline.index_tree === "string"
    && typeof baseline.index_control_checksum === "string"
    && baseline.index_control_algorithm === GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM
    && Number.isSafeInteger(baseline.index_control_entry_count)
    && Array.isArray(baseline.refs)
    && Number.isInteger(baseline.head_reflog_count)
    && typeof baseline.head_reflog_checksum === "string";
  if (!currentFormat) {
    violations.push({
      code: "E_BASELINE_FORMAT",
      message: "baseline is not a current-format Git safety snapshot",
    });
  }
  if (root !== baseline.repo_root) violations.push({ code: "E_BASELINE_REPO_MISMATCH", message: "baseline belongs to another repository" });
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head !== baseline.head) violations.push({ code: "E_HEAD_MUTATION", message: "worker changed Git HEAD" });
  if (currentFormat && git(root, ["branch", "--show-current"]).trim() !== baseline.branch) {
    violations.push({ code: "E_BRANCH_MUTATION", message: "worker changed the current branch" });
  }
  if (currentFormat && (gitOptional(root, ["symbolic-ref", "-q", "HEAD"])?.trim() || "") !== baseline.branch_ref) {
    violations.push({ code: "E_BRANCH_MUTATION", message: "worker changed the attached branch ref" });
  }
  if (currentFormat) {
    const observedRefs = refsSnapshot(root);
    const refsAccepted = policy.shared_refs === "parent-owned"
      ? parentOwnedRefsPreserved(root, observedRefs, baseline.refs)
      : sameList(observedRefs, baseline.refs);
    if (!refsAccepted) violations.push({ code: "E_REFS_MUTATION", message: "worker changed Git refs" });
  }
  if (currentFormat) {
    const reflog = headReflog(root);
    if (reflog.length !== baseline.head_reflog_count || checksumValue(reflog) !== baseline.head_reflog_checksum) {
      violations.push({ code: "E_HEAD_REFLOG_MUTATION", message: "worker changed the HEAD reflog" });
    }
  }
  // `git status` and similar read-only commands may refresh stat-cache bytes in
  // the index. Compare the semantic staged tree and control metadata from the
  // current-format Receipt; old raw index checksums are never accepted.
  if (currentFormat) {
    if (stagedTree(root) !== baseline.index_tree) violations.push({ code: "E_INDEX_MUTATION", message: "worker changed the staged Git index tree" });
    if (!metadataError && indexControlChecksum(root) !== baseline.index_control_checksum) {
      violations.push({ code: "E_INDEX_MUTATION", message: "worker changed Git index control metadata" });
    }
  }

  const entries = parsePorcelainV1Z(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const modeChanged = new Set(
    git(root, ["diff", "--summary", "HEAD"]).split("\n")
      .map((line) => line.match(/^ mode change \d+ => \d+ (.+)$/)?.[1])
      .filter((item): item is string => Boolean(item)),
  );
  const changes = entries.map((entry) => ({ ...entry, operation: modeChanged.has(entry.path) ? "chmod" as const : operationOf(entry) }));
  const baselineDirt = new Map(baseline.dirty_entries.map((entry) => [entry.path, entry]));
  const checksums = baseline.dirty_checksums || {};

  for (const change of changes) {
    const inScope = pathAllowed(change.path, policy.write_allowlist)
      && (!change.original_path || pathAllowed(change.original_path, policy.write_allowlist));
    if (inScope) {
      if (!policy.allowed_operations.includes(change.operation)) {
        violations.push({ code: "E_OUT_OF_SCOPE_OP", path: change.path, original_path: change.original_path, operation: change.operation, message: "change operation is not authorized" });
        continue;
      }
    } else if (coveredByPeers(change.path, change.original_path, policy.peer_write_allowlists)) {
      continue;
    } else if (baselineDirt.has(change.path)) {
      const expected = checksums[change.path];
      const actual = checksumWorktreePath(root, change.path);
      if (expected !== actual) {
        violations.push({ code: "E_OUT_OF_SCOPE_PATH", path: change.path, original_path: change.original_path, operation: change.operation, message: "worker mutated pre-existing dirt outside the Receipt allowlist" });
      }
      continue;
    } else {
      violations.push({ code: "E_OUT_OF_SCOPE_PATH", path: change.path, original_path: change.original_path, operation: change.operation, message: "changed path is outside the Receipt allowlist" });
      continue;
    }
    const absolute = path.join(root, change.path);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
      const resolved = fs.realpathSync(absolute);
      const relative = path.relative(root, resolved).replaceAll("\\", "/");
      if (relative.startsWith("../") || !pathAllowed(relative, policy.write_allowlist)) {
        violations.push({ code: "E_SYMLINK_ESCAPE", path: change.path, operation: change.operation, message: "symlink target escapes repository or Receipt scope" });
      }
    }
  }

  for (const entry of baseline.dirty_entries) {
    if (pathAllowed(entry.path, policy.write_allowlist)) continue;
    if (coveredByPeers(entry.path, entry.original_path, policy.peer_write_allowlists)) continue;
    if (entries.some((item) => item.path === entry.path)) continue;
    violations.push({
      code: "E_OUT_OF_SCOPE_PATH",
      path: entry.path,
      original_path: entry.original_path,
      operation: operationOf(entry),
      message: "worker cleared pre-existing dirt outside the Receipt allowlist",
    });
  }
  return { accepted: violations.length === 0, changes, violations };
}

function auditWorktreeFromFacts(root: string, facts: StableGitSafetyFacts, baseline: GitBaseline, policy: SafetyPolicy): SafetyVerdict {
  const violations: SafetyViolation[] = [];
  const metadataError = indexControlBaselineViolation(baseline);
  if (metadataError) violations.push({ code: metadataError.code, message: metadataError.message });
  const currentFormat = typeof baseline.branch_ref === "string"
    && typeof baseline.index_tree === "string"
    && typeof baseline.index_control_checksum === "string"
    && Array.isArray(baseline.refs)
    && Number.isInteger(baseline.head_reflog_count)
    && typeof baseline.head_reflog_checksum === "string";
  if (!currentFormat) violations.push({ code: "E_BASELINE_FORMAT", message: "baseline is not a current-format Git safety snapshot" });
  if (root !== baseline.repo_root) violations.push({ code: "E_BASELINE_REPO_MISMATCH", message: "baseline belongs to another repository" });
  if (facts.head !== baseline.head) violations.push({ code: "E_HEAD_MUTATION", message: "worker changed Git HEAD" });
  if (currentFormat && facts.branch !== baseline.branch) violations.push({ code: "E_BRANCH_MUTATION", message: "worker changed the current branch" });
  if (currentFormat && facts.branchRef !== baseline.branch_ref) violations.push({ code: "E_BRANCH_MUTATION", message: "worker changed the attached branch ref" });
  if (currentFormat) {
    const refsAccepted = policy.shared_refs === "parent-owned"
      ? parentOwnedRefsPreserved(root, facts.refs, baseline.refs)
      : sameList(facts.refs, baseline.refs);
    if (!refsAccepted) violations.push({ code: "E_REFS_MUTATION", message: "worker changed Git refs" });
  }
  if (currentFormat && (facts.reflog.count !== baseline.head_reflog_count || facts.reflog.checksum !== baseline.head_reflog_checksum)) {
    violations.push({ code: "E_HEAD_REFLOG_MUTATION", message: "worker changed the HEAD reflog" });
  }
  if (currentFormat) {
    if (facts.stagedTree !== baseline.index_tree) violations.push({ code: "E_INDEX_MUTATION", message: "worker changed the staged Git index tree" });
    const index = indexMetadata(facts.indexControl);
    const expectedAlgorithm = baseline.index_control_algorithm;
    if (!metadataError && (index.checksum !== baseline.index_control_checksum
      || index.algorithm !== expectedAlgorithm
      || index.entryCount !== baseline.index_control_entry_count)) {
      violations.push({ code: "E_INDEX_MUTATION", message: "worker changed Git index control metadata" });
    }
  }

  const entries = facts.dirtyEntries;
  const changes = entries.map((entry) => ({ ...entry, operation: facts.modeChangedPaths.has(entry.path) ? "chmod" as const : operationOf(entry) }));
  const baselineDirt = new Map(baseline.dirty_entries.map((entry) => [entry.path, entry]));
  const checksums = baseline.dirty_checksums || {};
  for (const change of changes) {
    const inScope = pathAllowed(change.path, policy.write_allowlist)
      && (!change.original_path || pathAllowed(change.original_path, policy.write_allowlist));
    if (inScope) {
      if (!policy.allowed_operations.includes(change.operation)) {
        violations.push({ code: "E_OUT_OF_SCOPE_OP", path: change.path, original_path: change.original_path, operation: change.operation, message: "change operation is not authorized" });
        continue;
      }
    } else if (coveredByPeers(change.path, change.original_path, policy.peer_write_allowlists)) {
      continue;
    } else if (baselineDirt.has(change.path)) {
      const expected = checksums[change.path];
      const actual = checksumWorktreePath(root, change.path);
      if (expected !== actual) violations.push({ code: "E_OUT_OF_SCOPE_PATH", path: change.path, original_path: change.original_path, operation: change.operation, message: "worker mutated pre-existing dirt outside the Receipt allowlist" });
      continue;
    } else {
      violations.push({ code: "E_OUT_OF_SCOPE_PATH", path: change.path, original_path: change.original_path, operation: change.operation, message: "changed path is outside the Receipt allowlist" });
      continue;
    }
    const absolute = path.join(root, change.path);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
      const resolved = fs.realpathSync(absolute);
      const relative = path.relative(root, resolved).replaceAll("\\", "/");
      if (relative.startsWith("../") || !pathAllowed(relative, policy.write_allowlist)) {
        violations.push({ code: "E_SYMLINK_ESCAPE", path: change.path, operation: change.operation, message: "symlink target escapes repository or Receipt scope" });
      }
    }
  }
  for (const entry of baseline.dirty_entries) {
    if (pathAllowed(entry.path, policy.write_allowlist)) continue;
    if (coveredByPeers(entry.path, entry.original_path, policy.peer_write_allowlists)) continue;
    if (entries.some((item) => item.path === entry.path)) continue;
    violations.push({ code: "E_OUT_OF_SCOPE_PATH", path: entry.path, original_path: entry.original_path, operation: operationOf(entry), message: "worker cleared pre-existing dirt outside the Receipt allowlist" });
  }
  return { accepted: violations.length === 0, changes, violations };
}

/** Promise-based worktree audit over one stable complete facts pass. */
export async function auditWorktreeAsync(
  worktree: string,
  baseline: GitBaseline,
  policy: SafetyPolicy,
  options: AsyncSafetyOptions = {},
): Promise<SafetyVerdict> {
  const root = await resolveRepoRootAsync(worktree, options.spawn);
  const indexControlAlgorithm = selectAuditIndexControlAlgorithm(baseline);
  const facts = await captureStableSafetyFacts(root, stableObservationOptions(options, "audit", indexControlAlgorithm));
  return auditWorktreeFromFacts(root, facts, baseline, policy);
}
