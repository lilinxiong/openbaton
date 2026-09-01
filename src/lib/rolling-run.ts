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

export class RollingRunError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly diagnostics?: readonly { code: string; message: string; path?: string; refs?: string[] }[];
  constructor(message: string, code: string, retryable = false, diagnostics?: readonly { code: string; message: string; path?: string; refs?: string[] }[]) {
    super(message);
    this.name = "RollingRunError";
    this.code = code;
    this.retryable = retryable;
    this.diagnostics = diagnostics;
  }
}

/**
 * The expected append sequence is a storage compare token, not semantic
 * lineage.  Expose a typed retryable outcome so callers can mechanically
 * rebase the unchanged delta and retry after a concurrent append while the
 * legacy `ROLLING_SEQUENCE_MISMATCH` code remains intact.
 */
export class RollingStorageRaceError extends RollingRunError {
  readonly expected_append_sequence: number;
  readonly current_append_sequence: number;
  readonly expected_sequence: number;
  readonly current_sequence: number;
  readonly storage_race = true as const;

  constructor(expected_append_sequence: number, current_append_sequence: number) {
    super(
      `rolling append sequence is stale (expected ${expected_append_sequence}, current ${current_append_sequence})`,
      "ROLLING_SEQUENCE_MISMATCH",
      true,
    );
    this.name = "RollingStorageRaceError";
    this.expected_append_sequence = expected_append_sequence;
    this.current_append_sequence = current_append_sequence;
    this.expected_sequence = expected_append_sequence;
    this.current_sequence = current_append_sequence;
  }
}


function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function sequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function now(value: string | number | Date | undefined): string {
  const stamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value || "");
  return new Date(Number.isFinite(stamp) ? stamp : Date.now()).toISOString();
}
function sha(value: unknown): string { return sha256Hex(canonicalizeRolling(value)); }
function factFingerprint(value: Omit<RollingFact, "fingerprint">): string {
  return sha(value);
}
function documentFingerprint(value: unknown): string { return sha(value); }
function error(message: string, code: string, retryable = false): never { throw new RollingRunError(message, code, retryable); }

/** Replace a file in one rename, with a private temporary file and fsync. */
function atomicBytes(file: string, bytes: Buffer): void {
  writeBytesAtomic(file, bytes, { chmodAfter: true });
}
function atomicJson(file: string, value: unknown): void {
  atomicBytes(file, Buffer.from(`${canonicalizeRolling(value)}\n`, "utf8"));
}
function sourceOf(input: RollingRunCreateInput): TaskSourceDescriptor {
  const source = input.source || input.source_descriptor;
  if (!source) error("rolling run requires a source descriptor", "ROLLING_SOURCE_REQUIRED");
  try { return assertTaskSourceDescriptor(source); }
  catch (cause) { throw new RollingRunError(`invalid rolling source: ${(cause as Error).message}`, "ROLLING_SOURCE_INVALID"); }
}
function sourceDocument(source: TaskSourceDescriptor): TaskSourceDescriptor {
  const copy = structuredClone(source) as TaskSourceDescriptor;
  if (!copy.source_fingerprint) copy.source_fingerprint = fingerprintTaskSourceDescriptor(copy);
  if (!copy.fingerprint) copy.fingerprint = fingerprintTaskSourceDescriptor(copy);
  return copy;
}
function sourceDocumentId(source: TaskSourceDescriptor): string { return `source-${fingerprintTaskSourceDescriptor(source).slice(0, 32)}`; }

function identityFromInput(input: RollingRunCreateInput, source: TaskSourceDescriptor): RollingRunIdentity {
  if (!nonEmpty(input.host)) error("host is required", "ROLLING_IDENTITY_INVALID");
  if (!nonEmpty(input.runId)) error("run id is required", "ROLLING_IDENTITY_INVALID");
  const session_uid = input.session_uid || sessionUidFromEnv(input.env);
  if (!nonEmpty(session_uid)) error("session_uid is required", "ROLLING_SESSION_REQUIRED");
  return {
    run_id: input.runId,
    host: input.host,
    adapter: input.adapter || source.adapter,
    source_kind: input.source_kind || source.source_kind,
    execution_mode: input.execution_mode || "isolated-worktree",
    session_uid,
  };
}

