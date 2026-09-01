import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./json-utils.js";

export const BATON_DIR = ".baton";
export const CONFIG_NAME = "config.toml";
export const SKILL_NAME = "SKILL.md";
export const SPAWNS_DIR = "spawns";
export const RUNS_DIR = "runs";
/** Compiled OpenSpec apply runs have their own versioned namespace. */
export const COMPILED_APPLY_RUNS_DIR = "compiled-apply-runs";
/** Rolling execution runs use a separate v2 namespace and never share the
 * compiled-apply-v1 records above. */
export const ROLLING_RUNS_DIR = "rolling-runs-v2";
export const ROLLING_FACTS_DIR = "facts";
export const ROLLING_FACT_LOG_NAME = "facts.ndjson";
export const ROLLING_ACCEPTED_DOCUMENTS_DIR = "accepted-documents";
export const ROLLING_CHECKPOINT_NAME = "checkpoint.json";
export const ROLLING_LOCK_NAME = ".lock";
/** Versioned worktree-execution records live inside one rolling-run root. */
export const ROLLING_WORKTREES_DIR = "worktrees";
export const ROLLING_SNAPSHOTS_DIR = "snapshots";
export const ROLLING_BUNDLES_DIR = "bundles";
export const ROLLING_INTEGRATIONS_DIR = "integrations";
/** Cross-run admission locks for one workspace repository destination. */
export const ROLLING_INTEGRATION_DESTINATIONS_DIR = "rolling-integration-destinations-v1";
export const WORKTREE_RECORD_NAME = "record-v1.json";
export const SNAPSHOT_MANIFEST_NAME = "manifest-v1.json";
export const BUNDLE_MANIFEST_NAME = "manifest-v1.json";
export const INTEGRATION_RECORD_NAME = "record-v1.json";
export const WORKTREE_EXECUTION_ROOT_DIR = "root";
export const SELECTIONS_DIR = "selections";
export const RECEIPTS_DIR = "receipts";
export const TMP_DIR = "tmp";
export const CACHE_DIR = "cache";
export const STATE_DIR = "state";
export const WORKSPACES_DIR = "workspaces";
/**
 * Current workspace runtime-state format.
 *
 * The directory before this component is intentionally left untouched. It
 * is the unversioned state written by older releases, and current code must
 * neither inspect nor migrate it.
 */
export const CURRENT_RUNTIME_NAMESPACE = "v2";
export const ROUTE_HEALTH_NAME = "route-health.json";
export const MODEL_AVAILABILITY_NAME = "model-availability.json";

export class CompiledApplyPathError extends Error {
  readonly code = "COMPILED_PATH_SEGMENT_INVALID";
  constructor(label: string, value: unknown) {
    super(`${label} must be one non-empty path segment: ${JSON.stringify(String(value))}`);
    this.name = "CompiledApplyPathError";
  }
}

export const ROLLING_PATH_SEGMENT_INVALID = "ROLLING_PATH_SEGMENT_INVALID" as const;

export class RollingRunPathError extends Error {
  readonly code = ROLLING_PATH_SEGMENT_INVALID;
  constructor(label: string, value: unknown) {
    super(`${label} must be one non-empty path segment: ${JSON.stringify(String(value))}`);
    this.name = "RollingRunPathError";
  }
}

/**
 * Validate one externally supplied path component.  In addition to ordinary
 * separators, reject Windows drive roots so the same contract is safe when a
 * path is later materialized on another platform.  The error factory keeps
 * the validator shared while preserving the legacy compiled-run error code.
 */
function strictPathSegment(
  label: string,
  value: unknown,
  error: (label: string, value: unknown) => Error,
  requireString = false,
): string {
  const segment = String(value);
  if (
    (requireString && typeof value !== "string")
    || !segment.trim()
    || segment === "."
    || segment === ".."
    || /[/\\\p{Cc}\p{Cf}]/u.test(segment)
    || path.isAbsolute(segment)
    || path.win32.isAbsolute(segment)
    || path.win32.parse(segment).root
  ) {
    throw error(label, value);
  }
  return segment;
}

function compiledPathSegment(label: string, value: unknown): string {
  return strictPathSegment(label, value, (part, input) => new CompiledApplyPathError(part, input));
}

/** Shared strict validator for rolling-run identifiers. */
export function rollingPathSegment(label: string, value: unknown): string {
  return strictPathSegment(label, value, (part, input) => new RollingRunPathError(part, input), true);
}

/** Host-keyed state names used by the current runtime. */
export function hostRouteSnapshotName(host: string): string {
  return `cli-models-${String(host).trim().toLowerCase()}.json`;
}

export function hostDispatchStateName(host: string): string {
  return `dispatch-${String(host).trim().toLowerCase()}.json`;
}

