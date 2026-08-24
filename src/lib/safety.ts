import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type SafetyOperation = "write" | "create" | "delete" | "rename" | "chmod";

export interface GitBaseline {
  repo_root: string;
  head: string;
  branch: string;
  index_path: string;
  index_checksum: string | null;
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
}

export interface SafetyViolation {
  code: string;
  path?: string;
  original_path?: string;
  operation?: SafetyOperation;
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

export class CommitBaselineError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CommitBaselineError";
    this.code = code;
  }
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
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function refsSnapshot(repoRoot: string): string[] {
  return git(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"])
    .split("\n")
    .filter(Boolean);
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
    index_path: indexPath,
    index_checksum: checksumFile(indexPath),
    dirty_entries: dirtyEntries,
    dirty_checksums: dirtyChecksums,
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
    staged_paths: stagedPaths(repoRoot),
    refs,
    head_reflog_count: reflog.length,
    head_reflog_checksum: checksumValue(reflog),
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
  if (!sameList(stagedPaths(root), baseline.staged_paths)) commitViolation(violations, "E_STAGED_PATH_MUTATION", "staged paths changed after commit authorization");
  if (gitExitZero(root, ["diff", "--cached", "--quiet"])) commitViolation(violations, "E_STAGED_DIFF_MISSING", "authorized staged diff is no longer present");
  if (hasUnstagedOrUntracked(root)) commitViolation(violations, "E_WORKTREE_MUTATION", "worktree gained unstaged or untracked changes");
  const operation = gitOperationInProgress(root);
  if (operation) commitViolation(violations, "E_GIT_OPERATION", `unexpected Git operation state: ${operation}`);
  return { accepted: violations.length === 0, committed: false, commit: null, violations };
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
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head === baseline.head) {
    const prepared = auditPreparedCommit(root, baseline);
    if (requireCommit) commitViolation(prepared.violations, "E_COMMIT_MISSING", "worker completed without creating the authorized commit");
    prepared.accepted = prepared.violations.length === 0;
    return prepared;
  }

  const violations: CommitSafetyViolation[] = [];
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
  const status = parsePorcelainV1Z(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  if (status.length) commitViolation(violations, "E_WORKTREE_MUTATION", "commit-only worker left tracked or untracked worktree changes");
  const operation = gitOperationInProgress(root);
  if (operation) commitViolation(violations, "E_GIT_OPERATION", `unexpected Git operation state: ${operation}`);
  return { accepted: violations.length === 0, committed: true, commit, violations };
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
  if (root !== baseline.repo_root) violations.push({ code: "E_BASELINE_REPO_MISMATCH", message: "baseline belongs to another repository" });
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head !== baseline.head) violations.push({ code: "E_HEAD_MUTATION", message: "worker changed Git HEAD" });
  if (checksumFile(baseline.index_path) !== baseline.index_checksum) violations.push({ code: "E_INDEX_MUTATION", message: "worker changed the Git index" });

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
