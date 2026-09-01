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

export const WORKTREE_RECORD_SCHEMA_VERSION = 2 as const;
export const SNAPSHOT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const INTEGRATION_RECORD_SCHEMA_VERSION = 1 as const;
export const CLEANUP_STATE_SCHEMA_VERSION = 1 as const;

export type WorktreeSetupState = "planned" | "registering" | "registered" | "verified" | "failed";
export type WorktreeLifecycleState =
  | "preparing"
  | "worker_active"
  | "terminal_awaiting_audit"
  | "rejected"
  | "bundle_ready"
  | "integrating"
  | "awaiting_parent_resolution"
  | "integrated"
  | "accepted"
  | "cleanup_eligible"
  | "cleaned"
  | "cleanup_failed";
export type WorktreeTransitionPhase =
  | "setup"
  | "native_execution"
  | "audit"
  | "bundling"
  | "integration"
  | "conflict"
  | "acceptance"
  | "cleanup";
export type RetentionReason =
  | "live_native_handle"
  | "terminal_unreleased_ticket"
  | "pending_audit"
  | "rejected_result_evidence"
  | "ready_bundle"
  | "active_integration"
  | "unresolved_conflict"
  | "downstream_base_dependency"
  | "user_requested";
export type CleanupStatus = "retained" | "eligible" | "cleaning" | "cleaned" | "failed";
export type IntegrationState = "queued" | "integrating" | "awaiting_parent_resolution" | "integrated" | "accepted" | "failed";

export interface WorktreeSetupFailureDiagnostic {
  code: string;
  message: string;
  stage: "registration" | "materialization" | "identity_verification";
  execution_root_state: "absent" | "directory" | "other";
  registration_present: boolean;
  recorded_at: string;
}

export interface CleanupState {
  schema_version: typeof CLEANUP_STATE_SCHEMA_VERSION;
  status: CleanupStatus;
  attempts: number;
  last_error?: string;
  updated_at: string;
}

export interface WorktreeLifecycleTransition {
  sequence: number;
  idempotency_key: string;
  phase: WorktreeTransitionPhase;
  from_state: WorktreeLifecycleState;
  to_state: WorktreeLifecycleState;
  payload_fingerprint: string;
  recorded_at: string;
}

export interface WorktreeRecord {
  schema_version: typeof WORKTREE_RECORD_SCHEMA_VERSION;
  record_id: string;
  revision: number;
  execution_mode: WorktreeExecutionMode;
  repository_id: string;
  repository_root: string;
  git_common_dir: string;
  git_common_dir_identity: string;
  execution_root: string;
  base_tree: string;
  run_id: string;
  unit_key: string;
  unit_version: number;
  attempt_id: string;
  setup_state: WorktreeSetupState;
  setup_failure: WorktreeSetupFailureDiagnostic | null;
  lifecycle_state: WorktreeLifecycleState;
  native_handle: string | null;
  bundle_id: string | null;
  integration_id: string | null;
  retention_reasons: RetentionReason[];
  cleanup: CleanupState;
  transition_log: WorktreeLifecycleTransition[];
  created_at: string;
  updated_at: string;
  fingerprint: string;
}

export interface SnapshotManifest {
  schema_version: typeof SNAPSHOT_MANIFEST_SCHEMA_VERSION;
  snapshot_id: string;
  repository_id: string;
  git_common_dir_identity: string;
  source_root: string;
  head_tree: string;
  snapshot_tree: string;
  included_paths: string[];
  excluded_paths: string[];
  git_facts: Record<string, unknown>;
  caller_before_fingerprint: string;
  caller_after_fingerprint: string;
  created_at: string;
  fingerprint: string;
}

export interface ChangeBundleManifest {
  schema_version: typeof CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION;
  bundle_id: string;
  run_id: string;
  unit_key: string;
  unit_version: number;
  attempt_id: string;
  receipt_id: string;
  repository_id: string;
  git_common_dir_identity: string;
  base_tree: string;
  result_tree: string;
  operations: SafetyOperation[];
  changed_paths: string[];
  non_text_facts: Record<string, unknown>;
  transport: Record<string, unknown>;
  validation_summaries: string[];
  terminal_conclusion: string;
  safety_verdict: "safe" | "rejected";
  retention_reasons: RetentionReason[];
  created_at: string;
  fingerprint: string;
}

