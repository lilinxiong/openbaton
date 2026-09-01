/**
 * Source-neutral, append-only planning documents used by rolling execution.
 *
 * This module is deliberately a pure boundary.  It does not read a task
 * source, persist a run, schedule a unit, or infer missing execution facts.
 * Every document is versioned and its wire representation is snake_case.
 */
import type { SafetyOperation } from "./safety.js";
import { canonicalizeJson, sha256Hex } from "./json-utils.js";
import { isNonEmptyString, isRecord } from "./validate-utils.js";

export const ROLLING_PROTOCOL_SCHEMA_VERSION = 1 as const;
export const TASK_SOURCE_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const TASK_MANIFEST_PAGE_SCHEMA_VERSION = 1 as const;
export const TASK_MANIFEST_ENTRY_SCHEMA_VERSION = 1 as const;
export const PLAN_DELTA_SCHEMA_VERSION = 1 as const;
export const UNIT_VERSION_SCHEMA_VERSION = 1 as const;
export const GATE_VERSION_SCHEMA_VERSION = 1 as const;
export const TASK_COVERAGE_SCHEMA_VERSION = 1 as const;
export const TASK_SEAL_SCHEMA_VERSION = 1 as const;
export const SUPERSESSION_SCHEMA_VERSION = 1 as const;
export const LOCAL_FAILURE_SCHEMA_VERSION = 1 as const;
export const RETRY_ATTEMPT_SCHEMA_VERSION = 1 as const;
/** Worktree isolation is available only on the durable rolling-run v2 state. */
export const ROLLING_WORKTREE_STATE_SCHEMA_VERSION = 2 as const;
/** Short aliases used by callers that treat the protocol as one wire schema. */

export type RollingSourceKind = "openspec" | "director";
export type TaskSourceState = "pending" | "complete" | "unavailable";
export type UnitExecutionMode = "patch-only" | "verification-only";
/**
 * Where a writing unit executes. This is deliberately separate from
 * `UnitExecutionMode`, which is the patch/verification contract already
 * persisted by rolling protocol v1 documents.
 */
export type WorktreeExecutionMode = "isolated-worktree" | "shared-worktree";
export type UnitRouteProfile = "coding" | "runner" | "longctx";
export type GateType = "safety-precondition" | "integration-acceptance" | "evidence";
export type CoverageKind = "unit" | "gate" | "no-op";
export type FailureOwner = "manifest_entry" | "delta" | "unit_version" | "attempt" | "gate_version" | "seal" | "reconciliation";
export type RetryAttemptState = "pending" | "reserved" | "running" | "succeeded" | "failed" | "cancelled";

export interface RepositoryLocalUnitPart {
  part_key: string;
  repository_id: string;
  write_paths: string[];
  /** Repository-local predecessors, expressed as sibling part keys. */
  depends_on: string[];
  /** Stable deterministic parent integration order for this semantic unit. */
  integration_order: number;
  integration_gate_keys?: string[];
}

export interface TaskSourceDescriptor {
  schema_version: typeof TASK_SOURCE_DESCRIPTOR_SCHEMA_VERSION;
  source_kind: RollingSourceKind;
  adapter: string;
  /** Adapter-owned selection/configuration. Baton preserves its shape. */
  selection?: unknown;
  /** Adapter-owned identity, when a source has one before discovery. */
  source_ref?: unknown;
  source_fingerprint?: string;
  fingerprint?: string;
}

export interface TaskManifestEntry {
  schema_version: typeof TASK_MANIFEST_ENTRY_SCHEMA_VERSION;
  /** Baton-owned identity, stable for the lifetime of a run. */
  task_key: string;
  source_kind: RollingSourceKind;
  /** Opaque source identity. It must not be interpreted by the kernel. */
  source_ref: unknown;
  display_id: string;
  title: string;
  source_fingerprint: string;
  source_state: TaskSourceState;
  discovery_sequence: number;
  /** OpenSpec's apply ordinal, when applicable; never used for reconciliation. */
  apply_ordinal?: number;
  metadata?: Record<string, unknown>;
  fingerprint?: string;
}

export interface TaskManifestPage {
  schema_version: typeof TASK_MANIFEST_PAGE_SCHEMA_VERSION;
  source: TaskSourceDescriptor;
  entries: TaskManifestEntry[];
  cursor?: string | null;
  next_cursor?: string | null;
  has_more: boolean;
  fingerprint?: string;
}
export type TaskManifest = TaskManifestPage;

export interface UnitVersion {
  schema_version: typeof UNIT_VERSION_SCHEMA_VERSION;
  unit_key: string;
  version: number;
  task_keys: string[];
  depends_on: string[];
  execution_mode: UnitExecutionMode;
  /** Explicit worktree policy. Absence is reserved for legacy/shared state. */
  worktree_mode?: WorktreeExecutionMode;
  /** Configured host profile selected by policy, never a raw model override. */
  route_profile?: UnitRouteProfile;
  prompt?: string;
  recipe?: string;
  description?: string;
  write_paths?: string[];
  allowed_operations?: SafetyOperation[];
  read_context?: unknown;
  completion_criteria?: string[];
  permitted_validation?: string[];
  input_fingerprints?: Record<string, string>;
  required_gate_keys?: string[];
  /** Required when one semantic unit is explicitly split across repositories. */
  repository_parts?: RepositoryLocalUnitPart[];
  /** Parent-owned gates that order/accept cross-repository integration. */
  integration_gate_keys?: string[];
  fingerprint?: string;
}

