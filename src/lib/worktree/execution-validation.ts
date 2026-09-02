/**
 * Runtime-record validation and canonicalization for worktree execution.
 * Split from worktree-execution.ts.
 */
import path from "node:path";
import { canonicalizeJson, fingerprintJson } from "../json-utils.js";
import type { RollingValidationResult } from "../rolling-plan.js";
import { isNonBlankString } from "../validate-utils.js";
import { isRecord } from "../validate-utils.js";
import {
  CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
  CLEANUP_STATE_SCHEMA_VERSION,
  ChangeBundleManifest,
  ChangeBundleOperation,
  CleanupState,
  CleanupStatus,
  INTEGRATION_RECORD_SCHEMA_VERSION,
  IntegrationRecord,
  IntegrationState,
  RetentionReason,
  RuntimeRecordDiagnostic,
  SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  SnapshotManifest,
  WORKTREE_RECORD_SCHEMA_VERSION,
  WorktreeExecutionError,
  WorktreeLifecycleState,
  WorktreeLifecycleTransition,
  WorktreeRecord,
  WorktreeSetupFailureDiagnostic,
  WorktreeSetupState,
  WorktreeTransitionPhase
} from "./execution-types.js";

type AnyRecord = Record<string, unknown>;
export const HASH = /^[0-9a-f]{64}$/u;
export const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
export const UNIT_VERSION_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@[1-9][0-9]*$/u;
export const SETUP_STATES = new Set<WorktreeSetupState>(["planned", "registering", "registered", "verified", "failed"]);
export const LIFECYCLE_STATES = new Set<WorktreeLifecycleState>([
  "preparing", "worker_active", "terminal_awaiting_audit", "rejected", "bundle_ready", "integrating",
  "awaiting_parent_resolution", "integrated", "accepted", "cleanup_eligible", "cleaned", "cleanup_failed",
]);
export const PHASES = new Set<WorktreeTransitionPhase>(["setup", "native_execution", "audit", "bundling", "integration", "conflict", "acceptance", "cleanup"]);
export const RETENTION_REASONS = new Set<RetentionReason>([
  "live_native_handle", "terminal_unreleased_ticket", "pending_audit", "rejected_result_evidence", "ready_bundle",
  "active_integration", "unresolved_conflict", "downstream_base_dependency", "user_requested",
]);
export const CLEANUP_STATUSES = new Set<CleanupStatus>(["retained", "eligible", "cleaning", "cleaned", "failed"]);
export const INTEGRATION_STATES = new Set<IntegrationState>(["queued", "integrating", "awaiting_parent_resolution", "integrated", "accepted", "failed"]);
export const OPERATIONS = new Set<ChangeBundleOperation>(["write", "create", "delete", "rename", "copy", "chmod"]);

export const ALLOWED_TRANSITIONS = new Set<string>([
  "preparing>rejected",
  "preparing>worker_active",
  "worker_active>terminal_awaiting_audit",
  "terminal_awaiting_audit>rejected",
  "terminal_awaiting_audit>bundle_ready",
  "bundle_ready>integrating",
  "integrating>awaiting_parent_resolution",
  "integrating>integrated",
  "awaiting_parent_resolution>integrating",
  "awaiting_parent_resolution>integrated",
  "integrated>accepted",
  "accepted>cleanup_eligible",
  "rejected>cleanup_eligible",
  "cleanup_eligible>cleaned",
  "cleanup_eligible>cleanup_failed",
  "cleanup_failed>cleanup_eligible",
]);


export function text(value: unknown): value is string { return isNonBlankString(value); }

export function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export function iso(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

export function absolute(value: unknown): value is string {
  return text(value) && path.isAbsolute(value) && path.normalize(value) === value;
}

export function now(value?: string | number | Date): string {
  const stamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value || "");
  return new Date(Number.isFinite(stamp) ? stamp : Date.now()).toISOString();
}

export function canonicalizeWorktreeExecution(value: unknown): string {
  return canonicalizeJson(value);
}

export function fingerprintWorktreeRuntimeRecord(value: unknown): string {
  return fingerprintJson(value);
}

export function add(diagnostics: RuntimeRecordDiagnostic[], code: string, message: string, pathName?: string): void {
  diagnostics.push({ code, message, ...(pathName ? { path: pathName } : {}) });
}

export function exactFields(value: AnyRecord, allowed: readonly string[], root: string, diagnostics: RuntimeRecordDiagnostic[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) add(diagnostics, "UNKNOWN_FIELD", `unknown field ${key}`, `${root}.${key}`);
}

export function requiredIdentity(value: AnyRecord, key: string, root: string, diagnostics: RuntimeRecordDiagnostic[]): void {
  if (!text(value[key]) || !ID.test(value[key] as string)) add(diagnostics, "INVALID_IDENTITY", `${key} must be a stable identity`, `${root}.${key}`);
}

