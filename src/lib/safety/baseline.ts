/**
 * Git baseline capture and sync Git helpers for the safety gate. Split from
 * safety.ts (leaf module).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../json-utils.js";
import {
  AsyncSafetyOptions,
  CommitBaseline,
  CommitBaselineError,
  GitBaseline,
  IndexControlBaselineErrorCode,
  StatusEntry
} from "../safety.js";
import { GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM } from "../apply-source.js";
import { fingerprintGitIndexControlRecords } from "../git/index-control.js";
import { isRuntimeTurnDiffRef } from "../git/record-consumers.js";
import {
  GitSafetyFacts,
  StableGitSafetyFactsOptions,
  captureStableSafetyFacts
} from "../git/safety-facts.js";
import {
  GitProcessOptions,
  collectGitScalar
} from "../git/safety-process.js";

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

export function indexControlBaselineViolation(
  baseline: { index_control_algorithm?: unknown; index_control_checksum?: unknown; index_control_entry_count?: unknown },
  prefix = "index_control",
): { code: IndexControlBaselineErrorCode; message: string } | null {
  const code = validateIndexControlBaselineMetadata(baseline, prefix);
  return code ? { code, message: `${prefix} baseline metadata is invalid` } : null;
}


export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git safety command failed: git ${args.join(" ")}: ${message}`);
  }
}

export function checksumFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return sha256Hex(fs.readFileSync(file));
}

export function checksumWorktreePath(root: string, rel: string): string {
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

export function checksumValue(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

export function gitExitZero(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch (cause) {
    if (Number((cause as { status?: number }).status) === 1) return false;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git safety command failed: git ${args.join(" ")}: ${message}`);
  }
}

export function gitOptional(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    if (Number((cause as { status?: number }).status) === 1) return null;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git safety command failed: git ${args.join(" ")}: ${message}`);
  }
}

export function localGitPath(repoRoot: string, name: string): string {
  const value = git(repoRoot, ["rev-parse", "--git-path", name]).trim();
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

export function gitOperationInProgress(repoRoot: string): string | null {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge", "sequencer"]) {
    if (fs.existsSync(localGitPath(repoRoot, name))) return name;
  }
  return null;
}

export function stagedPaths(repoRoot: string): string[] {
  return git(repoRoot, ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function stagedTree(repoRoot: string): string {
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
export function indexControlChecksum(repoRoot: string): string {
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

export function indexControlEntryCount(repoRoot: string): number {
  const output = git(repoRoot, ["ls-files", "--debug", "-z"]);
  return (output.match(/\0/g) || []).length;
}

export function refsSnapshot(repoRoot: string): string[] {
  return git(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"])
    .split("\n")
    .filter(Boolean)
    .filter((entry) => !isRuntimeTurnDiffRef(entry));
}

export function headReflog(repoRoot: string): string[] {
  return git(repoRoot, ["reflog", "show", "--format=%H%x00%gs", "HEAD"])
    .split("\n")
    .filter(Boolean);
}

export function hasUnstagedOrUntracked(repoRoot: string): boolean {
  if (!gitExitZero(repoRoot, ["diff", "--quiet"])) return true;
  return Boolean(git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
}

export function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function splitRefSnapshotEntry(entry: string): { ref: string; object: string } | null {
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
export function parentOwnedRefsPreserved(repoRoot: string, observed: string[], baseline: string[]): boolean {
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

export async function resolveRepoRootAsync(worktree: string, spawn?: GitProcessOptions["spawn"]): Promise<string> {
  const resolved = await collectGitScalar({ cwd: worktree, args: ["rev-parse", "--show-toplevel"], spawn });
  return fs.realpathSync(resolved.trim());
}

export function indexMetadata(fingerprint: GitSafetyFacts["indexControl"]): {
  checksum: string;
  algorithm: string;
  entryCount: number;
} {
  return { checksum: fingerprint.checksum, algorithm: fingerprint.algorithm, entryCount: fingerprint.entryCount };
}

export function stableObservationOptions(
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

export function factsHaveUnstagedOrUntracked(facts: GitSafetyFacts): boolean {
  return facts.untrackedExists || facts.dirtyEntries.some((entry) => entry.code === "??" || entry.code[1] !== " ");
}

export function dirtyChecksumsFromFacts(root: string, entries: StatusEntry[]): Record<string, string> {
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