function validateIdentity(value: unknown, runId: string): RollingRunIdentity {
  if (!record(value) || !record(value.identity)) error("rolling identity is corrupt", "ROLLING_STATE_CORRUPT");
  const v = value.identity;
  for (const key of ["run_id", "host", "adapter", "source_kind", "execution_mode", "session_uid"]) if (!nonEmpty(v[key])) error(`missing rolling identity ${key}`, "ROLLING_STATE_CORRUPT");
  if (v.run_id !== runId) error("rolling run id does not match state", "ROLLING_ID_MISMATCH");
  return v as unknown as RollingRunIdentity;
}

function parseFacts(cwd: string, runId: string, env?: NodeJS.ProcessEnv): RollingFact[] {
  const file = rollingRunFactLogPath(cwd, runId, env);
  if (!fs.existsSync(file)) return [];
  let lines: string;
  try { lines = fs.readFileSync(file, "utf8"); } catch { error(`cannot read rolling fact log: ${file}`, "ROLLING_STATE_CORRUPT"); }
  if (!lines) return [];
  const out: RollingFact[] = [];
  const rawLines = lines.endsWith("\n") ? lines.slice(0, -1).split("\n") : lines.split("\n");
  if (rawLines.some((line) => !line)) error("blank or partial rolling fact line", "ROLLING_STATE_CORRUPT");
  for (const [index, line] of rawLines.entries()) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { error(`partial rolling fact at line ${index + 1}`, "ROLLING_STATE_CORRUPT"); }
    if (!record(value) || value.schema_version !== ROLLING_FACT_SCHEMA_VERSION || !sequence(value.append_sequence)
      || !nonEmpty(value.fact_id) || !nonEmpty(value.idempotency_key) || !nonEmpty(value.kind) || !nonEmpty(value.document_id)
      || !nonEmpty(value.document_fingerprint) || !nonEmpty(value.payload_fingerprint) || !nonEmpty(value.recorded_at)
      || !nonEmpty(value.fingerprint)
      || (value.kind === "delta"
        ? !String(value.document_id).startsWith("delta-") || String(value.document_id).length === "delta-".length
        : String(value.document_id).startsWith("delta-"))) error("malformed rolling fact", "ROLLING_STATE_CORRUPT");
    const fact = value as unknown as RollingFact;
    const { fingerprint: _fingerprint, ...without } = fact;
    if (fact.fingerprint !== factFingerprint(without)) error("rolling fact fingerprint mismatch", "ROLLING_STATE_CORRUPT");
    if (fact.append_sequence !== index) error("rolling fact append sequence is not contiguous", "ROLLING_STATE_CORRUPT");
    if (out.some((item) => item.fact_id === fact.fact_id || item.idempotency_key === fact.idempotency_key)) error("duplicate rolling fact identity", "ROLLING_STATE_CORRUPT");
    out.push(fact);
  }
  return out;
}

function writeFacts(cwd: string, runId: string, facts: RollingFact[], env?: NodeJS.ProcessEnv): void {
  const text = facts.map((fact) => `${canonicalizeRolling(fact)}\n`).join("");
  atomicBytes(rollingRunFactLogPath(cwd, runId, env), Buffer.from(text, "utf8"));
}
function rollingFactDocumentPath(cwd: string, runId: string, fact: Pick<RollingFact, "kind" | "document_id">, env?: NodeJS.ProcessEnv): string {
  return fact.kind === "delta"
    ? rollingRunDeltaDocumentPath(cwd, runId, fact.document_id.slice("delta-".length), env)
    : rollingRunAcceptedDocumentPath(cwd, runId, fact.document_id, env);
}
function factDocumentMatches(cwd: string, runId: string, fact: RollingFact, env?: NodeJS.ProcessEnv): boolean {
  const file = rollingFactDocumentPath(cwd, runId, fact, env);
  if (!fs.existsSync(file)) return false;
  try { return documentFingerprint(readJsonFile(file)) === fact.document_fingerprint; } catch { return false; }
}
function requireFactDocuments(cwd: string, runId: string, facts: RollingFact[], env?: NodeJS.ProcessEnv): void {
  for (const fact of facts) if (!factDocumentMatches(cwd, runId, fact, env)) error(`accepted document missing or corrupt: ${fact.document_id}`, "ROLLING_STATE_CORRUPT");
}