export function requiredHash(value: AnyRecord, key: string, root: string, diagnostics: RuntimeRecordDiagnostic[], gitObject = false): void {
  const pattern = gitObject ? GIT_OBJECT : HASH;
  if (!text(value[key]) || !pattern.test(value[key] as string)) add(diagnostics, "INVALID_HASH", `${key} has an invalid hash`, `${root}.${key}`);
}

export function uniqueStrings(value: unknown, allowed: Set<string> | null, pathName: string, diagnostics: RuntimeRecordDiagnostic[], allowEmpty = true): value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every(text)) {
    add(diagnostics, "INVALID_SHAPE", `${pathName} must be ${allowEmpty ? "a" : "a non-empty"} string array`, pathName);
    return false;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (seen.has(item)) add(diagnostics, "DUPLICATE_VALUE", `duplicate value ${item}`, pathName);
    if (allowed && !allowed.has(item)) add(diagnostics, "INVALID_VALUE", `unsupported value ${item}`, pathName);
    seen.add(item);
  }
  return true;
}

export function validateCleanup(input: unknown, root = "cleanup"): RollingValidationResult<CleanupState> {
  const diagnostics: RuntimeRecordDiagnostic[] = [];
  if (!isRecord(input)) return { valid: false, diagnostics: [{ code: "INVALID_SHAPE", message: "cleanup state must be an object", path: root }] };
  exactFields(input, ["schema_version", "status", "attempts", "last_error", "updated_at"], root, diagnostics);
  if (input.schema_version !== CLEANUP_STATE_SCHEMA_VERSION) add(diagnostics, "UNKNOWN_SCHEMA", `schema_version must be ${CLEANUP_STATE_SCHEMA_VERSION}`, `${root}.schema_version`);
  if (!CLEANUP_STATUSES.has(input.status as CleanupStatus)) add(diagnostics, "INVALID_STATE", "unsupported cleanup status", `${root}.status`);
  if (!safeInteger(input.attempts)) add(diagnostics, "INVALID_REVISION", "cleanup attempts must be non-negative", `${root}.attempts`);
  if (input.last_error !== undefined && !text(input.last_error)) add(diagnostics, "INVALID_SHAPE", "last_error must be non-empty when present", `${root}.last_error`);
  if (!iso(input.updated_at)) add(diagnostics, "INVALID_TIMESTAMP", "updated_at must be an ISO timestamp", `${root}.updated_at`);
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as unknown as CleanupState }) };
}

export function validateTransition(input: unknown, root: string): RollingValidationResult<WorktreeLifecycleTransition> {
  const diagnostics: RuntimeRecordDiagnostic[] = [];
  if (!isRecord(input)) return { valid: false, diagnostics: [{ code: "INVALID_SHAPE", message: "transition must be an object", path: root }] };
  exactFields(input, ["sequence", "idempotency_key", "phase", "from_state", "to_state", "payload_fingerprint", "recorded_at"], root, diagnostics);
  if (!safeInteger(input.sequence)) add(diagnostics, "INVALID_SEQUENCE", "sequence must be non-negative", `${root}.sequence`);
  requiredIdentity(input, "idempotency_key", root, diagnostics);
  if (!PHASES.has(input.phase as WorktreeTransitionPhase)) add(diagnostics, "INVALID_PHASE", "unsupported transition phase", `${root}.phase`);
  if (!LIFECYCLE_STATES.has(input.from_state as WorktreeLifecycleState)) add(diagnostics, "INVALID_STATE", "unsupported from_state", `${root}.from_state`);
  if (!LIFECYCLE_STATES.has(input.to_state as WorktreeLifecycleState)) add(diagnostics, "INVALID_STATE", "unsupported to_state", `${root}.to_state`);
  requiredHash(input, "payload_fingerprint", root, diagnostics);
  if (!iso(input.recorded_at)) add(diagnostics, "INVALID_TIMESTAMP", "recorded_at must be an ISO timestamp", `${root}.recorded_at`);
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as unknown as WorktreeLifecycleTransition }) };
}

export function validateSetupFailure(input: unknown, root: string): RollingValidationResult<WorktreeSetupFailureDiagnostic> {
  const diagnostics: RuntimeRecordDiagnostic[] = [];
  if (!isRecord(input)) return { valid: false, diagnostics: [{ code: "INVALID_SHAPE", message: "setup failure must be an object", path: root }] };
  exactFields(input, ["code", "message", "stage", "execution_root_state", "registration_present", "recorded_at"], root, diagnostics);
  if (!text(input.code) || !text(input.message)) add(diagnostics, "INVALID_SHAPE", "setup failure code and message are required", root);
  if (!["registration", "materialization", "identity_verification"].includes(String(input.stage))) add(diagnostics, "INVALID_STATE", "unsupported setup failure stage", `${root}.stage`);
  if (!["absent", "directory", "other"].includes(String(input.execution_root_state))) add(diagnostics, "INVALID_STATE", "unsupported execution root state", `${root}.execution_root_state`);
  if (typeof input.registration_present !== "boolean") add(diagnostics, "INVALID_SHAPE", "registration_present must be boolean", `${root}.registration_present`);
  if (!iso(input.recorded_at)) add(diagnostics, "INVALID_TIMESTAMP", "recorded_at must be an ISO timestamp", `${root}.recorded_at`);
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as unknown as WorktreeSetupFailureDiagnostic }) };
}

