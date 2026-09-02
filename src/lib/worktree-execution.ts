/**
 * Versioned control-plane records for isolated worktree execution.
 *
 * This foundation deliberately does not create or remove Git worktrees. It
 * defines the immutable mode gate, durable record contracts, and the atomic,
 * idempotent transition primitive used by later setup/audit/integration code.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  resolveWorktreeExecutionMode,
  type RollingValidationResult,
  type WorktreeExecutionMode,
} from "./rolling-plan.js";
import {
  bundleManifestPath,
  integrationRecordPath,
  snapshotManifestPath,
  worktreeExecutionRootPath,
  worktreeRecordPath,
} from "./paths.js";
import type { SafetyOperation } from "./safety.js";
import { canonicalizeJson, fingerprintJson, writeBytesAtomic } from "./json-utils.js";
import { isNonBlankString, isRecord } from "./validate-utils.js";
import {
  ALLOWED_TRANSITIONS,
  ID,
  LIFECYCLE_STATES,
  PHASES,
  assertChangeBundleManifest,
  assertIntegrationRecord,
  assertSnapshotManifest,
  assertWorktreeRecord,
  canonicalizeWorktreeExecution,
  fingerprintWorktreeRuntimeRecord,
  now,
  parseChangeBundleManifest,
  parseIntegrationRecord,
  parseSnapshotManifest,
  parseWorktreeRecord,
  withFingerprint
} from "./worktree-execution-validation.js";
import {
  CLEANUP_STATE_SCHEMA_VERSION,
  ChangeBundleManifest,
  CreateWorktreeRecordInput,
  IntegrationRecord,
  SnapshotManifest,
  WORKTREE_RECORD_SCHEMA_VERSION,
  WorktreeExecutionError,
  WorktreeRecord,
  WorktreeSetupState,
  WorktreeTransitionInput
} from "./worktree-execution-types.js";

type AnyRecord = Record<string, unknown>;

export function initializeWorktreeRecord(input: CreateWorktreeRecordInput): WorktreeRecord {
  const createdAt = now(input.created_at);
  const value = withFingerprint<WorktreeRecord>({
    schema_version: WORKTREE_RECORD_SCHEMA_VERSION,
    record_id: input.record_id || `${input.run_id}:${input.unit_key}:${input.attempt_id}`,
    revision: 0,
    execution_mode: input.execution_mode || "isolated-worktree",
    repository_id: input.repository_id,
    repository_root: path.resolve(input.repository_root),
    git_common_dir: path.resolve(input.git_common_dir),
    git_common_dir_identity: input.git_common_dir_identity,
    execution_root: path.resolve(input.execution_root),
    base_tree: input.base_tree,
    run_id: input.run_id,
    unit_key: input.unit_key,
    unit_version: input.unit_version,
    attempt_id: input.attempt_id,
    setup_state: "planned",
    setup_failure: null,
    lifecycle_state: "preparing",
    native_handle: null,
    bundle_id: null,
    integration_id: null,
    retention_reasons: [],
    cleanup: { schema_version: CLEANUP_STATE_SCHEMA_VERSION, status: "retained", attempts: 0, updated_at: createdAt },
    transition_log: [],
    created_at: createdAt,
    updated_at: createdAt,
  } as Omit<WorktreeRecord, "fingerprint">);
  return assertWorktreeRecord(value);
}


function transitionPayload(input: WorktreeTransitionInput): string {
  const { expected_revision: _expected, recorded_at: _recorded, ...semantic } = input;
  return fingerprintWorktreeRuntimeRecord(semantic);
}

function setupRank(value: WorktreeSetupState): number {
  return ["planned", "registering", "registered", "verified", "failed"].indexOf(value);
}

export function applyWorktreeLifecycleTransition(recordInput: WorktreeRecord, input: WorktreeTransitionInput): WorktreeRecord {
  const record = assertWorktreeRecord(recordInput);
  if (input.expected_revision !== undefined && input.expected_revision !== record.revision) {
    throw new WorktreeExecutionError(`expected revision ${input.expected_revision}, found ${record.revision}`, "WORKTREE_REVISION_MISMATCH");
  }
  if (!ID.test(input.idempotency_key)) throw new WorktreeExecutionError("transition idempotency_key is invalid", "WORKTREE_TRANSITION_INVALID");
  if (!PHASES.has(input.phase) || !LIFECYCLE_STATES.has(input.to_state)) throw new WorktreeExecutionError("transition phase or state is unsupported", "WORKTREE_TRANSITION_INVALID");
  const payloadFingerprint = transitionPayload(input);
  const replay = record.transition_log.find((transition) => transition.idempotency_key === input.idempotency_key);
  if (replay) {
    if (replay.payload_fingerprint !== payloadFingerprint) throw new WorktreeExecutionError(`idempotency key ${input.idempotency_key} was already used for another transition`, "WORKTREE_IDEMPOTENCY_CONFLICT");
    return record;
  }

  const sameStateSetup = input.phase === "setup" && input.to_state === record.lifecycle_state && input.setup_state !== undefined;
  const sameStateCleanup = input.phase === "cleanup" && input.to_state === record.lifecycle_state && input.cleanup !== undefined;
  if (!sameStateSetup && !sameStateCleanup && !ALLOWED_TRANSITIONS.has(`${record.lifecycle_state}>${input.to_state}`)) {
    throw new WorktreeExecutionError(`illegal lifecycle transition ${record.lifecycle_state} -> ${input.to_state}`, "WORKTREE_TRANSITION_INVALID");
  }
  if (input.phase === "setup") {
    if (record.lifecycle_state !== "preparing" || !input.setup_state || setupRank(input.setup_state) <= setupRank(record.setup_state)) {
      throw new WorktreeExecutionError("setup transitions must advance setup_state while preparing", "WORKTREE_TRANSITION_INVALID");
    }
  } else if (input.setup_state !== undefined && input.setup_state !== record.setup_state) {
    throw new WorktreeExecutionError("only setup transitions may change setup_state", "WORKTREE_TRANSITION_INVALID");
  }
  if (input.to_state === "worker_active" && (input.setup_state || record.setup_state) !== "verified") {
    throw new WorktreeExecutionError("a worker cannot become active before setup is verified", "WORKTREE_TRANSITION_INVALID");
  }
  if (input.to_state === "cleanup_eligible" && (input.retention_reasons || record.retention_reasons).length > 0) {
    throw new WorktreeExecutionError("cleanup cannot become eligible while retention reasons remain", "WORKTREE_TRANSITION_INVALID");
  }

  const recordedAt = now(input.recorded_at);
  const next = structuredClone(record);
  next.revision += 1;
  next.lifecycle_state = input.to_state;
  if (input.setup_state !== undefined) next.setup_state = input.setup_state;
  if (Object.prototype.hasOwnProperty.call(input, "setup_failure")) next.setup_failure = input.setup_failure ? structuredClone(input.setup_failure) : null;
  if (next.setup_state === "failed" && next.setup_failure === null) {
    throw new WorktreeExecutionError("failed setup transitions require a durable diagnostic", "WORKTREE_TRANSITION_INVALID");
  }
  if (Object.prototype.hasOwnProperty.call(input, "native_handle")) next.native_handle = input.native_handle ?? null;
  if (Object.prototype.hasOwnProperty.call(input, "bundle_id")) next.bundle_id = input.bundle_id ?? null;
  if (Object.prototype.hasOwnProperty.call(input, "integration_id")) next.integration_id = input.integration_id ?? null;
  if (input.retention_reasons !== undefined) next.retention_reasons = [...new Set(input.retention_reasons)].sort();
  if (input.cleanup !== undefined) next.cleanup = structuredClone(input.cleanup);
  next.transition_log.push({
    sequence: record.transition_log.length,
    idempotency_key: input.idempotency_key,
    phase: input.phase,
    from_state: record.lifecycle_state,
    to_state: input.to_state,
    payload_fingerprint: payloadFingerprint,
    recorded_at: recordedAt,
  });
  next.updated_at = recordedAt;
  next.fingerprint = fingerprintWorktreeRuntimeRecord(next);
  return assertWorktreeRecord(next);
}

/** Confirm that dispatch is both rolling-v2 and explicitly isolated. */
export function assertIsolatedWorktreeExecution(runState: unknown, unitMode?: WorktreeExecutionMode): "isolated-worktree" {
  const mode = resolveWorktreeExecutionMode(runState, unitMode);
  if (mode !== "isolated-worktree") throw new WorktreeExecutionError("isolated worktree execution is not enabled for this run", "ISOLATED_WORKTREE_REQUIRED");
  return mode;
}