export interface GateVersion {
  schema_version: typeof GATE_VERSION_SCHEMA_VERSION;
  gate_key: string;
  version: number;
  type: GateType;
  task_keys: string[];
  depends_on: string[];
  acceptance_contract?: unknown;
  relevant_input_fingerprints?: Record<string, string>;
  fingerprint?: string;
}

export interface TaskCoverage {
  schema_version: typeof TASK_COVERAGE_SCHEMA_VERSION;
  task_key: string;
  kind: CoverageKind;
  unit_versions?: string[];
  gate_versions?: string[];
  /** Required for an explicit no-op; an empty task is never implicit coverage. */
  reason?: string;
  fingerprint?: string;
}

export interface TaskSeal {
  schema_version: typeof TASK_SEAL_SCHEMA_VERSION;
  task_key: string;
  required_unit_versions: string[];
  required_gate_versions: string[];
  source_fingerprint: string;
  sealed_at?: string;
  fingerprint?: string;
}

export interface Supersession {
  schema_version: typeof SUPERSESSION_SCHEMA_VERSION;
  owner: "unit_version" | "gate_version";
  previous: string;
  successor: string;
  reason: string;
  fingerprint?: string;
}

export interface LocalFailure {
  schema_version: typeof LOCAL_FAILURE_SCHEMA_VERSION;
  owner: FailureOwner;
  owner_key: string;
  owner_version?: number;
  code: string;
  message: string;
  retryable: boolean;
  caused_by?: string;
  recorded_at?: string;
  fingerprint?: string;
}

export interface RetryAttempt {
  schema_version: typeof RETRY_ATTEMPT_SCHEMA_VERSION;
  attempt_key: string;
  unit_key: string;
  unit_version: number;
  attempt: number;
  state: RetryAttemptState;
  retry_of?: string;
  failure_key?: string;
  fingerprint?: string;
}

export interface PlanDelta {
  schema_version: typeof PLAN_DELTA_SCHEMA_VERSION;
  delta_id: string;
  prepared_from_append_sequence: number;
  manifest_additions?: TaskManifestEntry[];
  manifest_refreshes?: TaskManifestEntry[];
  unit_versions: UnitVersion[];
  gate_versions: GateVersion[];
  task_coverage: TaskCoverage[];
  supersessions?: Supersession[];
  local_failures?: LocalFailure[];
  retry_attempts?: RetryAttempt[];
  seals?: TaskSeal[];
  fingerprint?: string;
}

export interface RollingDiagnostic {
  code: string;
  message: string;
  path?: string;
  refs?: string[];
}

export interface RollingValidationResult<T> {
  valid: boolean;
  diagnostics: RollingDiagnostic[];
  value?: T;
}

export class RollingProtocolValidationError extends Error {
  readonly diagnostics: RollingDiagnostic[];
  constructor(diagnostics: RollingDiagnostic[]) {
    super(diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
    this.name = "RollingProtocolValidationError";
    this.diagnostics = diagnostics;
  }
}

export class RollingWorktreeModeError extends Error {
  readonly code: "ROLLING_V2_REQUIRED" | "WORKTREE_MODE_INVALID" | "WORKTREE_MODE_REQUIRED" | "WORKTREE_MODE_IMMUTABLE";
  constructor(message: string, code: RollingWorktreeModeError["code"]) {
    super(message);
    this.name = "RollingWorktreeModeError";
    this.code = code;
  }
}

type AnyRecord = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const OPERATIONS = new Set<SafetyOperation>(["write", "create", "delete", "rename", "chmod"]);
const GATES = new Set<GateType>(["safety-precondition", "integration-acceptance", "evidence"]);
const SOURCES = new Set<RollingSourceKind>(["openspec", "director"]);
const WORKTREE_MODES = new Set<WorktreeExecutionMode>(["isolated-worktree", "shared-worktree"]);

function has(value: AnyRecord, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function nonEmpty(value: unknown): value is string { return isNonEmptyString(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value); }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(nonEmpty); }
function issue(out: RollingDiagnostic[], code: string, message: string, path?: string, refs?: string[]): void {
  out.push({ code, message, ...(path ? { path } : {}), ...(refs ? { refs } : {}) });
}
function unknownFields(value: AnyRecord, allowed: readonly string[], path: string, out: RollingDiagnostic[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) issue(out, "UNKNOWN_FIELD", `unknown field ${key}`, `${path}.${key}`);
}
function requiredString(value: AnyRecord, key: string, path: string, out: RollingDiagnostic[], identity = false): void {
  if (!nonEmpty(value[key])) issue(out, "REQUIRED_FIELD", `${key} is required`, `${path}.${key}`);
  else if (identity && !ID.test(value[key] as string)) issue(out, "INVALID_IDENTITY", `${key} is not a stable identity`, `${path}.${key}`);
}
function requiredArray(value: AnyRecord, key: string, path: string, out: RollingDiagnostic[]): void {
  if (!Array.isArray(value[key])) issue(out, "REQUIRED_FIELD", `${key} must be an array`, `${path}.${key}`);
}
function checkHash(value: unknown, key: string, path: string, out: RollingDiagnostic[]): void {
  if (value !== undefined && (!nonEmpty(value) || !HASH.test(value))) issue(out, "INVALID_FINGERPRINT", `${key} must be a SHA-256 hex string`, `${path}.${key}`);
}
function uniqueStrings(values: unknown, path: string, out: RollingDiagnostic[]): void {
  if (!stringArray(values)) return;
  const seen = new Set<string>();
  for (const [index, item] of values.entries()) {
    if (!ID.test(item)) issue(out, "INVALID_IDENTITY", "identity contains unsupported characters", `${path}.${index}`);
    if (seen.has(item)) issue(out, "DUPLICATE_KEY", `duplicate identity ${item}`, `${path}.${index}`);
    seen.add(item);
  }
}
function uniqueVersionRefs(values: unknown, path: string, out: RollingDiagnostic[]): void {
  if (!stringArray(values)) return;
  const seen = new Set<string>();
  for (const [index, item] of values.entries()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@[1-9][0-9]*$/.test(item)) issue(out, "INVALID_IDENTITY", "version reference is malformed", `${path}.${index}`);
    if (seen.has(item)) issue(out, "DUPLICATE_KEY", `duplicate version reference ${item}`, `${path}.${index}`);
    seen.add(item);
  }
}
function checkVersion(value: AnyRecord, path: string, out: RollingDiagnostic[], schema: number): void {
  if (value.schema_version !== schema) issue(out, "UNKNOWN_SCHEMA", `schema_version must be ${schema}`, `${path}.schema_version`);
}
function checkObject(value: unknown, path: string, out: RollingDiagnostic[]): value is AnyRecord {
  if (!isRecord(value)) { issue(out, "INVALID_SHAPE", "expected an object", path); return false; }
  return true;
}

