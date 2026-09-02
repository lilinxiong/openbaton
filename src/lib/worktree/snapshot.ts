/** Materialize an authorized dirty caller baseline without using its index. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertGitSafetyStabilityTokenUnchanged,
  captureStableSafetyFacts,
  fingerprintGitSafetyStabilityToken,
  type StableGitSafetyFacts,
} from "../git/safety-facts.js";
import { collectGitScalar, runGitProcess, type GitProcessOptions } from "../git/safety-process.js";
import {
  SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  fingerprintWorktreeRuntimeRecord,
  persistSnapshotManifest,
  type SnapshotManifest,
} from "../worktree-execution.js";

export interface DirtyBaselineSnapshotInput {
  repository_root: string;
  repository_id: string;
  git_common_dir_identity: string;
  run_id: string;
  snapshot_id: string;
  /** Exact repository-relative paths authorized for this dirty baseline. */
  authorized_paths: readonly string[];
  env?: NodeJS.ProcessEnv;
  created_at?: string | number | Date;
  /** A stable observation already made by a surrounding setup transaction. */
  caller_before?: StableGitSafetyFacts;
  spawn?: GitProcessOptions["spawn"];
}

export class DirtyBaselineAuthorizationError extends Error {
  readonly code: "WORKTREE_DIRTY_PATH_INVALID" | "WORKTREE_DIRTY_PATH_UNAUTHORIZED";
  readonly paths: readonly string[];
  constructor(message: string, code: DirtyBaselineAuthorizationError["code"], paths: readonly string[]) {
    super(message);
    this.name = "DirtyBaselineAuthorizationError";
    this.code = code;
    this.paths = [...paths];
  }
}

export class DirtyBaselineStabilityError extends Error {
  readonly code: "WORKTREE_DIRTY_SNAPSHOT_RACED" | "WORKTREE_SNAPSHOT_REPLAY_MISMATCH";
  constructor(message: string, code: DirtyBaselineStabilityError["code"]) {
    super(message);
    this.name = "DirtyBaselineStabilityError";
    this.code = code;
  }
}

export interface DirtyBaselineSnapshotResult {
  manifest: SnapshotManifest;
  caller_before: StableGitSafetyFacts;
  caller_after: StableGitSafetyFacts;
}

function timestamp(value?: string | number | Date): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("created_at must be a valid timestamp");
  return date.toISOString();
}

function exactAuthorizedPaths(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new DirtyBaselineAuthorizationError("dirty baseline authorized_paths must be an exact path array", "WORKTREE_DIRTY_PATH_INVALID", []);
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === "." || value.startsWith("../")
      || value.split("/").includes(".git") || seen.has(value)) invalid.push(String(value));
    seen.add(value);
  }
  if (invalid.length) throw new DirtyBaselineAuthorizationError(
    `dirty baseline contains invalid or ambiguous exact paths: ${invalid.sort().join(", ")}`,
    "WORKTREE_DIRTY_PATH_INVALID",
    invalid.sort(),
  );
  return [...seen].sort();
}

function assertDirtyPathsAuthorized(before: StableGitSafetyFacts, authorized: readonly string[]): void {
  const allowed = new Set(authorized);
  const dirty = new Set<string>();
  for (const entry of before.dirtyEntries) {
    dirty.add(entry.path);
    if (entry.original_path) dirty.add(entry.original_path);
  }
  const unauthorized = [...dirty].filter((value) => !allowed.has(value)).sort();
  if (unauthorized.length) throw new DirtyBaselineAuthorizationError(
    `dirty baseline paths are not authorized exactly: ${unauthorized.join(", ")}`,
    "WORKTREE_DIRTY_PATH_UNAUTHORIZED",
    unauthorized,
  );
}

async function nulStrings(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; spawn?: GitProcessOptions["spawn"] } = {},
): Promise<string[]> {
  const values: string[] = [];
  let pending = Buffer.alloc(0);
  await runGitProcess({
    cwd,
    args,
    env: options.env,
    spawn: options.spawn,
    onStdout(chunk) {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf(0);
        if (end < 0) break;
        values.push(pending.subarray(0, end).toString("utf8"));
        pending = pending.subarray(end + 1);
      }
    },
  });
  if (pending.length !== 0) throw new Error("Git returned a malformed NUL-delimited path stream");
  return values.filter(Boolean);
}

interface VisibleTreeCapture {
  tree: string;
  includedPaths: string[];
}