function atomicBytes(file: string, bytes: Buffer): void {
  writeBytesAtomic(file, bytes, { fsyncDirectory: true });
}

function atomicJson(file: string, value: unknown): void {
  atomicBytes(file, Buffer.from(`${canonicalizeWorktreeExecution(value)}\n`, "utf8"));
}

interface AtomicCandidate<T> { file: string; value: T; revision: number; fingerprint: string; primary: boolean }

function candidateFiles(file: string): string[] {
  const parent = path.dirname(file);
  const base = path.basename(file);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent)
    .filter((name) => name === base || name.startsWith(`${base}.tmp-`))
    .map((name) => path.join(parent, name));
}

function recoverAtomicRecord<T extends { fingerprint: string }>(
  file: string,
  parser: (textValue: string) => T,
  identity: (value: T) => string,
  revision: (value: T) => number,
  expectedIdentity?: string,
  extendsPrimary?: (primary: T, candidate: T) => boolean,
): T {
  const files = candidateFiles(file);
  if (files.length === 0) throw new WorktreeExecutionError(`runtime record is missing: ${file}`, "WORKTREE_RECORD_MISSING");
  const candidates: AtomicCandidate<T>[] = [];
  for (const candidate of files) {
    try {
      const value = parser(fs.readFileSync(candidate, "utf8"));
      if (expectedIdentity !== undefined && identity(value) !== expectedIdentity) continue;
      candidates.push({ file: candidate, value, revision: revision(value), fingerprint: value.fingerprint, primary: candidate === file });
    } catch { /* A valid sibling temp may recover an interrupted primary. */ }
  }
  if (candidates.length === 0) throw new WorktreeExecutionError(`runtime record is corrupt and has no valid atomic candidate: ${file}`, "WORKTREE_RECORD_CORRUPT");
  const primary = candidates.find((candidate) => candidate.primary);
  if (primary !== undefined && extendsPrimary !== undefined && candidates.some(
    (candidate) => candidate.revision > primary.revision && !extendsPrimary(primary.value, candidate.value),
  )) {
    throw new WorktreeExecutionError(`atomic candidate does not extend the persisted record: ${file}`, "WORKTREE_RECORD_CONFLICT");
  }
  candidates.sort((left, right) => right.revision - left.revision || Number(right.primary) - Number(left.primary) || left.file.localeCompare(right.file));
  const selected = candidates[0]!;
  const sameRevision = candidates.filter((candidate) => candidate.revision === selected.revision);
  if (sameRevision.some((candidate) => candidate.fingerprint !== selected.fingerprint)) {
    throw new WorktreeExecutionError(`conflicting atomic candidates exist for ${file}`, "WORKTREE_RECORD_CONFLICT");
  }
  if (!selected.primary) {
    try { fs.renameSync(selected.file, file); }
    catch (cause) {
      try {
        const promoted = parser(fs.readFileSync(file, "utf8"));
        if (promoted.fingerprint === selected.fingerprint) return selected.value;
      } catch { /* The original rename failure remains authoritative. */ }
      throw cause;
    }
  }
  return selected.value;
}

