/**
 * Durable storage for the source-neutral rolling execution protocol.
 *
 * The log is the authority.  `checkpoint.json` is only a deterministic cache
 * and may always be deleted and rebuilt.  Accepted control documents are
 * immutable snapshots; a document becomes accepted only when a corresponding
 * fact has reached the log.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertPlanDelta,
  assertTaskSeal,
  assertTaskSourceDescriptor,
  canonicalizeRolling,
  fingerprintGateVersion,
  fingerprintPlanDelta,
  fingerprintTaskSeal,
  fingerprintTaskSourceDescriptor,
  fingerprintUnitVersion,
  type PlanDelta,
  type TaskManifestEntry,
  type TaskSeal,
  type TaskSourceDescriptor,
  type WorktreeExecutionMode,
} from "./rolling-plan.js";
import {
  validatePlanDeltaAgainstFacts,
  type PlanDeltaValidationContext,
} from "./rolling-delta.js";
import {
  deriveRollingLifecycle,
  validateTaskSealAgainstFacts,
  type RollingTaskLifecycle,
  type RollingTaskLifecycleState,
  type RollingTaskStatus,
} from "./rolling-lifecycle.js";
import {
  rollingRunAcceptedDocumentPath,
  rollingRunCheckpointPath,
  rollingRunDeltaDocumentPath,
  rollingRunFactLogPath,
  rollingRunLockPath,
  rollingRunRoot,
} from "./paths.js";
import { withOwnedLock } from "./owned-lock.js";
import { sessionUidFromEnv, validateSessionScope } from "./session-scope.js";
import { readApplyRun, statusApplyRun, type ApplyRunState, type ApplyRunStatusReport } from "./apply-run.js";
import { readJsonFile, sha256Hex, writeBytesAtomic } from "./json-utils.js";
import {
  appendInput,
  appendLocked
} from "./rolling-run-append.js";
import {
  RollingRunError,
  atomicJson,
  derive,
  documentFingerprint,
  error,
  factFingerprint,
  identityFromInput,
  now,
  parseFacts,
  readIdentityFromFacts,
  requireFactDocuments,
  sourceDocument,
  sourceDocumentId,
  sourceOf,
  writeCheckpoint,
  writeFacts
} from "./rolling-run-store.js";

export const ROLLING_RUN_SCHEMA_VERSION = 2 as const;
export const ROLLING_FACT_SCHEMA_VERSION = 2 as const;
export const ROLLING_CHECKPOINT_SCHEMA_VERSION = 2 as const;
export const ROLLING_RUN_LOCK_OPERATION = "rolling-run-append" as const;

export type RollingFactKind = "source" | "delta" | "seal" | string;

export interface RollingRunIdentity {
  run_id: string;
  host: string;
  adapter: string;
  source_kind: string;
  execution_mode: string;
  session_uid: string;
}

export interface RollingFact {
  schema_version: typeof ROLLING_FACT_SCHEMA_VERSION;
  append_sequence: number;
  fact_id: string;
  idempotency_key: string;
  kind: RollingFactKind;
  document_id: string;
  document_fingerprint: string;
  payload_fingerprint: string;
  payload: unknown;
  recorded_at: string;
  fingerprint: string;
}

export interface RollingCheckpoint {
  schema_version: typeof ROLLING_CHECKPOINT_SCHEMA_VERSION;
  identity: RollingRunIdentity;
  append_sequence: number;
  fact_ids: string[];
  facts: RollingFact[];
  manifest_entries: TaskManifestEntry[];
  accepted_deltas: PlanDelta[];
  seals: TaskSeal[];
  updated_at: string;
}

export type RollingExecutionRun = RollingCheckpoint;

export interface RollingRunCreateInput {
  cwd: string;
  runId: string;
  host: string;
  adapter?: string;
  source_kind?: string;
  execution_mode?: string;
  session_uid?: string;
  source?: TaskSourceDescriptor;
  source_descriptor?: TaskSourceDescriptor;
  env?: NodeJS.ProcessEnv;
  now?: string | number | Date;
}

export interface RollingRunAppendInput {
  cwd: string;
  runId: string;
  env?: NodeJS.ProcessEnv;
  host?: string;
  session_uid?: string;
  expected_append_sequence?: number;
  append_sequence?: number;
  fact?: Partial<RollingFact> & { kind?: RollingFactKind; payload?: unknown };
  kind?: RollingFactKind;
  idempotency_key?: string;
  fact_id?: string;
  document_id?: string;
  document?: unknown;
  payload?: unknown;
  now?: string | number | Date;
}

export interface RollingPlanDeltaAppendInput extends Omit<RollingRunAppendInput, "fact" | "kind" | "payload" | "document" | "idempotency_key" | "document_id"> {
  delta: PlanDelta;
}

export interface RollingRunReadOptions { env?: NodeJS.ProcessEnv; host?: string; session_uid?: string; rebuild_checkpoint?: boolean; }

export function createRollingExecutionRun(input: RollingRunCreateInput): RollingCheckpoint {
  const env = input.env || process.env;
  const source = sourceDocument(sourceOf(input));
  const identity = identityFromInput(input, source);
  const root = rollingRunRoot(input.cwd, input.runId, env);
  return withOwnedLock(rollingRunLockPath(input.cwd, input.runId, env), () => {
    if (fs.existsSync(rollingRunCheckpointPath(input.cwd, input.runId, env)) || fs.existsSync(rollingRunFactLogPath(input.cwd, input.runId, env))) error(`rolling run already exists: ${input.runId}`, "ROLLING_RUN_ALREADY_EXISTS");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const sourcePayload = { ...source, __run_identity: identity };
    const sourceId = sourceDocumentId(source);
    const factInput = { kind: "source", idempotency_key: `source:${sourceId}`, fact_id: `source:${sourceId}`, document_id: sourceId, payload: sourcePayload, document: source };
    const fact: Omit<RollingFact, "fingerprint"> = { schema_version: ROLLING_FACT_SCHEMA_VERSION, append_sequence: 0, fact_id: factInput.fact_id, idempotency_key: factInput.idempotency_key, kind: "source", document_id: sourceId, document_fingerprint: documentFingerprint(source), payload_fingerprint: documentFingerprint(sourcePayload), payload: sourcePayload, recorded_at: now(input.now) };
    const accepted: RollingFact = { ...fact, fingerprint: factFingerprint(fact) };
    try {
      atomicJson(rollingRunAcceptedDocumentPath(input.cwd, input.runId, sourceId, env), source);
      writeFacts(input.cwd, input.runId, [accepted], env);
      const checkpoint = derive(identity, [accepted]);
      writeCheckpoint(input.cwd, input.runId, checkpoint, env);
      return checkpoint;
    } catch (cause) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* scoped cleanup */ }
      throw cause;
    }
  }, { operation: ROLLING_RUN_LOCK_OPERATION });
}