export interface IntegrationConflict {
  path: string;
  kind: "content" | "add_add" | "rename" | "delete_modify" | "mode" | "binary" | "symlink" | "gitlink" | string;
  detail?: string;
}

export interface IntegrationRecord {
  schema_version: typeof INTEGRATION_RECORD_SCHEMA_VERSION;
  integration_id: string;
  revision: number;
  run_id: string;
  repository_id: string;
  git_common_dir_identity: string;
  bundle_id: string;
  queue_position: number;
  state: IntegrationState;
  before_tree: string;
  after_tree?: string;
  conflicts: IntegrationConflict[];
  resolution_id?: string;
  idempotency_keys: string[];
  created_at: string;
  updated_at: string;
  fingerprint: string;
}

export interface CreateWorktreeRecordInput {
  record_id?: string;
  execution_mode?: WorktreeExecutionMode;
  repository_id: string;
  repository_root: string;
  git_common_dir: string;
  git_common_dir_identity: string;
  execution_root: string;
  base_tree: string;
  run_id: string;
  unit_key: string;
  unit_version: number;
  attempt_id: string;
  created_at?: string | number | Date;
}

export interface WorktreeTransitionInput {
  idempotency_key: string;
  phase: WorktreeTransitionPhase;
  to_state: WorktreeLifecycleState;
  expected_revision?: number;
  recorded_at?: string | number | Date;
  setup_state?: WorktreeSetupState;
  setup_failure?: WorktreeSetupFailureDiagnostic | null;
  native_handle?: string | null;
  bundle_id?: string | null;
  integration_id?: string | null;
  retention_reasons?: RetentionReason[];
  cleanup?: CleanupState;
}

export interface RuntimeRecordDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export type WorktreeExecutionErrorCode =
  | "WORKTREE_RECORD_INVALID"
  | "WORKTREE_RECORD_CORRUPT"
  | "WORKTREE_RECORD_MISSING"
  | "WORKTREE_RECORD_CONFLICT"
  | "WORKTREE_IDEMPOTENCY_CONFLICT"
  | "WORKTREE_REVISION_MISMATCH"
  | "WORKTREE_TRANSITION_INVALID"
  | "WORKTREE_IDENTITY_MISMATCH"
  | "ISOLATED_WORKTREE_REQUIRED";

export class WorktreeExecutionError extends Error {
  readonly code: WorktreeExecutionErrorCode;
  readonly diagnostics?: readonly RuntimeRecordDiagnostic[];

