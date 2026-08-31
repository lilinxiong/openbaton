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
  fingerprintPlanDelta,
  fingerprintTaskSeal,
  fingerprintTaskSourceDescriptor,
  type PlanDelta,
  type TaskManifestEntry,
  type TaskSeal,
  type TaskSourceDescriptor,
} from "./rolling-plan.js";
import {
  rollingRunAcceptedDocumentPath,
  rollingRunCheckpointPath,
  rollingRunFactLogPath,
  rollingRunLockPath,
  rollingRunRoot,
} from "./paths.js";
import { withOwnedLock } from "./owned-lock.js";
import { sessionUidFromEnv, validateSessionScope } from "./session-scope.js";
import { readApplyRun, statusApplyRun, type ApplyRunState, type ApplyRunStatusReport } from "./apply-run.js";

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
  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "RollingRunError";
    this.code = code;
    this.retryable = retryable;
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
function sha(value: unknown): string { return crypto.createHash("sha256").update(canonicalizeRolling(value)).digest("hex"); }
function factFingerprint(value: Omit<RollingFact, "fingerprint">): string {
  return sha(value);
}
function documentFingerprint(value: unknown): string { return sha(value); }
function error(message: string, code: string, retryable = false): never { throw new RollingRunError(message, code, retryable); }

/** Replace a file in one rename, with a private temporary file and fsync. */
function atomicBytes(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* mode is set by openSync */ }
  } catch (cause) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ }
    try { fs.unlinkSync(temp); } catch { /* noop */ }
    throw cause;
  }
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
    execution_mode: input.execution_mode || "shared-worktree",
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
      || !nonEmpty(value.fingerprint)) error("malformed rolling fact", "ROLLING_STATE_CORRUPT");
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
function factDocumentMatches(cwd: string, runId: string, fact: RollingFact, env?: NodeJS.ProcessEnv): boolean {
  const file = rollingRunAcceptedDocumentPath(cwd, runId, fact.document_id, env);
  if (!fs.existsSync(file)) return false;
  try { return documentFingerprint(JSON.parse(fs.readFileSync(file, "utf8"))) === fact.document_fingerprint; } catch { return false; }
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
      const cached = validateIdentity(JSON.parse(fs.readFileSync(checkpoint, "utf8")), runId);
      if (canonicalizeRolling(cached) !== canonicalizeRolling(identity)) error("rolling checkpoint identity differs from source fact", "ROLLING_STATE_CORRUPT");
    } catch (cause) {
      if (cause instanceof RollingRunError && cause.code === "ROLLING_STATE_CORRUPT" && String((cause as Error).message).includes("differs from source")) throw cause;
      /* A replaceable checkpoint may be absent or interrupted; the log wins. */
    }
  }
  return identity;
}

