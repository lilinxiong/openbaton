import { GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM } from "../apply-source.js";
import {
  StableGitSafetyFacts,
  captureStableSafetyFacts
} from "../git/safety-facts.js";
import {
  checksumValue,
  checksumWorktreePath,
  factsHaveUnstagedOrUntracked,
  git,
  gitExitZero,
  gitOperationInProgress,
  gitOptional,
  hasUnstagedOrUntracked,
  headReflog,
  indexControlBaselineViolation,
  indexControlChecksum,
  indexControlEntryCount,
  parentOwnedRefsPreserved,
  parsePorcelainV1Z,
  refsSnapshot,
  resolveRepoRootAsync,
  sameList,
  stableObservationOptions,
  stagedPaths,
  stagedTree
} from "./baseline.js";
import {
  AsyncSafetyOptions,
  CommitBaseline,
  CommitSafetyVerdict,
  CommitSafetyViolation,
  GitBaseline,
  SafetyOperation,
  SafetyPolicy,
  SafetyVerdict,
  SafetyViolation,
  StatusEntry
} from "../safety.js";
import fs from "node:fs";
import path from "node:path";
/**
 * Commit/worktree audit rule tables and observation collectors. Split from
 * safety.ts.
 */

export function commitViolation(violations: CommitSafetyViolation[], code: string, message: string): void {
  violations.push({ code, message });
}

/** Observation inputs shared by the sync and facts-based audit paths. Each
 * collector keeps its own acquisition semantics; the rule tables below are
 * the single source of truth for commit/worktree audit verdicts. */
interface IndexControlObservation {
  checksum: string;
  algorithm: string;
  entryCount: number;
}

interface PreparedCommitObservation {
  head: string;
  branchRef: string;
  refs: string[];
  reflog: { count: number; checksum: string };
  stagedTree: string;
  indexControl: IndexControlObservation;
  stagedPaths: string[];
  /** Sync path: `git diff --cached --quiet`; facts path: stagedPaths non-empty. */
  stagedDiffPresent: boolean;
  unstagedOrUntracked: boolean;
  gitOperation: string | null;
}

interface CommitOutcomeObservation extends PreparedCommitObservation {
  commit: { id: string; parent: string; parentCount?: number; tree: string; subject: string };
  reflogFirst: string | undefined;
  reflogPriorChecksum: string | undefined;
  dirtyEntryCount: number;
}

interface WorktreeAuditObservation {
  head: string;
  branch: string;
  branchRef: string;
  refs: string[];
  reflog: { count: number; checksum: string };
  stagedTree: string;
  indexControl: IndexControlObservation;
  dirtyEntries: StatusEntry[];
  modeChangedPaths: Set<string>;
}

export function stagedIndexControlMetadata(baseline: CommitBaseline): {
  index_control_algorithm?: unknown;
  index_control_checksum?: unknown;
  index_control_entry_count?: unknown;
} {
  return {
    index_control_algorithm: baseline.staged_index_control_algorithm,
    index_control_checksum: baseline.staged_index_control_checksum,
    index_control_entry_count: baseline.staged_index_control_entry_count,
  };
}

/** Single rule table for the prepared-commit audit. */
export function auditPreparedCommitRules(root: string, obs: PreparedCommitObservation, baseline: CommitBaseline): CommitSafetyVerdict {
  const violations: CommitSafetyViolation[] = [];
  const metadataError = indexControlBaselineViolation(stagedIndexControlMetadata(baseline), "staged_index_control");
  if (metadataError) commitViolation(violations, metadataError.code, metadataError.message);
  if (root !== baseline.repo_root) commitViolation(violations, "E_BASELINE_REPO_MISMATCH", "baseline belongs to another repository");
  if (obs.head !== baseline.head) commitViolation(violations, "E_HEAD_MUTATION", "HEAD changed after commit authorization");
  if (obs.branchRef !== baseline.branch_ref) commitViolation(violations, "E_BRANCH_MUTATION", "current branch changed after commit authorization");
  if (!sameList(obs.refs, baseline.refs)) commitViolation(violations, "E_REFS_MUTATION", "Git refs changed after commit authorization");
  if (obs.reflog.count !== baseline.head_reflog_count || obs.reflog.checksum !== baseline.head_reflog_checksum) {
    commitViolation(violations, "E_HEAD_REFLOG_MUTATION", "HEAD reflog changed after commit authorization");
  }
  if (obs.stagedTree !== baseline.staged_tree) commitViolation(violations, "E_INDEX_TREE_MUTATION", "staged tree changed after commit authorization");
  if (!metadataError && (obs.indexControl.checksum !== baseline.staged_index_control_checksum
    || obs.indexControl.algorithm !== baseline.staged_index_control_algorithm
    || obs.indexControl.entryCount !== baseline.staged_index_control_entry_count)) {
    commitViolation(violations, "E_INDEX_CONTROL_MUTATION", "index control metadata changed after commit authorization");
  }
  if (!sameList(obs.stagedPaths, baseline.staged_paths)) commitViolation(violations, "E_STAGED_PATH_MUTATION", "staged paths changed after commit authorization");
  if (!obs.stagedDiffPresent) commitViolation(violations, "E_STAGED_DIFF_MISSING", "authorized staged diff is no longer present");
  if (obs.unstagedOrUntracked) commitViolation(violations, "E_WORKTREE_MUTATION", "worktree gained unstaged or untracked changes");
  if (obs.gitOperation) commitViolation(violations, "E_GIT_OPERATION", `unexpected Git operation state: ${obs.gitOperation}`);
  return { accepted: violations.length === 0, committed: false, commit: null, violations };
}