export function appendRollingFact(input: RollingRunAppendInput): RollingCheckpoint {
  return withOwnedLock(rollingRunLockPath(input.cwd, input.runId, input.env), () => appendLocked(input, appendInput(input)), { operation: ROLLING_RUN_LOCK_OPERATION });
}

export function appendRollingPlanDelta(input: RollingPlanDeltaAppendInput): RollingCheckpoint {
  const delta = assertPlanDelta(input.delta);
  const copied = structuredClone(delta) as PlanDelta;
  if (!copied.fingerprint) copied.fingerprint = fingerprintPlanDelta(copied);
  return appendRollingFact({ ...input, kind: "delta", idempotency_key: `delta:${copied.delta_id}`, document_id: `delta-${copied.delta_id}`, payload: copied, document: copied });
}

export function appendRollingSeal(input: RollingRunAppendInput & { seal: TaskSeal }): RollingCheckpoint {
  let seal: TaskSeal;
  try { seal = assertTaskSeal(input.seal); }
  catch (cause) {
    const diagnostics = (cause as { diagnostics?: readonly { code: string; message: string; path?: string; refs?: string[] }[] }).diagnostics;
    throw new RollingRunError(`invalid rolling seal: ${(cause as Error).message}`, "ROLLING_SEAL_INVALID", false, diagnostics);
  }
  const copied = structuredClone(seal) as TaskSeal;
  if (!copied.fingerprint) copied.fingerprint = fingerprintTaskSeal(copied);
  const sourceIdentity = copied.source_fingerprint;
  return appendRollingFact({
    ...input,
    kind: "seal",
    idempotency_key: `seal:${copied.task_key}:${sourceIdentity}`,
    document_id: `seal-${copied.task_key}-${sourceIdentity}`,
    payload: copied,
    document: copied,
  });
}

