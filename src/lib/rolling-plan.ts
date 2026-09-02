/**
 * Source-neutral, append-only planning documents used by rolling execution.
 *
 * This module is deliberately a pure boundary.  It does not read a task
 * source, persist a run, schedule a unit, or infer missing execution facts.
 * Every document is versioned and its wire representation is snake_case.
 */
import type { SafetyOperation } from "./safety.js";
import { sha256Hex } from "./json-utils.js";
import { isRecord } from "./validate-utils.js";
import {
  canonicalizeRolling,
  RollingProtocolValidationError,
  SOURCES,
  GATE_VERSION_SCHEMA_VERSION,
  LOCAL_FAILURE_SCHEMA_VERSION,
  PLAN_DELTA_SCHEMA_VERSION,
  RETRY_ATTEMPT_SCHEMA_VERSION,
  ROLLING_WORKTREE_STATE_SCHEMA_VERSION,
  SUPERSESSION_SCHEMA_VERSION,
  TASK_COVERAGE_SCHEMA_VERSION,
  TASK_MANIFEST_ENTRY_SCHEMA_VERSION,
  TASK_MANIFEST_PAGE_SCHEMA_VERSION,
  TASK_SEAL_SCHEMA_VERSION,
  TASK_SOURCE_DESCRIPTOR_SCHEMA_VERSION,
  UNIT_VERSION_SCHEMA_VERSION,
} from "./rolling/plan-validate.js";

export * from "./rolling/plan-validate.js";

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


export class RollingWorktreeModeError extends Error {
  readonly code: "ROLLING_V2_REQUIRED" | "WORKTREE_MODE_INVALID" | "WORKTREE_MODE_REQUIRED" | "WORKTREE_MODE_IMMUTABLE";
  constructor(message: string, code: RollingWorktreeModeError["code"]) {
    super(message);
    this.name = "RollingWorktreeModeError";
    this.code = code;
  }
}

type AnyRecord = Record<string, unknown>;
const WORKTREE_MODES = new Set<WorktreeExecutionMode>(["isolated-worktree", "shared-worktree"]);

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

export const fingerprintPlan = fingerprintPlanDelta;
export { RollingProtocolValidationError as RollingPlanValidationError } from "./rolling/plan-validate.js";

/** Derive a stable Baton key without inspecting the adapter-owned reference. */
export function deriveTaskKey(sourceKind: RollingSourceKind, sourceRef: unknown): string {
  if (!SOURCES.has(sourceKind)) throw new RollingProtocolValidationError([{ code: "INVALID_SOURCE_KIND", message: "source_kind is unsupported" }]);
  return `${sourceKind}:${sha256Hex(canonicalizeRolling(sourceRef)).slice(0, 32)}`;
}