function appendLocked(input: RollingRunAppendInput, normalized: { kind: RollingFactKind; idempotency_key: string; fact_id: string; document_id: string; payload: unknown; document: unknown }): RollingCheckpoint {
  const env = input.env || process.env;
  const identity = readIdentityFromFacts(input.cwd, input.runId, env);
  if (input.host !== undefined && input.host !== identity.host) error("rolling run host does not match state", "ROLLING_HOST_MISMATCH");
  if (input.session_uid !== undefined && input.session_uid !== identity.session_uid) error("rolling run session does not match state", "ROLLING_SESSION_MISMATCH");
  if (env.BATON_SESSION_ID) {
    try { validateSessionScope(identity.session_uid, env); } catch (cause) { throw new RollingRunError((cause as Error).message, "ROLLING_SESSION_MISMATCH"); }
  }
  const facts = parseFacts(input.cwd, input.runId, env);
  const expected = input.expected_append_sequence ?? input.append_sequence;
  const current = facts.length ? facts[facts.length - 1]!.append_sequence : 0;
  if (expected !== undefined && expected !== current) error(`rolling append sequence is stale (expected ${expected}, current ${current})`, "ROLLING_SEQUENCE_MISMATCH", true);
  const existing = facts.find((fact) => fact.idempotency_key === normalized.idempotency_key);
  if (existing) {
    if (existing.kind !== normalized.kind || existing.payload_fingerprint !== documentFingerprint(normalized.payload)) error("rolling idempotency key conflicts with an accepted fact", "ROLLING_IDEMPOTENCY_CONFLICT");
    return derive(identity, facts);
  }
  if (facts.some((fact) => fact.fact_id === normalized.fact_id)) error("rolling fact id conflicts with an accepted fact", "ROLLING_FACT_ID_CONFLICT");
  if (normalized.kind === "delta") {
    try { normalized.payload = assertPlanDelta(normalized.payload); }
    catch (cause) { throw new RollingRunError(`invalid rolling delta: ${(cause as Error).message}`, "ROLLING_DELTA_INVALID"); }
  }
  if (normalized.kind === "seal") {
    try { normalized.payload = assertTaskSeal(normalized.payload); }
    catch (cause) { throw new RollingRunError(`invalid rolling seal: ${(cause as Error).message}`, "ROLLING_SEAL_INVALID"); }
  }
  const documentFile = rollingRunAcceptedDocumentPath(input.cwd, input.runId, normalized.document_id, env);
  const documentHash = documentFingerprint(normalized.document);
  if (fs.existsSync(documentFile)) {
    if (!factDocumentMatches(input.cwd, input.runId, { document_id: normalized.document_id, document_fingerprint: documentHash } as RollingFact, env)) error("accepted document identity conflicts", "ROLLING_DOCUMENT_CONFLICT");
  } else atomicJson(documentFile, normalized.document);
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
    if (!facts.some((item) => item.document_id === normalized.document_id)) try { fs.unlinkSync(documentFile); } catch { /* best effort */ }
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

export const createRollingRun = createRollingExecutionRun;
export const startRollingExecutionRun = createRollingExecutionRun;

export function appendRollingFact(input: RollingRunAppendInput): RollingCheckpoint {
  return withOwnedLock(rollingRunLockPath(input.cwd, input.runId, input.env), () => appendLocked(input, appendInput(input)), { operation: ROLLING_RUN_LOCK_OPERATION });
}
export const appendRollingRun = appendRollingFact;
export const appendRollingExecutionFact = appendRollingFact;

export function appendRollingPlanDelta(input: RollingPlanDeltaAppendInput): RollingCheckpoint {
  const delta = assertPlanDelta(input.delta);
  const copied = structuredClone(delta) as PlanDelta;
  if (!copied.fingerprint) copied.fingerprint = fingerprintPlanDelta(copied);
  return appendRollingFact({ ...input, kind: "delta", idempotency_key: `delta:${copied.delta_id}`, document_id: `delta-${copied.delta_id}`, payload: copied, document: copied });
}

export function appendRollingSeal(input: RollingRunAppendInput & { seal: TaskSeal }): RollingCheckpoint {
  const seal = assertTaskSeal(input.seal);
  const copied = structuredClone(seal) as TaskSeal;
  if (!copied.fingerprint) copied.fingerprint = fingerprintTaskSeal(copied);
  return appendRollingFact({ ...input, kind: "seal", idempotency_key: `seal:${copied.task_key}`, document_id: `seal-${copied.task_key}`, payload: copied, document: copied });
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
export const rebuildRollingCheckpoint = rebuildRollingRunCheckpoint;

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
      const cached = fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, "utf8")) as RollingCheckpoint : undefined;
      if (!cached || cached.append_sequence !== checkpoint.append_sequence || cached.fact_ids.join("\u0000") !== checkpoint.fact_ids.join("\u0000")) writeCheckpoint(cwd, runId, checkpoint, env);
    } catch { writeCheckpoint(cwd, runId, checkpoint, env); }
  }
  return checkpoint;
}
export const readRollingRun = readRollingExecutionRun;
export const readRollingExecutionRunState = readRollingExecutionRun;

export interface RollingRunStatus extends RollingCheckpoint {
  status: "unplanned" | "open" | "sealed" | "reconciled";
  task_status: Record<string, "unplanned" | "planned" | "open" | "sealed">;
}
export function statusRollingExecutionRun(cwd: string, runId: string, options: RollingRunReadOptions = {}): RollingRunStatus {
  const run = readRollingExecutionRun(cwd, runId, options);
  const task_status: RollingRunStatus["task_status"] = {};
  for (const entry of run.manifest_entries) task_status[entry.task_key] = "unplanned";
  for (const delta of run.accepted_deltas) for (const coverage of delta.task_coverage) if (task_status[coverage.task_key] === "unplanned") task_status[coverage.task_key] = "planned";
  for (const seal of run.seals) task_status[seal.task_key] = "sealed";
  const statuses = Object.values(task_status);
  const status = statuses.length === 0 ? "unplanned" : statuses.every((value) => value === "sealed") ? "sealed" : statuses.some((value) => value === "planned") ? "open" : "unplanned";
  return { ...run, status, task_status };
}
export const statusRollingRun = statusRollingExecutionRun;

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
export const inspectLegacyCompiledRun = normalizeLegacyCompiledRunStatus;
export const readLegacyCompiledRunStatus = normalizeLegacyCompiledRunStatus;