export function validateWorktreeRecord(input: unknown): RollingValidationResult<WorktreeRecord> {
  const diagnostics: RuntimeRecordDiagnostic[] = [];
  const root = "worktree_record";
  if (!isRecord(input)) return { valid: false, diagnostics: [{ code: "INVALID_SHAPE", message: "worktree record must be an object", path: root }] };
  exactFields(input, [
    "schema_version", "record_id", "revision", "execution_mode", "repository_id", "repository_root", "git_common_dir",
    "git_common_dir_identity", "execution_root", "base_tree", "run_id", "unit_key", "unit_version", "attempt_id",
    "setup_state", "setup_failure", "lifecycle_state", "native_handle", "bundle_id", "integration_id", "retention_reasons", "cleanup",
    "transition_log", "created_at", "updated_at", "fingerprint",
  ], root, diagnostics);
  if (input.schema_version !== WORKTREE_RECORD_SCHEMA_VERSION) add(diagnostics, "UNKNOWN_SCHEMA", `schema_version must be ${WORKTREE_RECORD_SCHEMA_VERSION}`, `${root}.schema_version`);
  for (const key of ["record_id", "run_id", "unit_key", "attempt_id"] as const) requiredIdentity(input, key, root, diagnostics);
  if (!safeInteger(input.revision)) add(diagnostics, "INVALID_REVISION", "revision must be non-negative", `${root}.revision`);
  if (input.execution_mode !== "isolated-worktree" && input.execution_mode !== "shared-worktree") add(diagnostics, "INVALID_MODE", "unsupported worktree execution mode", `${root}.execution_mode`);
  requiredHash(input, "repository_id", root, diagnostics);
  requiredHash(input, "git_common_dir_identity", root, diagnostics);
  requiredHash(input, "base_tree", root, diagnostics, true);
  for (const key of ["repository_root", "git_common_dir", "execution_root"] as const) if (!absolute(input[key])) add(diagnostics, "INVALID_PATH", `${key} must be a normalized absolute path`, `${root}.${key}`);
  if (!safeInteger(input.unit_version, 1)) add(diagnostics, "INVALID_VERSION", "unit_version must be positive", `${root}.unit_version`);
  if (!SETUP_STATES.has(input.setup_state as WorktreeSetupState)) add(diagnostics, "INVALID_STATE", "unsupported setup_state", `${root}.setup_state`);
  if (input.setup_failure !== null) diagnostics.push(...validateSetupFailure(input.setup_failure, `${root}.setup_failure`).diagnostics);
  if (input.setup_state === "failed" && input.setup_failure === null) add(diagnostics, "INVALID_SHAPE", "failed setup requires a diagnostic", `${root}.setup_failure`);
  if (input.setup_state !== "failed" && input.setup_failure !== null) add(diagnostics, "INVALID_STATE", "only failed setup may retain a diagnostic", `${root}.setup_failure`);
  if (!LIFECYCLE_STATES.has(input.lifecycle_state as WorktreeLifecycleState)) add(diagnostics, "INVALID_STATE", "unsupported lifecycle_state", `${root}.lifecycle_state`);
  for (const key of ["native_handle", "bundle_id", "integration_id"] as const) if (input[key] !== null && !text(input[key])) add(diagnostics, "INVALID_SHAPE", `${key} must be a non-empty string or null`, `${root}.${key}`);
  uniqueStrings(input.retention_reasons, RETENTION_REASONS as Set<string>, `${root}.retention_reasons`, diagnostics);
  diagnostics.push(...validateCleanup(input.cleanup, `${root}.cleanup`).diagnostics);
  if (!Array.isArray(input.transition_log)) add(diagnostics, "INVALID_SHAPE", "transition_log must be an array", `${root}.transition_log`);
  else {
    const idempotency = new Set<string>();
    let previousState: WorktreeLifecycleState = "preparing";
    for (const [index, transition] of input.transition_log.entries()) {
      const transitionRoot = `${root}.transition_log.${index}`;
      diagnostics.push(...validateTransition(transition, transitionRoot).diagnostics);
      if (!isRecord(transition)) continue;
      if (transition.sequence !== index) add(diagnostics, "INVALID_SEQUENCE", "transition sequence must be contiguous", `${transitionRoot}.sequence`);
      if (transition.from_state !== previousState) add(diagnostics, "INVALID_TRANSITION", "transition history is not contiguous", `${transitionRoot}.from_state`);
      if (text(transition.idempotency_key)) {
        if (idempotency.has(transition.idempotency_key)) add(diagnostics, "DUPLICATE_VALUE", "idempotency key is reused", `${transitionRoot}.idempotency_key`);
        idempotency.add(transition.idempotency_key);
      }
      if (LIFECYCLE_STATES.has(transition.to_state as WorktreeLifecycleState)) previousState = transition.to_state as WorktreeLifecycleState;
    }
    if (input.transition_log.length > 0 && input.lifecycle_state !== previousState) add(diagnostics, "INVALID_TRANSITION", "lifecycle_state does not match transition history", `${root}.lifecycle_state`);
    if (input.revision !== input.transition_log.length) add(diagnostics, "INVALID_REVISION", "revision must equal the number of persisted transitions", `${root}.revision`);
  }
  if (!iso(input.created_at) || !iso(input.updated_at)) add(diagnostics, "INVALID_TIMESTAMP", "created_at and updated_at must be ISO timestamps", root);
  requiredHash(input, "fingerprint", root, diagnostics);
  if (HASH.test(String(input.fingerprint || "")) && input.fingerprint !== fingerprintWorktreeRuntimeRecord(input)) add(diagnostics, "FINGERPRINT_MISMATCH", "worktree record fingerprint does not match", `${root}.fingerprint`);
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as unknown as WorktreeRecord }) };
}