function recordIdentity(record: WorktreeRecord): string {
  return `${record.run_id}\u0000${record.unit_key}\u0000${record.attempt_id}`;
}

function expectedRecordIdentity(runId: string, unitKey: string, attemptId: string): string {
  return `${runId}\u0000${unitKey}\u0000${attemptId}`;
}

const WORKTREE_IMMUTABLE_FIELDS = [
  "record_id",
  "execution_mode",
  "repository_id",
  "repository_root",
  "git_common_dir",
  "git_common_dir_identity",
  "execution_root",
  "base_tree",
  "run_id",
  "unit_key",
  "unit_version",
  "attempt_id",
  "created_at",
] as const satisfies readonly (keyof WorktreeRecord)[];

function extendsWorktreeRecord(current: WorktreeRecord, candidate: WorktreeRecord): boolean {
  return WORKTREE_IMMUTABLE_FIELDS.every((field) => candidate[field] === current[field])
    && canonicalizeWorktreeExecution(candidate.transition_log.slice(0, current.transition_log.length))
      === canonicalizeWorktreeExecution(current.transition_log);
}

export function readPersistedWorktreeRecord(
  cwd: string,
  runId: string,
  unitKey: string,
  attemptId: string,
  env?: NodeJS.ProcessEnv,
): WorktreeRecord {
  const file = worktreeRecordPath(cwd, runId, unitKey, attemptId, env);
  return recoverAtomicRecord(
    file,
    parseWorktreeRecord,
    recordIdentity,
    (value) => value.revision,
    expectedRecordIdentity(runId, unitKey, attemptId),
    extendsWorktreeRecord,
  );
}