  constructor(message: string, code: WorktreeExecutionErrorCode, diagnostics?: readonly RuntimeRecordDiagnostic[]) {
    super(message);
    this.name = "WorktreeExecutionError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

type AnyRecord = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/u;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SETUP_STATES = new Set<WorktreeSetupState>(["planned", "registering", "registered", "verified", "failed"]);
const LIFECYCLE_STATES = new Set<WorktreeLifecycleState>([
  "preparing", "worker_active", "terminal_awaiting_audit", "rejected", "bundle_ready", "integrating",
  "awaiting_parent_resolution", "integrated", "accepted", "cleanup_eligible", "cleaned", "cleanup_failed",
]);
const PHASES = new Set<WorktreeTransitionPhase>(["setup", "native_execution", "audit", "bundling", "integration", "conflict", "acceptance", "cleanup"]);
const RETENTION_REASONS = new Set<RetentionReason>([
  "live_native_handle", "terminal_unreleased_ticket", "pending_audit", "rejected_result_evidence", "ready_bundle",
  "active_integration", "unresolved_conflict", "downstream_base_dependency", "user_requested",
]);
const CLEANUP_STATUSES = new Set<CleanupStatus>(["retained", "eligible", "cleaning", "cleaned", "failed"]);
const INTEGRATION_STATES = new Set<IntegrationState>(["queued", "integrating", "awaiting_parent_resolution", "integrated", "accepted", "failed"]);
const OPERATIONS = new Set<SafetyOperation>(["write", "create", "delete", "rename", "chmod"]);

const ALLOWED_TRANSITIONS = new Set<string>([
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

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function iso(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

function absolute(value: unknown): value is string {
  return text(value) && path.isAbsolute(value) && path.normalize(value) === value;
}

function now(value?: string | number | Date): string {
  const stamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value || "");
  return new Date(Number.isFinite(stamp) ? stamp : Date.now()).toISOString();
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

export function canonicalizeWorktreeExecution(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function withoutFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFingerprint);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "fingerprint")
    .map(([key, item]) => [key, withoutFingerprint(item)]));
}

export function fingerprintWorktreeRuntimeRecord(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalizeWorktreeExecution(withoutFingerprint(value))).digest("hex");
}

function add(diagnostics: RuntimeRecordDiagnostic[], code: string, message: string, pathName?: string): void {
  diagnostics.push({ code, message, ...(pathName ? { path: pathName } : {}) });
}

function exactFields(value: AnyRecord, allowed: readonly string[], root: string, diagnostics: RuntimeRecordDiagnostic[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) add(diagnostics, "UNKNOWN_FIELD", `unknown field ${key}`, `${root}.${key}`);
}

function requiredIdentity(value: AnyRecord, key: string, root: string, diagnostics: RuntimeRecordDiagnostic[]): void {
  if (!text(value[key]) || !ID.test(value[key] as string)) add(diagnostics, "INVALID_IDENTITY", `${key} must be a stable identity`, `${root}.${key}`);
}

function requiredHash(value: AnyRecord, key: string, root: string, diagnostics: RuntimeRecordDiagnostic[], gitObject = false): void {
  const pattern = gitObject ? GIT_OBJECT : HASH;
  if (!text(value[key]) || !pattern.test(value[key] as string)) add(diagnostics, "INVALID_HASH", `${key} has an invalid hash`, `${root}.${key}`);
}

function uniqueStrings(value: unknown, allowed: Set<string> | null, pathName: string, diagnostics: RuntimeRecordDiagnostic[], allowEmpty = true): value is string[] {
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

function validateCleanup(input: unknown, root = "cleanup"): RollingValidationResult<CleanupState> {
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

function validateTransition(input: unknown, root: string): RollingValidationResult<WorktreeLifecycleTransition> {
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

function validateSetupFailure(input: unknown, root: string): RollingValidationResult<WorktreeSetupFailureDiagnostic> {
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

function validateManifestCommon(
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
    "validation_summaries", "terminal_conclusion", "safety_verdict", "retention_reasons", "created_at", "fingerprint",
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
    "queue_position", "state", "before_tree", "after_tree", "conflicts", "resolution_id", "idempotency_keys", "created_at", "updated_at", "fingerprint",
  ], root, diagnostics);
  if (input.schema_version !== INTEGRATION_RECORD_SCHEMA_VERSION) add(diagnostics, "UNKNOWN_SCHEMA", `schema_version must be ${INTEGRATION_RECORD_SCHEMA_VERSION}`, `${root}.schema_version`);
  for (const key of ["integration_id", "run_id", "bundle_id"] as const) requiredIdentity(input, key, root, diagnostics);
  requiredHash(input, "repository_id", root, diagnostics);
  requiredHash(input, "git_common_dir_identity", root, diagnostics);
  if (!safeInteger(input.revision) || !safeInteger(input.queue_position)) add(diagnostics, "INVALID_REVISION", "revision and queue_position must be non-negative", root);
  if (!INTEGRATION_STATES.has(input.state as IntegrationState)) add(diagnostics, "INVALID_STATE", "unsupported integration state", `${root}.state`);
  requiredHash(input, "before_tree", root, diagnostics, true);
  if (input.after_tree !== undefined && (!text(input.after_tree) || !GIT_OBJECT.test(input.after_tree))) add(diagnostics, "INVALID_HASH", "after_tree has an invalid hash", `${root}.after_tree`);
  if (!Array.isArray(input.conflicts) || !input.conflicts.every((item) => isRecord(item) && text(item.path) && text(item.kind))) add(diagnostics, "INVALID_SHAPE", "conflicts must contain path/kind objects", `${root}.conflicts`);
  if (input.resolution_id !== undefined && (!text(input.resolution_id) || !ID.test(input.resolution_id))) add(diagnostics, "INVALID_IDENTITY", "resolution_id is invalid", `${root}.resolution_id`);
  uniqueStrings(input.idempotency_keys, null, `${root}.idempotency_keys`, diagnostics);
  if (!iso(input.created_at) || !iso(input.updated_at)) add(diagnostics, "INVALID_TIMESTAMP", "created_at and updated_at must be ISO timestamps", root);
  requiredHash(input, "fingerprint", root, diagnostics);
  if (HASH.test(String(input.fingerprint || "")) && input.fingerprint !== fingerprintWorktreeRuntimeRecord(input)) add(diagnostics, "FINGERPRINT_MISMATCH", "integration record fingerprint does not match", `${root}.fingerprint`);
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as unknown as IntegrationRecord }) };
}