export function validateManifestCommon(
  input: unknown,
  root: string,
  schema: number,
  allowed: readonly string[],
): { value?: AnyRecord; diagnostics: RuntimeRecordDiagnostic[] } {
  const diagnostics: RuntimeRecordDiagnostic[] = [];
  if (!isRecord(input)) return { diagnostics: [{ code: "INVALID_SHAPE", message: `${root} must be an object`, path: root }] };
  exactFields(input, allowed, root, diagnostics);
  if (input.schema_version !== schema) add(diagnostics, "UNKNOWN_SCHEMA", `schema_version must be ${schema}`, `${root}.schema_version`);
  requiredHash(input, "repository_id", root, diagnostics);
  requiredHash(input, "git_common_dir_identity", root, diagnostics);
  requiredHash(input, "fingerprint", root, diagnostics);
  if (!iso(input.created_at)) add(diagnostics, "INVALID_TIMESTAMP", "created_at must be an ISO timestamp", `${root}.created_at`);
  if (HASH.test(String(input.fingerprint || "")) && input.fingerprint !== fingerprintWorktreeRuntimeRecord(input)) add(diagnostics, "FINGERPRINT_MISMATCH", `${root} fingerprint does not match`, `${root}.fingerprint`);
  return { value: input, diagnostics };
}

export function validateSnapshotManifest(input: unknown): RollingValidationResult<SnapshotManifest> {
  const root = "snapshot_manifest";
  const result = validateManifestCommon(input, root, SNAPSHOT_MANIFEST_SCHEMA_VERSION, [
    "schema_version", "snapshot_id", "repository_id", "git_common_dir_identity", "source_root", "head_tree", "snapshot_tree",
    "included_paths", "excluded_paths", "git_facts", "caller_before_fingerprint", "caller_after_fingerprint", "created_at", "fingerprint",
  ]);
  const diagnostics = result.diagnostics;
  const value = result.value;
  if (value) {
    requiredIdentity(value, "snapshot_id", root, diagnostics);
    if (!absolute(value.source_root)) add(diagnostics, "INVALID_PATH", "source_root must be a normalized absolute path", `${root}.source_root`);
    requiredHash(value, "head_tree", root, diagnostics, true);
    requiredHash(value, "snapshot_tree", root, diagnostics, true);
    uniqueStrings(value.included_paths, null, `${root}.included_paths`, diagnostics);
    uniqueStrings(value.excluded_paths, null, `${root}.excluded_paths`, diagnostics);
    if (!isRecord(value.git_facts)) add(diagnostics, "INVALID_SHAPE", "git_facts must be an object", `${root}.git_facts`);
    requiredHash(value, "caller_before_fingerprint", root, diagnostics);
    requiredHash(value, "caller_after_fingerprint", root, diagnostics);
  }
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as SnapshotManifest }) };
}