function derive(identity: RollingRunIdentity, facts: RollingFact[]): RollingCheckpoint {
  const manifest = new Map<string, TaskManifestEntry>();
  const deltas: PlanDelta[] = [];
  const seals: TaskSeal[] = [];
  for (const fact of facts) {
    if (fact.kind === "source") continue;
    if (fact.kind === "delta") {
      const delta = fact.payload as PlanDelta;
      for (const entry of [...(delta.manifest_additions || []), ...(delta.manifest_refreshes || [])]) manifest.set(entry.task_key, entry);
      deltas.push(delta);
    }
    if (fact.kind === "seal") seals.push(fact.payload as TaskSeal);
  }
  return {
    schema_version: ROLLING_CHECKPOINT_SCHEMA_VERSION,
    identity,
    append_sequence: facts.length ? facts[facts.length - 1]!.append_sequence : 0,
    fact_ids: facts.map((fact) => fact.fact_id),
    facts: structuredClone(facts),
    manifest_entries: [...manifest.values()].sort((a, b) => a.task_key.localeCompare(b.task_key)),
    accepted_deltas: structuredClone(deltas),
    seals: structuredClone(seals),
    updated_at: facts.length ? facts[facts.length - 1]!.recorded_at : new Date(0).toISOString(),
  };
}

function writeCheckpoint(cwd: string, runId: string, checkpoint: RollingCheckpoint, env?: NodeJS.ProcessEnv): void {
  atomicJson(rollingRunCheckpointPath(cwd, runId, env), checkpoint);
}

function readIdentityFromFacts(cwd: string, runId: string, env?: NodeJS.ProcessEnv): RollingRunIdentity {
  const facts = parseFacts(cwd, runId, env);
  const sourceFact = facts.find((fact) => fact.kind === "source");
  if (!sourceFact || !record(sourceFact.payload)) error("rolling run has no source identity", "ROLLING_STATE_CORRUPT");
  const payload = sourceFact.payload as Record<string, unknown>;
  const identity = validateIdentity({ identity: payload.__run_identity }, runId);
  const checkpoint = rollingRunCheckpointPath(cwd, runId, env);
  if (fs.existsSync(checkpoint)) {
    try {
      const cached = validateIdentity(readJsonFile(checkpoint), runId);
      if (canonicalizeRolling(cached) !== canonicalizeRolling(identity)) error("rolling checkpoint identity differs from source fact", "ROLLING_STATE_CORRUPT");
    } catch (cause) {
      if (cause instanceof RollingRunError && cause.code === "ROLLING_STATE_CORRUPT" && String((cause as Error).message).includes("differs from source")) throw cause;
      /* A replaceable checkpoint may be absent or interrupted; the log wins. */
    }
  }
  return identity;
}

function deltaPayloads(facts: readonly RollingFact[]): PlanDelta[] {
  return facts.filter((fact) => fact.kind === "delta" && record(fact.payload)).map((fact) => fact.payload as PlanDelta);
}

function deltaIdempotencyFingerprint(value: PlanDelta): string {
  const copy = structuredClone(value) as PlanDelta;
  // These values are injected only for the compact phase-1 compatibility
  // facade.  Ignore the injected marker when comparing a replay with the
  // original compact transport document.
  for (const unit of copy.unit_versions || []) {
    if (Array.isArray(unit.completion_criteria) && unit.completion_criteria.length === 1 && unit.completion_criteria[0] === "phase-1 compatibility contract") delete unit.completion_criteria;
    if (Array.isArray(unit.permitted_validation) && unit.permitted_validation.length === 1 && unit.permitted_validation[0] === "phase-1 compatibility validation") delete unit.permitted_validation;
  }
  return fingerprintPlanDelta(copy);
}