/** Single rule table for the terminal commit-outcome audit. */
export function auditCommitOutcomeRules(
  root: string,
  obs: CommitOutcomeObservation,
  baseline: CommitBaseline,
  { requireCommit = true }: { requireCommit?: boolean } = {},
): CommitSafetyVerdict {
  if (obs.head === baseline.head) {
    const prepared = auditPreparedCommitRules(root, obs, baseline);
    if (requireCommit) commitViolation(prepared.violations, "E_COMMIT_MISSING", "worker completed without creating the authorized commit");
    prepared.accepted = prepared.violations.length === 0;
    return prepared;
  }
  const violations: CommitSafetyViolation[] = [];
  const metadataError = indexControlBaselineViolation(stagedIndexControlMetadata(baseline), "staged_index_control");
  if (metadataError) commitViolation(violations, metadataError.code, metadataError.message);
  if (root !== baseline.repo_root) commitViolation(violations, "E_BASELINE_REPO_MISMATCH", "baseline belongs to another repository");
  if (obs.branchRef !== baseline.branch_ref) commitViolation(violations, "E_BRANCH_MUTATION", "commit changed or detached the authorized branch");
  const observedCommit = obs.commit;
  if (observedCommit.parentCount !== undefined
    ? observedCommit.parentCount !== 1 || observedCommit.parent !== baseline.head
    : observedCommit.parent !== baseline.head) {
    commitViolation(violations, "E_COMMIT_PARENT_MISMATCH", "authorized commit must have exactly the frozen HEAD as its only parent");
  }
  if (observedCommit.tree !== baseline.staged_tree) {
    commitViolation(violations, "E_COMMIT_TREE_MISMATCH", "commit tree does not match the frozen staged tree");
  }
  const expectedRefs = baseline.refs.map((item) => item.startsWith(`${baseline.branch_ref}\0`)
    ? `${baseline.branch_ref}\0${obs.head}`
    : item);
  if (!sameList(obs.refs, expectedRefs)) commitViolation(violations, "E_REFS_MUTATION", "refs changed outside the authorized branch commit");
  if (obs.reflog.count !== baseline.head_reflog_count + 1
    || !obs.reflogFirst?.startsWith(`${obs.head}\0`)
    || obs.reflogPriorChecksum !== baseline.head_reflog_checksum) {
    commitViolation(violations, "E_HEAD_REFLOG_MUTATION", "HEAD did not advance through exactly one reflog entry");
  }
  if (obs.stagedTree !== baseline.staged_tree) {
    commitViolation(violations, "E_INDEX_TREE_MUTATION", "index does not match the authorized committed tree");
  }
  if (!metadataError && (obs.indexControl.checksum !== baseline.staged_index_control_checksum
    || obs.indexControl.algorithm !== baseline.staged_index_control_algorithm
    || obs.indexControl.entryCount !== baseline.staged_index_control_entry_count)) {
    commitViolation(violations, "E_INDEX_CONTROL_MUTATION", "index control metadata does not match the authorized committed state");
  }
  if (obs.dirtyEntryCount) commitViolation(violations, "E_WORKTREE_MUTATION", "commit-only worker left tracked or untracked worktree changes");
  if (obs.gitOperation) commitViolation(violations, "E_GIT_OPERATION", `unexpected Git operation state: ${obs.gitOperation}`);
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

/** Single rule table for the write-mode worktree audit. */
export function auditWorktreeRules(root: string, obs: WorktreeAuditObservation, baseline: GitBaseline, policy: SafetyPolicy): SafetyVerdict {
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
  if (obs.head !== baseline.head) violations.push({ code: "E_HEAD_MUTATION", message: "worker changed Git HEAD" });
  if (currentFormat && obs.branch !== baseline.branch) {
    violations.push({ code: "E_BRANCH_MUTATION", message: "worker changed the current branch" });
  }
  if (currentFormat && obs.branchRef !== baseline.branch_ref) {
    violations.push({ code: "E_BRANCH_MUTATION", message: "worker changed the attached branch ref" });
  }
  if (currentFormat) {
    const refsAccepted = policy.shared_refs === "parent-owned"
      ? parentOwnedRefsPreserved(root, obs.refs, baseline.refs)
      : sameList(obs.refs, baseline.refs);
    if (!refsAccepted) violations.push({ code: "E_REFS_MUTATION", message: "worker changed Git refs" });
  }
  if (currentFormat && (obs.reflog.count !== baseline.head_reflog_count || obs.reflog.checksum !== baseline.head_reflog_checksum)) {
    violations.push({ code: "E_HEAD_REFLOG_MUTATION", message: "worker changed the HEAD reflog" });
  }
  // `git status` and similar read-only commands may refresh stat-cache bytes in
  // the index. Compare the semantic staged tree and control metadata from the
  // current-format Receipt; old raw index checksums are never accepted.
  if (currentFormat) {
    if (obs.stagedTree !== baseline.index_tree) violations.push({ code: "E_INDEX_MUTATION", message: "worker changed the staged Git index tree" });
    if (!metadataError && (obs.indexControl.checksum !== baseline.index_control_checksum
      || obs.indexControl.algorithm !== baseline.index_control_algorithm
      || obs.indexControl.entryCount !== baseline.index_control_entry_count)) {
      violations.push({ code: "E_INDEX_MUTATION", message: "worker changed Git index control metadata" });
    }
  }

  const entries = obs.dirtyEntries;
  const changes = entries.map((entry) => ({ ...entry, operation: obs.modeChangedPaths.has(entry.path) ? "chmod" as const : operationOf(entry) }));
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

/** Synchronous observation via direct Git invocations. */
export function observePreparedCommitSync(root: string): PreparedCommitObservation {
  const reflog = headReflog(root);
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branchRef: gitOptional(root, ["symbolic-ref", "-q", "HEAD"])?.trim() || "",
    refs: refsSnapshot(root),
    reflog: { count: reflog.length, checksum: checksumValue(reflog) },
    stagedTree: git(root, ["write-tree"]).trim(),
    indexControl: {
      checksum: indexControlChecksum(root),
      algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
      entryCount: indexControlEntryCount(root),
    },
    stagedPaths: stagedPaths(root),
    stagedDiffPresent: !gitExitZero(root, ["diff", "--cached", "--quiet"]),
    unstagedOrUntracked: hasUnstagedOrUntracked(root),
    gitOperation: gitOperationInProgress(root),
  };
}

export function observeCommitOutcomeSync(root: string): CommitOutcomeObservation {
  const prepared = observePreparedCommitSync(root);
  const reflog = headReflog(root);
  const fields = git(root, ["show", "-s", "--format=%H%x00%P%x00%T%x00%s", "HEAD"]).trimEnd().split("\0");
  const parents = (fields[1] || "").split(" ").filter(Boolean);
  const status = parsePorcelainV1Z(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  return {
    ...prepared,
    head: prepared.head,
    commit: {
      id: fields[0] || prepared.head,
      parent: parents[0] || "",
      parentCount: parents.length,
      tree: fields[2] || "",
      subject: fields[3] || "",
    },
    reflogFirst: reflog[0],
    reflogPriorChecksum: checksumValue(reflog.slice(1)),
    dirtyEntryCount: status.length,
  };
}

export function observeWorktreeAuditSync(root: string): WorktreeAuditObservation {
  const reflog = headReflog(root);
  const entries = parsePorcelainV1Z(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const modeChanged = new Set(
    git(root, ["diff", "--summary", "HEAD"]).split("\n")
      .map((line) => line.match(/^ mode change \d+ => \d+ (.+)$/)?.[1])
      .filter((item): item is string => Boolean(item)),
  );
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branch: git(root, ["branch", "--show-current"]).trim(),
    branchRef: gitOptional(root, ["symbolic-ref", "-q", "HEAD"])?.trim() || "",
    refs: refsSnapshot(root),
    reflog: { count: reflog.length, checksum: checksumValue(reflog) },
    stagedTree: stagedTree(root),
    indexControl: {
      checksum: indexControlChecksum(root),
      algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
      entryCount: indexControlEntryCount(root),
    },
    dirtyEntries: entries,
    modeChangedPaths: modeChanged,
  };
}

/** Facts-pass adapters: map one stable observation onto the shared shape. */
export function preparedObservationFromFacts(facts: StableGitSafetyFacts): PreparedCommitObservation {
  return {
    head: facts.head,
    branchRef: facts.branchRef,
    refs: facts.refs,
    reflog: facts.reflog,
    stagedTree: facts.stagedTree,
    indexControl: facts.indexControl,
    stagedPaths: facts.stagedPaths,
    stagedDiffPresent: facts.stagedPaths.length > 0,
    unstagedOrUntracked: factsHaveUnstagedOrUntracked(facts),
    gitOperation: facts.gitOperation ?? null,
  };
}

export function commitOutcomeObservationFromFacts(facts: StableGitSafetyFacts): CommitOutcomeObservation {
  const observedCommit = facts.commit || { id: facts.head, parent: "", parentCount: 0, tree: "", subject: "" };
  return {
    ...preparedObservationFromFacts(facts),
    commit: observedCommit,
    reflogFirst: facts.reflogFirst,
    reflogPriorChecksum: facts.reflogPriorChecksum,
    dirtyEntryCount: facts.dirtyEntries.length,
  };
}

export function worktreeObservationFromFacts(facts: StableGitSafetyFacts): WorktreeAuditObservation {
  return {
    head: facts.head,
    branch: facts.branch,
    branchRef: facts.branchRef,
    refs: facts.refs,
    reflog: facts.reflog,
    stagedTree: facts.stagedTree,
    indexControl: facts.indexControl,
    dirtyEntries: facts.dirtyEntries,
    modeChangedPaths: facts.modeChangedPaths,
  };
}

/** Verify that nothing changed between Receipt creation and host reservation. */
export function auditPreparedCommit(worktree: string, baseline: CommitBaseline): CommitSafetyVerdict {
  const root = fs.realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]).trim());
  return auditPreparedCommitRules(root, observePreparedCommitSync(root), baseline);
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
  return auditCommitOutcomeRules(root, observeCommitOutcomeSync(root), baseline, { requireCommit });
}