function assertResult<T>(result: RollingValidationResult<T>, label: string): T {
  if (!result.valid) throw new WorktreeExecutionError(`${label} is invalid: ${result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")}`, "WORKTREE_RECORD_INVALID", result.diagnostics);
  return result.value as T;
}

export const assertWorktreeRecord = (value: unknown) => assertResult(validateWorktreeRecord(value), "worktree record");
export const assertSnapshotManifest = (value: unknown) => assertResult(validateSnapshotManifest(value), "snapshot manifest");
export const assertChangeBundleManifest = (value: unknown) => assertResult(validateChangeBundleManifest(value), "bundle manifest");
export const assertIntegrationRecord = (value: unknown) => assertResult(validateIntegrationRecord(value), "integration record");

function parse<T>(textValue: string, validate: (value: unknown) => RollingValidationResult<T>, label: string): T {
  let value: unknown;
  try { value = JSON.parse(textValue); }
  catch { throw new WorktreeExecutionError(`${label} is not valid JSON`, "WORKTREE_RECORD_CORRUPT"); }
  return assertResult(validate(value), label);
}

export const parseWorktreeRecord = (textValue: string) => parse(textValue, validateWorktreeRecord, "worktree record");
export const parseSnapshotManifest = (textValue: string) => parse(textValue, validateSnapshotManifest, "snapshot manifest");
export const parseChangeBundleManifest = (textValue: string) => parse(textValue, validateChangeBundleManifest, "bundle manifest");
export const parseIntegrationRecord = (textValue: string) => parse(textValue, validateIntegrationRecord, "integration record");

function withFingerprint<T extends { fingerprint: string }>(value: Omit<T, "fingerprint"> | T): T {
  const copy = structuredClone(value) as T;
  copy.fingerprint = fingerprintWorktreeRuntimeRecord(copy);
  return copy;
}

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

export const createWorktreeRecord = initializeWorktreeRecord;

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
  if (!sameStateSetup && !ALLOWED_TRANSITIONS.has(`${record.lifecycle_state}>${input.to_state}`)) {
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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    try {
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { /* directory fsync is not available on every platform */ }
  } catch (cause) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* noop */ }
    try { fs.unlinkSync(temporary); } catch { /* preserve the original error */ }
    throw cause;
  }
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
  if (!selected.primary) fs.renameSync(selected.file, file);
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
    const current = recoverAtomicRecord(file, parseIntegrationRecord, (record) => record.integration_id, (record) => record.revision, value.integration_id);
    if (current.fingerprint === value.fingerprint) return current;
    if (value.revision !== current.revision + 1) throw new WorktreeExecutionError(`integration revision ${value.revision} does not follow ${current.revision}`, "WORKTREE_REVISION_MISMATCH");
  } else if (value.revision !== 0) throw new WorktreeExecutionError("the first integration record must have revision zero", "WORKTREE_REVISION_MISMATCH");
  atomicJson(file, value);
  return value;
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
  );
}

export const readWorktreeRecord = readPersistedWorktreeRecord;
export const writeWorktreeRecordAtomic = persistWorktreeRecord;
export const transitionWorktreeRecord = transitionPersistedWorktreeRecord;
export const writeSnapshotManifestAtomic = persistSnapshotManifest;
export const writeChangeBundleManifestAtomic = persistChangeBundleManifest;
export const writeIntegrationRecordAtomic = persistIntegrationRecord;
export { resolveWorktreeExecutionMode };
export type { WorktreeExecutionMode };
