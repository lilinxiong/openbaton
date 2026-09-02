import { SpawnTicket } from "../spawn.js";
import { UnknownRecord } from "../../types.js";
import { HostId } from "../hosts.js";
import {
  ExecutableRoute,
  readRouteSnapshot
} from "../routes.js";
import {
  CompiledApplyContext,
  isCompiledApplyTicket,
  validateCompiledTicket
} from "./compiled.js";
import { deriveMinimumModelRequirements } from "../selection/requirements.js";
import {
  readReceipt,
  writeReceipt
} from "../receipt.js";
import {
  listSpawns,
  sessionTicketId,
  writeSpawn
} from "../spawn/store.js";
import { AsyncSafetyOptions } from "../safety.js";
import { auditWorktreeAsync } from "../safety/audit.js";
import {
  configuredCodingModelsForHost,
  loadConfig
} from "../config.js";
import {
  DispatchError,
  requiredCapacity,
  resolvedCapacity,
  ticketTargetHost
} from "./core.js";
import {
  availabilityForRoute,
  isConfirmedQuotaExhaustion,
  isExplicitRateLimit,
  markRouteAvailable,
  markRouteExhausted
} from "../model-availability.js";
/**
 * Quota-successor route selection and creation. Split from dispatch.ts.
 */

export function availabilityOutcome(
  cwd: string,
  ticket: SpawnTicket,
  at: string,
  outcome: { errorCode?: string | null; message?: string | null; remainingPercent?: number | null; resetAt?: string | null; success?: boolean; env?: NodeJS.ProcessEnv },
): UnknownRecord | null {
  if (!ticket.route_id) return null;
  let host: HostId;
  try {
    host = ticketTargetHost(ticket, outcome.env);
  } catch {
    return null;
  }
  try {
    const positiveRemaining = typeof outcome.remainingPercent === "number"
      && Number.isFinite(outcome.remainingPercent)
      && outcome.remainingPercent > 0;
    if (isConfirmedQuotaExhaustion(outcome) && !positiveRemaining) {
      const record = markRouteExhausted(cwd, { host, routeId: ticket.route_id }, {
        reason: outcome.errorCode || "QUOTA_EXHAUSTED",
        evidenceKind: "quota",
        resetAt: outcome.resetAt || null,
        now: at,
        env: outcome.env,
      });
      return {
        status: record.status,
        reason: record.reason,
        evidence_kind: record.evidence_kind,
        reset_at: record.reset_at,
        next_probe_at: record.next_probe_at,
        remaining_percent: outcome.remainingPercent ?? null,
      };
    }
    if (isExplicitRateLimit(outcome)) {
      const record = markRouteExhausted(cwd, { host, routeId: ticket.route_id }, {
        reason: outcome.errorCode || "RATE_LIMITED",
        evidenceKind: "rate_limit",
        resetAt: outcome.resetAt || null,
        now: at,
        env: outcome.env,
      });
      return {
        status: record.status,
        reason: record.reason,
        evidence_kind: record.evidence_kind,
        reset_at: record.reset_at,
        next_probe_at: record.next_probe_at,
        remaining_percent: outcome.remainingPercent ?? null,
      };
    }
    if (isSessionUncallable(outcome)) {
      const record = markRouteExhausted(cwd, { host, routeId: ticket.route_id }, {
        reason: outcome.errorCode || "MODEL_SESSION_UNCALLABLE",
        evidenceKind: "session_uncallable",
        resetAt: null,
        now: at,
        env: outcome.env,
      });
      return {
        status: record.status,
        reason: record.reason,
        evidence_kind: record.evidence_kind,
        reset_at: record.reset_at,
        next_probe_at: record.next_probe_at,
        remaining_percent: outcome.remainingPercent ?? null,
      };
    }
    if (outcome.success || positiveRemaining) {
      const record = markRouteAvailable(cwd, { host, routeId: ticket.route_id }, { now: at, env: outcome.env });
      return { status: record.status, reason: null, evidence_kind: record.evidence_kind, reset_at: null, next_probe_at: null };
    }
    return null;
  } catch (error) {
    const durable = isConfirmedQuotaExhaustion(outcome)
      || isExplicitRateLimit(outcome)
      || isSessionUncallable(outcome)
      || (typeof outcome.remainingPercent === "number" && outcome.remainingPercent <= 0)
      || outcome.success === true
      || (typeof outcome.remainingPercent === "number" && outcome.remainingPercent > 0);
    if (durable) {
      throw new DispatchError(
        `model availability persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        "MODEL_AVAILABILITY_WRITE_FAILED",
        { ticketId: ticket.id },
      );
    }
    return null;
  }
}

/** Exact native callability failures are session-local route evidence. */
export function isSessionUncallable(input: { errorCode?: string | null; message?: string | null }): boolean {
  const code = String(input.errorCode || "").trim().toUpperCase();
  if (/^(?:MODEL|ROUTE|NATIVE|EXECUTION)_(?:UNCALLABLE|UNAVAILABLE|UNREACHABLE|NOT_CALLABLE|NOT_AVAILABLE)$/.test(code)) return true;
  if (["MODEL_NOT_FOUND", "SESSION_UNCALLABLE", "CLI_UNCALLABLE"].includes(code)) return true;
  return /(?:model|route|native|session|cli).*(?:uncallable|not callable|unavailable|unreachable)/i.test(String(input.message || ""));
}

export interface SuccessorRouteCandidate {
  route: ExecutableRoute;
  routeId: string;
  reasoning_effort: string | null;
  exclusions: Array<{ model_id: string; route_id: string; codes: string[]; reasons: string[] }>;
}

export function compiledRoutingRequirements(ticket: SpawnTicket, context?: CompiledApplyContext | null): Record<string, unknown> {
  const ticketRequirements = ticket.routing_requirements as unknown as Record<string, unknown> | undefined;
  const unitRequirements = context?.unit as unknown as Record<string, unknown> | undefined;
  const prompt = String(context?.unit.prompt || context?.unit.description || ticket.prompt || ticket.description || "").trim();
  let derived: Record<string, unknown> = {};
  if (context) {
    try {
      // Compiled materialization derives this same minimum contract during
      // selection. Re-derive it for a native successor because the selected
      // model is the only field allowed to change across a retry. Legacy
      // tickets retain their historical route-only successor behavior.
      derived = deriveMinimumModelRequirements(prompt, {
        native_execution: true,
        tool: true,
      }) as unknown as Record<string, unknown>;
    } catch {
      // An older compiled record may not carry enough task text to derive
      // requirements. Its persisted ticket requirements remain authoritative.
    }
  }
  return {
    ...derived,
    ...(unitRequirements?.minimum_requirements && typeof unitRequirements.minimum_requirements === "object"
      ? unitRequirements.minimum_requirements as Record<string, unknown> : {}),
    ...(ticketRequirements || {}),
  };
}

export function routeVariantBase(routeId: string): { base: string; effort: string | null } {
  const at = routeId.lastIndexOf("@");
  return at > 0 ? { base: routeId.slice(0, at), effort: routeId.slice(at + 1) || null } : { base: routeId, effort: null };
}

export const SUCCESSOR_EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

export function successorEffort(value: unknown): string | null {
  const normalized = String(value || "").trim().toLowerCase().replaceAll(/[_ ]+/g, "-");
  return Object.hasOwn(SUCCESSOR_EFFORT_RANK, normalized) ? normalized : null;
}

export function lowestSupportedEffort(values: string[], minimumRank: number): string | null {
  return values
    .map((value) => successorEffort(value))
    .filter((value): value is string => Boolean(value) && SUCCESSOR_EFFORT_RANK[value] >= minimumRank)
    .sort((left, right) => SUCCESSOR_EFFORT_RANK[left] - SUCCESSOR_EFFORT_RANK[right])[0] || null;
}

export function successorCapability(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase().replaceAll(/[_ ]+/g, "-");
  if (["native", "native-exec", "execution-handle", "native-child"].includes(normalized)) return "native-execution";
  if (["tool", "tools", "tooling", "function-calling"].includes(normalized)) return "tool-use";
  if (["readonly", "read"].includes(normalized)) return "read-only";
  if (["commit", "commitonly"].includes(normalized)) return "commit-only";
  return normalized;
}

export function routeCapabilitySets(route: ExecutableRoute): { supported: Set<string>; unsupported: Set<string>; known: boolean } {
  const record = route as unknown as Record<string, unknown>;
  const supported = new Set<string>();
  const unsupported = new Set<string>();
  let known = false;
  const addList = (value: unknown) => {
    if (!Array.isArray(value)) return;
    known = true;
    for (const item of value) {
      const itemRecord = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
      const capability = successorCapability(itemRecord?.id || itemRecord?.name || itemRecord?.capability || itemRecord?.kind || item);
      if (!capability) continue;
      if (itemRecord && (itemRecord.supported === false || itemRecord.available === false || itemRecord.enabled === false)) unsupported.add(capability);
      else supported.add(capability);
    }
  };
  const addObject = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    known = true;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const capability = successorCapability(key);
      if (!capability) continue;
      if (item === true || (item && typeof item === "object" && (item as Record<string, unknown>).supported === true)) supported.add(capability);
      else if (item === false || (item && typeof item === "object" && ((item as Record<string, unknown>).supported === false || (item as Record<string, unknown>).available === false))) unsupported.add(capability);
    }
  };
  addList(record.execution_capabilities ?? record.executionCapabilities);
  addList(record.capabilities);
  addList(record.tools ?? record.supported_tools ?? record.supportedTools);
  addObject(record.capabilities);
  addObject(record.execution_capabilities ?? record.executionCapabilities);
  addObject(record.execution);
  addObject(record.supports);
  const native = record.supports_native_execution ?? record.supportsNativeExecution ?? record.supports_native ?? record.supportsNative;
  if (native === true) supported.add("native-execution");
  if (native === false) unsupported.add("native-execution");
  const tool = record.supports_tool_use ?? record.supportsToolUse ?? record.supports_tools ?? record.supportsTools
    ?? record.supports_tool ?? record.supportsTool ?? record.tool_use ?? record.toolUse ?? record.tool;
  if (tool === true) supported.add("tool-use");
  if (tool === false) unsupported.add("tool-use");
  if (route.native === true) supported.add("native-execution");
  return { supported, unsupported, known };
}

export function providerQuotaExhausted(snapshot: { provider_quotas?: Array<{ provider: string; windows: Array<{ remaining_percent: number }> }> }, provider: string | null): boolean {
  if (!provider) return false;
  const quota = snapshot.provider_quotas?.find((item) => item.provider === provider);
  return Boolean(quota?.windows?.some((window) => Number.isFinite(window.remaining_percent) && window.remaining_percent <= 0));
}

export function successorRouteForTicket(cwd: string, ticket: SpawnTicket, at: string, env: NodeJS.ProcessEnv = process.env, context?: CompiledApplyContext | null): SuccessorRouteCandidate | null {
  const compiled = isCompiledApplyTicket(ticket);
  if (!ticket.route_id || (!compiled && ticket.mode !== "write") || !ticket.receipt_id) return null;
  const receipt = readReceipt(cwd, ticket.receipt_id, env);
  if (ticket.mode === "write" && !receipt.baseline) return null;
  if (compiled && ticket.mode === "read-only" && receipt.baseline !== null) return null;
  const host = ticketTargetHost(ticket, env);
  const config = loadConfig(cwd, { env });
  const configured = [...configuredCodingModelsForHost(config, host)];
  const currentIndex = configured.findIndex((item) => item === ticket.route_id || routeVariantBase(item).base === ticket.route_id);
  const exclusions: SuccessorRouteCandidate["exclusions"] = [];
  if (currentIndex < 0) {
    for (const configuredId of configured) {
      exclusions.push({ model_id: configuredId, route_id: routeVariantBase(configuredId).base, codes: ["CURRENT_ROUTE_NOT_CONFIGURED"], reasons: ["the failed ticket route is not in the configured coding route order"] });
    }
    (ticket as unknown as UnknownRecord).successor_exclusion_matrix = exclusions;
    return null;
  }
  const snapshot = readRouteSnapshot(cwd, { host, env });
  const requirements = compiledRoutingRequirements(ticket, context);
  const requiredEffort = String(requirements.required_reasoning_effort
    || requirements.requiredReasoningEffort
    || requirements.reasoning_effort
    || requirements.reasoning
    || ticket.reasoning_effort
    || "").trim() || null;
  const requiredEffortValue = successorEffort(requiredEffort);
  const requiredEffortRank = requiredEffortValue ? SUCCESSOR_EFFORT_RANK[requiredEffortValue] : 0;
  const estimatedContext = Number(requirements.estimated_context_tokens
    ?? requirements.estimatedContextTokens
    ?? requirements.estimated_context
    ?? requirements.context_tokens);
  const requiredCapabilities = (requirements.required_execution_capabilities
    || requirements.requiredExecutionCapabilities
    || requirements.execution_capabilities
    || requirements.executionCapabilities);
  const requiredCapabilityNames = Array.isArray(requiredCapabilities)
    ? requiredCapabilities.map(String).map((item) => item.trim().toLowerCase().replaceAll(/[_ ]+/g, "-")).filter(Boolean)
    : [];
  const configuredLater = configured.slice(currentIndex + 1);
  if (!snapshot) {
    for (const routeId of configured) exclusions.push({ model_id: routeId, route_id: routeVariantBase(routeId).base, codes: ["ROUTE_ABSENT_FROM_ACTIVE_CATALOG"], reasons: ["active CLI catalog snapshot is missing"] });
    (ticket as unknown as UnknownRecord).successor_exclusion_matrix = exclusions;
    return null;
  }
  // Keep the failed/current route and every earlier configured route in the
  // diagnostic matrix as well. The successor scan below then appends each
  // later candidate in the exact user-configured order.
  for (let index = 0; index <= currentIndex; index += 1) {
    const configuredId = configured[index]!;
    const variant = routeVariantBase(configuredId);
    const route = snapshot.routes.find((item) => item.route_id === configuredId || item.route_id === variant.base);
    if (index < currentIndex) {
      exclusions.push({ model_id: configuredId, route_id: variant.base, codes: ["HIGHER_PRIORITY_ROUTE_FAILED"], reasons: ["a higher-priority configured route was selected before this retry"] });
      continue;
    }
    const availability = route ? availabilityForRoute(cwd, { host, routeId: route.route_id }, at, env) : null;
    const failedCode = !route
      ? "ROUTE_ABSENT_FROM_ACTIVE_CATALOG"
      : isSessionUncallable({ errorCode: ticket.error?.code, message: ticket.error?.message })
        ? "CURRENT_SESSION_UNCALLABLE"
        : availability?.evidence_kind === "rate_limit"
          ? "CURRENT_SESSION_RATE_LIMITED"
          : availability?.status === "exhausted" || availability?.status === "probe_due"
            ? "CURRENT_SESSION_QUOTA_EXHAUSTED"
          : "NATIVE_ROUTE_FAILURE";
    exclusions.push({
      model_id: configuredId,
      route_id: variant.base,
      codes: [failedCode],
      reasons: [!route ? "route is absent from the active CLI catalog" : ticket.error?.message || "the selected route failed at the native execution surface"],
    });
  }
  for (const configuredId of configuredLater) {
    const variant = routeVariantBase(configuredId);
    const route = snapshot.routes.find((item) => item.route_id === configuredId || item.route_id === variant.base);
    const modelId = configuredId;
    const codes: string[] = [];
    const reasons: string[] = [];
    if (!route) {
      codes.push("ROUTE_ABSENT_FROM_ACTIVE_CATALOG"); reasons.push("route is absent from the active CLI catalog");
    } else if (route.disabled) {
      codes.push("ROUTE_DISABLED"); reasons.push("route is disabled in the active CLI catalog");
    } else {
      const supportedEfforts = route.reasoning_efforts.map((item) => successorEffort(item) || String(item).trim().toLowerCase());
      // An unqualified route may advertise a lower default while still
      // supporting the captured minimum. Preserve that captured requirement
      // for the successor instead of rejecting the route because its default
      // is lower.
      const capturedMinimumEffort = requiredEffortValue && supportedEfforts.length > 0
        ? lowestSupportedEffort(supportedEfforts, requiredEffortRank)
        : null;
      const candidateEffort = successorEffort(variant.effort)
        || capturedMinimumEffort
        || successorEffort(route.default_reasoning_effort)
        || successorEffort(ticket.reasoning_effort);
      const candidateEffortRank = candidateEffort ? SUCCESSOR_EFFORT_RANK[candidateEffort] || 0 : 0;
      const exactVariantUnsupported = Boolean(variant.effort && supportedEfforts.length && !supportedEfforts.includes(variant.effort.toLowerCase()));
      const unsupportedDefault = Boolean(requiredEffort && !variant.effort && supportedEfforts.length
        && (!candidateEffort || !supportedEfforts.includes(candidateEffort)));
      const belowMinimum = Boolean(requiredEffort && (
        (candidateEffort && candidateEffortRank < requiredEffortRank)
        || (!candidateEffort && supportedEfforts.length && !supportedEfforts.some((item) => (SUCCESSOR_EFFORT_RANK[item] || 0) >= requiredEffortRank))
      ));
      if (exactVariantUnsupported || belowMinimum || Boolean(requiredEffort && !requiredEffortValue
        && variant.effort && variant.effort !== requiredEffort) || unsupportedDefault) {
        const label = variant.effort ? "configured" : "required";
        const effort = variant.effort || requiredEffortValue || requiredEffort;
        codes.push("REASONING_CAPABILITY_INSUFFICIENT"); reasons.push(`${label} reasoning effort ${effort} is not supported`);
      }
      if (Number.isFinite(estimatedContext) && estimatedContext > 0 && route.context_window !== null && route.context_window < estimatedContext) {
        codes.push("CONTEXT_WINDOW_INSUFFICIENT"); reasons.push(`context window ${route.context_window} is smaller than ${estimatedContext}`);
      }
      const capabilities = routeCapabilitySets(route);
      for (const rawCapability of requiredCapabilityNames) {
        const capability = successorCapability(rawCapability);
        if (!capability) continue;
        if (capabilities.unsupported.has(capability)
          || (capabilities.known && !capabilities.supported.has(capability))
          || (capability === "native-execution" && route.native !== true)) {
          codes.push("REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED"); reasons.push(`${capability} is not supported by the route`);
        }
      }
      if (providerQuotaExhausted(snapshot, route.provider)) {
        codes.push("QUOTA_POOL_EXHAUSTED"); reasons.push(`${route.provider || "provider"} quota pool is exhausted`);
      }
      const availability = availabilityForRoute(cwd, { host, routeId: route.route_id }, at, env);
      if ((availability.status === "exhausted" || availability.status === "probe_due") && !availability.probe_available) {
        const uncallable = isSessionUncallable({ errorCode: availability.reason, message: availability.reason });
        codes.push(uncallable
          ? "CURRENT_SESSION_UNCALLABLE"
          : availability.evidence_kind === "rate_limit" ? "CURRENT_SESSION_RATE_LIMITED" : "CURRENT_SESSION_QUOTA_EXHAUSTED");
        reasons.push(availability.reason || "route is unavailable in the current Baton session");
      }
    }
    if (codes.length) {
      exclusions.push({ model_id: modelId, route_id: variant.base, codes: [...new Set(codes)], reasons: [...new Set(reasons)] });
      continue;
    }
    exclusions.push({ model_id: modelId, route_id: variant.base, codes: ["AVAILABLE"], reasons: ["later configured route satisfies the captured requirements"] });
    (ticket as unknown as UnknownRecord).successor_exclusion_matrix = exclusions;
    const selectedEffort = successorEffort(variant.effort)
      || (requiredEffortValue && route.reasoning_efforts.length > 0
        ? lowestSupportedEffort(route.reasoning_efforts, requiredEffortRank)
        : null)
      || successorEffort(route.default_reasoning_effort)
      || successorEffort(ticket.reasoning_effort);
    return { route, routeId: configuredId, reasoning_effort: selectedEffort, exclusions };
  }
  (ticket as unknown as UnknownRecord).successor_exclusion_matrix = exclusions;
  return null;
}

/**
 * Allocate a successor ordinal in the originating session without clobbering
 * another ticket that was already materialized in the same wave.
 */
export function nextSuccessorOrdinal(cwd: string, ticket: SpawnTicket, env: NodeJS.ProcessEnv): number {
  const occupied = new Set(
    listSpawns(cwd, env)
      .filter((item) => item.session_uid === ticket.session_uid)
      .map((item) => item.session_ordinal),
  );
  let ordinal = ticket.session_ordinal + 1;
  while (occupied.has(ordinal)) ordinal += 1;
  return ordinal;
}

export async function createQuotaSuccessor(cwd: string, ticket: SpawnTicket, at: string, env: NodeJS.ProcessEnv = process.env, safetyOptions: AsyncSafetyOptions = {}, compiledContext?: CompiledApplyContext | null): Promise<string | null> {
  const compiled = isCompiledApplyTicket(ticket);
  if ((!compiled && ticket.mode !== "write") || !ticket.receipt_id) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const receipt = readReceipt(cwd, ticket.receipt_id, env);
  if (ticket.mode === "write" && !receipt.baseline) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const candidate = successorRouteForTicket(cwd, ticket, at, env, compiledContext);
  if (ticket.mode === "write") {
    const noMutation = await auditWorktreeAsync(cwd, receipt.baseline!, { write_allowlist: [], allowed_operations: [] }, safetyOptions);
    if (!noMutation.accepted) {
      ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
      (ticket as unknown as UnknownRecord).successor_safety_verdict = noMutation as unknown as UnknownRecord;
      const matrix = candidate?.exclusions || ((ticket as unknown as UnknownRecord).successor_exclusion_matrix as SuccessorRouteCandidate["exclusions"] | undefined) || [];
      (ticket as unknown as UnknownRecord).successor_exclusion_matrix = matrix.map((entry) => ({
        ...entry,
        codes: [...new Set([...entry.codes, "SAFETY_RECONCILIATION_UNRESOLVED"])],
        reasons: [...entry.reasons, "authorized partial-write safety reconciliation was not accepted"],
      }));
      return null;
    }
  }
  if (!candidate) {
    ticket.successor_reason = "NO_SUCCESSOR_ROUTE";
    return null;
  }
  if (compiled) {
    try {
      // A successor is still a queued unit, but the effective host capacity
      // is an authorization requirement and must be known again at retry
      // time. Do not mint a successor from a stale/unknown capacity view.
      requiredCapacity(resolvedCapacity(cwd, ticketTargetHost(ticket, env), env));
    } catch (error) {
      ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
      (ticket as unknown as UnknownRecord).successor_exclusion_matrix = candidate.exclusions.map((entry) => ({
        ...entry,
        codes: [...new Set([...entry.codes, "CAPACITY_UNAVAILABLE"])],
        reasons: [...entry.reasons, error instanceof Error ? error.message : "effective host capacity is unavailable"],
      }));
      return null;
    }
  }
  // Successors belong to the originating session even if the environment
  // changed while reconciliation was running.
  const successorOrdinal = nextSuccessorOrdinal(cwd, ticket, env);
  const successorId = sessionTicketId("spn", ticket.session_uid, successorOrdinal);
  const route = candidate.route;
  const candidateVariant = routeVariantBase(candidate.routeId);
  const reasoningEffort = candidate.reasoning_effort
    || candidateVariant.effort
    || (ticket.reasoning_effort && route.reasoning_efforts.includes(ticket.reasoning_effort) ? ticket.reasoning_effort : route.default_reasoning_effort);
  const serviceTier = ticket.service_tier
    && (route.service_tiers.includes(ticket.service_tier) || route.additional_speed_tiers.includes(ticket.service_tier))
    ? ticket.service_tier
    : route.default_service_tier;
  const selection = ticket.selection ? {
    ...structuredClone(ticket.selection),
    approval_id: `successor-${successorId}`,
    approved_at: at,
    confirmed_by: "baton-recommendation" as const,
    catalog_fingerprint: readRouteSnapshot(cwd, { host: ticketTargetHost(ticket, env), env })?.fingerprint || ticket.selection.catalog_fingerprint,
    recommended_model_id: candidate.routeId,
    selected_model_id: candidate.routeId,
    service_tier: serviceTier,
    changed_by_user: false,
  } : null;
  if (!selection) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const successor = structuredClone(ticket);
  successor.id = successorId;
  successor.session_uid = ticket.session_uid;
  successor.session_ordinal = successorOrdinal;
  successor.model_id = candidate.routeId;
  successor.route_id = route.route_id;
  successor.reasoning_effort = reasoningEffort;
  successor.service_tier = serviceTier;
  successor.selection = selection;
  successor.status = "queued";
  successor.attempt = 0;
  successor.reservation_id = undefined;
  successor.dispatch_host = undefined;
  successor.dispatch_requested_at = undefined;
  successor.started_at = undefined;
  successor.finished_at = undefined;
  successor.slot_released_at = undefined;
  successor.execution_handle = null;
  successor.host = null;
  successor.error = null;
  successor.conclusion = null;
  successor.progress = null;
  successor.liveness = null;
  successor.successor_from_ticket_id = ticket.id;
  successor.successor_reason = "QUOTA_EXHAUSTED";
  successor.successor_id = undefined;
  // Keep the originating availability observation as lineage evidence. The
  // successor still gets its own route checks; this field is never reused as
  // the new route's availability decision.
  successor.quota_diagnostic = ticket.quota_diagnostic
    ? structuredClone(ticket.quota_diagnostic)
    : undefined;
  successor.safety_verdict = undefined;
  successor.routing_requirements = ticket.routing_requirements ? structuredClone(ticket.routing_requirements) : undefined;
  successor.receipt_id = `rcpt-${successorId}-a1`;
  successor.created_at = at;
  successor.updated_at = at;
  successor.history = [
    { event: "ticket_queued", at },
    { event: "successor_created", at, from_ticket_id: ticket.id, reason: "QUOTA_EXHAUSTED" },
  ];
  const successorReceipt = structuredClone(receipt);
  successorReceipt.issued_at = at;
  successorReceipt.receipt_id = successor.receipt_id;
  successorReceipt.ticket_id = successor.id;
  successorReceipt.route = {
    ...successorReceipt.route,
    card_id: candidate.routeId,
    route_id: route.route_id,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    provider: route.provider,
  };
  successorReceipt.selection = selection;
  if (compiled) {
    // The candidate is a new authorization edge, not an implicit fallback.
    // Re-run the complete ticket/Receipt/run validation before either
    // successor artifact is persisted.
    try {
      validateCompiledTicket(cwd, successor, ticketTargetHost(successor, env), env, successorReceipt);
    } catch (error) {
      const code = error instanceof DispatchError ? error.code : "SUCCESSOR_VALIDATION_FAILED";
      const message = error instanceof Error ? error.message : "successor authorization validation failed";
      ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
      (ticket as unknown as UnknownRecord).successor_exclusion_matrix = candidate.exclusions.map((entry) => (
        entry.model_id === candidate.routeId
          ? {
            ...entry,
            codes: [...new Set([...entry.codes.filter((item) => item !== "AVAILABLE"), code])],
            reasons: [...new Set([...entry.reasons, message])],
          }
          : entry
      ));
      return null;
    }
  }
  writeReceipt(cwd, successorReceipt, env);
  writeSpawn(cwd, successor, env);
  ticket.successor_id = successor.id;
  ticket.successor_reason = "QUOTA_EXHAUSTED_SUCCESSOR_CREATED";
  return successor.id;
}
