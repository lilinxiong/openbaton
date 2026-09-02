import {
  WorktreeCleanupEligibilityInput,
  WorktreeCleanupInput,
  WorktreeCleanupResult,
  WorktreeLifecycleError
} from "../worktree-lifecycle.js";
import {
  canonicalPotentialPath,
  registeredWorktreeRoots,
  rootState,
  sha,
  timestamp,
  within
} from "./lifecycle-common.js";
import {
  listPersistedWorktreeRecords,
  readBundle,
  readIntegration
} from "./lifecycle-records.js";
import {
  GitProcessOptions,
  GitSafetyError,
  collectGitScalar,
  runGitProcess
} from "../git/safety-process.js";
import {
  rollingRunSnapshotsDir,
  rollingRunWorktreesDir,
  snapshotManifestPath,
  worktreeExecutionRootPath,
  worktreeRecordPath
} from "../paths.js";
import {
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord
} from "../worktree-execution.js";
import {
  CLEANUP_STATE_SCHEMA_VERSION,
  ChangeBundleManifest,
  IntegrationRecord,
  RetentionReason,
  WorktreeRecord
} from "./execution-types.js";
/**
 * Retention derivation and cleanup operations for worktree runs. Split from
 * worktree-lifecycle.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { parseSnapshotManifest } from "../worktree-execution.js";
import { resolveOwningRepository } from "./topology.js";
/*
 */

export function deriveWorktreeRetentionReasons(
  record: WorktreeRecord,
  options: {
    terminal_ticket_released?: boolean;
    release_downstream_base?: boolean;
    discard_rejected_evidence?: boolean;
    release_user_retention?: boolean;
  } = {},
): RetentionReason[] {
  const reasons = new Set<RetentionReason>();
  if (record.retention_reasons.includes("user_requested") && !options.release_user_retention) reasons.add("user_requested");
  if (record.lifecycle_state === "worker_active") reasons.add("live_native_handle");
  if (record.lifecycle_state === "terminal_awaiting_audit") {
    reasons.add("pending_audit");
    if (!options.terminal_ticket_released) reasons.add("terminal_unreleased_ticket");
  }
  if (record.lifecycle_state === "rejected" && !options.discard_rejected_evidence) reasons.add("rejected_result_evidence");
  if (record.lifecycle_state === "bundle_ready") reasons.add("ready_bundle");
  if (record.lifecycle_state === "integrating") reasons.add("active_integration");
  if (record.lifecycle_state === "awaiting_parent_resolution") reasons.add("unresolved_conflict");
  if ((record.lifecycle_state === "integrated" || record.lifecycle_state === "accepted") && !options.release_downstream_base) reasons.add("downstream_base_dependency");
  return [...reasons].sort();
}

export async function markWorktreeCleanupEligible(input: WorktreeCleanupEligibilityInput): Promise<WorktreeRecord> {
  const root = fs.realpathSync(input.cwd);
  let record = readPersistedWorktreeRecord(root, input.run_id, input.unit_key, input.attempt_id, input.env);
  if (record.lifecycle_state === "cleanup_eligible" || record.lifecycle_state === "cleaned") return record;
  if (record.lifecycle_state === "cleanup_failed") {
    return transitionPersistedWorktreeRecord(root, input.run_id, input.unit_key, input.attempt_id, { idempotency_key: `cleanup-retry:${record.cleanup.attempts + 1}`, phase: "cleanup", to_state: "cleanup_eligible", retention_reasons: [], cleanup: { schema_version: CLEANUP_STATE_SCHEMA_VERSION, status: "eligible", attempts: record.cleanup.attempts, updated_at: timestamp(input.at) }, recorded_at: timestamp(input.at) }, input.env);
  }
  if (record.lifecycle_state === "accepted" && input.release_downstream_base) await assertAcceptedTreeReachable(root, record, readIntegration(root, record, input.env), input.spawn);
  const reasons = deriveWorktreeRetentionReasons(record, input);
  if (reasons.length) throw new WorktreeLifecycleError("worktree still has retention reasons", "WORKTREE_CLEANUP_RETAINED", { retention_reasons: reasons });
  if (record.lifecycle_state !== "accepted" && record.lifecycle_state !== "rejected") throw new WorktreeLifecycleError(`worktree ${record.lifecycle_state} is not cleanup eligible`, "WORKTREE_CLEANUP_NOT_READY");
  record = transitionPersistedWorktreeRecord(root, input.run_id, input.unit_key, input.attempt_id, {
    idempotency_key: "cleanup-eligible",
    phase: "cleanup",
    to_state: "cleanup_eligible",
    retention_reasons: [],
    cleanup: { schema_version: CLEANUP_STATE_SCHEMA_VERSION, status: "eligible", attempts: record.cleanup.attempts, updated_at: timestamp(input.at) },
    recorded_at: timestamp(input.at),
  }, input.env);
  return record;
}

