import fs from "node:fs";
import path from "node:path";
import {
  captureStableGitTerminalTree,
  type GitTreeChangeFact,
  type StableGitTerminalTreeFacts,
  type StableGitTerminalTreeOptions,
} from "./git-safety-facts.js";
import { collectGitScalar, GitSafetyError } from "./git-safety-process.js";
import { pathAllowed, type SafetyOperation, type SafetyViolation } from "./safety.js";
import { assertWorktreeRecord, type ChangeBundleOperation, type WorktreeRecord } from "./worktree-execution.js";

const OPERATION_ORDER: readonly ChangeBundleOperation[] = ["write", "create", "delete", "rename", "copy", "chmod"];

export interface WorktreeAuditReceipt {
  receipt_id: string;
  repository_id: string;
  git_common_dir_identity: string;
  execution_root: string;
  base_tree: string;
  worktree_record_id?: string;
  run_id?: string;
  unit_key?: string;
  unit_version?: number;
  attempt_id?: string;
  write_allowlist: readonly string[];
  allowed_operations: readonly ChangeBundleOperation[];
  allow_noop?: boolean;
}

export interface TerminalWorktreeAuditInput {
  record: WorktreeRecord;
  receipt: WorktreeAuditReceipt;
  max_diagnostics?: number;
  spawn?: StableGitTerminalTreeOptions["spawn"];
  collectFacts?: StableGitTerminalTreeOptions["collectFacts"];
  collectToken?: StableGitTerminalTreeOptions["collectToken"];
}

export interface WorktreeNonTextFacts {
  [key: string]: unknown;
  raw_changes: GitTreeChangeFact[];
  binary_paths: string[];
  mode_changes: Array<{ path: string; old_mode: string; new_mode: string }>;
  renames: Array<{ source: string; target: string; score?: number }>;
  copies: Array<{ source: string; target: string; score?: number }>;
  symlinks: Array<{ path: string; old_object: string; new_object: string; target?: string }>;
  gitlinks: Array<{ path: string; old_object: string; new_object: string }>;
  terminal_control: {
    head: string;
    branch_ref: string;
    staged_tree: string;
    staged_paths: string[];
    index_control: StableGitTerminalTreeFacts["terminal"]["indexControl"];
    git_operation: string | null;
    refs_digest: string;
    reflog_count: number;
    reflog_checksum: string;
  };
}

export interface TerminalWorktreeAuditResult {
  accepted: boolean;
  safety_verdict: "safe" | "rejected";
  repository_id: string;
  git_common_dir_identity: string;
  base_tree: string;
  result_tree: string | null;
  receipt_id: string;
  operations: ChangeBundleOperation[];
  changed_paths: string[];
  changes: GitTreeChangeFact[];
  non_text_facts: WorktreeNonTextFacts | null;
  violations: SafetyViolation[];
  total_violation_count: number;
  diagnostics_truncated: boolean;
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(200, Math.max(1, Math.floor(value!)));
}

function safeRelative(value: string): boolean {
  return Boolean(value) && !value.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(value)
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && value !== "." && !value.startsWith("../") && !value.split("/").includes(".git");
}

function validAllowlistEntry(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\*+/gu, "placeholder");
  return Boolean(value) && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(value) && !path.posix.isAbsolute(value)
    && path.posix.normalize(normalized) === normalized && normalized !== "."
    && !normalized.startsWith("../") && !normalized.split("/").includes(".git");
}

function operationsFor(change: GitTreeChangeFact): ChangeBundleOperation[] {
  const operations = new Set<ChangeBundleOperation>([change.operation]);
  if (change.old_mode !== change.new_mode && change.status !== "A" && change.status !== "D") operations.add("chmod");
  return OPERATION_ORDER.filter((operation) => operations.has(operation));
}