function worktreeMode(value: unknown): WorktreeExecutionMode | undefined {
  return typeof value === "string" && WORKTREE_MODES.has(value as WorktreeExecutionMode)
    ? value as WorktreeExecutionMode
    : undefined;
}

/**
 * Resolve one persisted rolling run's worktree policy without migrating it.
 * Version-1/manual state has only the explicit compatibility result
 * `shared-worktree`; isolated mode is never inferred after a setup failure.
 */
export function resolveWorktreeExecutionMode(state: unknown, requested?: unknown): WorktreeExecutionMode {
  const source = isRecord(state) ? state : {};
  const identity = isRecord(source.identity) ? source.identity : {};
  const schemaVersion = source.schema_version;
  const rawPersisted = identity.execution_mode ?? source.worktree_mode ?? source.execution_mode;
  const persisted = worktreeMode(rawPersisted);
  const desired = worktreeMode(requested);
  if (rawPersisted !== undefined && !persisted) {
    throw new RollingWorktreeModeError("persisted worktree execution mode is unsupported", "WORKTREE_MODE_INVALID");
  }
  if (requested !== undefined && !desired) {
    throw new RollingWorktreeModeError("requested worktree execution mode is unsupported", "WORKTREE_MODE_INVALID");
  }
  if (persisted && desired && persisted !== desired) {
    throw new RollingWorktreeModeError("an active rolling run cannot change worktree execution mode", "WORKTREE_MODE_IMMUTABLE");
  }
  const selected = desired || persisted;
  if (schemaVersion !== ROLLING_WORKTREE_STATE_SCHEMA_VERSION) {
    if (selected === "isolated-worktree") {
      throw new RollingWorktreeModeError("isolated worktree execution requires rolling-run v2 state", "ROLLING_V2_REQUIRED");
    }
    return "shared-worktree";
  }
  if (!selected) {
    throw new RollingWorktreeModeError("rolling-run v2 state must persist an explicit worktree execution mode", "WORKTREE_MODE_REQUIRED");
  }
  return selected;
}


/** Canonical JSON: object keys sorted recursively; array order is semantic. */
export function canonicalizeRolling(value: unknown): string {
  return canonicalizeJson(value);
}

const OPAQUE_FINGERPRINT_SUBTREES = new Set([
  "selection",
  "source_ref",
  "metadata",
  "acceptance_contract",
  "read_context",
]);

function withoutFingerprints(value: unknown, omitSequence = false): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutFingerprints(item, omitSequence));
  if (!isRecord(value)) return value;
  const copy: AnyRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "fingerprint") continue;
    if (omitSequence && (key === "append_sequence" || key === "run_append_sequence" || key === "prepared_from_append_sequence")) continue;
    copy[key] = OPAQUE_FINGERPRINT_SUBTREES.has(key) ? item : withoutFingerprints(item, omitSequence);
  }
  return copy;
}
function sha(value: unknown, omitSequence = false): string {
  return sha256Hex(canonicalizeRolling(withoutFingerprints(value, omitSequence)));
}

export function fingerprintTaskSourceDescriptor(value: TaskSourceDescriptor | unknown): string { return sha(value); }
export function fingerprintTaskManifestEntry(value: TaskManifestEntry | unknown): string { return sha(value); }
export function fingerprintUnitVersion(value: UnitVersion | unknown): string { return sha(value, true); }
export function fingerprintGateVersion(value: GateVersion | unknown): string { return sha(value, true); }
export function fingerprintTaskCoverage(value: TaskCoverage | unknown): string { return sha(value); }
export function fingerprintTaskSeal(value: TaskSeal | unknown): string { return sha(value); }
export function fingerprintSupersession(value: Supersession | unknown): string { return sha(value); }
export function fingerprintLocalFailure(value: LocalFailure | unknown): string { return sha(value); }
export function fingerprintRetryAttempt(value: RetryAttempt | unknown): string { return sha(value); }
export function fingerprintPlanDelta(value: PlanDelta | unknown): string { return sha(value); }