/** Promise-based prepared-commit audit over one stable complete facts pass. */
export async function auditPreparedCommitAsync(
  worktree: string,
  baseline: CommitBaseline,
  options: AsyncSafetyOptions = {},
): Promise<CommitSafetyVerdict> {
  const root = await resolveRepoRootAsync(worktree, options.spawn);
  const facts = await captureStableSafetyFacts(root, stableObservationOptions(options, "audit", GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM));
  return auditPreparedCommitRules(root, preparedObservationFromFacts(facts), baseline);
}

/** Promise-based commit-outcome audit over one stable complete facts pass. */
export async function auditCommitOutcomeAsync(
  worktree: string,
  baseline: CommitBaseline,
  options: { requireCommit?: boolean } & AsyncSafetyOptions = {},
): Promise<CommitSafetyVerdict> {
  const root = await resolveRepoRootAsync(worktree, options.spawn);
  const { requireCommit = true, ...factsOptions } = options;
  const facts = await captureStableSafetyFacts(root, stableObservationOptions(factsOptions, "audit", GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM));
  return auditCommitOutcomeRules(root, commitOutcomeObservationFromFacts(facts), baseline, { requireCommit });
}

export function globPattern(pattern: string): RegExp {
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

export function coveredByPeers(candidate: string, original: string | undefined, peers?: string[][]): boolean {
  if (!peers?.length) return false;
  if (!peers.some((list) => pathAllowed(candidate, list))) return false;
  if (!original) return true;
  return peers.some((list) => pathAllowed(original, list));
}

export function operationOf(entry: StatusEntry): SafetyOperation {
  if (entry.code === "??" || entry.code.includes("A")) return "create";
  if (entry.code.includes("R") || entry.code.includes("C")) return "rename";
  if (entry.code.includes("D")) return "delete";
  if (entry.code.includes("T")) return "chmod";
  return "write";
}

export function auditWorktree(worktree: string, baseline: GitBaseline, policy: SafetyPolicy): SafetyVerdict {
  const root = fs.realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]).trim());
  return auditWorktreeRules(root, observeWorktreeAuditSync(root), baseline, policy);
}

/** Promise-based worktree audit over one stable complete facts pass. */
export async function auditWorktreeAsync(
  worktree: string,
  baseline: GitBaseline,
  policy: SafetyPolicy,
  options: AsyncSafetyOptions = {},
): Promise<SafetyVerdict> {
  const root = await resolveRepoRootAsync(worktree, options.spawn);
  const facts = await captureStableSafetyFacts(root, stableObservationOptions(options, "audit", GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM));
  return auditWorktreeRules(root, worktreeObservationFromFacts(facts), baseline, policy);
}