export function persistWorktreeRecord(cwd: string, recordInput: WorktreeRecord, env?: NodeJS.ProcessEnv): WorktreeRecord {
  const record = assertWorktreeRecord(recordInput);
  const expectedRoot = path.resolve(worktreeExecutionRootPath(cwd, record.run_id, record.unit_key, record.attempt_id, env));
  if (path.resolve(record.execution_root) !== expectedRoot) throw new WorktreeExecutionError("worktree execution_root does not match its safe runtime path", "WORKTREE_IDENTITY_MISMATCH");
  const file = worktreeRecordPath(cwd, record.run_id, record.unit_key, record.attempt_id, env);
  if (candidateFiles(file).length > 0) {
    const current = readPersistedWorktreeRecord(cwd, record.run_id, record.unit_key, record.attempt_id, env);
    if (current.fingerprint === record.fingerprint) return current;
    if (record.revision !== current.revision + 1) throw new WorktreeExecutionError(`record revision ${record.revision} does not follow ${current.revision}`, "WORKTREE_REVISION_MISMATCH");
    if (!WORKTREE_IMMUTABLE_FIELDS.every((field) => record[field] === current[field])) {
      throw new WorktreeExecutionError("worktree identity changed across persisted revisions", "WORKTREE_IDENTITY_MISMATCH");
    }
    if (!extendsWorktreeRecord(current, record)) throw new WorktreeExecutionError("worktree transition history does not extend the persisted record", "WORKTREE_RECORD_CONFLICT");
  } else if (record.revision !== 0) {
    throw new WorktreeExecutionError("the first persisted worktree record must have revision zero", "WORKTREE_REVISION_MISMATCH");
  }
  atomicJson(file, record);
  return record;
}

export function transitionPersistedWorktreeRecord(
  cwd: string,
  runId: string,
  unitKey: string,
  attemptId: string,
  transition: WorktreeTransitionInput,
  env?: NodeJS.ProcessEnv,
): WorktreeRecord {
  const current = readPersistedWorktreeRecord(cwd, runId, unitKey, attemptId, env);
  const next = applyWorktreeLifecycleTransition(current, transition);
  if (next.fingerprint === current.fingerprint) return current;
  return persistWorktreeRecord(cwd, next, env);
}

function persistImmutable<T extends { fingerprint: string }>(
  file: string,
  value: T,
  parser: (textValue: string) => T,
  identity: (record: T) => string,
): T {
  if (candidateFiles(file).length > 0) {
    const current = recoverAtomicRecord(file, parser, identity, () => 0, identity(value));
    if (current.fingerprint === value.fingerprint) return current;
    throw new WorktreeExecutionError(`immutable runtime record already exists with different content: ${file}`, "WORKTREE_IDEMPOTENCY_CONFLICT");
  }
  atomicJson(file, value);
  return value;
}

export function persistSnapshotManifest(cwd: string, runId: string, input: SnapshotManifest, env?: NodeJS.ProcessEnv): SnapshotManifest {
  const value = assertSnapshotManifest(input);
  return persistImmutable(snapshotManifestPath(cwd, runId, value.snapshot_id, env), value, parseSnapshotManifest, (record) => record.snapshot_id);
}

export function readPersistedSnapshotManifest(cwd: string, runId: string, snapshotId: string, env?: NodeJS.ProcessEnv): SnapshotManifest {
  return recoverAtomicRecord(snapshotManifestPath(cwd, runId, snapshotId, env), parseSnapshotManifest, (record) => record.snapshot_id, () => 0, snapshotId);
}

export function persistChangeBundleManifest(cwd: string, runId: string, input: ChangeBundleManifest, env?: NodeJS.ProcessEnv): ChangeBundleManifest {
  const value = assertChangeBundleManifest(input);
  if (value.run_id !== runId) throw new WorktreeExecutionError("bundle run identity does not match its path", "WORKTREE_IDENTITY_MISMATCH");
  return persistImmutable(bundleManifestPath(cwd, runId, value.bundle_id, env), value, parseChangeBundleManifest, (record) => record.bundle_id);
}

