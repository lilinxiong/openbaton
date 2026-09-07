import {
  TaskCapabilityExclusion,
  WORK_MODE_DEFAULT_EFFORT,
  normalizeWorkMode,
  taskCapabilityExclusion,
  type WorkMode,
} from "../task-suitability.js";
import {
  candidateFor,
  unavailableCandidate
} from "./candidates.js";
import {
  RouteSnapshot,
  readRouteSnapshot
} from "../routes.js";
import {
  deriveMinimumModelRequirements,
  estimateTaskContext,
  firstBoolean,
  recordValue
} from "./requirements.js";
import {
  EFFORT_VALUES,
  MinimumModelRequirementsInput,
  QuotaPoolStatus,
  ReasoningEffort,
  SelectionCandidate,
  SelectionNoQualifiedResult,
  SelectionUnit
} from "../selection.js";
import type { ModelCard, UnknownRecord } from "../../types.js";
/**
 * Selection-unit construction (effort/context fit, tie-breaks). Split from
 * selection.ts.
 */

export const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

export function normalizedEffort(value: string | null | undefined): string | null {
  const effort = String(value || "").trim().toLowerCase();
  return Object.hasOwn(EFFORT_RANK, effort) ? effort : null;
}

export function compareEffortFit(left: string | null, right: string | null, target: SelectionUnit["target_reasoning_effort"]): number {
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
export function restrictAutomaticEffortCandidates(
  candidates: SelectionCandidate[],
  target: SelectionUnit["target_reasoning_effort"],
  explicit = false,
): void {
  const byRoute = new Map<string, SelectionCandidate[]>();
  for (const candidate of candidates) {
    const values = byRoute.get(candidate.route_id) || [];
    values.push(candidate);
    byRoute.set(candidate.route_id, values);
  }
  for (const values of byRoute.values()) {
    if (!values.some((candidate) => candidate.reasoning_effort_configurable)) {
      if (!explicit) continue;
      for (const candidate of values) {
        candidate.automatic_eligible = false;
        if (candidate.selection_code === "AVAILABLE") {
          candidate.selectable = false;
          candidate.selection_code = "REASONING_EFFORT_UNSUPPORTED";
          candidate.selection_reason = `route does not expose requested reasoning effort ${target}`;
        }
      }
      continue;
    }
    const targetRank = EFFORT_RANK[target];
    const eligibleProfiles = values
      .filter((candidate) => candidate.automatic_eligible
        && candidate.reasoning_effort
        && (explicit
          ? normalizedEffort(candidate.effective_reasoning_effort) === target
          : EFFORT_RANK[normalizedEffort(candidate.effective_reasoning_effort) || "none"] >= targetRank))
      .sort((left, right) => compareEffortFit(
        left.effective_reasoning_effort,
        right.effective_reasoning_effort,
        target,
      ) || Number(Boolean(right.reasoning_effort)) - Number(Boolean(left.reasoning_effort))
        || left.model_id.localeCompare(right.model_id));
    for (const candidate of values) {
      candidate.automatic_eligible = false;
      if (explicit
        && candidate.reasoning_effort
        && normalizedEffort(candidate.effective_reasoning_effort) !== target
        && candidate.selection_code === "AVAILABLE") {
        candidate.selectable = false;
        candidate.selection_code = "REASONING_EFFORT_UNSUPPORTED";
        candidate.selection_reason = `reasoning effort ${candidate.effective_reasoning_effort || candidate.reasoning_effort} does not match required ${target}`;
      }
    }
    if (eligibleProfiles[0]) eligibleProfiles[0].automatic_eligible = true;
  }
}

function resolveReasoningEffort(
  reasoningEffort: ReasoningEffort | string | null | undefined,
  workMode: WorkMode,
): ReasoningEffort {
  if (reasoningEffort !== undefined && reasoningEffort !== null && String(reasoningEffort).trim()) {
    const normalized = normalizedEffort(reasoningEffort);
    if (!normalized || !EFFORT_VALUES.has(normalized as ReasoningEffort)) {
      throw new Error(`REASONING_EFFORT_INVALID: ${String(reasoningEffort)}`);
    }
    return normalized as ReasoningEffort;
  }
  return WORK_MODE_DEFAULT_EFFORT[workMode];
}

function resolveContextTokens(contextTokens: number | null | undefined): {
  tokens: number;
  reason: SelectionUnit["context_estimate_reason"];
} {
  if (contextTokens === undefined || contextTokens === null) return { tokens: 0, reason: "unspecified" };
  if (!Number.isFinite(contextTokens) || contextTokens < 0) throw new Error(`CONTEXT_TOKENS_INVALID: ${String(contextTokens)}`);
  return { tokens: Math.floor(contextTokens), reason: "explicit" };
}

/** Stable catalog-backed ordering when task text does not identify one winner. */
export function compareContextFit(left: number | null, right: number | null, target: number): number {
  const fit = (window: number | null) => {
    if (window == null) return { rank: 0, distance: Number.POSITIVE_INFINITY };
    if (window >= target) return { rank: 2, distance: window - target };
    return { rank: 1, distance: target - window };
  };
  const leftFit = fit(left);
  const rightFit = fit(right);
  return rightFit.rank - leftFit.rank || leftFit.distance - rightFit.distance;
}

export function recommendationTieBreak(
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
  modelPreferences = {},
  workMode = "implementation",
  reasoningEffort,
  contextTokens,
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
  /** Optional per-work-mode ordering, constrained to the enabled codingModels allowlist. */
  modelPreferences?: Partial<Record<WorkMode, string[]>>;
  workMode?: WorkMode | string;
  reasoningEffort?: ReasoningEffort | string | null;
  contextTokens?: number | null;
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
  const resolvedWorkMode = normalizeWorkMode(workMode);
  if (!resolvedWorkMode) throw new Error(`WORK_MODE_INVALID: ${String(workMode)}`);
  const hasExplicitReasoningEffort = reasoningEffort !== undefined
    && reasoningEffort !== null
    && String(reasoningEffort).trim().length > 0;
  let targetEffort = resolveReasoningEffort(reasoningEffort, resolvedWorkMode);
  const requestedInputCard = requestedModelId ? cards.find((card) => card.id === requestedModelId) : undefined;
  if (requestedInputCard?.reasoning_effort) {
    const requestedProfileEffort = normalizedEffort(requestedInputCard.reasoning_effort);
    if (!requestedProfileEffort) throw new Error(`REASONING_EFFORT_INVALID: ${requestedInputCard.reasoning_effort}`);
    if (hasExplicitReasoningEffort && requestedProfileEffort !== targetEffort) {
      throw new Error(`REQUESTED_MODEL_EFFORT_CONFLICT: ${requestedModelId} uses ${requestedProfileEffort}, requested ${targetEffort}`);
    }
    if (!hasExplicitReasoningEffort) targetEffort = requestedProfileEffort as ReasoningEffort;
  }
  const parsedContext = estimateTaskContext(prompt);
  const contextEstimate = contextTokens !== undefined && contextTokens !== null
    ? resolveContextTokens(contextTokens)
    : parsedContext.reason === "explicit"
      ? parsedContext
      : { tokens: 0, reason: "unspecified" as const };
  const complexityReason: SelectionUnit["complexity_reason"] = resolvedWorkMode === "execution" ? "simple"
    : resolvedWorkMode === "investigation" ? "complex" : "standard";
  explicitRequirements.complexity = explicitRequirements.complexity ?? complexityReason;
  explicitRequirements.reasoning_effort = explicitRequirements.reasoning_effort ?? targetEffort;
  explicitRequirements.estimated_context_tokens = explicitRequirements.estimated_context_tokens
    ?? (contextEstimate.reason === "explicit" ? contextEstimate.tokens : 0);
  const minimum = deriveMinimumModelRequirements(prompt, explicitRequirements);
  const contextEstimateReason = contextEstimate.reason;
  if (directorLocal) {
    return {
      ...(host ? { host } : {}), key, description, prompt, director_local: true,
      recommended_model_id: null, requested_model_id: null, default_model_id: null,
      recommendation_reason: "DIRECTOR_LOCAL",
      work_mode: resolvedWorkMode,
      target_reasoning_effort: targetEffort,
      complexity_reason: complexityReason,
      estimated_context_tokens: contextEstimate.tokens,
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
  const enabledRoutes = new Set(codingModels.map((item) => String(item || "").trim()).filter(Boolean));
  const preferredRoutes = (modelPreferences[resolvedWorkMode] || [])
    .map((routeId) => String(routeId || "").trim())
    .filter((routeId) => enabledRoutes.has(routeId));
  const configuredIds = [...new Set([...preferredRoutes, ...codingModels.map((item) => String(item || "").trim()).filter(Boolean)])];
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
      const candidate = candidateFor(cwd, prompt, card, snapshot, automaticIds, selectedHost, contextEstimate.tokens, claimedProbeRoutes, minimum, taskExcluded, env);
      if (candidate && !candidateIds.has(candidate.model_id)) {
        candidateIds.add(candidate.model_id);
        candidates.push(candidate);
      }
    }
  }
  restrictAutomaticEffortCandidates(candidates, targetEffort, hasExplicitReasoningEffort);
  candidates.sort((a, b) => {
    return configuredPriorityFor(a) - configuredPriorityFor(b)
      || Number(b.selectable) - Number(a.selectable)
      || recommendationTieBreak(a, b, targetEffort, contextEstimate.tokens);
  });
  const automatic = candidates.filter((item) => item.automatic_eligible);
  const priorityOrdered = automatic.slice().sort((left, right) =>
    configuredPriorityFor(left) - configuredPriorityFor(right)
    || recommendationTieBreak(left, right, targetEffort, contextEstimate.tokens));
  const automaticRecommended = priorityOrdered[0]?.model_id || null;
  let reason: SelectionUnit["recommendation_reason"];
  if (!automatic.length) reason = "CODING_MODELS_EXHAUSTED";
  else reason = "CODING_PRIORITY";

  let requested: SelectionCandidate | undefined;
  let resolvedRequestedModelId = requestedModelId;
  if (requestedModelId) {
    requested = candidates.find((item) => item.model_id === requestedModelId)
      || candidates.find((item) => item.route_id === requestedModelId && !item.reasoning_effort);
    if (!requested) throw new Error(`requested model is not an exact route/profile id in this proposal: ${requestedModelId}`);
    if (!requested.reasoning_effort && requested.reasoning_effort_configurable) {
      const requestedProfiles = candidates.filter((item) => item.route_id === requested!.route_id && item.reasoning_effort);
      const requestedProfile = hasExplicitReasoningEffort
        ? requestedProfiles.find((item) => item.reasoning_effort === targetEffort)
        : requestedProfiles
          .filter((item) => EFFORT_RANK[normalizedEffort(item.reasoning_effort) || "none"] >= EFFORT_RANK[targetEffort])
          .sort((left, right) => compareEffortFit(left.reasoning_effort, right.reasoning_effort, targetEffort))[0];
      if (!requestedProfile) {
        throw new Error(`${requestedModelId}: REASONING_EFFORT_UNSUPPORTED: reasoning effort ${targetEffort} was not returned for ${requested.route_id}`);
      }
      requested = requestedProfile;
      resolvedRequestedModelId = requested.model_id;
    }
    if (hasExplicitReasoningEffort && !requested.reasoning_effort_configurable) {
      throw new Error(`${requestedModelId}: REASONING_EFFORT_UNSUPPORTED: route does not expose requested reasoning effort ${targetEffort}`);
    }
    if (!requested.selectable) throw new Error(`${requestedModelId}: ${requested.selection_code}: ${requested.selection_reason}`);
    reason = "REQUESTED_MODEL";
    candidates.sort((left, right) => Number(right.model_id === resolvedRequestedModelId) - Number(left.model_id === resolvedRequestedModelId));
  }
  const recommended = requested?.model_id || automaticRecommended;
  const defaultModel = recommended;
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
    requested_model_id: resolvedRequestedModelId,
    default_model_id: defaultModel,
    recommendation_reason: reason,
    work_mode: resolvedWorkMode,
    target_reasoning_effort: targetEffort,
    complexity_reason: complexityReason,
    estimated_context_tokens: contextEstimate.tokens,
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
