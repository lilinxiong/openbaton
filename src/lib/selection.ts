import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyTask, scoreCard } from "./cards.js";
import { quotaForProvider, type ProviderQuotaDisclosure } from "./provider-quotas.js";
import { selectionsDir } from "./paths.js";
import { readRouteSnapshot, type RouteSnapshot } from "./routes.js";
import { TaskCapabilityExclusion } from "./task-suitability.js";
import type { ModelSelectionApproval, UnknownRecord } from "../types.js";
export type QuotaPoolStatus = "available" | "unknown" | "exhausted";
export interface SelectionQuotaPool {
  id: string; provider: string; label: string; status: QuotaPoolStatus;
  selectable: boolean; remaining_percent: number | null; source: string | null;
  observed_at: string; reason: string | null;
  windows: import("./provider-quotas.js").QuotaWindow[]; model_ids: string[];
}

export type SelectionProposalStatus = "pending_confirmation" | "approved";

/** Stable diagnostic codes used by the selector.  The legacy selection codes
 * remain part of the public candidate shape; these codes make the reason for
 * a rejected configured route explicit and machine-readable. */
export type SelectionDiagnosticCode =
  | "AVAILABLE"
  | "QUOTA_POOL_EXHAUSTED"
  | "CURRENT_SESSION_QUOTA_EXHAUSTED"
  | "CURRENT_SESSION_UNCALLABLE"
  | "ROUTE_ABSENT_FROM_ACTIVE_CATALOG"
  | "REASONING_CAPABILITY_INSUFFICIENT"
  | "CONTEXT_WINDOW_INSUFFICIENT"
  | "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED"
  | "TASK_CAPABILITY_MISMATCH";

export type SelectionLegacyCode =
  | "AVAILABLE"
  | "QUOTA_POOL_EXHAUSTED"
  | "DURABLE_QUOTA_EXHAUSTED"
  | "CONTEXT_WINDOW_INSUFFICIENT"
  | "REASONING_EFFORT_UNSUPPORTED"
  | "CURRENT_SESSION_UNCALLABLE"
  | "ROUTE_ABSENT_FROM_ACTIVE_CATALOG"
  | "REASONING_CAPABILITY_INSUFFICIENT"
  | "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED"
  | "TASK_CAPABILITY_MISMATCH";

export type SelectionCodeScope = "unspecified" | "single-file" | "multi-file" | "repository-wide";

export interface SelectionRequirementEvidence {
  field: string;
  value: string | number | boolean | string[] | null;
  source: string;
  detail: string;
}

/**
 * The minimum contract a route must satisfy for one work unit.  Values are
 * derived before route ranking and are persisted with the unit/proposal so a
 * later approval or retry cannot silently relax the original task contract.
 */
export interface MinimumModelRequirements {
  complexity: SelectionUnit["complexity_reason"];
  estimated_context_tokens: number;
  code_scope: SelectionCodeScope;
  /** Minimum reasoning level, retained under both descriptive names. */
  reasoning: SelectionUnit["target_reasoning_effort"];
  reasoning_effort: SelectionUnit["target_reasoning_effort"];
  native_execution: boolean;
  tool: boolean;
  tool_use: boolean;
  execution_mode: string | null;
  required_execution_capabilities: string[];
  other_execution_requirements: string[];
  evidence: SelectionRequirementEvidence[];
}

export interface SelectionDiagnostic {
  code: SelectionDiagnosticCode;
  reason: string;
  evidence: string[];
}

export interface SelectionNoQualifiedResult {
  code: "NO_QUALIFIED_CANDIDATE";
  configured_route_ids: string[];
  exclusions: Array<{
    model_id: string;
    route_id: string;
    codes: SelectionDiagnosticCode[];
    reasons: string[];
  }>;
}

export interface SelectionCandidate {
  model_id: string;
  route_id: string;
  reasoning_effort: string | null;
  reasoning_effort_configurable: boolean;
  effective_reasoning_effort: string | null;
  context_window: number | null;
  service_tier: string | null;
  speed_optimized: boolean;
  speed_signals: Array<"route-name" | "catalog-description" | "service-tier">;
  provider: string | null;
  selectable: boolean;
  selection_code: SelectionLegacyCode;
  selection_reason: string;
  /** Canonical reason; selection_code keeps older callers source-compatible. */
  diagnostic_code?: SelectionDiagnosticCode;
  diagnostics: SelectionDiagnostic[];
  exclusion_reasons?: SelectionDiagnostic[];
  exclusion_codes?: SelectionDiagnosticCode[];
  selection_diagnostics?: SelectionDiagnostic[];
  required_execution_capabilities?: string[];
  execution_capabilities?: string[];
  automatic_eligible: boolean;
  task_score: number | null;
  strengths: string;
  positioning: string[];
  quota: ProviderQuotaDisclosure;
  quota_pool_id: string;
  quota_pool_label: string;
  quota_pool_status: QuotaPoolStatus;
  quota_pool_remaining_percent: number | null;
  availability_status: "available" | "exhausted" | "probe_due";
  availability_reason: string | null;
  /** A due route may be claimed only by the eventual reservation owner. */
  probe_available: boolean;
}