export function validateChangeBundleManifest(input: unknown): RollingValidationResult<ChangeBundleManifest> {
  const root = "bundle_manifest";
  const result = validateManifestCommon(input, root, CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION, [
    "schema_version", "bundle_id", "run_id", "unit_key", "unit_version", "attempt_id", "receipt_id", "repository_id",
    "git_common_dir_identity", "base_tree", "result_tree", "operations", "changed_paths", "non_text_facts", "transport",
    "validation_summaries", "terminal_conclusion", "safety_verdict", "state", "retention_reasons", "created_at", "fingerprint",
  ]);
  const diagnostics = result.diagnostics;
  const value = result.value;
  if (value) {
    for (const key of ["bundle_id", "run_id", "unit_key", "attempt_id", "receipt_id"] as const) requiredIdentity(value, key, root, diagnostics);
    if (!safeInteger(value.unit_version, 1)) add(diagnostics, "INVALID_VERSION", "unit_version must be positive", `${root}.unit_version`);
    requiredHash(value, "base_tree", root, diagnostics, true);
    requiredHash(value, "result_tree", root, diagnostics, true);
    uniqueStrings(value.operations, OPERATIONS as Set<string>, `${root}.operations`, diagnostics);
    uniqueStrings(value.changed_paths, null, `${root}.changed_paths`, diagnostics);
    if (!isRecord(value.non_text_facts) || !isRecord(value.transport)) add(diagnostics, "INVALID_SHAPE", "non_text_facts and transport must be objects", root);
    uniqueStrings(value.validation_summaries, null, `${root}.validation_summaries`, diagnostics);
    if (!text(value.terminal_conclusion)) add(diagnostics, "INVALID_SHAPE", "terminal_conclusion is required", `${root}.terminal_conclusion`);
    if (value.safety_verdict !== "safe" && value.safety_verdict !== "rejected") add(diagnostics, "INVALID_STATE", "unsupported safety_verdict", `${root}.safety_verdict`);
    if (value.state !== undefined && value.state !== "ready_for_integration" && value.state !== "rejected") add(diagnostics, "INVALID_STATE", "unsupported bundle state", `${root}.state`);
    if (value.state === "ready_for_integration" && value.safety_verdict !== "safe") add(diagnostics, "INVALID_STATE", "only a safe bundle may be ready for integration", `${root}.state`);
    uniqueStrings(value.retention_reasons, RETENTION_REASONS as Set<string>, `${root}.retention_reasons`, diagnostics);
  }
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as ChangeBundleManifest }) };
}

