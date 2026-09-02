/**
 * Worktree runtime record schema: types, schema versions and the shared
 * error type. Split from worktree-execution.ts (leaf module).
 */
import type { RollingValidationResult } from "../rolling-plan.js";
import type { SafetyOperation } from "../safety.js";
import { WorktreeExecutionMode } from "../rolling-plan.js";

export type ChangeBundleOperation = SafetyOperation | "copy";

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
  operations: ChangeBundleOperation[];
  changed_paths: string[];
  non_text_facts: Record<string, unknown>;
  transport: Record<string, unknown>;
  validation_summaries: string[];
  terminal_conclusion: string;
  safety_verdict: "safe" | "rejected";
  /** New bundles freeze this explicit integration-readiness verdict. */
  state?: "ready_for_integration" | "rejected";
  retention_reasons: RetentionReason[];
  created_at: string;
  fingerprint: string;
}

export type IntegrationConflictKind =
  | "content"
  | "add_add"
  | "rename"
  | "delete_modify"
  | "mode"
  | "binary"
  | "symlink"
  | "gitlink";

export interface IntegrationConflict {
  path: string;
  kind: IntegrationConflictKind;
  detail?: string;
}

/** Immutable recovery boundary persisted before any bundle merge plumbing. */
export interface IntegrationApplicationIntent {
  schema_version: 1;
  idempotency_key: string;
  context: "baton-temporary-object-merge";
  before_tree: string;
  bundle_base_tree: string;
  bundle_result_tree: string;
  prepared_at: string;
  fingerprint: string;
}

/** Parent-authored conflict result; this never rewrites the worker bundle. */
export interface IntegrationResolutionResult {
  schema_version: 1;
  resolution_id: string;
  integration_id: string;
  bundle_id: string;
  before_tree: string;
  bundle_result_tree: string;
  resolved_tree: string;
  conflict_fingerprint: string;
  conclusion: string;
  operations: ChangeBundleOperation[];
  changed_paths: string[];
  non_text_facts: Record<string, unknown>;
  submitted_at: string;
  fingerprint: string;
}

/** Recovery boundary persisted before the accepted tree touches the caller. */
export interface IntegrationAcceptanceIntent {
  schema_version: 1;
  idempotency_key: string;
  before_tree: string;
  after_tree: string;
  integration_fingerprint: string;
  conclusion: string;
  prepared_at: string;
  fingerprint: string;
}

/** Frozen parent-side facts authorizing one narrow begin-integration action. */
export interface IntegrationBeginAuthorization {
  schema_version: 1;
  expected_before_tree: string;
  observed_before_tree: string;
  head: string;
  head_tree: string;
  branch_ref: string;
  refs_digest: string;
  reflog: { count: number; checksum: string };
  staged_tree: string;
  index_control: { algorithm: string; checksum: string; entry_count: number };
  control_facts_fingerprint: string;
  dirty_facts_fingerprint: string;
  git_operation: string | null;
  parent_order_override: number | null;
  fingerprint: string;
}

/** Stable queue order derived only from accepted rolling-plan lineage. */
export interface IntegrationQueueOrderProvenance {
  schema_version: 1;
  source: "rolling-accepted-delta";
  dependency_rank: number;
  accepted_delta_index: number;
  stable_unit_index: number;
  unit_ref: string;
  depends_on: string[];
  parent_order_override: number | null;
  fingerprint: string;
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
  /** Optional so records written before application support remain readable. */
  application?: IntegrationApplicationIntent;
  /** Optional so pre-ordering v1 records remain readable via queue_position. */
  queue_order?: IntegrationQueueOrderProvenance;
  /** Optional so persisted v1 records written before begin authorization remain readable. */
  authorization?: IntegrationBeginAuthorization;
  /** Separately fingerprinted parent-authored conflict resolution. */
  resolution?: IntegrationResolutionResult;
  /** Persisted before final caller application for restart recovery. */
  acceptance?: IntegrationAcceptanceIntent;
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
