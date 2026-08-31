import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyTask, scoreCard } from "./cards.js";
import { quotaForProvider, type ProviderQuotaDisclosure } from "./provider-quotas.js";
import { selectionsDir } from "./paths.js";
import { readRouteSnapshot, type RouteSnapshot } from "./routes.js";
export type QuotaPoolStatus = "available" | "unknown" | "exhausted";
export interface SelectionQuotaPool {
  id: string; provider: string; label: string; status: QuotaPoolStatus;
  selectable: boolean; remaining_percent: number | null; source: string | null;
  observed_at: string; reason: string | null;
  windows: import("./provider-quotas.js").QuotaWindow[]; model_ids: string[];
}
type QuotaCandidate = { model_id: string; route_id?: string; provider: string | null; quota: ProviderQuotaDisclosure };
function quotaPoolForCandidate(candidate: QuotaCandidate): SelectionQuotaPool {
  const values = candidate.quota.windows.map((item) => item.remaining_percent).filter(Number.isFinite);
  const remaining = values.length ? Math.min(...values) : null;
  const status: QuotaPoolStatus = remaining === 0 ? "exhausted" : remaining == null ? "unknown" : "available";
  return { id: candidate.model_id, provider: candidate.provider || "unknown", label: candidate.provider || "unknown",
    status, selectable: status !== "exhausted", remaining_percent: remaining, source: candidate.quota.source,
    observed_at: candidate.quota.observed_at, reason: status === "unknown" ? candidate.quota.reason : null,
    windows: candidate.quota.windows, model_ids: [candidate.model_id] };
}
import { taskCapabilityExclusion, type TaskCapabilityExclusion } from "./task-suitability.js";
import { availabilityForRoute } from "./model-availability.js";
import type { ModelCard, ModelSelectionApproval, UnknownRecord } from "../types.js";

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

function scopedSourceFingerprint(host: string | undefined, sourceFingerprint: string): string {
  return host ? selectionSourceFingerprint({ host, source_fingerprint: sourceFingerprint }) : sourceFingerprint;
}

type RequirementValue = string | number | boolean | string[] | null;

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

const COMPLEXITY_VALUES = new Set<SelectionUnit["complexity_reason"]>([
  "simple", "standard", "complex", "very-complex",
]);
const EFFORT_VALUES = new Set<SelectionUnit["target_reasoning_effort"]>([
  "low", "medium", "high", "xhigh", "max",
]);
function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => {
      if (typeof item === "string" || typeof item === "number") return String(item).trim();
      const record = recordValue(item);
      return String(record?.id ?? record?.name ?? record?.capability ?? record?.kind ?? record?.path ?? record?.value ?? "").trim();
    }).filter(Boolean))].sort();
  }
  if (value && typeof value === "object") {
    return Object.entries(value as UnknownRecord)
      .filter(([, enabled]) => enabled === true || typeof enabled === "string")
      .map(([key, enabled]) => typeof enabled === "string" && enabled.trim() ? enabled.trim() : key)
      .filter(Boolean)
      .sort();
  }
  return [];
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.trim().toLowerCase() === "true") return true;
      if (value.trim().toLowerCase() === "false") return false;
    }
    const record = recordValue(value);
    const nested = record && (record.required ?? record.enabled ?? record.supported ?? record.value);
    if (typeof nested === "boolean") return nested;
  }
  return null;
}

function normalizedRequirementString(value: unknown): string | null {
  const record = recordValue(value);
  const nested = record && (record.minimum ?? record.minimum_effort ?? record.effort ?? record.level
    ?? record.scope ?? record.kind ?? record.type ?? record.value ?? record.name ?? record.id);
  const text = String(nested ?? value ?? "").trim().toLowerCase().replaceAll(/[_ ]+/g, "-");
  return text || null;
}

