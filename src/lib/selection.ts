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
  selection_code: "AVAILABLE" | "QUOTA_POOL_EXHAUSTED" | "DURABLE_QUOTA_EXHAUSTED" | "CONTEXT_WINDOW_INSUFFICIENT" | "REASONING_EFFORT_UNSUPPORTED";
  selection_reason: string;
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
  requires_manual_choice: boolean;
  candidates: SelectionCandidate[];
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

function candidateFor(
  cwd: string,
  prompt: string,
  card: ModelCard,
  snapshot: RouteSnapshot,
  automaticIds: Set<string>,
  host: string,
  estimatedContextTokens: number,
  probeRouteIds: Set<string>,
  env?: NodeJS.ProcessEnv,
): SelectionCandidate | null {
  if (!card.route_id || card.executable === false) return null;
  const route = snapshot.routes.find((item) => !item.disabled && item.route_id === card.route_id);
  if (!route) return null;
  if (card.reasoning_effort && !route.reasoning_efforts.includes(card.reasoning_effort)) return null;
  const quota = quotaForProvider(snapshot, card.provider);
  const quotaPool = quotaPoolForCandidate({
    model_id: card.id,
    route_id: card.route_id,
    provider: card.provider || null,
    quota,
  });
  const availability = availabilityForRoute(cwd, { host, routeId: card.route_id }, new Date(), env);
  const contextInsufficient = route.context_window !== null
    && route.context_window < estimatedContextTokens;
  // A due route still needs an explicit dispatch-side probe lease. Selection
  // never silently turns every concurrent selector into a probe attempt.
  const probeClaimed = availability.status === "probe_due" && probeRouteIds.has(card.route_id);
  const probeAvailable = availability.status === "probe_due" && availability.probe_available;
  // A due route is observable here but remains ineligible until the dispatch
  // reservation atomically claims it. Match/plan therefore never mutate or
  // pre-authorize a probe lease.
  const durableExhausted = availability.status !== "available" && !probeClaimed;
  const selectable = quotaPool.selectable && !contextInsufficient && !durableExhausted;
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
  return {
    model_id: card.id,
    route_id: card.route_id,
    reasoning_effort: card.reasoning_effort || null,
    reasoning_effort_configurable: route.reasoning_efforts.length > 0,
    effective_reasoning_effort: card.reasoning_effort || route.default_reasoning_effort || null,
    context_window: route.context_window,
    service_tier: serviceTier,
    speed_optimized: speedSignals.length > 0,
    speed_signals: speedSignals,
    provider: card.provider || null,
    selectable,
    selection_code: durableExhausted
      ? "DURABLE_QUOTA_EXHAUSTED"
      : contextInsufficient
        ? "CONTEXT_WINDOW_INSUFFICIENT"
        : quotaPool.status === "exhausted" ? "QUOTA_POOL_EXHAUSTED" : "AVAILABLE",
    selection_reason: durableExhausted
      ? `${availability.reason || "quota exhausted"}${availability.next_probe_at ? `; probe ${availability.next_probe_at}` : ""}`
      : contextInsufficient
        ? `context window ${route.context_window} is smaller than estimated ${estimatedContextTokens}`
        : quotaPool.status === "exhausted"
          ? `${quotaPool.label} quota is exhausted`
      : probeClaimed
        ? "bounded due-route probe lease claimed by this dispatcher"
        : probeAvailable
          ? "due-route probe is available for the eventual reservation"
        : "model/reasoning effort was returned by the active CLI",
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
        && candidate.reasoning_effort
        && EFFORT_RANK[normalizedEffort(candidate.effective_reasoning_effort) || "none"] >= targetRank)
      .sort((left, right) => compareEffortFit(
        left.effective_reasoning_effort,
        right.effective_reasoning_effort,
        target,
      ) || left.model_id.localeCompare(right.model_id));
    for (const candidate of values) {
      candidate.automatic_eligible = false;
      const rank = EFFORT_RANK[normalizedEffort(candidate.effective_reasoning_effort) || "none"];
      if (candidate.reasoning_effort && rank < targetRank && candidate.selection_code === "AVAILABLE") {
        candidate.selectable = false;
        candidate.selection_code = "REASONING_EFFORT_UNSUPPORTED";
        candidate.selection_reason = `reasoning effort ${candidate.effective_reasoning_effort || candidate.reasoning_effort} is below required ${target}`;
      }
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
}): SelectionUnit {
  const contextEstimate = estimateTaskContext(prompt);
  const complexityEstimate = estimateTaskComplexity(prompt);
  if (directorLocal) {
    return {
      ...(host ? { host } : {}), key, description, prompt, director_local: true,
      recommended_model_id: null, requested_model_id: null, default_model_id: null,
      recommendation_reason: "DIRECTOR_LOCAL",
      target_reasoning_effort: complexityEstimate.effort,
      complexity_reason: complexityEstimate.reason,
      estimated_context_tokens: contextEstimate.tokens,
      context_estimate_reason: contextEstimate.reason,
      requires_manual_choice: false, candidates: [], task_exclusions: [], metadata,
    };
  }
  const snapshot = readRouteSnapshot(cwd, { host, env });
  if (!snapshot) throw new Error("ROUTE_SNAPSHOT_REQUIRED: run baton config before model selection");
  const taskExclusions = cards
    .map(taskCapabilityExclusion)
    .filter((item): item is TaskCapabilityExclusion => item !== null);
  const excludedIds = new Set(taskExclusions.map((item) => item.model_id));
  const configured = new Set(codingModels);
  const eligibleCards = cards.filter((card) => !excludedIds.has(card.id)
    && (configured.has(card.route_id || card.id) || configured.has(card.id)));
  const automaticIds = new Set(automaticCards.map((card) => card.id));
  const selectedHost = String(host || snapshot.cli || "");
  if (!selectedHost) throw new Error("HOST_REQUIRED: model selection must name its runtime host");
  const claimedProbeRoutes = new Set(probeRouteIds);
  const candidates = eligibleCards
    .map((card) => candidateFor(cwd, prompt, card, snapshot, automaticIds, selectedHost, contextEstimate.tokens, claimedProbeRoutes, env))
    .filter((item): item is SelectionCandidate => item !== null);
  const priority = new Map(codingModels.map((routeId, index) => [routeId, index]));
  restrictAutomaticEffortCandidates(candidates, complexityEstimate.effort);
  candidates.sort((a, b) => {
    return (priority.get(a.route_id) ?? Number.MAX_SAFE_INTEGER) - (priority.get(b.route_id) ?? Number.MAX_SAFE_INTEGER)
      || Number(b.selectable) - Number(a.selectable)
      || recommendationTieBreak(a, b, complexityEstimate.effort, contextEstimate.tokens);
  });
  const automatic = candidates.filter((item) => item.automatic_eligible);
  const priorityOrdered = automatic.slice().sort((left, right) =>
    (priority.get(left.route_id) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right.route_id) ?? Number.MAX_SAFE_INTEGER)
    || recommendationTieBreak(left, right, complexityEstimate.effort, contextEstimate.tokens));
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
    target_reasoning_effort: complexityEstimate.effort,
    complexity_reason: complexityEstimate.reason,
    estimated_context_tokens: contextEstimate.tokens,
    context_estimate_reason: contextEstimate.reason,
    requires_manual_choice: defaultModel == null,
    candidates,
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