export function rebuildRollingRunCheckpoint(cwd: string, runId: string, options: RollingRunReadOptions = {}): RollingCheckpoint {
  const env = options.env || process.env;
  return withOwnedLock(rollingRunLockPath(cwd, runId, env), () => {
    const identity = readIdentityFromFacts(cwd, runId, env);
    const facts = parseFacts(cwd, runId, env);
    requireFactDocuments(cwd, runId, facts, env);
    const checkpoint = derive(identity, facts);
    writeCheckpoint(cwd, runId, checkpoint, env);
    return checkpoint;
  }, { operation: ROLLING_RUN_LOCK_OPERATION });
}

export function readRollingExecutionRun(cwd: string, runId: string, options: RollingRunReadOptions = {}): RollingCheckpoint {
  const env = options.env || process.env;
  const identity = readIdentityFromFacts(cwd, runId, env);
  if (options.host !== undefined && options.host !== identity.host) error("rolling run host does not match state", "ROLLING_HOST_MISMATCH");
  if (options.session_uid !== undefined && options.session_uid !== identity.session_uid) error("rolling run session does not match state", "ROLLING_SESSION_MISMATCH");
  if (env.BATON_SESSION_ID) {
    try { validateSessionScope(identity.session_uid, env); } catch (cause) { throw new RollingRunError((cause as Error).message, "ROLLING_SESSION_MISMATCH"); }
  }
  const facts = parseFacts(cwd, runId, env);
  requireFactDocuments(cwd, runId, facts, env);
  const checkpoint = derive(identity, facts);
  const checkpointFile = rollingRunCheckpointPath(cwd, runId, env);
  if (options.rebuild_checkpoint !== false) {
    try {
      const cached = fs.existsSync(checkpointFile) ? readJsonFile(checkpointFile) as RollingCheckpoint : undefined;
      if (!cached || cached.append_sequence !== checkpoint.append_sequence || cached.fact_ids.join("\u0000") !== checkpoint.fact_ids.join("\u0000")) writeCheckpoint(cwd, runId, checkpoint, env);
    } catch { writeCheckpoint(cwd, runId, checkpoint, env); }
  }
  return checkpoint;
}

export interface RollingRunStatus extends RollingCheckpoint {
  status: RollingTaskLifecycleState;
  /** Phase-1 compatibility map: an open task is still spelled `planned`. */
  task_status: Record<string, RollingTaskStatus>;
  /** Source-neutral lifecycle projection for rolling callers. */
  task_lifecycle: Record<string, RollingTaskLifecycle>;
  lifecycle_status: Record<string, RollingTaskLifecycleState>;
  task_states: Record<string, RollingTaskLifecycleState>;
}
export function statusRollingExecutionRun(cwd: string, runId: string, options: RollingRunReadOptions = {}): RollingRunStatus {
  const run = readRollingExecutionRun(cwd, runId, options);
  const lifecycle = deriveRollingLifecycle({
    manifest_entries: run.manifest_entries,
    accepted_deltas: run.accepted_deltas,
    seals: run.seals,
    facts: run.facts,
  });
  return {
    ...run,
    status: lifecycle.status,
    task_status: lifecycle.task_status,
    task_lifecycle: lifecycle.task_lifecycle,
    lifecycle_status: lifecycle.lifecycle_status,
    task_states: lifecycle.task_states,
  };
}

export interface LegacyCompiledRunStatus {
  schema_version: 1;
  run_id: string;
  legacy: true;
  read_only: true;
  status: ApplyRunStatusReport["status"];
  historical_state: ApplyRunStatusReport;
  state: ApplyRunState;
}

/** Read-only compatibility view. It deliberately delegates to v1 public APIs. */
export function normalizeLegacyCompiledRunStatus(cwd: string, runId: string, options: { env?: NodeJS.ProcessEnv; ticket_facts?: Parameters<typeof readApplyRun>[2]["ticket_facts"] } = {}): LegacyCompiledRunStatus {
  try {
    const state = readApplyRun(cwd, runId, { env: options.env, ticket_facts: options.ticket_facts });
    const historical_state = statusApplyRun(cwd, runId, { env: options.env, ticket_facts: options.ticket_facts });
    return { schema_version: 1, run_id: runId, legacy: true, read_only: true, status: historical_state.status, historical_state, state };
  } catch (cause) { throw new RollingRunError(`legacy compiled run cannot be normalized: ${(cause as Error).message}`, "LEGACY_COMPILED_RUN_INVALID"); }
}
export const normalizeCompiledRunV1Status = normalizeLegacyCompiledRunStatus;

export { RollingRunError, RollingStorageRaceError } from "./rolling-run-store.js";
