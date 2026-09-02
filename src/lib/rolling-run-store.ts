/**
 * Fact-log and checkpoint storage for rolling runs. Split from
 * rolling-run.ts (leaf module; hosts the run error types).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, sha256Hex, writeBytesAtomic } from "./json-utils.js";
import { assertTaskSourceDescriptor } from "./rolling-plan-validate.js";
import { sessionUidFromEnv } from "./session-scope.js";
import {
  rollingRunAcceptedDocumentPath,
  rollingRunCheckpointPath,
  rollingRunDeltaDocumentPath,
  rollingRunFactLogPath
} from "./paths.js";
import {
  PlanDelta,
  TaskManifestEntry,
  TaskSeal,
  TaskSourceDescriptor,
  canonicalizeRolling,
  fingerprintTaskSourceDescriptor
} from "./rolling-plan.js";
import {
  ROLLING_CHECKPOINT_SCHEMA_VERSION,
  ROLLING_FACT_SCHEMA_VERSION,
  RollingCheckpoint,
  RollingFact,
  RollingRunCreateInput,
  RollingRunIdentity
} from "./rolling-run.js";

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



export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
export function sequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function now(value: string | number | Date | undefined): string {
  const stamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value || "");
  return new Date(Number.isFinite(stamp) ? stamp : Date.now()).toISOString();
}
export function sha(value: unknown): string { return sha256Hex(canonicalizeRolling(value)); }
export function factFingerprint(value: Omit<RollingFact, "fingerprint">): string {
  return sha(value);
}
export function documentFingerprint(value: unknown): string { return sha(value); }
export function error(message: string, code: string, retryable = false): never { throw new RollingRunError(message, code, retryable); }

/** Replace a file in one rename, with a private temporary file and fsync. */
export function atomicBytes(file: string, bytes: Buffer): void {
  writeBytesAtomic(file, bytes, { chmodAfter: true });
}
export function atomicJson(file: string, value: unknown): void {
  atomicBytes(file, Buffer.from(`${canonicalizeRolling(value)}\n`, "utf8"));
}
export function sourceOf(input: RollingRunCreateInput): TaskSourceDescriptor {
  const source = input.source || input.source_descriptor;
  if (!source) error("rolling run requires a source descriptor", "ROLLING_SOURCE_REQUIRED");
  try { return assertTaskSourceDescriptor(source); }
  catch (cause) { throw new RollingRunError(`invalid rolling source: ${(cause as Error).message}`, "ROLLING_SOURCE_INVALID"); }
}
export function sourceDocument(source: TaskSourceDescriptor): TaskSourceDescriptor {
  const copy = structuredClone(source) as TaskSourceDescriptor;
  if (!copy.source_fingerprint) copy.source_fingerprint = fingerprintTaskSourceDescriptor(copy);
  if (!copy.fingerprint) copy.fingerprint = fingerprintTaskSourceDescriptor(copy);
  return copy;
}
export function sourceDocumentId(source: TaskSourceDescriptor): string { return `source-${fingerprintTaskSourceDescriptor(source).slice(0, 32)}`; }

export function identityFromInput(input: RollingRunCreateInput, source: TaskSourceDescriptor): RollingRunIdentity {
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

export function validateIdentity(value: unknown, runId: string): RollingRunIdentity {
  if (!record(value) || !record(value.identity)) error("rolling identity is corrupt", "ROLLING_STATE_CORRUPT");
  const v = value.identity;
  for (const key of ["run_id", "host", "adapter", "source_kind", "execution_mode", "session_uid"]) if (!nonEmpty(v[key])) error(`missing rolling identity ${key}`, "ROLLING_STATE_CORRUPT");
  if (v.run_id !== runId) error("rolling run id does not match state", "ROLLING_ID_MISMATCH");
  return v as unknown as RollingRunIdentity;
}

export function parseFacts(cwd: string, runId: string, env?: NodeJS.ProcessEnv): RollingFact[] {
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

export function writeFacts(cwd: string, runId: string, facts: RollingFact[], env?: NodeJS.ProcessEnv): void {
  const text = facts.map((fact) => `${canonicalizeRolling(fact)}\n`).join("");
  atomicBytes(rollingRunFactLogPath(cwd, runId, env), Buffer.from(text, "utf8"));
}
export function rollingFactDocumentPath(cwd: string, runId: string, fact: Pick<RollingFact, "kind" | "document_id">, env?: NodeJS.ProcessEnv): string {
  return fact.kind === "delta"
    ? rollingRunDeltaDocumentPath(cwd, runId, fact.document_id.slice("delta-".length), env)
    : rollingRunAcceptedDocumentPath(cwd, runId, fact.document_id, env);
}
export function factDocumentMatches(cwd: string, runId: string, fact: RollingFact, env?: NodeJS.ProcessEnv): boolean {
  const file = rollingFactDocumentPath(cwd, runId, fact, env);
  if (!fs.existsSync(file)) return false;
  try { return documentFingerprint(readJsonFile(file)) === fact.document_fingerprint; } catch { return false; }
}
export function requireFactDocuments(cwd: string, runId: string, facts: RollingFact[], env?: NodeJS.ProcessEnv): void {
  for (const fact of facts) if (!factDocumentMatches(cwd, runId, fact, env)) error(`accepted document missing or corrupt: ${fact.document_id}`, "ROLLING_STATE_CORRUPT");
}

export function derive(identity: RollingRunIdentity, facts: RollingFact[]): RollingCheckpoint {
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

export function writeCheckpoint(cwd: string, runId: string, checkpoint: RollingCheckpoint, env?: NodeJS.ProcessEnv): void {
  atomicJson(rollingRunCheckpointPath(cwd, runId, env), checkpoint);
}

export function readIdentityFromFacts(cwd: string, runId: string, env?: NodeJS.ProcessEnv): RollingRunIdentity {
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
