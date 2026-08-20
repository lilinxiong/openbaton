import type { ProviderQuotaDisclosure, QuotaWindow } from "./host-capabilities.js";

export type QuotaPoolStatus = "available" | "unknown" | "exhausted";
export type CursorQuotaMode = "api" | "auto";

export interface QuotaPoolCandidate {
  model_id: string;
  route_id: string;
  provider: string | null;
  quota: ProviderQuotaDisclosure;
}
export interface SelectionQuotaPool {
  id: string;
  provider: string;
  label: string;
  cursor_mode: CursorQuotaMode | null;
  status: QuotaPoolStatus;
  selectable: boolean;
  remaining_percent: number | null;
  source: string | null;
  observed_at: string;
  reason: string | null;
  reverse_engineered: boolean;
  windows: QuotaWindow[];
  model_ids: string[];
}

const CURSOR_AUTO_ROUTE = /^cursor\/(?:grok|composer)(?:[-@/]|$)/i;

export function quotaPoolIdForRoute(provider: string | null | undefined, modelId: string, routeId = modelId): string {
  const normalizedProvider = String(provider || "unknown");
  if (normalizedProvider !== "cursor") return normalizedProvider;
  return CURSOR_AUTO_ROUTE.test(modelId) || CURSOR_AUTO_ROUTE.test(routeId) ? "cursor-auto" : "cursor-api";
}

function poolLabel(id: string): string {
  if (id === "cursor-auto") return "Cursor Auto";
  if (id === "cursor-api") return "Cursor API";
  return id;
}

function primaryWindows(id: string, quota: ProviderQuotaDisclosure): QuotaWindow[] {
  if (quota.status !== "reported") return [];
  if (id === "cursor-auto") return quota.windows.filter((window) => window.name === "monthly");
  if (id === "cursor-api") {
    return quota.windows.filter((window) => window.name.startsWith("custom_") && /api usage/i.test(window.label));
  }
  return quota.windows;
}

function disclosedWindows(id: string, quota: ProviderQuotaDisclosure): QuotaWindow[] {
  if (quota.status !== "reported") return [];
  if (id === "cursor-auto") {
    return quota.windows.filter((window) => window.name === "monthly" || /first-party models/i.test(window.label));
  }
  if (id === "cursor-api") return primaryWindows(id, quota);
  return quota.windows;
}

function missingReason(id: string, quota: ProviderQuotaDisclosure): string {
  if (quota.status === "unknown") return quota.reason || "PROVIDER_QUOTA_NOT_REPORTED";
  if (id === "cursor-auto") return "CURSOR_AUTO_QUOTA_NOT_REPORTED";
  if (id === "cursor-api") return "CURSOR_API_QUOTA_NOT_REPORTED";
  return "PROVIDER_QUOTA_NOT_REPORTED";
}

export function quotaPoolForCandidate(candidate: QuotaPoolCandidate): SelectionQuotaPool {
  const id = quotaPoolIdForRoute(candidate.provider, candidate.model_id, candidate.route_id);
  const windows = primaryWindows(id, candidate.quota);
  const remainingValues = windows.map((window) => window.remaining_percent).filter(Number.isFinite);
  const remaining = remainingValues.length ? Math.min(...remainingValues) : null;
  const status: QuotaPoolStatus = remaining === 0 ? "exhausted" : remaining == null ? "unknown" : "available";
  return {
    id,
    provider: String(candidate.provider || "unknown"),
    label: poolLabel(id),
    cursor_mode: id === "cursor-auto" ? "auto" : id === "cursor-api" ? "api" : null,
    status,
    selectable: status !== "exhausted",
    remaining_percent: remaining,
    source: candidate.quota.source,
    observed_at: candidate.quota.observed_at,
    reason: status === "unknown" ? missingReason(id, candidate.quota) : null,
    reverse_engineered: candidate.quota.reverse_engineered,
    windows: disclosedWindows(id, candidate.quota),
    model_ids: [candidate.model_id],
  };
}

function poolRank(pool: SelectionQuotaPool): number {
  if (pool.status === "available") return 0;
  if (pool.status === "unknown") return 1;
  return 2;
}

export function buildSelectionQuotaPools(candidates: QuotaPoolCandidate[]): SelectionQuotaPool[] {
  const groups = new Map<string, SelectionQuotaPool>();
  for (const candidate of candidates) {
    const pool = quotaPoolForCandidate(candidate);
    const current = groups.get(pool.id);
    if (!current) {
      groups.set(pool.id, pool);
      continue;
    }
    if (!current.model_ids.includes(candidate.model_id)) current.model_ids.push(candidate.model_id);
  }
  return [...groups.values()]
    .map((pool) => ({ ...pool, model_ids: [...pool.model_ids].sort() }))
    .sort((a, b) => poolRank(a) - poolRank(b)
      || (b.remaining_percent ?? -1) - (a.remaining_percent ?? -1)
      || a.label.localeCompare(b.label));
}