function deltaWithRunWorktreeDefaults(value: PlanDelta, identity: RollingRunIdentity): PlanDelta {
  const copy = structuredClone(value) as PlanDelta;
  let changed = false;
  for (const unit of copy.unit_versions || []) {
    if (unit.execution_mode !== "patch-only" || unit.worktree_mode !== undefined) continue;
    unit.worktree_mode = identity.execution_mode as WorktreeExecutionMode;
    delete unit.fingerprint;
    changed = true;
  }
  if (changed) delete copy.fingerprint;
  return copy;
}

function deltaValidationFacts(identity: RollingRunIdentity, facts: readonly RollingFact[], proposed: PlanDelta): PlanDeltaValidationContext {
  const accepted_deltas = deltaPayloads(facts);
  const manifest = new Map<string, TaskManifestEntry>();
  for (const delta of accepted_deltas) {
    for (const entry of [...(delta.manifest_additions || []), ...(delta.manifest_refreshes || [])]) {
      if (record(entry) && nonEmpty(entry.task_key)) manifest.set(entry.task_key, entry);
    }
  }

  // Phase-1 callers were allowed to append a plan before a manifest page was
  // available.  Preserve that API by treating an entirely absent manifest as
  // an unknown source boundary; as soon as a real entry exists, references are
  // checked strictly by the semantic validator.
  const proposedManifest = [...(proposed.manifest_additions || []), ...(proposed.manifest_refreshes || [])];
  const hasProposedManifest = proposedManifest.some((entry) => record(entry) && nonEmpty(entry.task_key));
  if (manifest.size === 0 && !hasProposedManifest) {
    const taskKeys = new Set<string>();
    for (const unit of proposed.unit_versions || []) for (const taskKey of unit.task_keys || []) if (nonEmpty(taskKey)) taskKeys.add(taskKey);
    for (const gate of proposed.gate_versions || []) for (const taskKey of gate.task_keys || []) if (nonEmpty(taskKey)) taskKeys.add(taskKey);
    for (const coverage of proposed.task_coverage || []) if (record(coverage) && nonEmpty(coverage.task_key)) taskKeys.add(coverage.task_key);
    for (const taskKey of taskKeys) manifest.set(taskKey, {
      schema_version: 1,
      task_key: taskKey,
      source_kind: identity.source_kind as TaskManifestEntry["source_kind"],
      source_ref: { task_key: taskKey, compatibility: true },
      display_id: taskKey,
      title: taskKey,
      source_fingerprint: "0".repeat(64),
      source_state: "pending",
      discovery_sequence: 0,
    });
  }
  return {
    rolling_run_schema_version: 2,
    run_execution_mode: identity.execution_mode as WorktreeExecutionMode,
    manifest_entries: [...manifest.values()],
    accepted_deltas,
    facts: [...facts],
  };
}