function inferCodeScope(text: string, input: MinimumModelRequirementsInput): SelectionCodeScope {
  const explicitValue = input.code_scope ?? input.codeScope ?? input.scope;
  const explicit = normalizedRequirementString(explicitValue);
  if (explicit) {
    if (explicit === "repo" || explicit === "repository" || explicit === "codebase" || explicit === "repository-wide") return "repository-wide";
    if (explicit === "single" || explicit === "single-file" || explicit === "file") return "single-file";
    if (explicit === "multi" || explicit === "multi-file" || explicit === "multiple-files") return "multi-file";
    if (explicit === "none" || explicit === "unspecified" || explicit === "unknown") return "unspecified";
  }
  const value = text.toLowerCase();
  const pathValues = [
    ...stringArray(input.write_paths),
    ...stringArray(input.files),
    ...stringArray(input.paths),
    ...stringArray(input.writePaths),
    ...stringArray(input.filePaths),
    ...stringArray(input.code_paths),
    ...stringArray(input.codePaths),
    ...stringArray(input.code_scope && typeof input.code_scope === "object" ? input.code_scope : undefined),
  ];
  if (pathValues.length > 1) return "multi-file";
  if (/\b(?:whole|entire|all|repository|repo|codebase)[ -]?wide\b|\b(?:monorepo|whole repo|entire repository|entire codebase)\b|全仓(?:库)?|整个仓库|跨模块/.test(value)) return "repository-wide";
  if (/\b(?:multi[- ]file|multiple files|several files|cross[- ]module)\b|多文件|跨模块/.test(value)) return "multi-file";
  if (pathValues.length === 1 || /(?:^|[\s`'"(])(?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|mjs|cjs|java|kt|kts|swift|go|rs|py|rb|php|cpp|cc|h|hpp|md|json|yaml|yml)(?:$|[\s`'"),.:])/.test(value)) return "single-file";
  return "unspecified";
}

function inferExecutionMode(input: MinimumModelRequirementsInput): string | null {
  const execution = recordValue(input.execution) || recordValue(input.execution_requirements) || recordValue(input.executionRequirements);
  const explicit = normalizedRequirementString(input.execution_mode || input.executionMode || input.execution_mode_name || input.executionModeName
    || input.mode || execution?.execution_mode || execution?.executionMode || execution?.mode);
  if (explicit) return explicit;
  if (input.commit_only === true || input.commitOnly === true || execution?.commit_only === true || execution?.commitOnly === true) return "commit-only";
  if (input.read_only === true || input.readOnly === true || execution?.read_only === true || execution?.readOnly === true) return "read-only";
  if (stringArray(input.write_paths).length || stringArray(input.writePaths).length || stringArray(input.files).length
    || stringArray(execution?.write_paths).length || stringArray(execution?.writePaths).length) return "write";
  return null;
}

function capabilityNames(input: MinimumModelRequirementsInput): string[] {
  const execution = recordValue(input.execution) || recordValue(input.execution_requirements) || recordValue(input.executionRequirements);
  return stringArray(
    input.required_execution_capabilities
      || input.requiredExecutionCapabilities
      || input.execution_capabilities
      || input.executionCapabilities
      || execution?.required_execution_capabilities
      || execution?.requiredExecutionCapabilities
      || execution?.capabilities,
  ).map(canonicalCapability);
}

function otherRequirementNames(input: MinimumModelRequirementsInput): string[] {
  const execution = recordValue(input.execution) || recordValue(input.execution_requirements) || recordValue(input.executionRequirements);
  return [...new Set(stringArray(
    input.other_execution_requirements
      || input.otherExecutionRequirements
      || input.other_requirements
      || input.otherRequirements
      || input.other
      || input.requirements
      || execution?.other_execution_requirements
      || execution?.otherExecutionRequirements
      || execution?.other
      || execution?.requirements,
  ))].sort();
}

function evidenceEntry(
  field: string,
  value: RequirementValue,
  source: string,
  detail: string,
): SelectionRequirementEvidence {
  return { field, value, source, detail };
}

/**
 * Derive the immutable minimum route contract from task text and optional
 * execution metadata.  The fixed evidence order and sorted list fields make
 * repeated derivation byte-stable and suitable for proposal persistence.
 */
export function deriveMinimumModelRequirements(
  text: unknown,
  overrides: MinimumModelRequirementsInput = {},
): MinimumModelRequirements {
  const taskRecord = recordValue(text);
  const value = taskRecord
    ? String(taskRecord.prompt || taskRecord.description || taskRecord.text || taskRecord.objective || "")
    : String(text || "");
  if (taskRecord) overrides = { ...taskRecord, ...overrides };
  const complexityEstimate = estimateTaskComplexity(value);
  const contextEstimate = estimateTaskContext(value);
  const metadata = recordValue(overrides.metadata) || {};
  const merged = { ...metadata, ...overrides } as MinimumModelRequirementsInput;
  const complexityRaw = normalizedRequirementString(merged.complexity ?? merged.task_complexity ?? merged.complexity_class ?? merged.complexity_reason);
  const complexity = complexityRaw && COMPLEXITY_VALUES.has(complexityRaw as SelectionUnit["complexity_reason"])
    ? complexityRaw as SelectionUnit["complexity_reason"]
    : complexityEstimate.reason;
  const effortRaw = normalizedRequirementString(merged.reasoning_effort || merged.reasoning || merged.minimum_reasoning_effort
    || merged.minimumReasoningEffort || merged.required_reasoning_effort || merged.requiredReasoningEffort);
  const reasoning = effortRaw && EFFORT_VALUES.has(effortRaw as SelectionUnit["target_reasoning_effort"])
    ? effortRaw as SelectionUnit["target_reasoning_effort"]
    : complexityEstimate.effort;
  const explicitContextRaw = merged.estimated_context_tokens
    ?? merged.estimatedContextTokens
    ?? merged.estimated_context
    ?? merged.context_tokens
    ?? merged.contextTokens
    ?? merged.estimated_context_length
    ?? merged.estimatedContextLength
    ?? merged.required_context_tokens
    ?? merged.requiredContextTokens;
  const explicitContext = Number(explicitContextRaw);
  const estimatedContextTokens = Number.isFinite(explicitContext) && explicitContext > 0
    ? Math.floor(explicitContext)
    : contextEstimate.tokens;
  const codeScope = inferCodeScope(value, merged);
  const executionMetadata = recordValue(merged.execution)
    || recordValue(merged.execution_requirements)
    || recordValue(merged.executionRequirements);
  const nativeExecution = firstBoolean(
    merged.native_execution,
    merged.nativeExecution,
    merged.native,
    merged.requires_native_execution,
    merged.requiresNativeExecution,
    executionMetadata?.native_execution,
    executionMetadata?.nativeExecution,
    executionMetadata?.native,
  ) ?? true;
  const tool = firstBoolean(
    merged.tool,
    merged.tool_use,
    merged.toolUse,
    merged.tools,
    merged.requires_tool,
    merged.requiresTool,
    merged.requires_tool_use,
    merged.requiresToolUse,
    executionMetadata?.tool,
    executionMetadata?.tool_use,
    executionMetadata?.toolUse,
  ) ?? true;
  const executionMode = inferExecutionMode(merged);
  const explicitCapabilities = capabilityNames(merged);
  const requiredCapabilities = new Set(explicitCapabilities);
  if (nativeExecution) requiredCapabilities.add("native-execution");
  if (tool) requiredCapabilities.add("tool-use");
  if (executionMode) requiredCapabilities.add(executionMode);
  const requiredExecutionCapabilities = [...requiredCapabilities].sort();
  const otherExecutionRequirements = otherRequirementNames(merged);
  const suppliedEvidence = Array.isArray(merged.evidence)
    ? merged.evidence
      .filter((item): item is SelectionRequirementEvidence => Boolean(item && typeof item === "object"))
      .map((item) => ({
        field: String(item.field || "").trim(),
        value: item.value,
        source: String(item.source || "explicit").trim() || "explicit",
        detail: String(item.detail || "").trim(),
      }))
      .filter((item) => item.field)
      .sort((left, right) => left.field.localeCompare(right.field) || left.source.localeCompare(right.source) || left.detail.localeCompare(right.detail))
    : [];
  const explicitComplexity = merged.complexity ?? merged.task_complexity ?? merged.complexity_class ?? merged.complexity_reason;
  const explicitCodeScope = merged.code_scope ?? merged.codeScope ?? merged.scope;
  const explicitReasoning = merged.reasoning ?? merged.reasoning_effort ?? merged.minimum_reasoning_effort
    ?? merged.minimumReasoningEffort ?? merged.required_reasoning_effort ?? merged.requiredReasoningEffort;
  const evidence = [
    evidenceEntry("complexity", complexity, explicitComplexity != null ? "explicit" : "task-text", `task complexity classified as ${complexity}`),
    evidenceEntry("estimated_context_tokens", estimatedContextTokens, explicitContextRaw != null ? "explicit" : `context-${contextEstimate.reason}`, `estimated context is ${estimatedContextTokens} tokens`),
    evidenceEntry("code_scope", codeScope, explicitCodeScope != null ? "explicit" : "task-text", `code scope classified as ${codeScope}`),
    evidenceEntry("reasoning", reasoning, explicitReasoning != null ? "explicit" : "task-complexity", `minimum reasoning effort is ${reasoning}`),
    evidenceEntry("native_execution", nativeExecution, "execution-contract", nativeExecution ? "delegated work requires native execution" : "native execution is not required"),
    evidenceEntry("tool", tool, "execution-contract", tool ? "delegated work requires tool use" : "tool use is not required"),
    evidenceEntry("execution_mode", executionMode, executionMode ? "execution-metadata" : "execution-default", executionMode ? `execution mode is ${executionMode}` : "no execution mode was declared"),
    evidenceEntry("required_execution_capabilities", requiredExecutionCapabilities, requiredCapabilities.size ? "execution-metadata" : "execution-default", requiredExecutionCapabilities.length ? `required capabilities: ${requiredExecutionCapabilities.join(", ")}` : "no additional execution capabilities were declared"),
    evidenceEntry("other_execution_requirements", otherExecutionRequirements, otherExecutionRequirements.length ? "execution-metadata" : "execution-default", otherExecutionRequirements.length ? `other requirements: ${otherExecutionRequirements.join(", ")}` : "no other execution requirements were declared"),
    ...suppliedEvidence,
  ];
  return {
    complexity,
    estimated_context_tokens: estimatedContextTokens,
    code_scope: codeScope,
    reasoning,
    reasoning_effort: reasoning,
    native_execution: nativeExecution,
    tool,
    tool_use: tool,
    execution_mode: executionMode,
    required_execution_capabilities: requiredExecutionCapabilities,
    other_execution_requirements: otherExecutionRequirements,
    evidence,
  };
}

/** Compatibility aliases for callers that describe this as a task contract. */
export const minimumModelRequirementsForTask = deriveMinimumModelRequirements;
export const deriveMinimumRequirements = deriveMinimumModelRequirements;
export const buildMinimumModelRequirements = deriveMinimumModelRequirements;
export const minimumRequirementsForTask = deriveMinimumModelRequirements;

function canonicalCapability(value: unknown): string {
  const text = String(value || "").trim().toLowerCase().replaceAll(/[_ ]+/g, "-");
  if (["native", "native-exec", "native-execution", "execution-handle", "native-child"].includes(text)) return "native-execution";
  if (["tool", "tools", "tool-use", "tooling", "function-calling"].includes(text)) return "tool-use";
  if (["readonly", "read"].includes(text)) return "read-only";
  if (["commit", "commitonly"].includes(text)) return "commit-only";
  return text;
}

interface RouteCapabilityView {
  supported: Set<string>;
  unsupported: Set<string>;
  known: boolean;
}

function capabilityView(card: ModelCard, route: RouteSnapshot["routes"][number] | null): RouteCapabilityView {
  const supported = new Set<string>();
  const unsupported = new Set<string>();
  let known = false;
  const values = [card as unknown as UnknownRecord, route as unknown as UnknownRecord | null].filter(Boolean) as UnknownRecord[];
  const addList = (value: unknown) => {
    if (!Array.isArray(value)) return;
    known = true;
    for (const item of value) {
      if (typeof item === "string") supported.add(canonicalCapability(item));
      else if (item && typeof item === "object") {
        const record = item as UnknownRecord;
        const name = canonicalCapability(record.id || record.name || record.capability || record.kind);
        if (!name) continue;
        if (record.supported === false || record.available === false || record.enabled === false) unsupported.add(name);
        else supported.add(name);
      }
    }
  };
  const addObject = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    known = true;
    for (const [key, item] of Object.entries(value as UnknownRecord)) {
      const name = canonicalCapability(key);
      if (!name) continue;
      if (item === true || (item && typeof item === "object" && (item as UnknownRecord).supported === true)) supported.add(name);
      else if (item === false || (item && typeof item === "object" && ((item as UnknownRecord).supported === false || (item as UnknownRecord).available === false))) unsupported.add(name);
    }
  };
  for (const value of values) {
    addList(value.execution_capabilities);
    addList(value.executionCapabilities);
    addList(value.capabilities);
    addList(value.tools);
    addList(value.supported_tools);
    addList(value.supportedTools);
    addObject(value.capabilities);
    addObject(value.execution_capabilities);
    addObject(value.executionCapabilities);
    addObject(value.execution);
    addObject(value.supports);
    const native = firstBoolean(value.supports_native_execution, value.supportsNativeExecution, value.supports_native, value.supportsNative,
      value.native_execution, value.nativeExecution,
      value === (card as unknown as UnknownRecord) ? value.native : undefined);
    if (native === true) supported.add("native-execution");
    if (native === false) unsupported.add("native-execution");
    const tools = firstBoolean(value.supports_tool_use, value.supportsToolUse, value.supports_tools, value.supportsTools,
      value.supports_tool, value.supportsTool, value.tool_use, value.toolUse,
      value === (card as unknown as UnknownRecord) ? value.tool : undefined);
    if (tools === true) supported.add("tool-use");
    if (tools === false) unsupported.add("tool-use");
  }
  // `native: true` is an explicit route fact.  A false value is omitted from
  // the support set because older catalog records use false as their default
  // when the capability is simply not reported.
  if (route?.native === true) supported.add("native-execution");
  return { supported, unsupported, known };
}

function executionCapabilityDiagnostics(
  card: ModelCard,
  route: RouteSnapshot["routes"][number] | null,
  requirements: MinimumModelRequirements,
): { diagnostics: SelectionDiagnostic[]; supported: string[] } {
  const view = capabilityView(card, route);
  const required = [...new Set([
    ...requirements.required_execution_capabilities,
    ...requirements.other_execution_requirements.map(canonicalCapability),
    ...(requirements.execution_mode ? [canonicalCapability(requirements.execution_mode)] : []),
  ])].filter(Boolean).sort();
  const diagnostics: SelectionDiagnostic[] = [];
  for (const capability of required) {
    const explicitlyUnsupported = view.unsupported.has(capability);
    // An explicit capability inventory is authoritative for named, non-core
    // requirements.  For old catalogs with no inventory, absence remains
    // unknown so existing routes retain their prior behavior.
    const absentFromKnownInventory = view.known && !view.supported.has(capability);
    if (explicitlyUnsupported || absentFromKnownInventory) {
      const why = explicitlyUnsupported
        ? `${capability} is explicitly unsupported by the route`
        : `${capability} is not advertised by the route's execution capabilities`;
      diagnostics.push({
        code: "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED",
        reason: why,
        evidence: [
          `required=${capability}`,
          `supported=${[...view.supported].sort().join(",") || "none"}`,
        ],
      });
    }
  }
  return { diagnostics, supported: [...view.supported].sort() };
}

function executionModeDiagnostics(
  card: ModelCard,
  route: RouteSnapshot["routes"][number],
  requirements: MinimumModelRequirements,
): SelectionDiagnostic[] {
  if (!requirements.execution_mode) return [];
  const cardRecord = card as unknown as UnknownRecord;
  const routeRecord = route as unknown as UnknownRecord;
  const advertised = [
    ...stringArray(cardRecord.execution_modes),
    ...stringArray(cardRecord.executionModes),
    ...stringArray(cardRecord.supported_execution_modes),
    ...stringArray(cardRecord.supportedExecutionModes),
    ...stringArray(routeRecord.execution_modes),
    ...stringArray(routeRecord.executionModes),
    ...stringArray(routeRecord.supported_execution_modes),
    ...stringArray(routeRecord.supportedExecutionModes),
  ].map(canonicalCapability);
  const required = canonicalCapability(requirements.execution_mode);
  const supportKey = required === "write" ? ["supports_write", "supportsWrite"]
    : required === "read-only" ? ["supports_read_only", "supportsReadOnly"]
      : required === "commit-only" ? ["supports_commit_only", "supportsCommitOnly"] : [];
  const explicitSupport = firstBoolean(...supportKey.flatMap((key) => [cardRecord[key], routeRecord[key]]));
  if (explicitSupport === false || (advertised.length > 0 && !advertised.includes(required))) {
    return [{
      code: "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED",
      reason: `execution mode ${requirements.execution_mode} is not supported by the route`,
      evidence: [`required_mode=${requirements.execution_mode}`, `advertised_modes=${advertised.join(",") || "none"}`],
    }];
  }
  return [];
}

function unavailableCandidate(
  card: ModelCard,
  snapshot: RouteSnapshot,
  requirements: MinimumModelRequirements,
  reason: string,
): SelectionCandidate {
  const provider = card.provider || null;
  const quota = quotaForProvider(snapshot, provider);
  const quotaPool = quotaPoolForCandidate({ model_id: card.id, route_id: card.route_id, provider, quota });
  const diagnostic: SelectionDiagnostic = {
    code: "ROUTE_ABSENT_FROM_ACTIVE_CATALOG",
    reason,
    evidence: [`configured_route=${card.route_id || card.id}`, `catalog=${snapshot.fingerprint}`],
  };
  return {
    model_id: card.id,
    route_id: card.route_id || card.id,
    reasoning_effort: card.reasoning_effort || null,
    reasoning_effort_configurable: false,
    effective_reasoning_effort: card.reasoning_effort || null,
    context_window: null,
    service_tier: null,
    speed_optimized: false,
    speed_signals: [],
    provider,
    selectable: false,
    selection_code: "ROUTE_ABSENT_FROM_ACTIVE_CATALOG",
    selection_reason: reason,
    diagnostic_code: diagnostic.code,
    diagnostics: [diagnostic],
    exclusion_reasons: [diagnostic],
    exclusion_codes: [diagnostic.code],
    selection_diagnostics: [diagnostic],
    required_execution_capabilities: requirements.required_execution_capabilities,
    execution_capabilities: [],
    automatic_eligible: false,
    task_score: scoreCard("", card),
    strengths: card.strengths,
    positioning: card.positioning || [],
    quota,
    quota_pool_id: quotaPool.id,
    quota_pool_label: quotaPool.label,
    quota_pool_status: quotaPool.status,
    quota_pool_remaining_percent: quotaPool.remaining_percent,
    availability_status: "available",
    availability_reason: null,
    probe_available: false,
  };
}

function candidateFor(
  cwd: string,
  prompt: string,
  card: ModelCard,
  snapshot: RouteSnapshot,
  automaticIds: Set<string>,
  host: string,
  estimatedContextTokens: number,
  probeRouteIds: Set<string>,
  requirements: MinimumModelRequirements,
  taskExcluded = false,
  env?: NodeJS.ProcessEnv,
): SelectionCandidate | null {
  if (!card.route_id) return null;
  const route = snapshot.routes.find((item) => item.route_id === card.route_id) || null;
  if (!route || route.disabled || card.executable === false) {
    return unavailableCandidate(card, snapshot, requirements, `route ${card.route_id} is absent from the active CLI catalog`);
  }
  const quota = quotaForProvider(snapshot, card.provider || route.provider);
  const quotaPool = quotaPoolForCandidate({
    model_id: card.id,
    route_id: card.route_id,
    provider: card.provider || route.provider || null,
    quota,
  });
  const availability = availabilityForRoute(cwd, { host, routeId: card.route_id }, new Date(), env);
  const contextInsufficient = route.context_window !== null
    && route.context_window < estimatedContextTokens;
  const effectiveReasoningEffort = card.reasoning_effort || route.default_reasoning_effort || null;
  const normalizedEffectiveEffort = normalizedEffort(effectiveReasoningEffort);
  const reasoningInsufficient = route.reasoning_efforts.length > 0
    ? !normalizedEffectiveEffort || !route.reasoning_efforts.map((item) => normalizedEffort(item) || item.toLowerCase()).includes(normalizedEffectiveEffort)
      || (EFFORT_RANK[normalizedEffectiveEffort] ?? 0) < EFFORT_RANK[requirements.reasoning]
    : Boolean(card.reasoning_effort && (!normalizedEffectiveEffort || (EFFORT_RANK[normalizedEffectiveEffort] ?? 0) < EFFORT_RANK[requirements.reasoning]));
  // A due route still needs an explicit dispatch-side probe lease. Selection
  // never silently turns every concurrent selector into a probe attempt.
  const probeClaimed = availability.status === "probe_due" && probeRouteIds.has(card.route_id);
  const probeAvailable = availability.status === "probe_due" && availability.probe_available;
  // A due route is observable here but remains ineligible until the dispatch
  // reservation atomically claims it. Match/plan therefore never mutate or
  // pre-authorize a probe lease.
  const durableExhausted = availability.status !== "available" && !probeClaimed;
  const execution = executionCapabilityDiagnostics(card, route, requirements);
  execution.diagnostics.push(...executionModeDiagnostics(card, route, requirements));
  const currentSessionUncallable = !automaticIds.has(card.id);
  const diagnostics: SelectionDiagnostic[] = [];
  if (quotaPool.status === "exhausted") {
    diagnostics.push({ code: "QUOTA_POOL_EXHAUSTED", reason: `${quotaPool.label} quota is exhausted`, evidence: [`quota_pool=${quotaPool.id}`, `remaining_percent=${quotaPool.remaining_percent ?? "unknown"}`] });
  }
  if (durableExhausted) {
    diagnostics.push({ code: "CURRENT_SESSION_QUOTA_EXHAUSTED", reason: `${availability.reason || "current Baton session quota is exhausted"}${availability.next_probe_at ? `; probe ${availability.next_probe_at}` : ""}`, evidence: [`session_status=${availability.status}`, `route=${card.route_id}`] });
  }
  if (currentSessionUncallable) {
    diagnostics.push({ code: "CURRENT_SESSION_UNCALLABLE", reason: "route is not callable in the current Baton session", evidence: [`automatic_catalog_match=${card.id}`] });
  }
  if (taskExcluded) {
    diagnostics.push({ code: "TASK_CAPABILITY_MISMATCH", reason: "route is not suitable for the text/tool work unit", evidence: [`model_id=${card.id}`] });
  }
  if (reasoningInsufficient) {
    diagnostics.push({ code: "REASONING_CAPABILITY_INSUFFICIENT", reason: `reasoning effort ${effectiveReasoningEffort || "unknown"} is below or absent from required ${requirements.reasoning}`, evidence: [`available_efforts=${route.reasoning_efforts.join(",") || "unknown"}`, `required_effort=${requirements.reasoning}`] });
  }
  if (contextInsufficient) {
    diagnostics.push({ code: "CONTEXT_WINDOW_INSUFFICIENT", reason: `context window ${route.context_window} is smaller than estimated ${estimatedContextTokens}`, evidence: [`context_window=${route.context_window}`, `estimated_context_tokens=${estimatedContextTokens}`] });
  }
  diagnostics.push(...execution.diagnostics);
  const selectable = diagnostics.length === 0;
  const wantsSpeed = classifyTask(prompt).speed > 0;
  const speedSignals: SelectionCandidate["speed_signals"] = [];
  const routeNamedFast = /(?:^|[-_.:/])(?:fast|highspeed|high-speed)(?:$|[-_.:/])/i.test(card.route_id);
  const catalogDescribesSpeed = /\b(?:fast|ultra-fast|low[- ]latency|high[- ]throughput)\b/i.test(route.description);
  const serviceTier = wantsSpeed
    ? route.service_tiers.find((tier) => /(?:fast|priority|ultrafast)/i.test(tier))
      || route.additional_speed_tiers.find((tier) => /(?:fast|priority|ultrafast)/i.test(tier))
      || null
    : null;
  if (wantsSpeed && routeNamedFast) speedSignals.push("route-name");
  if (wantsSpeed && catalogDescribesSpeed) speedSignals.push("catalog-description");
  if (serviceTier) speedSignals.push("service-tier");
  const first = diagnostics[0];
  const legacyCode: SelectionLegacyCode = first?.code === "CURRENT_SESSION_QUOTA_EXHAUSTED"
    ? "DURABLE_QUOTA_EXHAUSTED"
    : first?.code === "REASONING_CAPABILITY_INSUFFICIENT"
      ? "REASONING_EFFORT_UNSUPPORTED"
      : first?.code || "AVAILABLE";
  return {
    model_id: card.id,
    route_id: card.route_id,
    reasoning_effort: card.reasoning_effort || null,
    reasoning_effort_configurable: route.reasoning_efforts.length > 0,
    effective_reasoning_effort: effectiveReasoningEffort,
    context_window: route.context_window,
    service_tier: serviceTier,
    speed_optimized: speedSignals.length > 0,
    speed_signals: speedSignals,
    provider: card.provider || route.provider || null,
    selectable,
    selection_code: legacyCode,
    selection_reason: first?.reason || (probeClaimed
      ? "bounded due-route probe lease claimed by this dispatcher"
      : probeAvailable
        ? "due-route probe is available for the eventual reservation"
        : "model/reasoning effort was returned by the active CLI"),
    diagnostic_code: first?.code || "AVAILABLE",
    diagnostics,
    exclusion_reasons: diagnostics,
    exclusion_codes: [...new Set(diagnostics.map((diagnostic) => diagnostic.code))],
    selection_diagnostics: diagnostics,
    required_execution_capabilities: requirements.required_execution_capabilities,
    execution_capabilities: execution.supported,
    automatic_eligible: selectable && automaticIds.has(card.id),
    task_score: scoreCard(prompt, card),
    strengths: card.strengths,
    positioning: card.positioning || [],
    quota,
    quota_pool_id: quotaPool.id,
    quota_pool_label: quotaPool.label,
    quota_pool_status: quotaPool.status,
    quota_pool_remaining_percent: quotaPool.remaining_percent,
    availability_status: availability.status,
    availability_reason: availability.reason,
    probe_available: probeAvailable,
  };
}

export interface TaskContextEstimate {
  tokens: number;
  reason: SelectionUnit["context_estimate_reason"];
}

export interface TaskComplexityEstimate {
  effort: SelectionUnit["target_reasoning_effort"];
  reason: SelectionUnit["complexity_reason"];
}

export function estimateTaskComplexity(text: unknown): TaskComplexityEstimate {
  const value = String(text || "").toLowerCase();
  const dimensions = classifyTask(value);
  if ((dimensions.speed > 0 && dimensions.agentic === 0 && dimensions.intelligence === 0)
    || (/\b(?:simple|tiny|small|typo|rename-only|routine)\b|小改|简单任务|拼写|仅重命名|常规/.test(value)
    && dimensions.agentic === 0 && dimensions.intelligence === 0)) {
    return { effort: "low", reason: "simple" };
  }
  if (/\b(?:monorepo|multi-file|cross-module|migration|migrate|architecture|repository-wide|codebase-wide|complex integration)\b|全仓(?:库)?|多文件|跨模块|迁移|架构|复杂集成/.test(value)
    || dimensions.agentic >= 2
    || (dimensions.agentic >= 1 && dimensions.intelligence >= 1 && dimensions.coding >= 1)) {
    return { effort: "max", reason: "very-complex" };
  }
  if (dimensions.agentic + dimensions.intelligence + dimensions.coding >= 2
    || /\b(?:debug|investigate|refactor|review|audit|verify)\b|调试|排查|重构|审查|审计|验证/.test(value)) {
    return { effort: "high", reason: "complex" };
  }
  return { effort: "medium", reason: "standard" };
}

export function estimateTaskContext(text: unknown): TaskContextEstimate {
  const value = String(text || "").toLowerCase();
  const explicit = value.match(/(?:context|上下文)(?:\s*(?:window|窗口))?\s*(?:of|为|是|[:=])?\s*(\d+(?:\.\d+)?)\s*([km])/i)
    || value.match(/(\d+(?:\.\d+)?)\s*([km])\s*(?:context|上下文)/i);
  if (explicit) {
    const scale = explicit[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
    return { tokens: Math.max(1, Math.round(Number(explicit[1]) * scale)), reason: "explicit" };
  }
  if (/\b(?:whole|entire|all|large)\s+(?:repo|repository|codebase)\b|\b(?:repo|repository|codebase)-wide\b|\b(?:monorepo|multi-file|cross-module|migration|migrate|long[- ]context|search and digest|comprehensive audit)\b|全仓(?:库)?|整个仓库|全量|大型仓库|多文件|跨模块|迁移|长上下文|全面审计|检索并汇总/.test(value)
    || value.length >= 200_000) {
    return { tokens: 1_000_000, reason: "large-scope" };
  }
  if (/\b(?:tiny|small|single-file|one-file|typo|rename-only)\b|小改|简单任务|单文件|拼写|仅重命名/.test(value)) {
    return { tokens: 128_000, reason: "small-scope" };
  }
  return { tokens: 262_144, reason: "standard" };
}

const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

function normalizedEffort(value: string | null | undefined): string | null {
  const effort = String(value || "").trim().toLowerCase();
  return Object.hasOwn(EFFORT_RANK, effort) ? effort : null;
}

function compareEffortFit(left: string | null, right: string | null, target: SelectionUnit["target_reasoning_effort"]): number {
  const targetRank = EFFORT_RANK[target];
  const fit = (value: string | null) => {
    const effort = normalizedEffort(value);
    if (!effort) return { rank: 0, distance: Number.POSITIVE_INFINITY };
    const valueRank = EFFORT_RANK[effort];
    if (valueRank >= targetRank) return { rank: 2, distance: valueRank - targetRank };
    return { rank: 1, distance: targetRank - valueRank };
  };
  const leftFit = fit(left);
  const rightFit = fit(right);
  return rightFit.rank - leftFit.rank || leftFit.distance - rightFit.distance;
}

/**
 * Reasoning effort is a per-model execution setting, not a separate model.
 * Keep all CLI-returned profiles visible for audit, but let automatic routing
 * compare exactly one best-fit profile per route.
 */
function restrictAutomaticEffortCandidates(
  candidates: SelectionCandidate[],
  target: SelectionUnit["target_reasoning_effort"],
): void {
  const byRoute = new Map<string, SelectionCandidate[]>();
  for (const candidate of candidates) {
    const values = byRoute.get(candidate.route_id) || [];
    values.push(candidate);
    byRoute.set(candidate.route_id, values);
  }
  for (const values of byRoute.values()) {
    if (!values.some((candidate) => candidate.reasoning_effort_configurable)) continue;
    const targetRank = EFFORT_RANK[target];
    const eligibleProfiles = values
      .filter((candidate) => candidate.automatic_eligible
        && (candidate.effective_reasoning_effort === null
          || EFFORT_RANK[normalizedEffort(candidate.effective_reasoning_effort) || "none"] >= targetRank))
      .sort((left, right) => compareEffortFit(
        left.effective_reasoning_effort,
        right.effective_reasoning_effort,
        target,
      ) || Number(Boolean(right.reasoning_effort)) - Number(Boolean(left.reasoning_effort))
        || left.model_id.localeCompare(right.model_id));
    for (const candidate of values) {
      candidate.automatic_eligible = false;
    }
    if (eligibleProfiles[0]) eligibleProfiles[0].automatic_eligible = true;
  }
}

/** Stable catalog-backed ordering when task text does not identify one winner. */
function compareContextFit(left: number | null, right: number | null, target: number): number {
  const fit = (window: number | null) => {
    if (window == null) return { rank: 0, distance: Number.POSITIVE_INFINITY };
    if (window >= target) return { rank: 2, distance: window - target };
    return { rank: 1, distance: target - window };
  };
  const leftFit = fit(left);
  const rightFit = fit(right);
  return rightFit.rank - leftFit.rank || leftFit.distance - rightFit.distance;
}

function recommendationTieBreak(
  left: SelectionCandidate,
  right: SelectionCandidate,
  targetEffort: SelectionUnit["target_reasoning_effort"],
  estimatedContextTokens: number,
): number {
  const quotaRank: Record<QuotaPoolStatus, number> = { available: 2, unknown: 1, exhausted: 0 };
  return compareEffortFit(left.effective_reasoning_effort, right.effective_reasoning_effort, targetEffort)
    // When the CLI exposes explicit efforts, persist the chosen level instead
    // of relying on an implicit model default with the same effective rank.
    || Number(Boolean(right.reasoning_effort)) - Number(Boolean(left.reasoning_effort))
    || compareContextFit(left.context_window, right.context_window, estimatedContextTokens)
    || Number(right.speed_optimized) - Number(left.speed_optimized)
    || quotaRank[right.quota_pool_status] - quotaRank[left.quota_pool_status]
    || (right.quota_pool_remaining_percent ?? -1) - (left.quota_pool_remaining_percent ?? -1)
    || (right.task_score ?? -1) - (left.task_score ?? -1)
    || left.model_id.localeCompare(right.model_id);
}

export function buildSelectionUnit({
  cwd,
  host,
  key,
  description,
  prompt,
  cards,
  automaticCards,
  requestedModelId = null,
  directorLocal = false,
  codingModels,
  probeRouteIds = [],
  env,
  metadata = {},
  minimumRequirements,
  minimumModelRequirements,
  requirements,
  executionRequirements,
}: {
  cwd: string;
  host?: string;
  key: string;
  description: string;
  prompt: string;
  cards: ModelCard[];
  automaticCards: ModelCard[];
  requestedModelId?: string | null;
  directorLocal?: boolean;
  /** Ordered base route ids from cli.<host>.coding_models. */
  codingModels: string[];
  /** At most one due route may be enabled by a real spawn/apply probe lease. */
  probeRouteIds?: string[];
  env?: NodeJS.ProcessEnv;
  metadata?: UnknownRecord;
  /** Optional explicit execution contract; task-derived values remain the default. */
  minimumRequirements?: MinimumModelRequirementsInput;
  minimumModelRequirements?: MinimumModelRequirementsInput;
  /** Compatibility spelling for callers that call the contract `requirements`. */
  requirements?: MinimumModelRequirementsInput;
  executionRequirements?: MinimumModelRequirementsInput;
}): SelectionUnit {
  const nestedRequirements = [
    recordValue(metadata.minimum_requirements),
    recordValue(metadata.minimum_model_requirements),
    recordValue(metadata.minimumRequirements),
    recordValue(metadata.minimumModelRequirements),
  ].filter((item): item is UnknownRecord => item !== null);
  const explicitRequirements = {
    ...metadata,
    ...Object.assign({}, ...nestedRequirements),
    ...(minimumRequirements || {}),
    ...(minimumModelRequirements || {}),
    ...(requirements || {}),
    ...(executionRequirements || {}),
  } as MinimumModelRequirementsInput;
  const executionMetadata = recordValue(explicitRequirements.execution)
    || recordValue(explicitRequirements.execution_requirements)
    || recordValue(explicitRequirements.executionRequirements);
  const nativeRequirement = firstBoolean(
    explicitRequirements.native_execution,
    explicitRequirements.nativeExecution,
    explicitRequirements.native,
    explicitRequirements.requires_native_execution,
    explicitRequirements.requiresNativeExecution,
    executionMetadata?.native_execution,
    executionMetadata?.nativeExecution,
    executionMetadata?.native,
  );
  if (nativeRequirement === null) {
    explicitRequirements.native_execution = !directorLocal;
  }
  const toolRequirement = firstBoolean(
    explicitRequirements.tool,
    explicitRequirements.tool_use,
    explicitRequirements.toolUse,
    explicitRequirements.tools,
    explicitRequirements.requires_tool,
    explicitRequirements.requiresTool,
    explicitRequirements.requires_tool_use,
    explicitRequirements.requiresToolUse,
    executionMetadata?.tool,
    executionMetadata?.tool_use,
    executionMetadata?.toolUse,
  );
  if (toolRequirement === null) {
    explicitRequirements.tool = !directorLocal;
  }
  const minimum = deriveMinimumModelRequirements(prompt, explicitRequirements);
  const contextEstimate = estimateTaskContext(prompt);
  const complexityEstimate = estimateTaskComplexity(prompt);
  const explicitContextValue = explicitRequirements.estimated_context_tokens
    ?? explicitRequirements.estimatedContextTokens
    ?? explicitRequirements.estimated_context
    ?? explicitRequirements.context_tokens
    ?? explicitRequirements.contextTokens
    ?? explicitRequirements.estimated_context_length
    ?? explicitRequirements.estimatedContextLength
    ?? explicitRequirements.required_context_tokens
    ?? explicitRequirements.requiredContextTokens;
  const contextEstimateReason: SelectionUnit["context_estimate_reason"] = explicitContextValue != null
    ? "explicit"
    : contextEstimate.reason;
  const complexityReason: SelectionUnit["complexity_reason"] = COMPLEXITY_VALUES.has(minimum.complexity)
    ? minimum.complexity
    : complexityEstimate.reason;
  if (directorLocal) {
    return {
      ...(host ? { host } : {}), key, description, prompt, director_local: true,
      recommended_model_id: null, requested_model_id: null, default_model_id: null,
      recommendation_reason: "DIRECTOR_LOCAL",
      target_reasoning_effort: minimum.reasoning,
      complexity_reason: complexityReason,
      estimated_context_tokens: minimum.estimated_context_tokens,
      context_estimate_reason: contextEstimateReason,
      minimum_requirements: minimum,
      requires_manual_choice: false,
      candidates: [],
      qualification_status: "qualified",
      no_qualified_result: null,
      task_exclusions: [],
      metadata,
    };
  }
  const snapshot = readRouteSnapshot(cwd, { host, env });
  if (!snapshot) throw new Error("ROUTE_SNAPSHOT_REQUIRED: run baton config before model selection");
  const taskExclusions = cards
    .map(taskCapabilityExclusion)
    .filter((item): item is TaskCapabilityExclusion => item !== null);
  const excludedIds = new Set(taskExclusions.map((item) => item.model_id));
  const automaticIds = new Set(automaticCards.map((card) => card.id));
  const selectedHost = String(host || snapshot.cli || "");
  if (!selectedHost) throw new Error("HOST_REQUIRED: model selection must name its runtime host");
  const claimedProbeRoutes = new Set(probeRouteIds);
  const configuredIds = [...new Set(codingModels.map((item) => String(item || "").trim()).filter(Boolean))];
  const configuredPriorityFor = (candidate: Pick<SelectionCandidate, "model_id" | "route_id">): number => {
    const exact = configuredIds.indexOf(candidate.model_id);
    if (exact >= 0) return exact;
    const base = configuredIds.indexOf(candidate.route_id);
    if (base >= 0) return base;
    const variant = configuredIds.findIndex((item) => item.startsWith(`${candidate.route_id}@`));
    return variant >= 0 ? variant : Number.MAX_SAFE_INTEGER;
  };
  const routeForConfiguredId = (configuredId: string): RouteSnapshot["routes"][number] | null => {
    const direct = snapshot.routes.find((route) => route.route_id === configuredId);
    if (direct) return direct;
    const matchingCard = cards.find((card) => card.id === configuredId && card.route_id);
    if (matchingCard?.route_id) return snapshot.routes.find((route) => route.route_id === matchingCard.route_id) || null;
    const base = configuredId.includes("@") ? configuredId.slice(0, configuredId.lastIndexOf("@")) : configuredId;
    return snapshot.routes.find((route) => route.route_id === base) || null;
  };
  const candidates: SelectionCandidate[] = [];
  const candidateIds = new Set<string>();
  for (const configuredId of configuredIds) {
    const route = routeForConfiguredId(configuredId);
    if (!route) {
      const configuredCard = cards.find((card) => card.id === configuredId)
        || { id: configuredId, strengths: "configured route", route_id: configuredId, executable: false };
      const candidate = unavailableCandidate(configuredCard, snapshot, minimum, `route ${configuredId} is absent from the active CLI catalog`);
      if (!candidateIds.has(candidate.model_id)) {
        candidateIds.add(candidate.model_id);
        candidates.push(candidate);
      }
      continue;
    }
    const routeBase = route.route_id;
    const isVariant = configuredId !== routeBase && configuredId.startsWith(`${routeBase}@`);
    let routeCards = cards.filter((card) => card.route_id === routeBase);
    if (isVariant) {
      const requestedEffort = configuredId.slice(routeBase.length + 1);
      routeCards = routeCards.filter((card) => card.id === configuredId || card.reasoning_effort === requestedEffort);
    } else if (cards.some((card) => card.id === configuredId && card.route_id === routeBase)) {
      // A configured card id can be an exact variant returned by the CLI.
      const exact = cards.filter((card) => card.id === configuredId && card.route_id === routeBase);
      if (exact.some((card) => card.reasoning_effort)) routeCards = exact;
    }
    if (!routeCards.length) {
      const inferredEffort = isVariant ? configuredId.slice(routeBase.length + 1) : undefined;
      routeCards = [{
        id: configuredId,
        strengths: route.description,
        display_name: route.display_name,
        description: route.description,
        route_id: routeBase,
        ...(inferredEffort ? { reasoning_effort: inferredEffort } : {}),
        source: "dynamic",
        provider: route.provider,
        executable: !route.disabled,
        available_speed_tiers: route.additional_speed_tiers,
        service_tiers: route.service_tiers,
        default_service_tier: route.default_service_tier,
        is_default: route.is_default,
      }];
    }
    for (const card of routeCards) {
      // Keep task suitability exclusions as a separate audit list, but do not
      // let an unconfigured card leak into the candidate set.
      const taskExcluded = excludedIds.has(card.id);
      const candidate = candidateFor(cwd, prompt, card, snapshot, automaticIds, selectedHost, minimum.estimated_context_tokens, claimedProbeRoutes, minimum, taskExcluded, env);
      if (candidate && !candidateIds.has(candidate.model_id)) {
        candidateIds.add(candidate.model_id);
        candidates.push(candidate);
      }
    }
  }
  restrictAutomaticEffortCandidates(candidates, minimum.reasoning);
  candidates.sort((a, b) => {
    return configuredPriorityFor(a) - configuredPriorityFor(b)
      || Number(b.selectable) - Number(a.selectable)
      || recommendationTieBreak(a, b, minimum.reasoning, minimum.estimated_context_tokens);
  });
  const automatic = candidates.filter((item) => item.automatic_eligible);
  const priorityOrdered = automatic.slice().sort((left, right) =>
    configuredPriorityFor(left) - configuredPriorityFor(right)
    || recommendationTieBreak(left, right, minimum.reasoning, minimum.estimated_context_tokens));
  const recommended = priorityOrdered[0]?.model_id || null;
  let reason: SelectionUnit["recommendation_reason"];
  if (!automatic.length) reason = "CODING_MODELS_EXHAUSTED";
  else reason = "CODING_PRIORITY";

  if (requestedModelId) {
    const requested = candidates.find((item) => item.model_id === requestedModelId);
    if (!requested) throw new Error(`requested model is not an exact route/profile id in this proposal: ${requestedModelId}`);
    if (!requested.selectable) throw new Error(`${requestedModelId}: ${requested.selection_code}: ${requested.selection_reason}`);
  }
  const defaultModel = requestedModelId || recommended;
  const noQualifiedResult: SelectionNoQualifiedResult | null = automatic.length ? null : {
    code: "NO_QUALIFIED_CANDIDATE",
    configured_route_ids: configuredIds,
    exclusions: candidates.map((candidate) => ({
      model_id: candidate.model_id,
      route_id: candidate.route_id,
      codes: [...new Set(candidate.diagnostics.map((diagnostic) => diagnostic.code))],
      reasons: [...new Set(candidate.diagnostics.map((diagnostic) => diagnostic.reason))],
    })),
  };
  return {
    ...(host ? { host } : {}),
    key,
    description,
    prompt,
    director_local: false,
    recommended_model_id: recommended,
    requested_model_id: requestedModelId,
    default_model_id: defaultModel,
    recommendation_reason: reason,
    target_reasoning_effort: minimum.reasoning,
    complexity_reason: minimum.complexity,
    estimated_context_tokens: minimum.estimated_context_tokens,
    context_estimate_reason: contextEstimateReason,
    minimum_requirements: minimum,
    requires_manual_choice: defaultModel == null,
    candidates,
    qualification_status: automatic.length ? "qualified" : "no-qualified-candidate",
    no_qualified_result: noQualifiedResult,
    task_exclusions: taskExclusions,
    metadata,
  };
}

function taskExclusionSummary(units: SelectionUnit[]): TaskCapabilityExclusion[] {
  const exclusions = new Map<string, TaskCapabilityExclusion>();
  for (const unit of units) {
    for (const exclusion of unit.task_exclusions || []) exclusions.set(exclusion.model_id, exclusion);
  }
  return [...exclusions.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
}

function proposalQuotaPools(units: SelectionUnit[]): SelectionQuotaPool[] {
  const candidates = new Map<string, SelectionCandidate>();
  for (const unit of units) {
    for (const candidate of unit.candidates) {
      if (!candidates.has(candidate.model_id)) candidates.set(candidate.model_id, candidate);
    }
  }
  return [...candidates.values()].map((candidate) => quotaPoolForCandidate(candidate)).sort((a, b) => a.id.localeCompare(b.id));
}

function proposalMinimumRequirements(units: SelectionUnit[]): Record<string, MinimumModelRequirements> {
  const result: Record<string, MinimumModelRequirements> = {};
  for (const unit of units.slice().sort((left, right) => left.key.localeCompare(right.key))) {
    result[unit.key] = structuredClone(unit.minimum_requirements || deriveMinimumModelRequirements(unit.prompt, {
      complexity: unit.complexity_reason,
      estimated_context_tokens: unit.estimated_context_tokens,
      reasoning: unit.target_reasoning_effort,
      native_execution: !unit.director_local,
    }));
  }
  return result;
}

function nextProposalId(cwd: string, env?: NodeJS.ProcessEnv): string {
  const dir = selectionsDir(cwd, env);
  if (!fs.existsSync(dir)) return "sel-0001";
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^sel-(\d+)\.json$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `sel-${String(max + 1).padStart(4, "0")}`;
}

export function createSelectionProposal(cwd: string, {
  host,
  source,
  units,
  sourceFingerprint,
  payload = {},
  now = new Date(),
  env,
}: {
  host?: string;
  source: SelectionProposal["source"];
  units: SelectionUnit[];
  sourceFingerprint: string;
  payload?: UnknownRecord;
  now?: Date | string | number;
  env?: NodeJS.ProcessEnv;
}): SelectionProposal {
  if (source === "standalone" && (payload.source_shape !== "multi-unit-v1" || !Array.isArray(payload.units))) {
    throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: standalone proposals must use the multi-unit shape");
  }
  const scopedHost = host || units.find((unit) => unit.host)?.host;
  const snapshot = readRouteSnapshot(cwd, { host: scopedHost, env });
  if (!snapshot) throw new Error("ROUTE_SNAPSHOT_REQUIRED: run baton config before model selection");
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const proposal: SelectionProposal = {
    schema_version: 2,
    ...(scopedHost ? { host: scopedHost } : {}),
    id: nextProposalId(cwd, env),
    status: "pending_confirmation",
    source,
    created_at: createdAt,
    approved_at: null,
    catalog_fingerprint: snapshot.fingerprint,
    source_fingerprint: scopedSourceFingerprint(scopedHost, sourceFingerprint),
    units,
    minimum_requirements: proposalMinimumRequirements(units),
    quota_pools: proposalQuotaPools(units),
    task_exclusions: taskExclusionSummary(units),
    payload,
    confirmation: null,
    approvals: [],
    history: [{ event: "pending_confirmation", at: createdAt }],
  };
  writeSelectionProposal(cwd, proposal, env);
  return proposal;
}

export function selectionSourceFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function writeSelectionProposal(cwd: string, proposal: SelectionProposal, env?: NodeJS.ProcessEnv): SelectionProposal {
  const dir = selectionsDir(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${proposal.id}.json`);
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return proposal;
}

export function readSelectionProposal(cwd: string, id: string, env?: NodeJS.ProcessEnv): SelectionProposal {
  const file = path.join(selectionsDir(cwd, env), `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`selection proposal not found: ${id}`);
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as SelectionProposal;
  if (value.schema_version !== 2) {
    throw new Error(`SELECTION_PROPOSAL_SCHEMA_UNSUPPORTED: ${value.schema_version}; create a new proposal`);
  }
  if (value.source === "standalone" && (value.payload?.source_shape !== "multi-unit-v1" || !Array.isArray(value.payload?.units))) {
    throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: standalone proposals must use the multi-unit shape");
  }
  if (!Array.isArray(value.units) || !Array.isArray(value.quota_pools) || !Array.isArray(value.task_exclusions)) {
    throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: proposal fields are incomplete");
  }
  // Proposals written before requirement persistence remain readable. New
  // proposals always carry a deterministic unit-keyed copy.
  if (!value.minimum_requirements || typeof value.minimum_requirements !== "object" || Array.isArray(value.minimum_requirements)) {
    value.minimum_requirements = proposalMinimumRequirements(value.units);
  }
  return value;
}

export function listSelectionProposals(cwd: string, env?: NodeJS.ProcessEnv): SelectionProposal[] {
  const dir = selectionsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^sel-\d+\.json$/.test(name))
    .map((name) => readSelectionProposal(cwd, name.slice(0, -5), env))
    .sort((a, b) => a.id.localeCompare(b.id));
}
