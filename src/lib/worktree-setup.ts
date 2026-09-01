/** Detached, ref-invariant setup for one isolated execution unit. */
import fs from "node:fs";
import path from "node:path";
import {
  assertGitSafetyStabilityTokenUnchanged,
  captureStableSafetyFacts,
  fingerprintGitSafetyStabilityToken,
  type StableGitSafetyFacts,
} from "./git-safety-facts.js";
import { collectGitScalar, GitSafetyError, runGitProcess, type GitProcessOptions } from "./git-safety-process.js";
import {
  initializeWorktreeRecord,
  persistWorktreeRecord,
  readPersistedSnapshotManifest,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  WorktreeExecutionError,
  type WorktreeSetupFailureDiagnostic,
  type WorktreeRecord,
} from "./worktree-execution.js";
import { snapshotManifestPath, worktreeRecordPath } from "./paths.js";
import { createDirtyBaselineSnapshot, verifyDirtyBaselineSnapshot, type DirtyBaselineSnapshotResult } from "./worktree-snapshot.js";

export type WorktreeSetupErrorCode =
  | "WORKTREE_BASE_INVALID"
  | "WORKTREE_DIRTY_BASELINE_UNAUTHORIZED"
  | "WORKTREE_SETUP_FAILED"
  | "WORKTREE_MATERIALIZATION_MISMATCH"
  | "WORKTREE_CALLER_FACTS_CHANGED";

export class WorktreeSetupError extends Error {
  readonly code: WorktreeSetupErrorCode;
  readonly cause?: unknown;
  constructor(message: string, code: WorktreeSetupErrorCode, cause?: unknown) {
    super(message);
    this.name = "WorktreeSetupError";
    this.code = code;
    this.cause = cause;
  }
}

export interface DetachedWorktreeSetupInput {
  repository_root: string;
  repository_id: string;
  git_common_dir: string;
  git_common_dir_identity: string;
  execution_root: string;
  run_id: string;
  unit_key: string;
  unit_version: number;
  attempt_id: string;
  record_id?: string;
  /** Commit-ish selected by the accepted plan. Defaults to HEAD. */
  base?: string;
  /** Capture the caller's complete visible dirty state as the immutable base. */
  include_dirty_baseline?: boolean;
  /** Required when include_dirty_baseline is true. */
  dirty_baseline_authorized?: boolean;
  /** Exact repository-relative dirty paths accepted by the plan. */
  dirty_baseline_paths?: readonly string[];
  snapshot_id?: string;
  env?: NodeJS.ProcessEnv;
  created_at?: string | number | Date;
  spawn?: GitProcessOptions["spawn"];
}

export interface DetachedWorktreeSetupResult {
  record: WorktreeRecord;
  base_commit: string;
  base_tree: string;
  snapshot?: DirtyBaselineSnapshotResult;
  caller_before_fingerprint: string;
  caller_after_fingerprint: string;
  recovered: boolean;
}

async function optionalScalar(cwd: string, args: string[], spawn?: GitProcessOptions["spawn"]): Promise<string | null> {
  try { return await collectGitScalar({ cwd, args, spawn }); }
  catch (error) { if (error instanceof GitSafetyError && error.exitCode === 1) return null; throw error; }
}