/**
 * User home for host + director files.
 * HOME = env.HOME || env.USERPROFILE || os.homedir()
 */
export function hostHome(env?: NodeJS.ProcessEnv): string {
  const e = env || process.env || {};
  return e.HOME || e.USERPROFILE || os.homedir();
}

export function batonHomeDir(env?: NodeJS.ProcessEnv): string {
  return path.join(hostHome(env), BATON_DIR);
}

export function canonicalWorkspaceRoot(cwd: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return fs.realpathSync(root);
  } catch {
    // Non-Git workspaces are keyed by their canonical cwd.
  }
  return fs.realpathSync(cwd);
}

export function workspaceId(cwd: string): string {
  return sha256Hex(canonicalWorkspaceRoot(cwd));
}

/** User-global runtime namespace for one canonical workspace. */
export function batonDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), WORKSPACES_DIR, workspaceId(cwd), CURRENT_RUNTIME_NAMESPACE);
}

export function configPath(_cwd: string, { env }: { env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(batonHomeDir(env), CONFIG_NAME);
}

export function skillPath(_cwd: string, { env }: { env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(batonHomeDir(env), SKILL_NAME);
}

export function spawnsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), SPAWNS_DIR);
}

export function runsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), RUNS_DIR);
}

export function compiledApplyRunsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(runsDir(cwd, env), COMPILED_APPLY_RUNS_DIR);
}

export function compiledApplyRunDir(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(compiledApplyRunsDir(cwd, env), compiledPathSegment("run id", runId));
}

export function compiledApplyRunStatePath(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(compiledApplyRunDir(cwd, runId, env), "state-v1.json");
}

export function compiledApplyRunBodyPath(cwd: string, runId: string, revision: string, env?: NodeJS.ProcessEnv): string {
  return path.join(compiledApplyRunDir(cwd, runId, env), "revisions", `revision-${compiledPathSegment("revision", revision)}.json`);
}

export function applyRunStateLockPath(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(compiledApplyRunsDir(cwd, env), ".run-state-v1.lock");
}

/** Root directory for rolling-run v2 state in one workspace. */
export function rollingRunsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(runsDir(cwd, env), ROLLING_RUNS_DIR);
}

/** Root directory for one rolling run. */
export function rollingRunRoot(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunsDir(cwd, env), rollingPathSegment("run id", runId));
}

/** Directory form for implementations that shard the append-only facts. */
export function rollingRunFactsDir(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_FACTS_DIR);
}

/** Canonical append-only fact log for one rolling run. */
export function rollingRunFactLogPath(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_FACT_LOG_NAME);
}

/** Alias used by callers that treat the append log as the run's facts path. */

/** Optional sharded fact path; the fact id is still a single safe segment. */
export function rollingRunFactPath(cwd: string, runId: string, factId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunFactsDir(cwd, runId, env), `${rollingPathSegment("fact id", factId)}.json`);
}

/** Directory containing immutable, accepted control documents. */
export function rollingRunAcceptedDocumentsDir(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_ACCEPTED_DOCUMENTS_DIR);
}

/** Canonical path for one immutable accepted document. */
export function rollingRunAcceptedDocumentPath(cwd: string, runId: string, documentId: string, env?: NodeJS.ProcessEnv): string {
  const id = rollingPathSegment("document id", documentId);
  if (id.startsWith("delta-")) throw new RollingRunPathError("document id", documentId);
  return path.join(rollingRunAcceptedDocumentsDir(cwd, runId, env), `${id}.json`);
}

/** Canonical path for a delta document, retaining the delta identity in its filename. */
export function rollingRunDeltaDocumentPath(cwd: string, runId: string, deltaId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunAcceptedDocumentsDir(cwd, runId, env), `delta-${rollingPathSegment("delta id", deltaId)}.json`);
}

/** Replaceable derived checkpoint for one rolling run. */
export function rollingRunCheckpointPath(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_CHECKPOINT_NAME);
}

/** Per-run lock guarding append/checkpoint updates. */
export function rollingRunLockPath(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_LOCK_NAME);
}

/** Baton-owned detached worktrees for one rolling run. */
export function rollingRunWorktreesDir(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_WORKTREES_DIR);
}

/** One attempt namespace. Every externally supplied component is one segment. */
export function worktreeAttemptDir(
  cwd: string,
  runId: string,
  unitKey: string,
  attemptId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(
    rollingRunWorktreesDir(cwd, runId, env),
    rollingPathSegment("unit key", unitKey),
    rollingPathSegment("attempt id", attemptId),
  );
}

/** The exact directory that may later be registered as a detached Git worktree. */
export function worktreeExecutionRootPath(
  cwd: string,
  runId: string,
  unitKey: string,
  attemptId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(worktreeAttemptDir(cwd, runId, unitKey, attemptId, env), WORKTREE_EXECUTION_ROOT_DIR);
}