export function assertExactCleanupIdentity(cwd: string, record: WorktreeRecord, env?: NodeJS.ProcessEnv): void {
  const expected = path.resolve(worktreeExecutionRootPath(cwd, record.run_id, record.unit_key, record.attempt_id, env));
  if (path.resolve(record.execution_root) !== expected || !within(rollingRunWorktreesDir(cwd, record.run_id, env), expected)) throw new WorktreeLifecycleError("cleanup target is outside the exact recorded Baton namespace", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", { expected, recorded: record.execution_root });
  const marker = worktreeRecordPath(cwd, record.run_id, record.unit_key, record.attempt_id, env);
  if (!fs.existsSync(marker) || (fs.existsSync(expected) && fs.lstatSync(expected).isSymbolicLink())) throw new WorktreeLifecycleError("cleanup target ownership marker is missing or rewritten", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", { marker, expected });
  const common = fs.realpathSync(record.git_common_dir);
  if (sha(common) !== record.git_common_dir_identity) throw new WorktreeLifecycleError("cleanup common-dir identity differs from the WorktreeRecord", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH");
  if (fs.existsSync(expected)) {
    try {
      const owner = resolveOwningRepository(expected, ".").repository;
      if (owner.repository_id !== record.repository_id || owner.git_common_dir_identity !== record.git_common_dir_identity) throw new WorktreeLifecycleError("cleanup root repository identity differs from the WorktreeRecord", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH");
    } catch (error) {
      if (error instanceof WorktreeLifecycleError) throw error;
      throw new WorktreeLifecycleError("cleanup root no longer resolves to the recorded repository", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", { cause: error instanceof Error ? error.message : String(error) });
    }
  }
}

export async function deleteInternalBundleRef(record: WorktreeRecord, bundle: ChangeBundleManifest | null, spawn?: GitProcessOptions["spawn"]): Promise<string | null> {
  if (!bundle || typeof bundle.transport.internal_ref !== "string" || typeof bundle.transport.internal_commit !== "string") return null;
  const expectedRef = `refs/baton/change-bundles/${bundle.bundle_id}`;
  if (bundle.transport.internal_ref !== expectedRef) throw new WorktreeLifecycleError("bundle internal ref is outside the exact Baton namespace", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH");
  let current: string | null;
  try { current = await collectGitScalar({ cwd: record.repository_root, args: ["rev-parse", "--verify", expectedRef], spawn }); }
  catch (error) { if (error instanceof GitSafetyError && (error.exitCode === 1 || error.exitCode === 128)) current = null; else throw error; }
  if (current === null) return null;
  if (current !== bundle.transport.internal_commit) throw new WorktreeLifecycleError("bundle internal ref moved to an unexpected object", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH", { ref: expectedRef, current, expected: bundle.transport.internal_commit });
  await runGitProcess({ cwd: record.repository_root, args: ["update-ref", "-d", expectedRef, current], spawn });
  return expectedRef;
}

export function deleteUnusedSnapshots(cwd: string, record: WorktreeRecord, env?: NodeJS.ProcessEnv): string[] {
  const directory = rollingRunSnapshotsDir(cwd, record.run_id, env);
  if (!fs.existsSync(directory)) return [];
  const otherBases = new Set(listPersistedWorktreeRecords(cwd, record.run_id, env).records.filter((item) => item.record_id !== record.record_id && item.lifecycle_state !== "cleaned").map((item) => item.base_tree));
  if (otherBases.has(record.base_tree)) return [];
  const removed: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = snapshotManifestPath(cwd, record.run_id, entry.name, env);
    if (!fs.existsSync(file)) continue;
    const snapshot = parseSnapshotManifest(fs.readFileSync(file, "utf8"));
    if (snapshot.repository_id !== record.repository_id || snapshot.git_common_dir_identity !== record.git_common_dir_identity || snapshot.snapshot_tree !== record.base_tree) continue;
    fs.unlinkSync(file);
    try { fs.rmdirSync(path.dirname(file)); } catch { /* retain unexpected sibling evidence */ }
    removed.push(snapshot.snapshot_id);
  }
  return removed.sort();
}

/** Remove only an eligible, exact, identity-verified worktree and its disposable reachability ref. */
export async function cleanupWorktreeAttempt(input: WorktreeCleanupInput): Promise<WorktreeCleanupResult> {
  const root = fs.realpathSync(input.cwd);
  let record = await markWorktreeCleanupEligible(input);
  if (record.lifecycle_state === "cleaned") return { record, replayed: true, removed_worktree: false, removed_internal_ref: null, removed_snapshot_ids: [] };
  const attempt = record.cleanup.status === "cleaning" ? record.cleanup.attempts : record.cleanup.attempts + 1;
  if (record.cleanup.status !== "cleaning") record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: `cleanup-start:${attempt}`, phase: "cleanup", to_state: "cleanup_eligible", cleanup: { schema_version: CLEANUP_STATE_SCHEMA_VERSION, status: "cleaning", attempts: attempt, updated_at: timestamp(input.at) }, recorded_at: timestamp(input.at) }, input.env);
  let removedWorktree = false; let removedInternalRef: string | null = null; let removedSnapshots: string[] = [];
  try {
    assertExactCleanupIdentity(root, record, input.env);
    const registry = await registeredWorktreeRoots(record.repository_root, input.spawn);
    const state = rootState(record.execution_root);
    const canonical = canonicalPotentialPath(record.execution_root);
    if (state === "directory" && !registry.has(canonical)) throw new WorktreeLifecycleError("cleanup root exists without an exact Git registration", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH");
    if (state !== "absent" && state !== "directory") throw new WorktreeLifecycleError(`cleanup root has unsupported state ${state}`, "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH");
    if (registry.has(canonical)) {
      if (state === "absent") await runGitProcess({ cwd: record.repository_root, args: ["worktree", "prune"], spawn: input.spawn });
      else await runGitProcess({ cwd: record.repository_root, args: ["worktree", "remove", "--force", record.execution_root], spawn: input.spawn });
      removedWorktree = true;
    }
    removedInternalRef = await deleteInternalBundleRef(record, readBundle(root, record, input.env), input.spawn);
    removedSnapshots = deleteUnusedSnapshots(root, record, input.env);
    record = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: `cleanup-complete:${attempt}`, phase: "cleanup", to_state: "cleaned", cleanup: { schema_version: CLEANUP_STATE_SCHEMA_VERSION, status: "cleaned", attempts: attempt, updated_at: timestamp(input.at) }, recorded_at: timestamp(input.at) }, input.env);
    return { record, replayed: !removedWorktree && !removedInternalRef && removedSnapshots.length === 0, removed_worktree: removedWorktree, removed_internal_ref: removedInternalRef, removed_snapshot_ids: removedSnapshots };
  } catch (error) {
    try {
      transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: `cleanup-failed:${attempt}`, phase: "cleanup", to_state: "cleanup_failed", cleanup: { schema_version: CLEANUP_STATE_SCHEMA_VERSION, status: "failed", attempts: attempt, last_error: error instanceof Error ? error.message : String(error), updated_at: timestamp(input.at) }, recorded_at: timestamp(input.at) }, input.env);
    } catch { /* retain the primary cleanup failure */ }
    if (error instanceof WorktreeLifecycleError) throw error;
    throw new WorktreeLifecycleError(error instanceof Error ? error.message : String(error), "WORKTREE_CLEANUP_FAILED");
  }
}

async function assertAcceptedTreeReachable(cwd: string, record: WorktreeRecord, integration: IntegrationRecord | null, spawn?: GitProcessOptions["spawn"]): Promise<void> {
  if (!integration || integration.state !== "accepted" || !integration.after_tree) throw new WorktreeLifecycleError("accepted integration evidence is required before releasing the downstream base", "WORKTREE_CLEANUP_NOT_READY");
  try { await collectGitScalar({ cwd: record.repository_root, args: ["cat-file", "-e", `${integration.after_tree}^{tree}`], spawn }); }
  catch (error) { throw new WorktreeLifecycleError("accepted result tree is not reachable", "WORKTREE_CLEANUP_NOT_READY", { cause: error instanceof Error ? error.message : String(error) }); }
}