function validateDescriptor(input: unknown): RollingValidationResult<TaskSourceDescriptor> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, "source", d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "source_kind", "adapter", "selection", "source_ref", "source_fingerprint", "fingerprint"], "source", d);
  checkVersion(v, "source", d, TASK_SOURCE_DESCRIPTOR_SCHEMA_VERSION);
  requiredString(v, "source_kind", "source", d);
  if (nonEmpty(v.source_kind) && !SOURCES.has(v.source_kind as RollingSourceKind)) issue(d, "INVALID_SOURCE_KIND", "source_kind is unsupported", "source.source_kind");
  requiredString(v, "adapter", "source", d, true);
  checkHash(v.source_fingerprint, "source_fingerprint", "source", d); checkHash(v.fingerprint, "fingerprint", "source", d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as TaskSourceDescriptor } : {}) };
}

function validateEntry(input: unknown, path = "entry"): RollingValidationResult<TaskManifestEntry> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "task_key", "source_kind", "source_ref", "display_id", "title", "source_fingerprint", "source_state", "discovery_sequence", "apply_ordinal", "metadata", "fingerprint"], path, d);
  checkVersion(v, path, d, TASK_MANIFEST_ENTRY_SCHEMA_VERSION);
  requiredString(v, "task_key", path, d, true); requiredString(v, "display_id", path, d); requiredString(v, "title", path, d); requiredString(v, "source_fingerprint", path, d);
  if (!has(v, "source_ref")) issue(d, "REQUIRED_FIELD", "source_ref is required", `${path}.source_ref`);
  if (!SOURCES.has(v.source_kind as RollingSourceKind)) issue(d, "INVALID_SOURCE_KIND", "source_kind is unsupported", `${path}.source_kind`);
  if (!new Set<TaskSourceState>(["pending", "complete", "unavailable"]).has(v.source_state as TaskSourceState)) issue(d, "INVALID_STATE", "source_state is unsupported", `${path}.source_state`);
  if (!integer(v.discovery_sequence) || (v.discovery_sequence as number) < 0) issue(d, "INVALID_SEQUENCE", "discovery_sequence must be a non-negative integer", `${path}.discovery_sequence`);
  if (v.apply_ordinal !== undefined && (!integer(v.apply_ordinal) || (v.apply_ordinal as number) < 0)) issue(d, "INVALID_SEQUENCE", "apply_ordinal must be a non-negative integer", `${path}.apply_ordinal`);
  checkHash(v.source_fingerprint, "source_fingerprint", path, d); checkHash(v.fingerprint, "fingerprint", path, d);
  if (v.metadata !== undefined && !isRecord(v.metadata)) issue(d, "INVALID_SHAPE", "metadata must be an object", `${path}.metadata`);
  if (v.source_ref === null || v.source_ref === undefined) issue(d, "INVALID_IDENTITY", "source_ref must be a non-null opaque identity", `${path}.source_ref`);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as TaskManifestEntry } : {}) };
}

function validatePage(input: unknown): RollingValidationResult<TaskManifestPage> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, "page", d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "source", "entries", "cursor", "next_cursor", "has_more", "fingerprint"], "page", d);
  checkVersion(v, "page", d, TASK_MANIFEST_PAGE_SCHEMA_VERSION);
  const source = validateDescriptor(v.source); d.push(...source.diagnostics.map((x) => ({ ...x, path: x.path ? `source.${x.path.replace(/^source\.?/, "")}` : x.path })));
  if (!Array.isArray(v.entries)) issue(d, "REQUIRED_FIELD", "entries must be an array", "page.entries");
  else {
    const keys = new Set<string>();
    for (const [i, entry] of v.entries.entries()) {
      const result = validateEntry(entry, `page.entries.${i}`); d.push(...result.diagnostics);
      if (isRecord(entry) && nonEmpty(entry.task_key)) { if (keys.has(entry.task_key)) issue(d, "DUPLICATE_KEY", `duplicate task_key ${entry.task_key}`, `page.entries.${i}.task_key`); keys.add(entry.task_key); }
    }
  }
  if (typeof v.has_more !== "boolean") issue(d, "REQUIRED_FIELD", "has_more must be boolean", "page.has_more");
  if (v.cursor !== undefined && v.cursor !== null && !nonEmpty(v.cursor)) issue(d, "INVALID_SHAPE", "cursor must be a non-empty string or null", "page.cursor");
  if (v.next_cursor !== undefined && v.next_cursor !== null && !nonEmpty(v.next_cursor)) issue(d, "INVALID_SHAPE", "next_cursor must be a non-empty string or null", "page.next_cursor");
  checkHash(v.fingerprint, "fingerprint", "page", d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as TaskManifestPage } : {}) };
}

function validateRepositoryPart(input: unknown, path: string): RollingValidationResult<RepositoryLocalUnitPart> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["part_key", "repository_id", "write_paths", "depends_on", "integration_order", "integration_gate_keys"], path, d);
  requiredString(v, "part_key", path, d, true);
  requiredString(v, "repository_id", path, d);
  if (nonEmpty(v.repository_id) && !HASH.test(v.repository_id)) issue(d, "INVALID_REPOSITORY_ID", "repository_id must be a SHA-256 hex identity", `${path}.repository_id`);
  requiredArray(v, "write_paths", path, d);
  requiredArray(v, "depends_on", path, d);
  if (Array.isArray(v.write_paths) && (v.write_paths.length === 0 || !v.write_paths.every(nonEmpty))) issue(d, "INVALID_SHAPE", "write_paths must be a non-empty string array", `${path}.write_paths`);
  uniqueStrings(v.depends_on, `${path}.depends_on`, d);
  if (!integer(v.integration_order) || (v.integration_order as number) < 0) issue(d, "INVALID_INTEGRATION_ORDER", "integration_order must be a non-negative integer", `${path}.integration_order`);
  if (v.integration_gate_keys !== undefined) {
    if (!stringArray(v.integration_gate_keys)) issue(d, "INVALID_SHAPE", "integration_gate_keys must be an array of strings", `${path}.integration_gate_keys`);
    else uniqueStrings(v.integration_gate_keys, `${path}.integration_gate_keys`, d);
  }
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as RepositoryLocalUnitPart } : {}) };
}