export function validateIntegrationRecord(input: unknown): RollingValidationResult<IntegrationRecord> {
  const diagnostics: RuntimeRecordDiagnostic[] = [];
  const root = "integration_record";
  if (!isRecord(input)) return { valid: false, diagnostics: [{ code: "INVALID_SHAPE", message: "integration record must be an object", path: root }] };
  exactFields(input, [
    "schema_version", "integration_id", "revision", "run_id", "repository_id", "git_common_dir_identity", "bundle_id",
    "queue_position", "state", "before_tree", "after_tree", "conflicts", "application", "queue_order", "authorization", "resolution", "acceptance", "resolution_id", "idempotency_keys", "created_at", "updated_at", "fingerprint",
  ], root, diagnostics);
  if (input.schema_version !== INTEGRATION_RECORD_SCHEMA_VERSION) add(diagnostics, "UNKNOWN_SCHEMA", `schema_version must be ${INTEGRATION_RECORD_SCHEMA_VERSION}`, `${root}.schema_version`);
  for (const key of ["integration_id", "run_id", "bundle_id"] as const) requiredIdentity(input, key, root, diagnostics);
  requiredHash(input, "repository_id", root, diagnostics);
  requiredHash(input, "git_common_dir_identity", root, diagnostics);
  if (!safeInteger(input.revision) || !safeInteger(input.queue_position)) add(diagnostics, "INVALID_REVISION", "revision and queue_position must be non-negative", root);
  if (!INTEGRATION_STATES.has(input.state as IntegrationState)) add(diagnostics, "INVALID_STATE", "unsupported integration state", `${root}.state`);
  requiredHash(input, "before_tree", root, diagnostics, true);
  if (input.after_tree !== undefined && (!text(input.after_tree) || !GIT_OBJECT.test(input.after_tree))) add(diagnostics, "INVALID_HASH", "after_tree has an invalid hash", `${root}.after_tree`);
  if (!Array.isArray(input.conflicts) || !input.conflicts.every((item) => isRecord(item) && text(item.path)
    && ["content", "add_add", "rename", "delete_modify", "mode", "binary", "symlink", "gitlink"].includes(String(item.kind)))) {
    add(diagnostics, "INVALID_SHAPE", "conflicts must contain a bounded path/kind classification", `${root}.conflicts`);
  }
  if (input.application !== undefined) {
    const application = input.application;
    const applicationRoot = `${root}.application`;
    if (!isRecord(application)) add(diagnostics, "INVALID_SHAPE", "application must be an object", applicationRoot);
    else {
      exactFields(application, [
        "schema_version", "idempotency_key", "context", "before_tree", "bundle_base_tree", "bundle_result_tree",
        "prepared_at", "fingerprint",
      ], applicationRoot, diagnostics);
      if (application.schema_version !== 1 || application.context !== "baton-temporary-object-merge") {
        add(diagnostics, "UNKNOWN_SCHEMA", "application must use temporary object-merge schema 1", applicationRoot);
      }
      requiredIdentity(application, "idempotency_key", applicationRoot, diagnostics);
      for (const key of ["before_tree", "bundle_base_tree", "bundle_result_tree"] as const) {
        requiredHash(application, key, applicationRoot, diagnostics, true);
      }
      if (application.before_tree !== input.before_tree) add(diagnostics, "INVALID_STATE", "application before_tree must equal integration before_tree", applicationRoot);
      if (!iso(application.prepared_at)) add(diagnostics, "INVALID_TIMESTAMP", "application prepared_at must be an ISO timestamp", `${applicationRoot}.prepared_at`);
      requiredHash(application, "fingerprint", applicationRoot, diagnostics);
      if (HASH.test(String(application.fingerprint || ""))
        && application.fingerprint !== fingerprintWorktreeRuntimeRecord(application)) {
        add(diagnostics, "FINGERPRINT_MISMATCH", "application fingerprint does not match", `${applicationRoot}.fingerprint`);
      }
    }
  }
  if (input.resolution !== undefined) {
    const resolution = input.resolution;
    const resolutionRoot = `${root}.resolution`;
    if (!isRecord(resolution)) add(diagnostics, "INVALID_SHAPE", "resolution must be an object", resolutionRoot);
    else {
      exactFields(resolution, [
        "schema_version", "resolution_id", "integration_id", "bundle_id", "before_tree", "bundle_result_tree",
        "resolved_tree", "conflict_fingerprint", "conclusion", "operations", "changed_paths", "non_text_facts",
        "submitted_at", "fingerprint",
      ], resolutionRoot, diagnostics);
      if (resolution.schema_version !== 1) add(diagnostics, "UNKNOWN_SCHEMA", "resolution must use schema 1", resolutionRoot);
      for (const key of ["resolution_id", "integration_id", "bundle_id"] as const) requiredIdentity(resolution, key, resolutionRoot, diagnostics);
      for (const key of ["before_tree", "bundle_result_tree", "resolved_tree"] as const) requiredHash(resolution, key, resolutionRoot, diagnostics, true);
      requiredHash(resolution, "conflict_fingerprint", resolutionRoot, diagnostics);
      requiredHash(resolution, "fingerprint", resolutionRoot, diagnostics);
      if (!text(resolution.conclusion) || String(resolution.conclusion).length > 1000) add(diagnostics, "INVALID_SHAPE", "resolution conclusion must be concise", `${resolutionRoot}.conclusion`);
      uniqueStrings(resolution.operations, OPERATIONS as Set<string>, `${resolutionRoot}.operations`, diagnostics);
      uniqueStrings(resolution.changed_paths, null, `${resolutionRoot}.changed_paths`, diagnostics);
      if (!isRecord(resolution.non_text_facts)) add(diagnostics, "INVALID_SHAPE", "resolution non_text_facts must be an object", `${resolutionRoot}.non_text_facts`);
      if (!iso(resolution.submitted_at)) add(diagnostics, "INVALID_TIMESTAMP", "resolution submitted_at must be an ISO timestamp", `${resolutionRoot}.submitted_at`);
      if (resolution.integration_id !== input.integration_id || resolution.bundle_id !== input.bundle_id || resolution.before_tree !== input.before_tree) add(diagnostics, "INVALID_STATE", "resolution lineage must match the integration record", resolutionRoot);
      if (input.resolution_id !== resolution.resolution_id || input.after_tree !== resolution.resolved_tree) add(diagnostics, "INVALID_STATE", "resolution identity and tree must match the integration result", resolutionRoot);
      if (HASH.test(String(resolution.fingerprint || "")) && resolution.fingerprint !== fingerprintWorktreeRuntimeRecord(resolution)) add(diagnostics, "FINGERPRINT_MISMATCH", "resolution fingerprint does not match", `${resolutionRoot}.fingerprint`);
    }
  }
  if (input.acceptance !== undefined) {
    const acceptance = input.acceptance;
    const acceptanceRoot = `${root}.acceptance`;
    if (!isRecord(acceptance)) add(diagnostics, "INVALID_SHAPE", "acceptance must be an object", acceptanceRoot);
    else {
      exactFields(acceptance, ["schema_version", "idempotency_key", "before_tree", "after_tree", "integration_fingerprint", "conclusion", "prepared_at", "fingerprint"], acceptanceRoot, diagnostics);
      if (acceptance.schema_version !== 1) add(diagnostics, "UNKNOWN_SCHEMA", "acceptance must use schema 1", acceptanceRoot);
      requiredIdentity(acceptance, "idempotency_key", acceptanceRoot, diagnostics);
      for (const key of ["before_tree", "after_tree"] as const) requiredHash(acceptance, key, acceptanceRoot, diagnostics, true);
      for (const key of ["integration_fingerprint", "fingerprint"] as const) requiredHash(acceptance, key, acceptanceRoot, diagnostics);
      if (!text(acceptance.conclusion) || String(acceptance.conclusion).length > 1000) add(diagnostics, "INVALID_SHAPE", "acceptance conclusion must be concise", `${acceptanceRoot}.conclusion`);
      if (!iso(acceptance.prepared_at)) add(diagnostics, "INVALID_TIMESTAMP", "acceptance prepared_at must be an ISO timestamp", `${acceptanceRoot}.prepared_at`);
      if (acceptance.before_tree !== input.before_tree || acceptance.after_tree !== input.after_tree) add(diagnostics, "INVALID_STATE", "acceptance trees must match the integration record", acceptanceRoot);
      if (HASH.test(String(acceptance.fingerprint || "")) && acceptance.fingerprint !== fingerprintWorktreeRuntimeRecord(acceptance)) add(diagnostics, "FINGERPRINT_MISMATCH", "acceptance fingerprint does not match", `${acceptanceRoot}.fingerprint`);
    }
  }
  if (input.queue_order !== undefined) {
    const order = input.queue_order;
    const orderRoot = `${root}.queue_order`;
    if (!isRecord(order)) add(diagnostics, "INVALID_SHAPE", "queue_order must be an object", orderRoot);
    else {
      exactFields(order, [
        "schema_version", "source", "dependency_rank", "accepted_delta_index", "stable_unit_index", "unit_ref",
        "depends_on", "parent_order_override", "fingerprint",
      ], orderRoot, diagnostics);
      if (order.schema_version !== 1 || order.source !== "rolling-accepted-delta") add(diagnostics, "UNKNOWN_SCHEMA", "queue_order must use rolling accepted-delta schema 1", orderRoot);
      for (const key of ["dependency_rank", "accepted_delta_index", "stable_unit_index"] as const) {
        if (!safeInteger(order[key])) add(diagnostics, "INVALID_REVISION", `${key} must be non-negative`, `${orderRoot}.${key}`);
      }
      if (!text(order.unit_ref) || !UNIT_VERSION_REF.test(String(order.unit_ref))) add(diagnostics, "INVALID_IDENTITY", "unit_ref must be a stable unit version reference", `${orderRoot}.unit_ref`);
      uniqueStrings(order.depends_on, null, `${orderRoot}.depends_on`, diagnostics);
      if (Array.isArray(order.depends_on)) {
        for (const [index, dependency] of order.depends_on.entries()) {
          if (text(dependency) && !UNIT_VERSION_REF.test(dependency)) {
            add(diagnostics, "INVALID_IDENTITY", "dependency must be a stable unit version reference", `${orderRoot}.depends_on.${index}`);
          }
        }
      }
      if (order.parent_order_override !== null && !safeInteger(order.parent_order_override)) add(diagnostics, "INVALID_REVISION", "parent_order_override must be non-negative or null", `${orderRoot}.parent_order_override`);
      requiredHash(order, "fingerprint", orderRoot, diagnostics);
      if (HASH.test(String(order.fingerprint || "")) && order.fingerprint !== fingerprintWorktreeRuntimeRecord(order)) {
        add(diagnostics, "FINGERPRINT_MISMATCH", "queue_order fingerprint does not match", `${orderRoot}.fingerprint`);
      }
      if (order.parent_order_override !== null && order.parent_order_override !== input.queue_position) {
        add(diagnostics, "INVALID_STATE", "queue_position must equal the parent override", orderRoot);
      }
    }
  }
  if (input.authorization !== undefined) {
    const authorization = input.authorization;
    const authorizationRoot = `${root}.authorization`;
    if (!isRecord(authorization)) add(diagnostics, "INVALID_SHAPE", "authorization must be an object", authorizationRoot);
    else {
      exactFields(authorization, [
        "schema_version", "expected_before_tree", "observed_before_tree", "head", "head_tree", "branch_ref", "refs_digest",
        "reflog", "staged_tree", "index_control", "control_facts_fingerprint", "dirty_facts_fingerprint", "git_operation", "parent_order_override", "fingerprint",
      ], authorizationRoot, diagnostics);
      if (authorization.schema_version !== 1) add(diagnostics, "UNKNOWN_SCHEMA", "authorization schema_version must be 1", `${authorizationRoot}.schema_version`);
      for (const key of ["expected_before_tree", "observed_before_tree", "head", "head_tree", "staged_tree"] as const) {
        requiredHash(authorization, key, authorizationRoot, diagnostics, true);
      }
      for (const key of ["refs_digest", "control_facts_fingerprint", "dirty_facts_fingerprint", "fingerprint"] as const) requiredHash(authorization, key, authorizationRoot, diagnostics);
      if (typeof authorization.branch_ref !== "string") add(diagnostics, "INVALID_SHAPE", "branch_ref must be a string", `${authorizationRoot}.branch_ref`);
      if (authorization.git_operation !== null && !text(authorization.git_operation)) add(diagnostics, "INVALID_SHAPE", "git_operation must be a string or null", `${authorizationRoot}.git_operation`);
      if (authorization.parent_order_override !== null && !safeInteger(authorization.parent_order_override)) add(diagnostics, "INVALID_REVISION", "parent_order_override must be non-negative or null", `${authorizationRoot}.parent_order_override`);
      if (!isRecord(authorization.reflog) || !safeInteger(authorization.reflog.count) || !HASH.test(String(authorization.reflog.checksum || ""))) {
        add(diagnostics, "INVALID_SHAPE", "reflog must contain a non-negative count and checksum", `${authorizationRoot}.reflog`);
      }
      if (!isRecord(authorization.index_control)
        || !text(authorization.index_control.algorithm)
        || !HASH.test(String(authorization.index_control.checksum || ""))
        || !safeInteger(authorization.index_control.entry_count)) {
        add(diagnostics, "INVALID_SHAPE", "index_control is invalid", `${authorizationRoot}.index_control`);
      }
      if (HASH.test(String(authorization.fingerprint || ""))
        && authorization.fingerprint !== fingerprintWorktreeRuntimeRecord(authorization)) {
        add(diagnostics, "FINGERPRINT_MISMATCH", "authorization fingerprint does not match", `${authorizationRoot}.fingerprint`);
      }
      if (authorization.expected_before_tree !== input.before_tree || authorization.observed_before_tree !== input.before_tree) {
        add(diagnostics, "INVALID_STATE", "authorization tree must equal integration before_tree", authorizationRoot);
      }
    }
  }
  if (input.resolution_id !== undefined && (!text(input.resolution_id) || !ID.test(input.resolution_id))) add(diagnostics, "INVALID_IDENTITY", "resolution_id is invalid", `${root}.resolution_id`);
  uniqueStrings(input.idempotency_keys, null, `${root}.idempotency_keys`, diagnostics);
  if (!iso(input.created_at) || !iso(input.updated_at)) add(diagnostics, "INVALID_TIMESTAMP", "created_at and updated_at must be ISO timestamps", root);
  requiredHash(input, "fingerprint", root, diagnostics);
  if (HASH.test(String(input.fingerprint || "")) && input.fingerprint !== fingerprintWorktreeRuntimeRecord(input)) add(diagnostics, "FINGERPRINT_MISMATCH", "integration record fingerprint does not match", `${root}.fingerprint`);
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as unknown as IntegrationRecord }) };
}