/** Version-1 lifecycle record for one worktree attempt. */
export function worktreeRecordPath(
  cwd: string,
  runId: string,
  unitKey: string,
  attemptId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(worktreeAttemptDir(cwd, runId, unitKey, attemptId, env), WORKTREE_RECORD_NAME);
}

export function rollingRunSnapshotsDir(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_SNAPSHOTS_DIR);
}

export function snapshotManifestPath(cwd: string, runId: string, snapshotId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(
    rollingRunSnapshotsDir(cwd, runId, env),
    rollingPathSegment("snapshot id", snapshotId),
    SNAPSHOT_MANIFEST_NAME,
  );
}

export function rollingRunBundlesDir(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_BUNDLES_DIR);
}

export function bundleManifestPath(cwd: string, runId: string, bundleId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(
    rollingRunBundlesDir(cwd, runId, env),
    rollingPathSegment("bundle id", bundleId),
    BUNDLE_MANIFEST_NAME,
  );
}

export function rollingRunIntegrationsDir(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(rollingRunRoot(cwd, runId, env), ROLLING_INTEGRATIONS_DIR);
}

/** One repository-local serialization namespace inside a rolling run. */
export function integrationRepositoryDir(
  cwd: string,
  runId: string,
  repositoryId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(
    rollingRunIntegrationsDir(cwd, runId, env),
    rollingPathSegment("repository id", repositoryId),
  );
}

/** Lock guarding queue-position assignment and one-at-a-time begin transitions. */
export function integrationQueueLockPath(
  cwd: string,
  runId: string,
  repositoryId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(integrationRepositoryDir(cwd, runId, repositoryId, env), ".queue-v1.lock");
}

/** Workspace-local, cross-run serialization lock for one repository target. */
export function integrationDestinationLockPath(
  cwd: string,
  repositoryId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(
    runsDir(cwd, env),
    ROLLING_INTEGRATION_DESTINATIONS_DIR,
    rollingPathSegment("repository id", repositoryId),
    ".begin-v1.lock",
  );
}

export function integrationRecordPath(
  cwd: string,
  runId: string,
  repositoryId: string,
  integrationId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(
    integrationRepositoryDir(cwd, runId, repositoryId, env),
    rollingPathSegment("integration id", integrationId),
    INTEGRATION_RECORD_NAME,
  );
}

// Compact aliases for callers that already operate inside a rolling run.

// Keep the vocabulary close to the existing compiled-apply helpers for callers
// that use "dir" or "document" rather than "root" or "accepted document".

export function selectionsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), SELECTIONS_DIR);
}

export function receiptsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), RECEIPTS_DIR);
}

export function hostRouteSnapshotPath(_cwd: string, host: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), CACHE_DIR, hostRouteSnapshotName(host));
}

export function routeHealthPath(_cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), CACHE_DIR, ROUTE_HEALTH_NAME);
}

/** Global durable model availability, shared by projects and sessions. */
export function modelAvailabilityPath(_cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), STATE_DIR, MODEL_AVAILABILITY_NAME);
}

/** Dispatcher runtime state (remembered capacity) for one workspace. */
export function hostDispatchStatePath(cwd: string, host: string, env?: NodeJS.ProcessEnv): string {
  return path.join(runsDir(cwd, env), hostDispatchStateName(host));
}

export function dispatchLockPath(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), TMP_DIR, "dispatch.lock");
}

/** Shared reservation boundary for one canonical workspace. */
export function activationLockPath(cwd: string, env?: NodeJS.ProcessEnv, host?: string): string {
  const suffix = host ? `activation-${String(host).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-") || "unknown"}.lock` : "activation.lock";
  return path.join(batonDir(cwd, env), TMP_DIR, suffix);
}

/** Host-scoped global reservation lock. Cross-project operations share a
 * single ordering boundary per invoking CLI. */
export function globalActivationLockPath(host: string, env?: NodeJS.ProcessEnv): string {
  const normalized = String(host || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-") || "unknown";
  return path.join(batonHomeDir(env), STATE_DIR, `activation-${normalized}.lock`);
}

export function packageRoot(): string {
  const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (path.basename(candidate) === "dist") {
    const parent = path.dirname(candidate);
    if (fs.existsSync(path.join(parent, "package.json"))) return parent;
  }
  return candidate;
}

export function displayHomePath(dest: string, { cwd, env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const home = hostHome(env);
  if (home) {
    const fromHome = path.relative(home, dest);
    if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
      return `~/${fromHome.replaceAll("\\", "/")}`;
    }
  }
  if (cwd) return path.relative(cwd, dest) || dest;
  return dest;
}
