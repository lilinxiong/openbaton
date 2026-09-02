import { validateTaskSealAgainstFacts } from "../rolling-lifecycle.js";
import {
  ROLLING_FACT_SCHEMA_VERSION,
  RollingCheckpoint,
  RollingFact,
  RollingFactKind,
  RollingRunAppendInput,
  RollingRunIdentity
} from "../rolling-run.js";
import {
  PlanDelta,
  TaskManifestEntry,
  WorktreeExecutionMode,
  fingerprintGateVersion,
  fingerprintPlanDelta,
  fingerprintUnitVersion
} from "../rolling-plan.js";
import {
  RollingRunError,
  RollingStorageRaceError,
  atomicJson,
  derive,
  documentFingerprint,
  error,
  factDocumentMatches,
  factFingerprint,
  nonEmpty,
  now,
  parseFacts,
  readIdentityFromFacts,
  record,
  rollingFactDocumentPath,
  sequence,
  sha,
  writeCheckpoint,
  writeFacts
} from "./run-store.js";
import {
  PlanDeltaValidationContext,
  validatePlanDeltaAgainstFacts
} from "../rolling-delta.js";
import {
  assertPlanDelta,
  assertTaskSeal
} from "./plan-validate.js";
import fs from "node:fs";
import { validateSessionScope } from "../session-scope.js";
/**
 * Compare-and-append machinery for rolling runs. Split from rolling-run.ts.
 */

export function deltaPayloads(facts: readonly RollingFact[]): PlanDelta[] {
  return facts.filter((fact) => fact.kind === "delta" && record(fact.payload)).map((fact) => fact.payload as PlanDelta);
}

export function deltaIdempotencyFingerprint(value: PlanDelta): string {
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

export function deltaWithRunWorktreeDefaults(value: PlanDelta, identity: RollingRunIdentity): PlanDelta {
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

export function deltaValidationFacts(identity: RollingRunIdentity, facts: readonly RollingFact[], proposed: PlanDelta): PlanDeltaValidationContext {
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

export function appendLocked(input: RollingRunAppendInput, normalized: { kind: RollingFactKind; idempotency_key: string; fact_id: string; document_id: string; payload: unknown; document: unknown }): RollingCheckpoint {
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

export function appendInput(input: RollingRunAppendInput): { kind: RollingFactKind; idempotency_key: string; fact_id: string; document_id: string; payload: unknown; document: unknown } {
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
