export interface QuotaWindow {
  name: string;
  label: string;
  used_percent: number;
  remaining_percent: number;
  resets_at: string | null;
}

export interface ProviderQuotaDisclosure {
  provider: string;
  label: string;
  status: "reported" | "unknown";
  source: string | null;
  observed_at: string;
  windows: QuotaWindow[];
  reason: string | null;
  reverse_engineered: boolean;
}

export interface ProviderQuotaSource {
  fetched_at: string;
  quota_refresh_error?: string | null;
  provider_quotas?: ProviderQuotaDisclosure[];
}

function timestamp(value: unknown): string | null {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const millis = raw < 1_000_000_000_000 ? raw * 1_000 : raw;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function percent(value: unknown): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, raw));
}

function window(name: string, label: string, used: unknown, reset: unknown): QuotaWindow | null {
  const usedPercent = percent(used);
  if (usedPercent == null) return null;
  return {
    name,
    label,
    used_percent: usedPercent,
    remaining_percent: Math.max(0, 100 - usedPercent),
    resets_at: timestamp(reset),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeProviderQuotas(value: unknown, observedAt: Date | string = new Date()): ProviderQuotaDisclosure[] {
  const root = record(value);
  const reports = Array.isArray(root?.reports) ? root.reports : [];
  const fallbackObserved = (observedAt instanceof Date ? observedAt : new Date(observedAt)).toISOString();
  const normalized: ProviderQuotaDisclosure[] = [];
  for (const item of reports) {
    const report = record(item);
    const provider = String(report?.provider || "").trim();
    if (!provider) continue;
    const quota = record(report?.quota);
    const windows = [
      window("five_hour", "5 hour", quota?.fiveHourPercent, quota?.fiveHourResetAt),
      window("weekly", "Weekly", quota?.weeklyPercent, quota?.weeklyResetAt),
      window("monthly", "Monthly", quota?.monthlyPercent, quota?.monthlyResetAt),
    ].filter((item): item is QuotaWindow => item !== null);
    if (Array.isArray(quota?.customWindows)) {
      for (let index = 0; index < quota.customWindows.length; index += 1) {
        const custom = record(quota.customWindows[index]);
        const itemWindow = window(
          `custom_${index + 1}`,
          String(custom?.label || `Custom ${index + 1}`),
          custom?.percent,
          custom?.resetAt,
        );
        if (itemWindow) windows.push(itemWindow);
      }
    }
    const observed = timestamp(quota?.updatedAt ?? report?.updatedAt) || fallbackObserved;
    normalized.push({
      provider,
      label: String(report?.label || provider),
      status: windows.length ? "reported" : "unknown",
      source: String(report?.source || "").trim() || null,
      observed_at: observed,
      windows,
      reason: windows.length ? null : "PROVIDER_QUOTA_NOT_REPORTED",
      reverse_engineered: report?.reverseEngineered === true,
    });
  }
  return normalized.sort((a, b) => a.provider.localeCompare(b.provider));
}

export function unknownProviderQuota(provider: string, observedAt: string, reason = "PROVIDER_QUOTA_NOT_REPORTED"): ProviderQuotaDisclosure {
  return {
    provider,
    label: provider,
    status: "unknown",
    source: null,
    observed_at: observedAt,
    windows: [],
    reason,
    reverse_engineered: false,
  };
}

/** OpenCodex reported windows always win; fallback may fill only absent/unknown providers. */
export function mergeProviderQuotaFallbacks(
  primary: ProviderQuotaDisclosure[],
  fallbacks: ProviderQuotaDisclosure[],
): ProviderQuotaDisclosure[] {
  const byProvider = new Map<string, ProviderQuotaDisclosure>();
  for (const item of primary) {
    const current = byProvider.get(item.provider);
    if (!current || current.status === "unknown" || item.status === "reported") byProvider.set(item.provider, item);
  }
  for (const item of fallbacks) {
    const current = byProvider.get(item.provider);
    if (!current || current.status === "unknown") byProvider.set(item.provider, item);
  }
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

export function quotaForProvider(source: ProviderQuotaSource, provider: string | null | undefined): ProviderQuotaDisclosure {
  const id = String(provider || "unknown");
  return source.provider_quotas?.find((item) => item.provider === id)
    || unknownProviderQuota(id, source.fetched_at, source.quota_refresh_error ? "QUOTA_REFRESH_FAILED" : "PROVIDER_QUOTA_NOT_REPORTED");
}