function validateUnit(input: unknown, path = "unit_versions"): RollingValidationResult<UnitVersion> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "unit_key", "version", "task_keys", "depends_on", "execution_mode", "worktree_mode", "route_profile", "prompt", "recipe", "description", "write_paths", "allowed_operations", "read_context", "completion_criteria", "permitted_validation", "input_fingerprints", "required_gate_keys", "repository_parts", "integration_gate_keys", "fingerprint"], path, d);
  checkVersion(v, path, d, UNIT_VERSION_SCHEMA_VERSION); requiredString(v, "unit_key", path, d, true);
  if (!integer(v.version) || (v.version as number) < 1) issue(d, "INVALID_VERSION", "version must be a positive integer", `${path}.version`);
  requiredArray(v, "task_keys", path, d); requiredArray(v, "depends_on", path, d); uniqueStrings(v.task_keys, `${path}.task_keys`, d); uniqueStrings(v.depends_on, `${path}.depends_on`, d);
  if (!new Set<UnitExecutionMode>(["patch-only", "verification-only"]).has(v.execution_mode as UnitExecutionMode)) issue(d, "INVALID_MODE", "execution_mode is unsupported", `${path}.execution_mode`);
  if (v.worktree_mode !== undefined && !WORKTREE_MODES.has(v.worktree_mode as WorktreeExecutionMode)) issue(d, "INVALID_WORKTREE_MODE", "worktree_mode is unsupported", `${path}.worktree_mode`);
  if (v.route_profile !== undefined && !new Set(["coding", "runner", "longctx"]).has(v.route_profile as string)) issue(d, "INVALID_ROUTE_PROFILE", "route_profile is unsupported", `${path}.route_profile`);
  for (const key of ["write_paths", "completion_criteria", "permitted_validation", "required_gate_keys", "integration_gate_keys"]) if (v[key] !== undefined && !stringArray(v[key])) issue(d, "INVALID_SHAPE", `${key} must be an array of strings`, `${path}.${key}`);
  for (const key of ["required_gate_keys", "integration_gate_keys"] as const) if (stringArray(v[key])) uniqueStrings(v[key], `${path}.${key}`, d);
  if (v.allowed_operations !== undefined && (!Array.isArray(v.allowed_operations) || !(v.allowed_operations as unknown[]).every((x) => typeof x === "string" && OPERATIONS.has(x as SafetyOperation)))) issue(d, "INVALID_OPERATION", "allowed_operations contains an unsupported operation", `${path}.allowed_operations`);
  if (v.input_fingerprints !== undefined && (!isRecord(v.input_fingerprints) || !Object.values(v.input_fingerprints).every((x) => typeof x === "string" && HASH.test(x)))) issue(d, "INVALID_FINGERPRINT", "input_fingerprints must map names to SHA-256 strings", `${path}.input_fingerprints`);
  if (v.repository_parts !== undefined) {
    if (!Array.isArray(v.repository_parts) || v.repository_parts.length === 0) issue(d, "INVALID_REPOSITORY_PARTS", "repository_parts must be a non-empty array", `${path}.repository_parts`);
    else {
      const keys = new Set<string>();
      const repositories = new Set<string>();
      const orders = new Set<number>();
      for (const [index, part] of v.repository_parts.entries()) {
        const partPath = `${path}.repository_parts.${index}`;
        d.push(...validateRepositoryPart(part, partPath).diagnostics);
        if (!isRecord(part)) continue;
        if (nonEmpty(part.part_key)) {
          if (keys.has(part.part_key)) issue(d, "DUPLICATE_REPOSITORY_PART", `duplicate part_key ${part.part_key}`, `${partPath}.part_key`);
          keys.add(part.part_key);
        }
        if (nonEmpty(part.repository_id)) {
          if (repositories.has(part.repository_id)) issue(d, "DUPLICATE_REPOSITORY_PART", "repository-local parts must have distinct repository identities", `${partPath}.repository_id`);
          repositories.add(part.repository_id);
        }
        if (integer(part.integration_order)) {
          if (orders.has(part.integration_order)) issue(d, "DUPLICATE_INTEGRATION_ORDER", `duplicate integration_order ${part.integration_order}`, `${partPath}.integration_order`);
          orders.add(part.integration_order);
        }
      }
      for (const [index, part] of v.repository_parts.entries()) if (isRecord(part) && Array.isArray(part.depends_on)) {
        for (const dependency of part.depends_on) {
          if (dependency === part.part_key) issue(d, "INVALID_REPOSITORY_DEPENDENCY", "a repository part cannot depend on itself", `${path}.repository_parts.${index}.depends_on`);
          else if (nonEmpty(dependency) && !keys.has(dependency)) issue(d, "UNKNOWN_REPOSITORY_PART", `unknown repository part ${dependency}`, `${path}.repository_parts.${index}.depends_on`);
        }
      }
      if (v.repository_parts.length > 1 && (!Array.isArray(v.integration_gate_keys) || v.integration_gate_keys.length === 0)) {
        issue(d, "INTEGRATION_GATE_REQUIRED", "multi-repository units require explicit parent integration gates", `${path}.integration_gate_keys`);
      }
    }
  }
  checkHash(v.fingerprint, "fingerprint", path, d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as UnitVersion } : {}) };
}