async function immutableCommitForTree(root: string, tree: string, parent: string, spawn?: GitProcessOptions["spawn"]): Promise<string> {
  return collectGitScalar({
    cwd: root,
    args: ["commit-tree", tree, "-p", parent, "-m", `baton isolated baseline ${tree}`],
    env: {
      GIT_AUTHOR_NAME: "OpenBaton",
      GIT_AUTHOR_EMAIL: "baton@invalid.local",
      GIT_COMMITTER_NAME: "OpenBaton",
      GIT_COMMITTER_EMAIL: "baton@invalid.local",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
    spawn,
  });
}

export async function verifyDetachedWorktreeMaterialization(
  executionRoot: string,
  expectedCommit: string,
  expectedTree: string,
  expectedCommonDir: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<void> {
  if (!fs.existsSync(executionRoot)) throw new WorktreeSetupError("registered worktree path is missing", "WORKTREE_MATERIALIZATION_MISMATCH");
  const root = fs.realpathSync(executionRoot);
  const head = await collectGitScalar({ cwd: root, args: ["rev-parse", "HEAD"], spawn });
  const tree = await collectGitScalar({ cwd: root, args: ["rev-parse", "HEAD^{tree}"], spawn });
  const indexTree = await collectGitScalar({ cwd: root, args: ["write-tree"], spawn });
  const branch = await collectGitScalar({ cwd: root, args: ["branch", "--show-current"], spawn });
  const commonRaw = await collectGitScalar({ cwd: root, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], spawn });
  const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(root, commonRaw));
  let dirty = false;
  await runGitProcess({ cwd: root, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"], spawn, onStdout(chunk) { if (chunk.length) dirty = true; } });
  if (head !== expectedCommit || tree !== expectedTree || indexTree !== expectedTree || branch !== ""
    || common !== fs.realpathSync(expectedCommonDir) || dirty) {
    throw new WorktreeSetupError("detached worktree materialization does not match its immutable base", "WORKTREE_MATERIALIZATION_MISMATCH");
  }
}

function recordExists(root: string, input: DetachedWorktreeSetupInput): boolean {
  return fs.existsSync(worktreeRecordPath(root, input.run_id, input.unit_key, input.attempt_id, input.env));
}

function setupTransition(
  root: string,
  input: DetachedWorktreeSetupInput,
  state: "registering" | "registered" | "verified" | "failed",
  setupFailure?: WorktreeSetupFailureDiagnostic,
): WorktreeRecord {
  return transitionPersistedWorktreeRecord(root, input.run_id, input.unit_key, input.attempt_id, {
    idempotency_key: `setup-${state}`,
    phase: "setup",
    to_state: "preparing",
    setup_state: state,
    ...(state === "failed" ? { setup_failure: setupFailure! } : {}),
  }, input.env);
}

function failureDiagnostic(
  cause: unknown,
  stage: WorktreeSetupFailureDiagnostic["stage"],
  executionRoot: string,
): WorktreeSetupFailureDiagnostic {
  let rootState: WorktreeSetupFailureDiagnostic["execution_root_state"] = "absent";
  try {
    if (fs.existsSync(executionRoot)) rootState = fs.statSync(executionRoot).isDirectory() ? "directory" : "other";
  } catch { rootState = "other"; }
  const code = cause instanceof WorktreeSetupError || cause instanceof WorktreeExecutionError || cause instanceof GitSafetyError
    ? cause.code
    : "WORKTREE_SETUP_FAILED";
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code,
    message,
    stage,
    execution_root_state: rootState,
    registration_present: rootState === "directory" && fs.existsSync(path.join(executionRoot, ".git")),
    recorded_at: new Date().toISOString(),
  };
}

/** Set up or resume setup of the exact run/unit/attempt worktree. */
export async function setupDetachedWorktree(input: DetachedWorktreeSetupInput): Promise<DetachedWorktreeSetupResult> {
  const root = fs.realpathSync(input.repository_root);
  const executionRoot = path.resolve(input.execution_root);
  const before = await captureStableSafetyFacts(root, { purpose: "baseline", spawn: input.spawn });
  if (input.include_dirty_baseline && !input.dirty_baseline_authorized) {
    throw new WorktreeSetupError("dirty baseline snapshot was not explicitly authorized", "WORKTREE_DIRTY_BASELINE_UNAUTHORIZED");
  }
  if (input.include_dirty_baseline && !Array.isArray(input.dirty_baseline_paths)) {
    throw new WorktreeSetupError("dirty baseline requires exact authorized repository-relative paths", "WORKTREE_DIRTY_BASELINE_UNAUTHORIZED");
  }
  let snapshot: DirtyBaselineSnapshotResult | undefined;
  let baseCommit: string;
  let baseTree: string;
  try {
    baseCommit = await collectGitScalar({ cwd: root, args: ["rev-parse", `${input.base ?? "HEAD"}^{commit}`], spawn: input.spawn });
    baseTree = await collectGitScalar({ cwd: root, args: ["rev-parse", `${baseCommit}^{tree}`], spawn: input.spawn });
  } catch (cause) {
    if (!input.base) throw new WorktreeSetupError("worktree base must resolve to an immutable commit or tree", "WORKTREE_BASE_INVALID", cause);
    try {
      baseTree = await collectGitScalar({ cwd: root, args: ["rev-parse", `${input.base}^{tree}`], spawn: input.spawn });
      const parent = await collectGitScalar({ cwd: root, args: ["rev-parse", "HEAD^{commit}"], spawn: input.spawn });
      baseCommit = await immutableCommitForTree(root, baseTree, parent, input.spawn);
    } catch (treeCause) {
      throw new WorktreeSetupError("worktree base must resolve to an immutable commit or tree", "WORKTREE_BASE_INVALID", treeCause);
    }
  }
  if (input.include_dirty_baseline) {
    const snapshotId = input.snapshot_id ?? `${input.run_id}:${input.unit_key}:${input.attempt_id}`;
    const snapshotFile = snapshotManifestPath(root, input.run_id, snapshotId, input.env);
    if (fs.existsSync(snapshotFile) || (fs.existsSync(path.dirname(snapshotFile))
      && fs.readdirSync(path.dirname(snapshotFile)).some((name) => name.startsWith(`${path.basename(snapshotFile)}.tmp-`)))) {
      const manifest = readPersistedSnapshotManifest(root, input.run_id, snapshotId, input.env);
      const currentFingerprint = fingerprintGitSafetyStabilityToken(before.stabilityToken);
      if (manifest.repository_id !== input.repository_id
        || manifest.git_common_dir_identity !== input.git_common_dir_identity
        || manifest.caller_before_fingerprint !== currentFingerprint) {
        throw new WorktreeExecutionError("persisted snapshot identity differs from the requested dirty baseline", "WORKTREE_IDENTITY_MISMATCH");
      }
      const replay = await verifyDirtyBaselineSnapshot(manifest, {
        repository_root: root,
        authorized_paths: input.dirty_baseline_paths!,
        caller_before: before,
        spawn: input.spawn,
      });
      snapshot = { manifest, ...replay };
    } else {
      snapshot = await createDirtyBaselineSnapshot({
        repository_root: root,
        repository_id: input.repository_id,
        git_common_dir_identity: input.git_common_dir_identity,
        run_id: input.run_id,
        snapshot_id: snapshotId,
        authorized_paths: input.dirty_baseline_paths!,
        env: input.env,
        created_at: input.created_at,
        caller_before: before,
        spawn: input.spawn,
      });
    }
    baseTree = snapshot.manifest.snapshot_tree;
    baseCommit = await immutableCommitForTree(root, baseTree, baseCommit, input.spawn);
  }

  let record: WorktreeRecord;
  let recovered = false;
  let failureStage: WorktreeSetupFailureDiagnostic["stage"] = "registration";
  if (recordExists(root, input)) {
    record = readPersistedWorktreeRecord(root, input.run_id, input.unit_key, input.attempt_id, input.env);
    recovered = true;
    if (record.base_tree !== baseTree || path.resolve(record.execution_root) !== executionRoot) {
      throw new WorktreeExecutionError("persisted setup identity differs from the requested setup", "WORKTREE_IDENTITY_MISMATCH");
    }
  } else {
    record = initializeWorktreeRecord({
      record_id: input.record_id,
      repository_id: input.repository_id,
      repository_root: root,
      git_common_dir: input.git_common_dir,
      git_common_dir_identity: input.git_common_dir_identity,
      execution_root: executionRoot,
      base_tree: baseTree,
      run_id: input.run_id,
      unit_key: input.unit_key,
      unit_version: input.unit_version,
      attempt_id: input.attempt_id,
      created_at: input.created_at,
    });
    persistWorktreeRecord(root, record, input.env);
  }

  try {
    if (record.setup_state === "planned") record = setupTransition(root, input, "registering");
    if (record.setup_state === "registering") {
      if (!fs.existsSync(executionRoot)) {
        fs.mkdirSync(path.dirname(executionRoot), { recursive: true, mode: 0o700 });
        await runGitProcess({ cwd: root, args: ["worktree", "add", "--detach", executionRoot, baseCommit], spawn: input.spawn });
      }
      record = setupTransition(root, input, "registered");
    }
    if (record.setup_state === "registered") {
      failureStage = "materialization";
      await verifyDetachedWorktreeMaterialization(executionRoot, baseCommit, baseTree, input.git_common_dir, input.spawn);
      record = setupTransition(root, input, "verified");
    }
    if (record.setup_state !== "verified") {
      throw new WorktreeSetupError(`setup cannot resume from state ${record.setup_state}`, "WORKTREE_SETUP_FAILED");
    }
    failureStage = "identity_verification";
    const after = await captureStableSafetyFacts(root, { purpose: "baseline", spawn: input.spawn });
    try { assertGitSafetyStabilityTokenUnchanged(before.stabilityToken, after.stabilityToken); }
    catch (cause) { throw new WorktreeSetupError("caller control facts changed during worktree setup", "WORKTREE_CALLER_FACTS_CHANGED", cause); }
    return {
      record,
      base_commit: baseCommit,
      base_tree: baseTree,
      ...(snapshot ? { snapshot } : {}),
      caller_before_fingerprint: fingerprintGitSafetyStabilityToken(before.stabilityToken),
      caller_after_fingerprint: fingerprintGitSafetyStabilityToken(after.stabilityToken),
      recovered,
    };
  } catch (cause) {
    try {
      const current = readPersistedWorktreeRecord(root, input.run_id, input.unit_key, input.attempt_id, input.env);
      if (current.setup_state !== "verified" && current.setup_state !== "failed") {
        setupTransition(root, input, "failed", failureDiagnostic(cause, failureStage, executionRoot));
      }
    } catch { /* retain the primary failure and any recoverable partial state */ }
    if (cause instanceof WorktreeSetupError || cause instanceof WorktreeExecutionError) throw cause;
    throw new WorktreeSetupError("detached worktree setup failed", "WORKTREE_SETUP_FAILED", cause);
  }
}