export function assertResult<T>(result: RollingValidationResult<T>, label: string): T {
  if (!result.valid) throw new WorktreeExecutionError(`${label} is invalid: ${result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")}`, "WORKTREE_RECORD_INVALID", result.diagnostics);
  return result.value as T;
}

export const assertWorktreeRecord = (value: unknown) => assertResult(validateWorktreeRecord(value), "worktree record");
export const assertSnapshotManifest = (value: unknown) => assertResult(validateSnapshotManifest(value), "snapshot manifest");
export const assertChangeBundleManifest = (value: unknown) => assertResult(validateChangeBundleManifest(value), "bundle manifest");
export const assertIntegrationRecord = (value: unknown) => assertResult(validateIntegrationRecord(value), "integration record");

export function parse<T>(textValue: string, validate: (value: unknown) => RollingValidationResult<T>, label: string): T {
  let value: unknown;
  try { value = JSON.parse(textValue); }
  catch { throw new WorktreeExecutionError(`${label} is not valid JSON`, "WORKTREE_RECORD_CORRUPT"); }
  return assertResult(validate(value), label);
}

export const parseWorktreeRecord = (textValue: string) => parse(textValue, validateWorktreeRecord, "worktree record");
export const parseSnapshotManifest = (textValue: string) => parse(textValue, validateSnapshotManifest, "snapshot manifest");
export const parseChangeBundleManifest = (textValue: string) => parse(textValue, validateChangeBundleManifest, "bundle manifest");
export const parseIntegrationRecord = (textValue: string) => parse(textValue, validateIntegrationRecord, "integration record");

export function withFingerprint<T extends { fingerprint: string }>(value: Omit<T, "fingerprint"> | T): T {
  const copy = structuredClone(value) as T;
  copy.fingerprint = fingerprintWorktreeRuntimeRecord(copy);
  return copy;
}