function validateGate(input: unknown, path = "gate_versions"): RollingValidationResult<GateVersion> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "gate_key", "version", "type", "task_keys", "depends_on", "acceptance_contract", "relevant_input_fingerprints", "fingerprint"], path, d);
  checkVersion(v, path, d, GATE_VERSION_SCHEMA_VERSION); requiredString(v, "gate_key", path, d, true);
  if (!integer(v.version) || (v.version as number) < 1) issue(d, "INVALID_VERSION", "version must be a positive integer", `${path}.version`);
  if (!GATES.has(v.type as GateType)) issue(d, "UNKNOWN_GATE_TYPE", "gate type is unsupported", `${path}.type`);
  requiredArray(v, "task_keys", path, d); requiredArray(v, "depends_on", path, d); uniqueStrings(v.task_keys, `${path}.task_keys`, d); uniqueStrings(v.depends_on, `${path}.depends_on`, d);
  if (v.relevant_input_fingerprints !== undefined && (!isRecord(v.relevant_input_fingerprints) || !Object.values(v.relevant_input_fingerprints).every((x) => typeof x === "string" && HASH.test(x)))) issue(d, "INVALID_FINGERPRINT", "relevant_input_fingerprints must map names to SHA-256 strings", `${path}.relevant_input_fingerprints`);
  checkHash(v.fingerprint, "fingerprint", path, d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as GateVersion } : {}) };
}

function validateCoverage(input: unknown, path = "coverage"): RollingValidationResult<TaskCoverage> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "task_key", "kind", "unit_versions", "gate_versions", "reason", "fingerprint"], path, d);
  checkVersion(v, path, d, TASK_COVERAGE_SCHEMA_VERSION); requiredString(v, "task_key", path, d, true);
  if (!new Set<CoverageKind>(["unit", "gate", "no-op"]).has(v.kind as CoverageKind)) issue(d, "INVALID_COVERAGE", "kind is unsupported", `${path}.kind`);
  for (const key of ["unit_versions", "gate_versions"]) if (v[key] !== undefined) { if (!stringArray(v[key])) issue(d, "INVALID_SHAPE", `${key} must be an array of strings`, `${path}.${key}`); else uniqueVersionRefs(v[key], `${path}.${key}`, d); }
  if (v.kind === "no-op" && !nonEmpty(v.reason)) issue(d, "NOOP_REASON_REQUIRED", "explicit no-op coverage requires a reason", `${path}.reason`);
  checkHash(v.fingerprint, "fingerprint", path, d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as TaskCoverage } : {}) };
}

function validateSeal(input: unknown, path = "seal"): RollingValidationResult<TaskSeal> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "task_key", "required_unit_versions", "required_gate_versions", "source_fingerprint", "sealed_at", "fingerprint"], path, d);
  checkVersion(v, path, d, TASK_SEAL_SCHEMA_VERSION); requiredString(v, "task_key", path, d, true); requiredArray(v, "required_unit_versions", path, d); requiredArray(v, "required_gate_versions", path, d); requiredString(v, "source_fingerprint", path, d); uniqueVersionRefs(v.required_unit_versions, `${path}.required_unit_versions`, d); uniqueVersionRefs(v.required_gate_versions, `${path}.required_gate_versions`, d); checkHash(v.source_fingerprint, "source_fingerprint", path, d); checkHash(v.fingerprint, "fingerprint", path, d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as TaskSeal } : {}) };
}

function validateSuper(input: unknown, path = "supersession"): RollingValidationResult<Supersession> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "owner", "previous", "successor", "reason", "fingerprint"], path, d); checkVersion(v, path, d, SUPERSESSION_SCHEMA_VERSION); requiredString(v, "owner", path, d); requiredString(v, "previous", path, d); requiredString(v, "successor", path, d); requiredString(v, "reason", path, d); if (v.owner !== "unit_version" && v.owner !== "gate_version") issue(d, "INVALID_OWNER", "owner is unsupported", `${path}.owner`); if (v.previous === v.successor) issue(d, "INVALID_SUPERSESSION", "a version cannot supersede itself", path); checkHash(v.fingerprint, "fingerprint", path, d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as Supersession } : {}) };
}

function validateFailure(input: unknown, path = "failure"): RollingValidationResult<LocalFailure> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "owner", "owner_key", "owner_version", "code", "message", "retryable", "caused_by", "recorded_at", "fingerprint"], path, d); checkVersion(v, path, d, LOCAL_FAILURE_SCHEMA_VERSION); requiredString(v, "owner", path, d); requiredString(v, "owner_key", path, d, true); requiredString(v, "code", path, d, true); requiredString(v, "message", path, d); if (!new Set<FailureOwner>(["manifest_entry", "delta", "unit_version", "attempt", "gate_version", "seal", "reconciliation"]).has(v.owner as FailureOwner)) issue(d, "INVALID_OWNER", "owner is unsupported", `${path}.owner`); if (v.owner_version !== undefined && (!integer(v.owner_version) || (v.owner_version as number) < 1)) issue(d, "INVALID_VERSION", "owner_version must be positive", `${path}.owner_version`); if (typeof v.retryable !== "boolean") issue(d, "REQUIRED_FIELD", "retryable must be boolean", `${path}.retryable`); checkHash(v.fingerprint, "fingerprint", path, d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as LocalFailure } : {}) };
}