function lineageViolations(record: WorktreeRecord, receipt: WorktreeAuditReceipt): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  const mismatch = (message: string) => violations.push({ code: "E_RECEIPT_LINEAGE_MISMATCH", message });
  if (receipt.repository_id !== record.repository_id) mismatch("Receipt repository does not match the worktree record");
  if (receipt.git_common_dir_identity !== record.git_common_dir_identity) mismatch("Receipt common-directory identity does not match the worktree record");
  if (path.resolve(receipt.execution_root) !== path.resolve(record.execution_root)) mismatch("Receipt execution root does not match the worktree record");
  if (receipt.base_tree !== record.base_tree) mismatch("Receipt base tree does not match the worktree record");
  if (receipt.worktree_record_id !== undefined && receipt.worktree_record_id !== record.record_id) mismatch("Receipt worktree record id does not match");
  if (receipt.run_id !== undefined && receipt.run_id !== record.run_id) mismatch("Receipt run id does not match");
  if (receipt.unit_key !== undefined && receipt.unit_key !== record.unit_key) mismatch("Receipt unit key does not match");
  if (receipt.unit_version !== undefined && receipt.unit_version !== record.unit_version) mismatch("Receipt unit version does not match");
  if (receipt.attempt_id !== undefined && receipt.attempt_id !== record.attempt_id) mismatch("Receipt attempt id does not match");
  if (record.execution_mode !== "isolated-worktree" || record.setup_state !== "verified") {
    violations.push({ code: "E_WORKTREE_NOT_AUDITABLE", message: "worktree is not a verified isolated execution root" });
  }
  if (record.lifecycle_state !== "terminal_awaiting_audit" && record.lifecycle_state !== "bundle_ready") {
    violations.push({ code: "E_WORKTREE_NOT_AUDITABLE", message: "worktree has not reached a terminal auditable lifecycle state" });
  }
  if (!Array.isArray(receipt.write_allowlist) || receipt.write_allowlist.some((item) => !validAllowlistEntry(item))) {
    violations.push({ code: "E_RECEIPT_LINEAGE_MISMATCH", message: "Receipt write allowlist is not canonical" });
  }
  if (!Array.isArray(receipt.allowed_operations) || receipt.allowed_operations.some((item) => !OPERATION_ORDER.includes(item))) {
    violations.push({ code: "E_RECEIPT_LINEAGE_MISMATCH", message: "Receipt allowed operations are invalid" });
  }
  return violations;
}

function finalize(
  input: TerminalWorktreeAuditInput,
  result: Omit<TerminalWorktreeAuditResult, "violations" | "total_violation_count" | "diagnostics_truncated" | "accepted" | "safety_verdict">,
  violations: SafetyViolation[],
): TerminalWorktreeAuditResult {
  const limit = boundedLimit(input.max_diagnostics);
  return {
    ...result,
    accepted: violations.length === 0,
    safety_verdict: violations.length === 0 ? "safe" : "rejected",
    violations: violations.slice(0, limit),
    total_violation_count: violations.length,
    diagnostics_truncated: violations.length > limit,
  };
}

async function repositoryIdentityViolations(record: WorktreeRecord, spawn: StableGitTerminalTreeOptions["spawn"]): Promise<SafetyViolation[]> {
  const violations: SafetyViolation[] = [];
  let root: string;
  try { root = fs.realpathSync(record.execution_root); }
  catch { return [{ code: "E_REPOSITORY_ESCAPE", message: "recorded execution root is missing or cannot be resolved" }]; }
  try {
    const top = fs.realpathSync(await collectGitScalar({ cwd: root, args: ["rev-parse", "--show-toplevel"], spawn }));
    if (top !== root) violations.push({ code: "E_REPOSITORY_ESCAPE", message: "terminal root resolves to a different Git repository" });
    const rawCommon = await collectGitScalar({ cwd: root, args: ["rev-parse", "--git-common-dir"], spawn });
    const common = fs.realpathSync(path.isAbsolute(rawCommon) ? rawCommon : path.resolve(root, rawCommon));
    if (common !== fs.realpathSync(record.git_common_dir)) violations.push({ code: "E_REPOSITORY_ESCAPE", message: "terminal common-directory identity changed" });
  } catch {
    violations.push({ code: "E_REPOSITORY_ESCAPE", message: "terminal Git repository identity could not be verified" });
  }
  return violations;
}

