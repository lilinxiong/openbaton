import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostRouteSnapshotPath } from "./paths.js";
import type { ProviderQuotaDisclosure } from "./provider-quotas.js";
import type { ModelCard } from "../types.js";
import { readJsonFile, sha256Hex, writeJsonAtomic } from "./json-utils.js";

export interface ExecutableRoute {
  id: string;
  provider: string | null;
  /** Exact model string returned by the selected CLI. Never reconstruct it. */
  route_id: string;
  disabled: boolean;
  native: boolean;
  reasoning_efforts: string[];
  default_reasoning_effort: string | null;
  context_window: number | null;
  display_name: string;
  description: string;
  input_modalities: string[];
  additional_speed_tiers: string[];
  service_tiers: string[];
  default_service_tier: string | null;
  is_default: boolean;
  /** Effective per-model fast/service-tier support reported by the CLI. */
  supports_service_tier: boolean | null;
}

export interface RouteSnapshot {
  schema_version: 5;
  generation: number;
  fingerprint: string;
  fetched_at: string;
  source: "cli";
  cli: string;
  engine_version: string | null;
  routes: ExecutableRoute[];
  quota_refresh_error: string | null;
  provider_quotas: ProviderQuotaDisclosure[];
}

function stableRoutes(routes: ExecutableRoute[]): string {
  return JSON.stringify(routes.slice().sort((a, b) => a.route_id.localeCompare(b.route_id) || String(a.provider || "").localeCompare(String(b.provider || ""))));
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].sort();
}

function reasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => {
    const data = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return String(data?.reasoningEffort ?? data?.reasoning_effort ?? data?.id ?? item ?? "").trim();
  }).filter(Boolean))].sort();
}

function serviceTierIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => {
    const data = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return String(data?.id ?? item ?? "").trim();
  }).filter(Boolean))];
}

function contextWindow(record: Record<string, unknown> | null): number | null {
  const raw = record?.contextWindow ?? record?.context_window;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function exactRouteId(record: Record<string, unknown> | null, id: string, provider: string | null): string {
  const namespaced = String(record?.namespaced ?? record?.route_id ?? record?.routeId ?? "").trim();
  if (namespaced) return namespaced;
  if (id.includes("/") || !provider || record?.native === true) return id;
  return `${provider}/${id}`;
}

export function normalizeRouteCatalog(value: unknown): ExecutableRoute[] {
  let values: unknown = value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    values = record.data ?? record.models ?? record.liveModels ?? record.routes;
  }
  if (!Array.isArray(values)) throw new Error("CLI model catalog must be an array or contain models/data/routes");
  const byId = new Map<string, ExecutableRoute>();
  for (const item of values) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const id = String(record?.id ?? record?.model ?? record?.name ?? item ?? "").trim();
    if (!id) continue;
    const provider = typeof record?.provider === "string" ? record.provider : id.includes("/") ? id.split("/", 1)[0] : null;
    const routeId = exactRouteId(record, id, provider);
    const reasoningValues = reasoningEfforts(record?.supportedReasoningEfforts ?? record?.reasoningEfforts ?? record?.reasoning_efforts);
    const defaultReasoningEffort = String(record?.defaultReasoningEffort ?? record?.default_reasoning_effort ?? "").trim() || null;
    const supportsServiceTierRaw = record?.supportsServiceTier ?? record?.supports_service_tier;
    const serviceTiers = serviceTierIds(record?.serviceTiers ?? record?.service_tiers);
    const additionalSpeedTiers = strings(record?.additionalSpeedTiers ?? record?.additional_speed_tiers);
    const description = String(record?.description || "").trim();
    const catalogDescribesSpeed = /\b(?:fast|ultra-fast|low[- ]latency|high[- ]throughput)\b/i.test(description);
    const hasTierMetadata = record && (
      Object.hasOwn(record, "serviceTiers")
      || Object.hasOwn(record, "service_tiers")
      || Object.hasOwn(record, "additionalSpeedTiers")
      || Object.hasOwn(record, "additional_speed_tiers")
    );
    const supportsServiceTier = typeof supportsServiceTierRaw === "boolean"
      ? supportsServiceTierRaw || catalogDescribesSpeed
      : hasTierMetadata ? serviceTiers.length > 0 || additionalSpeedTiers.length > 0 || catalogDescribesSpeed : catalogDescribesSpeed || null;
    byId.set(`${provider || ""}\0${routeId}`, {
      id,
      provider,
      route_id: routeId,
      disabled: record?.disabled === true,
      native: record?.native === true,
      reasoning_efforts: reasoningValues,
      default_reasoning_effort: defaultReasoningEffort,
      context_window: contextWindow(record),
      display_name: String(record?.displayName ?? record?.display_name ?? id).trim() || id,
      description,
      input_modalities: strings(record?.inputModalities ?? record?.input_modalities),
      additional_speed_tiers: additionalSpeedTiers,
      service_tiers: serviceTiers,
      default_service_tier: String(record?.defaultServiceTier ?? record?.default_service_tier ?? "").trim() || null,
      is_default: record?.isDefault === true || record?.is_default === true,
      supports_service_tier: supportsServiceTier,
    });
  }
  return [...byId.values()].sort((a, b) => a.route_id.localeCompare(b.route_id) || String(a.provider || "").localeCompare(String(b.provider || "")));
}

