/**
 * Candidate capability evaluation for route selection. Split from
 * selection.ts.
 */
import type { RouteSnapshot } from "../routes.js";

export type QuotaCandidate = { model_id: string; route_id?: string; provider: string | null; quota: ProviderQuotaDisclosure };
export function quotaPoolForCandidate(candidate: QuotaCandidate): SelectionQuotaPool {
  const values = candidate.quota.windows.map((item) => item.remaining_percent).filter(Number.isFinite);
  const remaining = values.length ? Math.min(...values) : null;
  const status: QuotaPoolStatus = remaining === 0 ? "exhausted" : remaining == null ? "unknown" : "available";
  return { id: candidate.model_id, provider: candidate.provider || "unknown", label: candidate.provider || "unknown",
    status, selectable: status !== "exhausted", remaining_percent: remaining, source: candidate.quota.source,
    observed_at: candidate.quota.observed_at, reason: status === "unknown" ? candidate.quota.reason : null,
    windows: candidate.quota.windows, model_ids: [candidate.model_id] };
}
import { taskCapabilityExclusion, type TaskCapabilityExclusion } from "../task-suitability.js";
import { availabilityForRoute } from "../model-availability.js";
import type { ModelCard, ModelSelectionApproval, UnknownRecord } from "../../types.js";
import { readJsonFile, sha256Hex, writeJsonAtomic } from "../json-utils.js";
import {
  EFFORT_RANK,
  normalizedEffort
} from "./unit.js";
import {
  firstBoolean,
  stringArray
} from "./requirements.js";
import {
  MinimumModelRequirements,
  QuotaPoolStatus,
  SelectionCandidate,
  SelectionDiagnostic,
  SelectionLegacyCode,
  SelectionQuotaPool
} from "../selection.js";
import { classifyTask, scoreCard } from "../cards.js";
import {
  ProviderQuotaDisclosure,
  quotaForProvider
} from "../provider-quotas.js";

export function canonicalCapability(value: unknown): string {
  const text = String(value || "").trim().toLowerCase().replaceAll(/[_ ]+/g, "-");
  if (["native", "native-exec", "native-execution", "execution-handle", "native-child"].includes(text)) return "native-execution";
  if (["tool", "tools", "tool-use", "tooling", "function-calling"].includes(text)) return "tool-use";
  if (["readonly", "read"].includes(text)) return "read-only";
  if (["commit", "commitonly"].includes(text)) return "commit-only";
  return text;
}

export interface RouteCapabilityView {
  supported: Set<string>;
  unsupported: Set<string>;
  known: boolean;
}

export function capabilityView(card: ModelCard, route: RouteSnapshot["routes"][number] | null): RouteCapabilityView {
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

export function executionCapabilityDiagnostics(
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

export function executionModeDiagnostics(
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

export function unavailableCandidate(
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

export function candidateFor(
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