async function captureVisibleTree(
  root: string,
  headTree: string,
  temporaryIndex: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<VisibleTreeCapture> {
  const alternate = { GIT_INDEX_FILE: temporaryIndex };
  await runGitProcess({ cwd: root, args: ["read-tree", headTree], env: alternate, spawn });
  await runGitProcess({ cwd: root, args: ["add", "-A", "--", "."], env: alternate, spawn });
  const tree = await collectGitScalar({ cwd: root, args: ["write-tree"], env: alternate, spawn });
  const includedPaths = await nulStrings(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", headTree, tree], { spawn });
  return { tree, includedPaths };
}

function dirtyFacts(facts: StableGitSafetyFacts): string {
  return JSON.stringify({
    dirty_entries: facts.dirtyEntries,
    untracked_exists: facts.untrackedExists,
    mode_changed_paths: [...facts.modeChangedPaths].sort(),
  });
}

async function captureStableVisibleTree(
  root: string,
  headTree: string,
  authorizedPaths: readonly string[],
  before: StableGitSafetyFacts,
  temporaryRoot: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<{ capture: VisibleTreeCapture; after: StableGitSafetyFacts }> {
  const first = await captureVisibleTree(root, headTree, path.join(temporaryRoot, "index-first"), spawn);
  const middle = await captureStableSafetyFacts(root, { purpose: "baseline", spawn });
  assertGitSafetyStabilityTokenUnchanged(before.stabilityToken, middle.stabilityToken);
  assertDirtyPathsAuthorized(middle, authorizedPaths);
  const second = await captureVisibleTree(root, headTree, path.join(temporaryRoot, "index-second"), spawn);
  const after = await captureStableSafetyFacts(root, { purpose: "baseline", spawn });
  assertGitSafetyStabilityTokenUnchanged(middle.stabilityToken, after.stabilityToken);
  assertDirtyPathsAuthorized(after, authorizedPaths);
  if (first.tree !== second.tree
    || JSON.stringify(first.includedPaths) !== JSON.stringify(second.includedPaths)
    || dirtyFacts(before) !== dirtyFacts(middle)
    || dirtyFacts(middle) !== dirtyFacts(after)) {
    throw new DirtyBaselineStabilityError(
      "dirty baseline visible content or dirty facts changed across complete alternate-index captures",
      "WORKTREE_DIRTY_SNAPSHOT_RACED",
    );
  }
  return { capture: second, after };
}

function manifestAuthorizedPaths(manifest: SnapshotManifest): string[] {
  const value = manifest.git_facts.authorized_paths;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new DirtyBaselineStabilityError("persisted snapshot has no exact authorized path set", "WORKTREE_SNAPSHOT_REPLAY_MISMATCH");
  }
  return exactAuthorizedPaths(value);
}

/** Rebuild current authorized content twice and compare it with an immutable manifest. */
export async function verifyDirtyBaselineSnapshot(
  manifest: SnapshotManifest,
  input: Pick<DirtyBaselineSnapshotInput, "repository_root" | "authorized_paths" | "caller_before" | "spawn">,
): Promise<{ caller_before: StableGitSafetyFacts; caller_after: StableGitSafetyFacts }> {
  const root = fs.realpathSync(input.repository_root);
  const before = input.caller_before ?? await captureStableSafetyFacts(root, { purpose: "baseline", spawn: input.spawn });
  const authorizedPaths = exactAuthorizedPaths(input.authorized_paths);
  const persistedPaths = manifestAuthorizedPaths(manifest);
  if (JSON.stringify(authorizedPaths) !== JSON.stringify(persistedPaths)) {
    throw new DirtyBaselineStabilityError("dirty baseline replay authorization set differs from the persisted snapshot", "WORKTREE_SNAPSHOT_REPLAY_MISMATCH");
  }
  assertDirtyPathsAuthorized(before, authorizedPaths);
  const headTree = await collectGitScalar({ cwd: root, args: ["rev-parse", "HEAD^{tree}"], spawn: input.spawn });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baton-worktree-replay-index-"));
  try {
    const stable = await captureStableVisibleTree(root, headTree, authorizedPaths, before, temporaryRoot, input.spawn);
    if (headTree !== manifest.head_tree || stable.capture.tree !== manifest.snapshot_tree
      || JSON.stringify(stable.capture.includedPaths) !== JSON.stringify(manifest.included_paths)) {
      throw new DirtyBaselineStabilityError("current authorized content does not match the persisted snapshot", "WORKTREE_SNAPSHOT_REPLAY_MISMATCH");
    }
    return { caller_before: before, caller_after: stable.after };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Build a tree for the caller's visible filesystem state. The caller's real
 * index is never copied, refreshed, locked, or selected through GIT_INDEX_FILE.
 */
export async function createDirtyBaselineSnapshot(input: DirtyBaselineSnapshotInput): Promise<DirtyBaselineSnapshotResult> {
  const root = fs.realpathSync(input.repository_root);
  const before = input.caller_before ?? await captureStableSafetyFacts(root, { purpose: "baseline", spawn: input.spawn });
  const authorizedPaths = exactAuthorizedPaths(input.authorized_paths);
  assertDirtyPathsAuthorized(before, authorizedPaths);
  const headTree = await collectGitScalar({ cwd: root, args: ["rev-parse", "HEAD^{tree}"], spawn: input.spawn });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baton-worktree-index-"));
  try {
    const stable = await captureStableVisibleTree(root, headTree, authorizedPaths, before, temporaryRoot, input.spawn);
    const snapshotTree = stable.capture.tree;
    const includedPaths = stable.capture.includedPaths;
    const after = stable.after;
    const beforeFingerprint = fingerprintGitSafetyStabilityToken(before.stabilityToken);
    const afterFingerprint = fingerprintGitSafetyStabilityToken(after.stabilityToken);
    const unsigned: Omit<SnapshotManifest, "fingerprint"> = {
      schema_version: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
      snapshot_id: input.snapshot_id,
      repository_id: input.repository_id,
      git_common_dir_identity: input.git_common_dir_identity,
      source_root: root,
      head_tree: headTree,
      snapshot_tree: snapshotTree,
      included_paths: includedPaths,
      excluded_paths: [],
      git_facts: {
        head: before.head,
        branch_ref: before.branchRef,
        staged_tree: before.stagedTree,
        staged_paths: before.stagedPaths,
        dirty_entries: before.dirtyEntries,
        untracked_exists: before.untrackedExists,
        mode_changed_paths: [...before.modeChangedPaths].sort(),
        index_control: before.indexControl,
        authorized_paths: authorizedPaths,
      },
      caller_before_fingerprint: beforeFingerprint,
      caller_after_fingerprint: afterFingerprint,
      created_at: timestamp(input.created_at),
    };
    const manifest = { ...unsigned, fingerprint: "" } as SnapshotManifest;
    manifest.fingerprint = fingerprintWorktreeRuntimeRecord(manifest);
    persistSnapshotManifest(root, input.run_id, manifest, input.env);
    return { manifest, caller_before: before, caller_after: after };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