async function symlinkTarget(root: string, change: GitTreeChangeFact, spawn: StableGitTerminalTreeOptions["spawn"]): Promise<string | undefined> {
  if (change.new_mode !== "120000" || /^0+$/u.test(change.new_object)) return undefined;
  return collectGitScalar({ cwd: root, args: ["cat-file", "blob", change.new_object], scalarLimit: 16 * 1024, trimTrailingNewline: false, spawn });
}

function symlinkEscapes(pathname: string, target: string, allowlist: readonly string[]): boolean {
  if (path.posix.isAbsolute(target) || target.includes("\0")) return true;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(pathname), target));
  return !safeRelative(resolved) || !pathAllowed(resolved, [...allowlist]);
}

/** Audit one terminal isolated root into immutable base/result facts. */
export async function auditTerminalWorktree(input: TerminalWorktreeAuditInput): Promise<TerminalWorktreeAuditResult> {
  const record = assertWorktreeRecord(input.record);
  const receipt = input.receipt;
  const seed = {
    repository_id: record.repository_id,
    git_common_dir_identity: record.git_common_dir_identity,
    base_tree: record.base_tree,
    result_tree: null,
    receipt_id: receipt.receipt_id,
    operations: [] as ChangeBundleOperation[],
    changed_paths: [] as string[],
    changes: [] as GitTreeChangeFact[],
    non_text_facts: null,
  };
  const violations = lineageViolations(record, receipt);
  violations.push(...await repositoryIdentityViolations(record, input.spawn));
  if (violations.length) return finalize(input, seed, violations);

  let facts: StableGitTerminalTreeFacts;
  try {
    facts = await captureStableGitTerminalTree(record.execution_root, record.base_tree, {
      spawn: input.spawn,
      collectFacts: input.collectFacts,
      collectToken: input.collectToken,
    });
  } catch (error) {
    const unstable = error instanceof GitSafetyError && error.code === "GIT_AUDIT_RACED";
    violations.push({
      code: unstable ? "E_UNSTABLE_TERMINAL" : "E_AUDIT_CAPTURE_FAILED",
      message: unstable ? "terminal worktree did not remain stable for a complete audit" : "terminal Git facts could not be captured completely",
    });
    return finalize(input, seed, violations);
  }

  const operations = new Set<ChangeBundleOperation>();
  const changedPaths = new Set<string>();
  const symlinks: WorktreeNonTextFacts["symlinks"] = [];
  for (const change of facts.changes) {
    changedPaths.add(change.path);
    if (change.original_path) changedPaths.add(change.original_path);
    const changeOperations = operationsFor(change);
    for (const operation of changeOperations) operations.add(operation);
    const paths = [change.path, change.original_path].filter((item): item is string => Boolean(item));
    if (paths.some((item) => !safeRelative(item) || !pathAllowed(item, [...receipt.write_allowlist]))) {
      violations.push({ code: "E_OUT_OF_SCOPE_PATH", path: change.path, original_path: change.original_path, operation: change.operation, message: "changed path is outside the Receipt allowlist" });
    }
    for (const operation of changeOperations) if (!receipt.allowed_operations.includes(operation)) {
      violations.push({ code: "E_OUT_OF_SCOPE_OP", path: change.path, original_path: change.original_path, operation, message: "change operation is not authorized" });
    }
    if (change.old_mode === "160000" || change.new_mode === "160000") {
      violations.push({ code: "E_REPOSITORY_ESCAPE", path: change.path, operation: change.operation, message: "nested-repository or gitlink changes require a repository-local unit" });
    }
    if (change.old_mode === "120000" || change.new_mode === "120000") {
      let target: string | undefined;
      try { target = await symlinkTarget(record.execution_root, change, input.spawn); }
      catch { violations.push({ code: "E_AUDIT_CAPTURE_FAILED", path: change.path, operation: change.operation, message: "symlink object metadata could not be read" }); }
      symlinks.push({ path: change.path, old_object: change.old_object, new_object: change.new_object, ...(target === undefined ? {} : { target }) });
      if (target !== undefined && symlinkEscapes(change.path, target, receipt.write_allowlist)) {
        violations.push({ code: "E_SYMLINK_ESCAPE", path: change.path, operation: change.operation, message: "symlink target escapes the repository or Receipt scope" });
      }
    }
  }

  const terminal = facts.terminal;
  if (terminal.commit?.tree !== record.base_tree) violations.push({ code: "E_HEAD_MUTATION", message: "worker changed Git HEAD from the immutable base" });
  if (terminal.branch || terminal.branchRef) violations.push({ code: "E_BRANCH_MUTATION", message: "worker attached the isolated worktree to a branch" });
  if (terminal.stagedTree !== record.base_tree || terminal.stagedPaths.length > 0) violations.push({ code: "E_INDEX_MUTATION", message: "worker changed the isolated worktree index" });
  if (terminal.indexControl.algorithm !== facts.baseIndexControl.algorithm
    || terminal.indexControl.checksum !== facts.baseIndexControl.checksum
    || terminal.indexControl.entryCount !== facts.baseIndexControl.entryCount) {
    violations.push({ code: "E_INDEX_MUTATION", message: "worker changed isolated index control flags" });
  }
  if (terminal.gitOperation) violations.push({ code: "E_GIT_OPERATION", message: "an unfinished Git control operation exists in the terminal worktree" });
  if (facts.resultTree === record.base_tree && !receipt.allow_noop) {
    violations.push({ code: "E_EMPTY_RESULT", message: "writing unit produced no effective tree change and no-op was not authorized" });
  }

  const orderedOperations = OPERATION_ORDER.filter((operation) => operations.has(operation));
  const orderedPaths = [...changedPaths].sort();
  const nonTextFacts: WorktreeNonTextFacts = {
    raw_changes: facts.changes,
    binary_paths: facts.binaryPaths,
    mode_changes: facts.changes.filter((change) => facts.modeChangedPaths.includes(change.path))
      .map((change) => ({ path: change.path, old_mode: change.old_mode, new_mode: change.new_mode })),
    renames: facts.changes.filter((change) => change.status === "R")
      .map((change) => ({ source: change.original_path!, target: change.path, ...(change.score === undefined ? {} : { score: change.score }) })),
    copies: facts.changes.filter((change) => change.status === "C")
      .map((change) => ({ source: change.original_path!, target: change.path, ...(change.score === undefined ? {} : { score: change.score }) })),
    symlinks,
    gitlinks: facts.changes.filter((change) => change.old_mode === "160000" || change.new_mode === "160000")
      .map((change) => ({ path: change.path, old_object: change.old_object, new_object: change.new_object })),
    terminal_control: {
      head: terminal.head,
      branch_ref: terminal.branchRef,
      staged_tree: terminal.stagedTree,
      staged_paths: terminal.stagedPaths,
      index_control: terminal.indexControl,
      git_operation: terminal.gitOperation ?? null,
      refs_digest: terminal.stabilityToken.refsDigest,
      reflog_count: terminal.reflog.count,
      reflog_checksum: terminal.reflog.checksum,
    },
  };
  return finalize(input, {
    ...seed,
    result_tree: facts.resultTree,
    operations: orderedOperations,
    changed_paths: orderedPaths,
    changes: facts.changes,
    non_text_facts: nonTextFacts,
  }, violations);
}