export interface SelectionUnit {
  host?: string;
  key: string;
  description: string;
  prompt: string;
  director_local: boolean;
  recommended_model_id: string | null;
  requested_model_id: string | null;
  default_model_id: string | null;
  recommendation_reason: "CODING_PRIORITY" | "CODING_MODELS_EXHAUSTED" | "DIRECTOR_LOCAL";
  target_reasoning_effort: "low" | "medium" | "high" | "xhigh" | "max";
  complexity_reason: "simple" | "standard" | "complex" | "very-complex";
  estimated_context_tokens: number;
  context_estimate_reason: "explicit" | "large-scope" | "small-scope" | "standard";
  minimum_requirements?: MinimumModelRequirements;
  requires_manual_choice: boolean;
  candidates: SelectionCandidate[];
  qualification_status?: "qualified" | "no-qualified-candidate";
  no_qualified_result?: SelectionNoQualifiedResult | null;
  task_exclusions: TaskCapabilityExclusion[];
  metadata: UnknownRecord;
}

export interface SelectionProposal {
  schema_version: 2;
  host?: string;
  id: string;
  status: SelectionProposalStatus;
  source: "standalone" | "openspec";
  created_at: string;
  approved_at: string | null;
  catalog_fingerprint: string;
  source_fingerprint: string;
  units: SelectionUnit[];
  /** Deterministic unit-keyed copy retained at proposal scope for audit. */
  minimum_requirements: Record<string, MinimumModelRequirements>;
  quota_pools: SelectionQuotaPool[];
  task_exclusions: TaskCapabilityExclusion[];
  payload: UnknownRecord;
  confirmation?: {
    confirmation_id: string;
    scope: "proposal" | "bundle";
    confirmed_at: string;
    confirmed_by?: ModelSelectionApproval["confirmed_by"];
    selected_provider_ids: string[];
    global_provider_ids: string[];
    unit_keys: string[];
  } | null;
  approvals: Array<{
    key: string;
    host?: string;
    approval_id: string;
    confirmation_id?: string;
    confirmed_by?: ModelSelectionApproval["confirmed_by"];
    recommended_model_id: string | null;
    selected_model_id: string;
    service_tier?: string | null;
    changed_by_user: boolean;
    selected_provider_ids?: string[];
    global_provider_ids?: string[];
  }>;
  history: Array<{ event: "pending_confirmation" | "approved"; at: string }>;
}

export type RequirementValue = string | number | boolean | string[] | null;

export interface MinimumModelRequirementsInput {
  complexity?: SelectionUnit["complexity_reason"] | string | null;
  estimated_context_tokens?: number | string | null;
  code_scope?: SelectionCodeScope | string | UnknownRecord | null;
  reasoning?: SelectionUnit["target_reasoning_effort"] | string | null;
  reasoning_effort?: SelectionUnit["target_reasoning_effort"] | string | null;
  native_execution?: boolean | string | null;
  tool?: boolean | string | null;
  tool_use?: boolean | string | null;
  execution_mode?: string | UnknownRecord | null;
  required_execution_capabilities?: string[] | UnknownRecord | null;
  other_execution_requirements?: string[] | UnknownRecord | null;
  evidence?: SelectionRequirementEvidence[] | null;
  [key: string]: unknown;
}

export const COMPLEXITY_VALUES = new Set<SelectionUnit["complexity_reason"]>([
  "simple", "standard", "complex", "very-complex",
]);
export const EFFORT_VALUES = new Set<SelectionUnit["target_reasoning_effort"]>([
  "low", "medium", "high", "xhigh", "max",
]);
export interface TaskContextEstimate {
  tokens: number;
  reason: SelectionUnit["context_estimate_reason"];
}

export interface TaskComplexityEstimate {
  effort: SelectionUnit["target_reasoning_effort"];
  reason: SelectionUnit["complexity_reason"];
}


export * from "./selection/requirements.js";
export * from "./selection/candidates.js";
export * from "./selection/unit.js";
export * from "./selection/proposals.js";
