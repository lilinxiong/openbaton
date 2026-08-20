import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostCapabilitiesPath } from "./paths.js";
import { readRouteSnapshot } from "./routes.js";
import type { ModelCard } from "../types.js";

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

export interface HostCapabilitySnapshot {
  schema_version: 1;
  id: string;
  host: "codex";
  captured_at: string;
  catalog_fingerprint: string;
  advertised_models: string[];
  advertised_profiles: Record<string, string[]>;
  quota_refresh_error: string | null;
  provider_quotas: ProviderQuotaDisclosure[];
}

export interface HostRouteAvailability {
  available: boolean;
  code: "AVAILABLE" | "HOST_CAPABILITIES_REQUIRED" | "HOST_CAPABILITIES_STALE" | "HOST_ROUTE_UNAVAILABLE" | "HOST_PROFILE_UNAVAILABLE" | "NO_EXECUTABLE_ROUTE";
  reason: string;
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

export function writeHostCapabilitySnapshot(
  cwd: string,
  {
    advertisedModels,
    advertisedProfiles = {},
    quotaCatalog = null,
    quotaFallbacks = [],
    quotaRefreshError = null,
    now = new Date(),
  }: {
    advertisedModels: string[];
    advertisedProfiles?: Record<string, string[]>;
    quotaCatalog?: unknown;
    quotaFallbacks?: ProviderQuotaDisclosure[];
    quotaRefreshError?: string | null;
    now?: Date | string | number;
  },
): HostCapabilitySnapshot {
  const captured = (now instanceof Date ? now : new Date(now)).toISOString();
  const models = [...new Set(advertisedModels.map((item) => String(item || "").trim()).filter(Boolean))].sort();
  if (models.length === 0) throw new Error("host sync requires at least one exact --model route");
  const profiles: Record<string, string[]> = {};
  for (const model of models) {
    profiles[model] = [...new Set((advertisedProfiles[model] || []).map((item) => String(item || "").trim()).filter(Boolean))].sort();
  }
  const catalog = readRouteSnapshot(cwd);
  if (!catalog) throw new Error("OpenCodex route snapshot is missing. Run: baton routes refresh");
  const snapshot: HostCapabilitySnapshot = {
    schema_version: 1,
    id: `host-${crypto.randomUUID()}`,
    host: "codex",
    captured_at: captured,
    catalog_fingerprint: catalog.fingerprint,
    advertised_models: models,
    advertised_profiles: profiles,
    quota_refresh_error: quotaRefreshError ? String(quotaRefreshError) : null,
    provider_quotas: mergeProviderQuotaFallbacks(normalizeProviderQuotas(quotaCatalog, captured), quotaFallbacks),
  };
  const file = hostCapabilitiesPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return snapshot;
}

export function readHostCapabilitySnapshot(cwd: string): HostCapabilitySnapshot | null {
  const file = hostCapabilitiesPath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HostCapabilitySnapshot>;
    if (value.schema_version !== 1 || value.host !== "codex" || !Array.isArray(value.advertised_models)) return null;
    if (!value.advertised_profiles || typeof value.advertised_profiles !== "object") value.advertised_profiles = {};
    return value as HostCapabilitySnapshot;
  } catch {
    return null;
  }
}

export function hostRouteAvailability(cwd: string, card: ModelCard, host = readHostCapabilitySnapshot(cwd)): HostRouteAvailability {
  if (card.executable === false || !card.route_id) {
    return { available: false, code: "NO_EXECUTABLE_ROUTE", reason: "route is not executable in the OpenCodex snapshot" };
  }
  if (!host) {
    return { available: false, code: "HOST_CAPABILITIES_REQUIRED", reason: "complete current Codex host model surface has not been synced" };
  }
  const catalog = readRouteSnapshot(cwd);
  if (!catalog || catalog.fingerprint !== host.catalog_fingerprint) {
    return { available: false, code: "HOST_CAPABILITIES_STALE", reason: "Codex host snapshot does not match the current OpenCodex catalog" };
  }
  if (!host.advertised_models.includes(card.route_id)) {
    return { available: false, code: "HOST_ROUTE_UNAVAILABLE", reason: "route is visible in OpenCodex but absent from this Codex session's spawn surface" };
  }
  if (card.reasoning_effort && !(host.advertised_profiles[card.route_id] || []).includes(card.reasoning_effort)) {
    return { available: false, code: "HOST_PROFILE_UNAVAILABLE", reason: `reasoning profile ${card.reasoning_effort} is absent from this Codex session's spawn surface` };
  }
  return { available: true, code: "AVAILABLE", reason: "route is executable in OpenCodex and advertised by the current Codex host" };
}

export function quotaForProvider(host: HostCapabilitySnapshot, provider: string | null | undefined): ProviderQuotaDisclosure {
  const id = String(provider || "unknown");
  return host.provider_quotas.find((item) => item.provider === id)
    || unknownProviderQuota(id, host.captured_at, host.quota_refresh_error ? "QUOTA_REFRESH_FAILED" : "PROVIDER_QUOTA_NOT_REPORTED");
}