function appendLocked(input: RollingRunAppendInput, normalized: { kind: RollingFactKind; idempotency_key: string; fact_id: string; document_id: string; payload: unknown; document: unknown }): RollingCheckpoint {
  const env = input.env || process.env;
  const identity = readIdentityFromFacts(input.cwd, input.runId, env);
  if (normalized.kind === "delta" && record(normalized.payload)) {
    const defaulted = deltaWithRunWorktreeDefaults(normalized.payload as unknown as PlanDelta, identity);
    normalized.payload = defaulted;
    normalized.document = defaulted;
  }
  if (input.host !== undefined && input.host !== identity.host) error("rolling run host does not match state", "ROLLING_HOST_MISMATCH");
  if (input.session_uid !== undefined && input.session_uid !== identity.session_uid) error("rolling run session does not match state", "ROLLING_SESSION_MISMATCH");
  if (env.BATON_SESSION_ID) {
    try { validateSessionScope(identity.session_uid, env); } catch (cause) { throw new RollingRunError((cause as Error).message, "ROLLING_SESSION_MISMATCH"); }
  }
  const facts = parseFacts(input.cwd, input.runId, env);
  const current = facts.length ? facts[facts.length - 1]!.append_sequence : 0;
  const existing = facts.find((fact) => fact.idempotency_key === normalized.idempotency_key);
  if (existing) {
    const payloadHash = documentFingerprint(normalized.payload);
    const documentHash = documentFingerprint(normalized.document);
    const semanticDeltaMatch = existing.kind === "delta" && normalized.kind === "delta"
      && record(existing.payload) && record(normalized.payload)
      && deltaIdempotencyFingerprint(existing.payload as unknown as PlanDelta) === deltaIdempotencyFingerprint(normalized.payload as unknown as PlanDelta);
    const payloadMatches = existing.payload_fingerprint === payloadHash || semanticDeltaMatch;
    const documentMatches = existing.document_fingerprint === documentHash || semanticDeltaMatch;
    if (existing.kind !== normalized.kind || !payloadMatches || !documentMatches) {
      error("rolling idempotency key conflicts with an accepted fact", "ROLLING_IDEMPOTENCY_CONFLICT");
    }
    if (!factDocumentMatches(input.cwd, input.runId, existing, env)) error(`accepted document missing or corrupt: ${existing.document_id}`, "ROLLING_STATE_CORRUPT");
    return derive(identity, facts);
  }
  if (facts.some((fact) => fact.fact_id === normalized.fact_id)) error("rolling fact id conflicts with an accepted fact", "ROLLING_FACT_ID_CONFLICT");

  const expected = input.expected_append_sequence ?? input.append_sequence
    ?? (normalized.kind === "delta" && record(normalized.payload) && sequence(normalized.payload.prepared_from_append_sequence)
      ? normalized.payload.prepared_from_append_sequence
      : undefined);
  if (expected !== undefined && expected !== current) throw new RollingStorageRaceError(expected, current);

  if (normalized.kind === "delta") {
    try {
      const shaped = assertPlanDelta(normalized.payload);
      const fixedFacts = deltaValidationFacts(identity, facts, shaped);
      const semanticInput = structuredClone(shaped) as PlanDelta;
      // The phase-1 storage facade accepted a compact unit contract when no
      // source manifest had been discovered yet.  Keep that compatibility
      // boundary while enforcing the complete contract for every manifest-
      // anchored rolling delta.
      const compatibilityManifest = Array.isArray(fixedFacts.manifest_entries) && fixedFacts.manifest_entries.length > 0
        && fixedFacts.manifest_entries.every((entry) => record(entry.source_ref) && entry.source_ref.compatibility === true);
      const originalUnits = new Map((shaped.unit_versions || []).map((unit) => [`${unit.unit_key}@${unit.version}`, unit]));
      if (compatibilityManifest) {
        for (const unit of semanticInput.unit_versions || []) {
          if (!Array.isArray(unit.completion_criteria) || unit.completion_criteria.length === 0) unit.completion_criteria = ["phase-1 compatibility contract"];
          if (!Array.isArray(unit.permitted_validation) || unit.permitted_validation.length === 0) unit.permitted_validation = ["phase-1 compatibility validation"];
        }
      }
      const semantic = validatePlanDeltaAgainstFacts(semanticInput, fixedFacts);
      if (!semantic.valid) {
        const detail = semantic.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
        throw new RollingRunError(`invalid rolling delta: ${detail}`, "ROLLING_DELTA_INVALID", false, semantic.diagnostics);
      }
      const candidate = structuredClone(semantic.value || shaped) as PlanDelta;
      if (compatibilityManifest) {
        for (const unit of candidate.unit_versions || []) {
          const original = originalUnits.get(`${unit.unit_key}@${unit.version}`);
          if (!original || !Array.isArray(original.completion_criteria) || original.completion_criteria.length === 0) delete unit.completion_criteria;
          if (!original || !Array.isArray(original.permitted_validation) || original.permitted_validation.length === 0) delete unit.permitted_validation;
        }
      }
      for (const unit of candidate.unit_versions || []) unit.fingerprint = fingerprintUnitVersion(unit);
      for (const gate of candidate.gate_versions || []) gate.fingerprint = fingerprintGateVersion(gate);
      candidate.fingerprint = fingerprintPlanDelta(candidate);
      normalized.payload = candidate;
      // A delta's accepted control document is its canonical semantic value.
      // This prevents a transport-only spelling (for example `./src/a.ts`)
      // from being a second document for the same fact.
      normalized.document = candidate;
    } catch (cause) {
      if (cause instanceof RollingRunError && cause.code === "ROLLING_DELTA_INVALID") throw cause;
      throw new RollingRunError(`invalid rolling delta: ${(cause as Error).message}`, "ROLLING_DELTA_INVALID");
    }
  }
  if (normalized.kind === "seal") {
    try {
      const shaped = assertTaskSeal(normalized.payload);
      const semantic = validateTaskSealAgainstFacts(shaped, { facts });
      if (!semantic.valid) {
        const detail = semantic.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
        throw new RollingRunError(`invalid rolling seal: ${detail}`, "ROLLING_SEAL_INVALID", false, semantic.diagnostics);
      }
      normalized.payload = semantic.value || shaped;
      // Seal validation canonicalizes version lists.  Persist that same
      // value as the accepted document so a failed validation cannot leave a
      // transport-only seal behind and retries remain idempotent.
      normalized.document = normalized.payload;
    } catch (cause) {
      if (cause instanceof RollingRunError && cause.code === "ROLLING_SEAL_INVALID") throw cause;
      throw new RollingRunError(`invalid rolling seal: ${(cause as Error).message}`, "ROLLING_SEAL_INVALID");
    }
  }
  const documentFile = rollingFactDocumentPath(input.cwd, input.runId, normalized, env);
  const documentHash = documentFingerprint(normalized.document);
  let createdDocument = false;
  if (fs.existsSync(documentFile)) {
    if (!factDocumentMatches(input.cwd, input.runId, { kind: normalized.kind, document_id: normalized.document_id, document_fingerprint: documentHash } as RollingFact, env)) error("accepted document identity conflicts", "ROLLING_DOCUMENT_CONFLICT");
  } else {
    atomicJson(documentFile, normalized.document);
    createdDocument = true;
  }
  const next: Omit<RollingFact, "fingerprint"> = {
    schema_version: ROLLING_FACT_SCHEMA_VERSION,
    append_sequence: current + 1,
    fact_id: normalized.fact_id,
    idempotency_key: normalized.idempotency_key,
    kind: normalized.kind,
    document_id: normalized.document_id,
    document_fingerprint: documentHash,
    payload_fingerprint: documentFingerprint(normalized.payload),
    payload: structuredClone(normalized.payload),
    recorded_at: now(input.now),
  };
  const fact: RollingFact = { ...next, fingerprint: factFingerprint(next) };
  try { writeFacts(input.cwd, input.runId, [...facts, fact], env); }
  catch (cause) {
    if (createdDocument) try { fs.unlinkSync(documentFile); } catch { /* best effort */ }
    throw cause;
  }
  const checkpoint = derive(identity, [...facts, fact]);
  try { writeCheckpoint(input.cwd, input.runId, checkpoint, env); }
  catch { /* the log is authoritative; reconnect will rebuild it */ }
  return checkpoint;
}