export function readPersistedChangeBundleManifest(cwd: string, runId: string, bundleId: string, env?: NodeJS.ProcessEnv): ChangeBundleManifest {
  return recoverAtomicRecord(bundleManifestPath(cwd, runId, bundleId, env), parseChangeBundleManifest, (record) => record.bundle_id, () => 0, bundleId);
}

export function persistIntegrationRecord(cwd: string, input: IntegrationRecord, env?: NodeJS.ProcessEnv): IntegrationRecord {
  const value = assertIntegrationRecord(input);
  const file = integrationRecordPath(cwd, value.run_id, value.repository_id, value.integration_id, env);
  if (candidateFiles(file).length > 0) {
    const current = recoverAtomicRecord(
      file,
      parseIntegrationRecord,
      (record) => record.integration_id,
      (record) => record.revision,
      value.integration_id,
      extendsIntegrationRecord,
    );
    if (current.fingerprint === value.fingerprint) return current;
    if (value.revision !== current.revision + 1) throw new WorktreeExecutionError(`integration revision ${value.revision} does not follow ${current.revision}`, "WORKTREE_REVISION_MISMATCH");
    if (!extendsIntegrationRecord(current, value)) {
      throw new WorktreeExecutionError("integration update changes immutable lineage or does not extend its transaction", "WORKTREE_RECORD_CONFLICT");
    }
  } else if (value.revision !== 0) throw new WorktreeExecutionError("the first integration record must have revision zero", "WORKTREE_REVISION_MISMATCH");
  atomicJson(file, value);
  return value;
}

const INTEGRATION_IMMUTABLE_FIELDS = [
  "integration_id",
  "run_id",
  "repository_id",
  "git_common_dir_identity",
  "bundle_id",
  "queue_position",
  "before_tree",
  "created_at",
] as const satisfies readonly (keyof IntegrationRecord)[];

const INTEGRATION_STATE_TRANSITIONS = new Set<string>([
  "integrating>integrating",
  "queued>integrating",
  "queued>failed",
  "integrating>awaiting_parent_resolution",
  "integrating>integrated",
  "integrating>failed",
  "awaiting_parent_resolution>integrated",
  "awaiting_parent_resolution>failed",
  "integrated>integrated",
  "integrated>accepted",
  "integrated>failed",
]);

function extendsIntegrationRecord(current: IntegrationRecord, candidate: IntegrationRecord): boolean {
  return INTEGRATION_IMMUTABLE_FIELDS.every((field) => candidate[field] === current[field])
    && candidate.idempotency_keys.length > current.idempotency_keys.length
    && canonicalizeWorktreeExecution(candidate.idempotency_keys.slice(0, current.idempotency_keys.length))
      === canonicalizeWorktreeExecution(current.idempotency_keys)
    && (!current.authorization || candidate.authorization?.fingerprint === current.authorization.fingerprint)
    && (!current.queue_order || candidate.queue_order?.fingerprint === current.queue_order.fingerprint)
    && (!current.application || candidate.application?.fingerprint === current.application.fingerprint)
    && (!current.resolution || candidate.resolution?.fingerprint === current.resolution.fingerprint)
    && (!current.acceptance || candidate.acceptance?.fingerprint === current.acceptance.fingerprint)
    && (`${current.state}>${candidate.state}` !== "integrating>integrating"
      || (current.application === undefined && candidate.application !== undefined))
    && (`${current.state}>${candidate.state}` !== "integrated>integrated"
      || (current.acceptance === undefined && candidate.acceptance !== undefined))
    && INTEGRATION_STATE_TRANSITIONS.has(`${current.state}>${candidate.state}`);
}

export function readPersistedIntegrationRecord(
  cwd: string,
  runId: string,
  repositoryId: string,
  integrationId: string,
  env?: NodeJS.ProcessEnv,
): IntegrationRecord {
  return recoverAtomicRecord(
    integrationRecordPath(cwd, runId, repositoryId, integrationId, env),
    parseIntegrationRecord,
    (record) => `${record.run_id}\u0000${record.repository_id}\u0000${record.integration_id}`,
    (record) => record.revision,
    `${runId}\u0000${repositoryId}\u0000${integrationId}`,
    extendsIntegrationRecord,
  );
}

export { resolveWorktreeExecutionMode };
export type { WorktreeExecutionMode };

export * from "./worktree-execution-types.js";
export * from "./worktree-execution-validation.js";