function validateAttempt(input: unknown, path = "attempt"): RollingValidationResult<RetryAttempt> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, path, d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "attempt_key", "unit_key", "unit_version", "attempt", "state", "retry_of", "failure_key", "fingerprint"], path, d); checkVersion(v, path, d, RETRY_ATTEMPT_SCHEMA_VERSION); requiredString(v, "attempt_key", path, d, true); requiredString(v, "unit_key", path, d, true); if (!integer(v.unit_version) || (v.unit_version as number) < 1) issue(d, "INVALID_VERSION", "unit_version must be positive", `${path}.unit_version`); if (!integer(v.attempt) || (v.attempt as number) < 1) issue(d, "INVALID_ATTEMPT", "attempt must be positive", `${path}.attempt`); if (!new Set<RetryAttemptState>(["pending", "reserved", "running", "succeeded", "failed", "cancelled"]).has(v.state as RetryAttemptState)) issue(d, "INVALID_STATE", "state is unsupported", `${path}.state`); if (v.retry_of !== undefined) requiredString(v, "retry_of", path, d, true); if (v.failure_key !== undefined) requiredString(v, "failure_key", path, d, true); checkHash(v.fingerprint, "fingerprint", path, d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as RetryAttempt } : {}) };
}

function validateDelta(input: unknown): RollingValidationResult<PlanDelta> {
  const d: RollingDiagnostic[] = [];
  if (!checkObject(input, "delta", d)) return { valid: false, diagnostics: d };
  const v = input;
  unknownFields(v, ["schema_version", "delta_id", "prepared_from_append_sequence", "manifest_additions", "manifest_refreshes", "unit_versions", "gate_versions", "task_coverage", "supersessions", "local_failures", "retry_attempts", "seals", "fingerprint"], "delta", d); checkVersion(v, "delta", d, PLAN_DELTA_SCHEMA_VERSION); requiredString(v, "delta_id", "delta", d, true); if (!integer(v.prepared_from_append_sequence) || (v.prepared_from_append_sequence as number) < 0) issue(d, "INVALID_SEQUENCE", "prepared_from_append_sequence must be non-negative", "delta.prepared_from_append_sequence");
  for (const key of ["manifest_additions", "manifest_refreshes", "unit_versions", "gate_versions", "task_coverage", "supersessions", "local_failures", "retry_attempts", "seals"]) if (v[key] !== undefined && !Array.isArray(v[key])) issue(d, "INVALID_SHAPE", `${key} must be an array`, `delta.${key}`);
  const unitIds = new Set<string>(); const gateIds = new Set<string>();
  for (const [i, item] of (Array.isArray(v.unit_versions) ? v.unit_versions : []).entries()) { const r = validateUnit(item, `delta.unit_versions.${i}`); d.push(...r.diagnostics); if (isRecord(item) && nonEmpty(item.unit_key) && integer(item.version)) { const id = `${item.unit_key}@${item.version}`; if (unitIds.has(id)) issue(d, "DUPLICATE_VERSION", `duplicate unit version ${id}`, `delta.unit_versions.${i}`); unitIds.add(id); } }
  for (const [i, item] of (Array.isArray(v.gate_versions) ? v.gate_versions : []).entries()) { const r = validateGate(item, `delta.gate_versions.${i}`); d.push(...r.diagnostics); if (isRecord(item) && nonEmpty(item.gate_key) && integer(item.version)) { const id = `${item.gate_key}@${item.version}`; if (gateIds.has(id)) issue(d, "DUPLICATE_VERSION", `duplicate gate version ${id}`, `delta.gate_versions.${i}`); gateIds.add(id); } }
  for (const [i, item] of (Array.isArray(v.manifest_additions) ? v.manifest_additions : []).entries()) d.push(...validateEntry(item, `delta.manifest_additions.${i}`).diagnostics);
  for (const [i, item] of (Array.isArray(v.manifest_refreshes) ? v.manifest_refreshes : []).entries()) d.push(...validateEntry(item, `delta.manifest_refreshes.${i}`).diagnostics);
  const manifestKeys = new Set<string>();
  for (const key of ["manifest_additions", "manifest_refreshes"] as const) for (const [i, item] of (Array.isArray(v[key]) ? v[key] : []).entries()) if (isRecord(item) && nonEmpty(item.task_key)) {
    if (manifestKeys.has(item.task_key)) issue(d, "DUPLICATE_KEY", `duplicate manifest task_key ${item.task_key}`, `delta.${key}.${i}.task_key`);
    manifestKeys.add(item.task_key);
  }
  for (const [i, item] of (Array.isArray(v.task_coverage) ? v.task_coverage : []).entries()) d.push(...validateCoverage(item, `delta.task_coverage.${i}`).diagnostics);
  for (const [i, item] of (Array.isArray(v.supersessions) ? v.supersessions : []).entries()) d.push(...validateSuper(item, `delta.supersessions.${i}`).diagnostics);
  for (const [i, item] of (Array.isArray(v.local_failures) ? v.local_failures : []).entries()) d.push(...validateFailure(item, `delta.local_failures.${i}`).diagnostics);
  for (const [i, item] of (Array.isArray(v.retry_attempts) ? v.retry_attempts : []).entries()) d.push(...validateAttempt(item, `delta.retry_attempts.${i}`).diagnostics);
  for (const [i, item] of (Array.isArray(v.seals) ? v.seals : []).entries()) d.push(...validateSeal(item, `delta.seals.${i}`).diagnostics);
  if (Array.isArray(v.task_coverage)) {
    const tasks = new Set<string>();
    for (const [i, item] of v.task_coverage.entries()) if (isRecord(item) && nonEmpty(item.task_key)) {
      if (tasks.has(item.task_key)) issue(d, "DUPLICATE_KEY", `duplicate coverage for task ${item.task_key}`, `delta.task_coverage.${i}.task_key`);
      tasks.add(item.task_key);
    }
  }
  checkHash(v.fingerprint, "fingerprint", "delta", d);
  return { valid: d.length === 0, diagnostics: d, ...(d.length === 0 ? { value: input as unknown as PlanDelta } : {}) };
}