interface PublishRouteSnapshotOptions {
  cli?: string;
  /** Runtime host used to key the current-format snapshot. */
  host?: string;
  env?: NodeJS.ProcessEnv;
  engineVersion?: string | null;
  providerQuotas?: ProviderQuotaDisclosure[];
  quotaRefreshError?: string | null;
}

export function publishRouteSnapshot(
  cwd: string,
  catalog: unknown,
  now: Date = new Date(),
  { cli, host, env, engineVersion = null, providerQuotas, quotaRefreshError }: PublishRouteSnapshotOptions = {},
): { changed: boolean; snapshot: RouteSnapshot } {
  // Every snapshot is written under its normalized runtime-host key.
  const snapshotHost = String(host || cli).trim().toLowerCase();
  // A caller that already supplies the runtime host need not repeat the same
  // value as `cli`; this keeps the public API host-scoped without inventing a
  // provider-specific default.
  const snapshotCli = String(cli || host || "").trim().toLowerCase();
  if (!snapshotHost) throw new Error("HOST_REQUIRED: route snapshots must name their runtime host");
  if (snapshotCli !== snapshotHost) {
    throw new Error(`HOST_MISMATCH: route snapshot cli ${cli} does not match host ${host || snapshotHost}`);
  }
  const routes = normalizeRouteCatalog(catalog);
  const fingerprint = sha256Hex(stableRoutes(routes));
  const file = hostRouteSnapshotPath(cwd, snapshotHost, env);
  let previous: Partial<RouteSnapshot> | null = null;
  if (fs.existsSync(file)) {
    const parsed = readJsonFile(file) as Partial<RouteSnapshot>;
    if (!validSnapshot(parsed) || parsed.cli !== snapshotHost) {
      throw new Error(`ROUTE_SNAPSHOT_FORMAT_UNSUPPORTED: ${file}`);
    }
    previous = parsed;
  }
  const normalizedEngineVersion = String(engineVersion || "").trim() || null;
  const sameCatalog = previous?.schema_version === 5
    && previous.fingerprint === fingerprint
    && previous.cli === snapshotCli
    && previous.engine_version === normalizedEngineVersion;
  const quotaUpdate = providerQuotas !== undefined || quotaRefreshError !== undefined;
  if (sameCatalog && !quotaUpdate) {
    return { changed: false, snapshot: previous as RouteSnapshot };
  }
  const snapshot: RouteSnapshot = {
    schema_version: 5,
    generation: sameCatalog ? Number(previous?.generation || 1) : Number(previous?.generation || 0) + 1,
    fingerprint,
    fetched_at: now.toISOString(),
    source: "cli",
    cli: snapshotCli,
    engine_version: normalizedEngineVersion,
    routes,
    quota_refresh_error: quotaUpdate ? String(quotaRefreshError || "").trim() || null : previous?.quota_refresh_error || null,
    provider_quotas: quotaUpdate ? structuredClone(providerQuotas || []) : structuredClone(previous?.provider_quotas || []),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, snapshot);
  return { changed: !sameCatalog, snapshot };
}

export interface RouteSnapshotReadOptions {
  host?: string;
  env?: NodeJS.ProcessEnv;
}

function validSnapshot(value: Partial<RouteSnapshot>): value is RouteSnapshot {
  return value.schema_version === 5
    && value.source === "cli"
    && typeof value.cli === "string"
    && Array.isArray(value.routes)
    && Array.isArray(value.provider_quotas);
}

export function readRouteSnapshot(cwd: string, options: RouteSnapshotReadOptions | string = {}): RouteSnapshot | null {
  const resolved = typeof options === "string" ? { host: options } : options;
  const { host, env } = resolved;
  // Callers must identify the runtime host explicitly.
  const requestedHost = String(host || "").trim().toLowerCase();
  if (!requestedHost) throw new Error("HOST_REQUIRED");
  const file = hostRouteSnapshotPath(cwd, requestedHost, env);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = readJsonFile(file) as Partial<RouteSnapshot>;
    if (!validSnapshot(parsed) || parsed.cli !== requestedHost) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface RouteCandidate {
  card: ModelCard;
  executable: boolean;
}

export function canonicalRouteId(route: ExecutableRoute): string {
  return route.route_id;
}

export function buildRouteCandidates(
  cwd: string,
  { host, env }: { host?: string; env?: NodeJS.ProcessEnv } = {},
): RouteCandidate[] {
  const snapshot = readRouteSnapshot(cwd, { host, env });
  const candidates: RouteCandidate[] = [];
  for (const route of snapshot?.routes || []) {
    const canonical = canonicalRouteId(route);
    const profiles = ["", ...route.reasoning_efforts];
    for (const profile of [...new Set(profiles)]) {
      const id = profile ? `${canonical}@${profile}` : canonical;
      const executable = route.disabled !== true;
      const card: ModelCard = {
        id,
        strengths: route.description,
        display_name: route.display_name,
        description: route.description,
        route_id: canonical,
        reasoning_effort: profile || undefined,
        source: "dynamic",
        provider: route.provider,
        executable,
        available_speed_tiers: route.additional_speed_tiers,
        service_tiers: route.service_tiers,
        default_service_tier: route.default_service_tier,
        is_default: route.is_default,
      };
      candidates.push({ card, executable });
    }
  }
  return candidates.sort((a, b) => a.card.id.localeCompare(b.card.id));
}
