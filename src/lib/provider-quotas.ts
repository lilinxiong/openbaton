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
}

export interface ProviderQuotaSource {
  fetched_at: string;
  quota_refresh_error?: string | null;
  provider_quotas?: ProviderQuotaDisclosure[];
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
  };
}

export function quotaForProvider(source: ProviderQuotaSource, provider: string | null | undefined): ProviderQuotaDisclosure {
  const id = String(provider || "unknown");
  return source.provider_quotas?.find((item) => item.provider === id)
    || unknownProviderQuota(id, source.fetched_at, source.quota_refresh_error ? "QUOTA_REFRESH_FAILED" : "PROVIDER_QUOTA_NOT_REPORTED");
}