function assertResult<T>(result: RollingValidationResult<T>): T { if (!result.valid) throw new RollingProtocolValidationError(result.diagnostics); return result.value as T; }
function parse<T>(text: string, validator: (value: unknown) => RollingValidationResult<T>): T { let value: unknown; try { value = JSON.parse(text); } catch { throw new RollingProtocolValidationError([{ code: "INVALID_JSON", message: "document is not valid JSON" }]); } return assertResult(validator(value)); }
function serialize<T>(value: T, validator: (value: unknown) => RollingValidationResult<T>): string { return canonicalizeRolling(assertResult(validator(value))); }

export const validateTaskSourceDescriptor = (value: unknown) => validateDescriptor(value);
export const validateTaskManifestEntry = (value: unknown) => validateEntry(value);
export const validateTaskManifestPage = (value: unknown) => validatePage(value);
export const validateRepositoryLocalUnitPart = (value: unknown) => validateRepositoryPart(value, "repository_part");
export const validateUnitVersion = (value: unknown) => validateUnit(value);
export const validateGateVersion = (value: unknown) => validateGate(value);
export const validateTaskCoverage = (value: unknown) => validateCoverage(value);
export const validateTaskSeal = (value: unknown) => validateSeal(value);
export const validateSupersession = (value: unknown) => validateSuper(value);
export const validateLocalFailure = (value: unknown) => validateFailure(value);
export const validateRetryAttempt = (value: unknown) => validateAttempt(value);
export const validatePlanDelta = (value: unknown) => validateDelta(value);

export const assertTaskSourceDescriptor = (value: unknown) => assertResult(validateDescriptor(value));
export const assertTaskManifestEntry = (value: unknown) => assertResult(validateEntry(value));
export const assertTaskManifestPage = (value: unknown) => assertResult(validatePage(value));
export const assertRepositoryLocalUnitPart = (value: unknown) => assertResult(validateRepositoryPart(value, "repository_part"));
export const assertUnitVersion = (value: unknown) => assertResult(validateUnit(value));
export const assertGateVersion = (value: unknown) => assertResult(validateGate(value));
export const assertTaskCoverage = (value: unknown) => assertResult(validateCoverage(value));
export const assertTaskSeal = (value: unknown) => assertResult(validateSeal(value));
export const assertSupersession = (value: unknown) => assertResult(validateSuper(value));
export const assertLocalFailure = (value: unknown) => assertResult(validateFailure(value));
export const assertRetryAttempt = (value: unknown) => assertResult(validateAttempt(value));
export const assertPlanDelta = (value: unknown) => assertResult(validateDelta(value));

export const parseTaskSourceDescriptor = (text: string) => parse(text, validateDescriptor);
export const parseTaskManifestEntry = (text: string) => parse(text, validateEntry);
export const parseTaskManifestPage = (text: string) => parse(text, validatePage);
export const parseUnitVersion = (text: string) => parse(text, validateUnit);
export const parseGateVersion = (text: string) => parse(text, validateGate);
export const parseTaskCoverage = (text: string) => parse(text, validateCoverage);
export const parseTaskSeal = (text: string) => parse(text, validateSeal);
export const parseSupersession = (text: string) => parse(text, validateSuper);
export const parseLocalFailure = (text: string) => parse(text, validateFailure);
export const parseRetryAttempt = (text: string) => parse(text, validateAttempt);
export const parsePlanDelta = (text: string) => parse(text, validateDelta);

export const serializeTaskSourceDescriptor = (value: TaskSourceDescriptor) => serialize(value, validateDescriptor);
export const serializeTaskManifestEntry = (value: TaskManifestEntry) => serialize(value, validateEntry);
export const serializeTaskManifestPage = (value: TaskManifestPage) => serialize(value, validatePage);
export const serializeUnitVersion = (value: UnitVersion) => serialize(value, validateUnit);
export const serializeGateVersion = (value: GateVersion) => serialize(value, validateGate);
export const serializeTaskCoverage = (value: TaskCoverage) => serialize(value, validateCoverage);
export const serializeTaskSeal = (value: TaskSeal) => serialize(value, validateSeal);
export const serializeSupersession = (value: Supersession) => serialize(value, validateSuper);
export const serializeLocalFailure = (value: LocalFailure) => serialize(value, validateFailure);
export const serializeRetryAttempt = (value: RetryAttempt) => serialize(value, validateAttempt);
export const serializePlanDelta = (value: PlanDelta) => serialize(value, validateDelta);
export const canonicalJson = canonicalizeRolling;
export const fingerprintPlan = fingerprintPlanDelta;
export { RollingProtocolValidationError as RollingPlanValidationError };

/** Derive a stable Baton key without inspecting the adapter-owned reference. */
export function deriveTaskKey(sourceKind: RollingSourceKind, sourceRef: unknown): string {
  if (!SOURCES.has(sourceKind)) throw new RollingProtocolValidationError([{ code: "INVALID_SOURCE_KIND", message: "source_kind is unsupported" }]);
  return `${sourceKind}:${sha256Hex(canonicalizeRolling(sourceRef)).slice(0, 32)}`;
}