function appendInput(input: RollingRunAppendInput): { kind: RollingFactKind; idempotency_key: string; fact_id: string; document_id: string; payload: unknown; document: unknown } {
  const fact = input.fact || {};
  const kind = input.kind || fact.kind;
  if (!nonEmpty(kind)) error("rolling fact kind is required", "ROLLING_FACT_INVALID");
  const payload = input.payload !== undefined ? input.payload : fact.payload;
  if (payload === undefined) error("rolling fact payload is required", "ROLLING_FACT_INVALID");
  const idempotency_key = input.idempotency_key || fact.idempotency_key || `${kind}:${sha(payload)}`;
  const fact_id = input.fact_id || fact.fact_id || idempotency_key;
  const document_id = input.document_id || fact.document_id || (kind === "delta" && record(payload) && nonEmpty(payload.delta_id) ? `delta-${payload.delta_id}` : `${kind}-${sha(payload).slice(0, 32)}`);
  const document = input.document !== undefined ? input.document : payload;
  if (![idempotency_key, fact_id, document_id].every(nonEmpty)) error("rolling fact identities are required", "ROLLING_FACT_INVALID");
  if (kind === "delta"
    ? !document_id.startsWith("delta-") || document_id.length === "delta-".length
    : document_id.startsWith("delta-")) {
    error("the delta- document namespace is reserved for delta facts", "ROLLING_FACT_INVALID");
  }
  return { kind, idempotency_key, fact_id, document_id, payload, document };
}

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
