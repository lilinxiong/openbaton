/**
 * The in-memory contract for an OpenSpec apply run.
 *
 * This module deliberately has no persistence or scheduling side effects.  It
 * validates the director's plan before a dispatcher is allowed to consume it.
 */
import path from "node:path";
import type { SafetyOperation } from "./safety.js";
import { canonicalizeJson, sha256Hex } from "./json-utils.js";
import { wildcardStaticPrefix } from "./wildcard.js";
import { record } from "./apply/plan-scope.js";

export const APPLY_EXECUTION_PLAN_SCHEMA_VERSION = 1 as const;
export const APPLY_PLAN_OPERATIONS: readonly SafetyOperation[] = ["write", "create", "delete", "rename", "chmod"];

export type ApplyPlanUnitMode = "patch-only" | "verification-only";
export type ApplyPlanRuntimeState =
  | "planned"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "stale"
  | "superseded"
  | "materialized"
  | "terminal";
export type ApplyPlanTaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface ApplyPlanIdentity {
  plan_id: string;
  change_id: string;
  created_at?: string;
  owner?: string;
}

export interface ApplyPlanSourceSnapshot {
  repo_root: string;
  revision: string;
  tasks_path?: string;
  fingerprint?: string;
}

export interface ApplyPlanRevisionLineage {
  base: string;
  parent?: string;
  head?: string;
  ancestors?: string[];
}

export interface ApplyPlanTaskCompletion {
  status: ApplyPlanTaskStatus;
  unit_ids?: string[];
  completed_at?: string;
  conclusion?: string;
}

export interface ApplyPlanUnit {
  id: string;
  mode: ApplyPlanUnitMode;
  task_ids: string[];
  description?: string;
  prompt?: string;
  write_paths?: string[];
  allowed_operations?: SafetyOperation[];
  depends_on?: string[];
  parent_gate_ids?: string[];
  runtime_state?: ApplyPlanRuntimeState;
  remaining_critical_path?: number;
  /** A patch payload is intentionally metadata only; this module never applies it. */
  patch?: string;
  verification?: string[];
}

export interface ApplyPlanParentGate {
  id: string;
  depends_on?: string[];
  unit_ids?: string[];
  task_ids?: string[];
  runtime_state?: ApplyPlanRuntimeState;
}

export interface ApplyPlanTaskMapping {
  task_id: string;
  unit_ids: string[];
  gate_ids?: string[];
}

export interface ApplyExecutionPlan {
  schema_version: 1;
  identity: ApplyPlanIdentity;
  source_snapshot: ApplyPlanSourceSnapshot;
  selected_tasks: string[];
  units: ApplyPlanUnit[];
  parent_gates?: ApplyPlanParentGate[];
  task_mappings?: ApplyPlanTaskMapping[];
  task_completion?: Record<string, ApplyPlanTaskCompletion>;
  revision_lineage?: ApplyPlanRevisionLineage;
  runtime_state?: ApplyPlanRuntimeState;
  fingerprint?: string;
}

export interface ApplyPlanOverlapEdge {
  from: string;
  to: string;
  paths: string[];
}

export interface ApplyPlanDiagnostic {
  code: string;
  message: string;
  path?: string;
  refs?: string[];
}

export interface ApplyPlanValidationResult {
  valid: boolean;
  diagnostics: ApplyPlanDiagnostic[];
  overlap_edges: ApplyPlanOverlapEdge[];
  remaining_critical_path: Record<string, number>;
  plan?: ApplyExecutionPlan;
}

export class ApplyPlanValidationError extends Error {
  readonly diagnostics: ApplyPlanDiagnostic[];
  constructor(diagnostics: ApplyPlanDiagnostic[]) {
    super(diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
    this.name = "ApplyPlanValidationError";
    this.diagnostics = diagnostics;
  }
}

export class ApplyPlanSearchError extends Error {
  readonly code = "APPLY_FRONTIER_SEARCH_LIMIT";
  constructor(limit: number) {
    super(`exact apply frontier search exceeded ${limit} nodes`);
    this.name = "ApplyPlanSearchError";
  }
}

export type ApplyPlanScopeKind = "path" | "wildcard" | "rename-source" | "rename-target";

export interface ApplyPlanScopeFact {
  unit_id: string;
  path: string;
  kind: ApplyPlanScopeKind;
}

export interface ApplyPlanScopeSource {
  unit_id: string;
  facts: readonly ApplyPlanScopeFact[];
}

export interface ApplyPlanActiveOwnership {
  key: string;
  /** Repository/root namespace which owns these paths. Both fields are required together. */
  repository_id?: string;
  execution_root?: string;
  base_tree?: string;
  released?: boolean;
  terminal?: boolean;
  terminal_unreleased?: boolean;
  slot_released_at?: string | null;
  facts: readonly ApplyPlanScopeFact[];
}

export interface ApplyPlanOwnershipNamespace {
  repository_id: string;
  execution_root: string;
  base_tree?: string;
}

export interface ApplyPlanIntegrationConflictRisk {
  from: string;
  to: string;
  repository_id: string;
  execution_roots: [string, string];
  paths: string[];
}

export interface ApplyPlanDependencyReadyOptions {
  acceptedUnitStates?: readonly ApplyPlanRuntimeState[];
  acceptedGateStates?: readonly ApplyPlanRuntimeState[];
  excludedUnitStates?: readonly ApplyPlanRuntimeState[];
  excludedUnitIds?: readonly string[];
}

export interface ApplyPlanConflictGraphOptions {
  /** Explicit scope declarations; defaults are derived from patch-only write paths. */
  declaredScopeFacts?: ReadonlyMap<string, readonly ApplyPlanScopeFact[]> | readonly ApplyPlanScopeFact[];
  /** Active foreign ownership facts across root trees; terminal/unreleased owners always conflict. */
  activeOwnership?: readonly ApplyPlanActiveOwnership[];
  /** Exact repository/root namespace for each candidate unit. */
  ownershipByUnit?: Readonly<Record<string, ApplyPlanOwnershipNamespace>> | ReadonlyMap<string, ApplyPlanOwnershipNamespace>;
  /** Override unit order for deterministic tie-break and stable comparisons. */
  stableOrder?: readonly string[];
}

export interface ApplyPlanConflictGraphResult {
  conflicts: ReadonlyMap<string, string[]>;
  blockedByActiveOwnership: ReadonlySet<string>;
  /** Non-blocking overlaps isolated by distinct roots in the same repository. */
  integration_conflict_risks: ApplyPlanIntegrationConflictRisk[];
}

export interface ApplyPlanIndependentSetOptions {
  capacity?: number;
  criticalPathByUnit?: Record<string, number>;
  excludedUnitIds?: readonly string[];
  /** Fail closed instead of silently returning a suboptimal frontier. */
  maxSearchNodes?: number;
}

export interface ApplyPlanIndependentSetResult {
  selected: string[];
}


/** Stable JSON used for both receipts and plan fingerprints. */
export function canonicalizeApplyPlan(value: ApplyExecutionPlan | unknown): string {
  return canonicalizeJson(value);
}

function fingerprintValue(value: ApplyExecutionPlan | unknown): string {
  const copy = record(value) ? { ...value } : value;
  if (record(copy)) delete copy.fingerprint;
  return sha256Hex(canonicalizeApplyPlan(copy));
}

export function fingerprintApplyExecutionPlan(plan: ApplyExecutionPlan): string { return fingerprintValue(plan); }
export const applyPlanFingerprint = fingerprintApplyExecutionPlan;



export * from "./apply/plan-scope.js";
export * from "./apply/plan-frontier.js";
export * from "./apply/plan-validate.js";
