import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { routeSnapshotPath } from "./paths.js";
import {
  listStoredRouteMappings,
  loadRouteMappings,
  queryMappedRouteCapability,
  queryRouteCapability,
  type RouteCapabilityResult,
  type StoredRouteMapping,
} from "./capabilities/store.js";
import type { CardCapabilityEvidence, ModelCard } from "../types.js";

export interface ExecutableRoute {
  id: string;
  provider: string | null;
  /** Exact model string accepted by the host runtime. Never reconstruct it. */
  route_id: string;
  disabled: boolean;
  native: boolean;
  reasoning_efforts: string[];
  default_reasoning_effort: string | null;
}

export interface RouteSnapshot {
  schema_version: 2;
  generation: number;
  fingerprint: string;
  fetched_at: string;
  source: "opencodex";
  engine_version: string | null;
  routes: ExecutableRoute[];
}

function stableRoutes(routes: ExecutableRoute[]): string {
  return JSON.stringify(routes.slice().sort((a, b) => a.route_id.localeCompare(b.route_id) || String(a.provider || "").localeCompare(String(b.provider || ""))));
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].sort();
}

function exactRouteId(record: Record<string, unknown> | null, id: string, provider: string | null): string {
  const namespaced = String(record?.namespaced ?? record?.route_id ?? record?.routeId ?? "").trim();
  if (namespaced) return namespaced;
  if (id.includes("/") || !provider || record?.native === true || provider === "openai") return id;
  return `${provider}/${id}`;
}

export function normalizeRouteCatalog(value: unknown): ExecutableRoute[] {
  let values: unknown = value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    values = record.data ?? record.models ?? record.liveModels ?? record.routes;
  }
  if (!Array.isArray(values)) throw new Error("OpenCodex model catalog must be an array or contain models/data/liveModels/routes");
  const byId = new Map<string, ExecutableRoute>();
  for (const item of values) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const id = String(record?.id ?? record?.model ?? record?.name ?? item ?? "").trim();
    if (!id) continue;
    const provider = typeof record?.provider === "string" ? record.provider : id.includes("/") ? id.split("/", 1)[0] : null;
    const routeId = exactRouteId(record, id, provider);
    const reasoningEfforts = strings(record?.reasoningEfforts ?? record?.reasoning_efforts);
    const defaultReasoningEffort = String(record?.defaultReasoningEffort ?? record?.default_reasoning_effort ?? "").trim() || null;
    byId.set(`${provider || ""}\0${routeId}`, {
      id,
      provider,
      route_id: routeId,
      disabled: record?.disabled === true,
      native: record?.native === true,
      reasoning_efforts: reasoningEfforts,
      default_reasoning_effort: defaultReasoningEffort,
    });
  }
  return [...byId.values()].sort((a, b) => a.route_id.localeCompare(b.route_id) || String(a.provider || "").localeCompare(String(b.provider || "")));
}

interface PublishRouteSnapshotOptions { engineVersion?: string | null }

export function publishRouteSnapshot(
  cwd: string,
  catalog: unknown,
  now: Date = new Date(),
  { engineVersion = null }: PublishRouteSnapshotOptions = {},
): { changed: boolean; snapshot: RouteSnapshot } {
  const routes = normalizeRouteCatalog(catalog);
  const fingerprint = crypto.createHash("sha256").update(stableRoutes(routes)).digest("hex");
  const file = routeSnapshotPath(cwd);
  let previous: Partial<RouteSnapshot> | null = null;
  if (fs.existsSync(file)) previous = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RouteSnapshot>;
  const normalizedEngineVersion = String(engineVersion || "").trim() || null;
  if (previous?.schema_version === 2 && previous.fingerprint === fingerprint && previous.engine_version === normalizedEngineVersion) {
    return { changed: false, snapshot: previous as RouteSnapshot };
  }
  const snapshot: RouteSnapshot = {
    schema_version: 2,
    generation: Number(previous?.generation || 0) + 1,
    fingerprint,
    fetched_at: now.toISOString(),
    source: "opencodex",
    engine_version: normalizedEngineVersion,
    routes,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return { changed: true, snapshot };
}

export function readRouteSnapshot(cwd: string): RouteSnapshot | null {
  const file = routeSnapshotPath(cwd);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RouteSnapshot>;
  if (parsed.schema_version !== 2 || !Array.isArray(parsed.routes)) return null;
  return parsed as RouteSnapshot;
}

export function routeSnapshotSchemaVersion(cwd: string): number | null {
  const file = routeSnapshotPath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { schema_version?: unknown };
    const value = Number(parsed.schema_version);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

export interface RouteCandidate {
  card: ModelCard;
  executable: boolean;
  capability: RouteCapabilityResult | null;
}

export function canonicalRouteId(route: ExecutableRoute): string {
  return route.route_id;
}

function routeVariants(route: ExecutableRoute): string[] {
  return [canonicalRouteId(route)];
}

function numberAt(value: unknown, ...path: string[]): number | null {
  let current = value;
  for (const key of path) current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : null;
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function evidence(result: RouteCapabilityResult, mappingRouteId?: string): CardCapabilityEvidence {
  const model = "model" in result ? result.model : undefined;
  return {
    source: "artificial-analysis",
    ranked: result.ranked,
    unranked: result.unranked,
    reason: result.reason,
    ...(result.aaSlug ? { aa_slug: result.aaSlug } : {}),
    ...(mappingRouteId ? { mapping_route_id: mappingRouteId } : {}),
    ...(result.ranked && "mappingSource" in result ? { mapping_source: result.mappingSource } : {}),
    intelligence_index: model?.intelligence_index ?? null,
    coding_index: model?.coding_index ?? null,
    agentic_index: model?.agentic_index ?? null,
    cost_per_task: numberAt(model?.cost, "cost_per_task", "total_cost"),
    output_tokens_per_second: numberAt(model?.performance, "median_output_tokens_per_second"),
    time_to_first_answer_seconds: numberAt(model?.performance, "median_time_to_first_answer_token_seconds"),
  };
}

function percentile(value: number | null, values: number[], lowerIsBetter = false): number | undefined {
  if (value == null || values.length === 0) return undefined;
  const rank = values.filter((item) => item <= value).length / values.length;
  return lowerIsBetter ? 1 - rank + (1 / values.length) : rank;
}

function applyPositioning(candidates: RouteCandidate[]): void {
  const unique = new Map<string, CardCapabilityEvidence>();
  for (const candidate of candidates) {
    const capability = candidate.card.capability;
    if (candidate.executable && capability?.ranked && capability.aa_slug && !unique.has(capability.aa_slug)) unique.set(capability.aa_slug, capability);
  }
  const values = [...unique.values()];
  const metric = (key: keyof CardCapabilityEvidence) => values.map((item) => item[key]).filter((item): item is number => typeof item === "number");
  const intelligence = metric("intelligence_index");
  const coding = metric("coding_index");
  const agentic = metric("agentic_index");
  const cost = metric("cost_per_task");
  const throughput = metric("output_tokens_per_second");
  const latency = metric("time_to_first_answer_seconds");

  for (const candidate of candidates) {
    const cap = candidate.card.capability;
    if (!cap?.ranked) {
      candidate.card.positioning = ["unranked"];
      candidate.card.strengths = `unranked; ${cap?.reason || "no capability evidence"}`;
      continue;
    }
    cap.relative = {
      intelligence: percentile(cap.intelligence_index, intelligence),
      coding: percentile(cap.coding_index, coding),
      agentic: percentile(cap.agentic_index, agentic),
      cost_efficiency: percentile(cap.cost_per_task, cost, true),
      throughput: percentile(cap.output_tokens_per_second, throughput),
      latency: percentile(cap.time_to_first_answer_seconds, latency, true),
    };
    const tags: string[] = [];
    if ((cap.relative.coding || 0) >= 0.75) tags.push("strong-coding");
    if ((cap.relative.agentic || 0) >= 0.75) tags.push("strong-agentic");
    if ((cap.relative.intelligence || 0) >= 0.75) tags.push("strong-reasoning");
    if ((cap.relative.cost_efficiency || 0) >= 0.75) tags.push("cost-efficient");
    if ((cap.relative.throughput || 0) >= 0.75) tags.push("high-throughput");
    if ((cap.relative.latency || 0) >= 0.75) tags.push("low-latency");
    if (tags.length === 0) tags.push("balanced");
    candidate.card.positioning = tags;
    const fields = [
      cap.coding_index == null ? null : `coding=${cap.coding_index}`,
      cap.agentic_index == null ? null : `agentic=${cap.agentic_index}`,
      cap.intelligence_index == null ? null : `intelligence=${cap.intelligence_index}`,
      cap.cost_per_task == null ? null : `cost/task=${cap.cost_per_task}`,
      cap.output_tokens_per_second == null ? null : `tok/s=${cap.output_tokens_per_second}`,
    ].filter(Boolean);
    candidate.card.strengths = `AA-derived inference: ${tags.join(", ")}${fields.length ? `; ${fields.join(", ")}` : ""}`;
  }
}

function matchesOverride(card: ModelCard, override: ModelCard): boolean {
  const target = override.route_id || override.id;
  const route = card.route_id || "";
  const routeMatches = card.id === target || route === target || route.endsWith(`/${target}`);
  if (!routeMatches) return false;
  return override.reasoning_effort ? card.reasoning_effort === override.reasoning_effort : true;
}

function applyOverrides(candidates: RouteCandidate[], overrides: ModelCard[], snapshot: RouteSnapshot | null): RouteCandidate[] {
  const removed = new Set<RouteCandidate>();
  const aliases: RouteCandidate[] = [];
  for (const override of overrides) {
    const matches = candidates.filter((candidate) => matchesOverride(candidate.card, override));
    if (override.enabled === false) {
      for (const match of matches) removed.add(match);
      continue;
    }
    const matchedRoutes = new Set(matches.map((candidate) => candidate.card.route_id).filter(Boolean));
    const target = override.route_id || override.id;
    if (matchedRoutes.size > 1 && !target.includes("/")) {
      aliases.push({
        card: { ...override, strengths: override.strengths || "ambiguous provider route override", source: "override", executable: false },
        executable: false,
        capability: null,
      });
      continue;
    }
    const base = override.reasoning_effort
      ? matches.find((candidate) => candidate.card.reasoning_effort === override.reasoning_effort)
      : matches.find((candidate) => !candidate.card.reasoning_effort) || matches[0];
    if (base) {
      removed.add(base);
      aliases.push({
        ...base,
        card: {
          ...base.card,
          ...override,
          id: override.id,
          strengths: [base.card.strengths, override.strengths ? `User override: ${override.strengths}` : ""].filter(Boolean).join(". "),
          route_id: base.card.route_id,
          reasoning_effort: override.reasoning_effort || base.card.reasoning_effort,
          source: "override",
          enabled: true,
        },
      });
      continue;
    }
    const matchingSnapshotRoutes = snapshot?.routes.filter((route) => routeVariants(route).includes(target)) || [];
    const executable = matchingSnapshotRoutes.length === 1 && matchingSnapshotRoutes[0].disabled !== true;
    aliases.push({
      card: { ...override, strengths: override.strengths || "unranked user override", source: "override", executable },
      executable,
      capability: null,
    });
  }
  return [...candidates.filter((candidate) => !removed.has(candidate)), ...aliases]
    .sort((a, b) => a.card.id.localeCompare(b.card.id));
}

export function buildRouteCandidates(cwd: string, overrides: ModelCard[], capabilityDbPath: string): RouteCandidate[] {
  const snapshot = readRouteSnapshot(cwd);
  const mergedMappings = new Map<string, StoredRouteMapping>();
  for (const mapping of listStoredRouteMappings({ dbPath: capabilityDbPath })) {
    mergedMappings.set(`${mapping.routeId}\0${mapping.profile}`, mapping);
  }
  for (const mapping of loadRouteMappings()) {
    mergedMappings.set(`${mapping.routeId}\0${mapping.profile}`, {
      routeId: mapping.routeId,
      profile: mapping.profile,
      aaSlug: mapping.aaSlug,
      mappingSource: mapping.source,
      note: mapping.note,
    });
  }
  const mappings = [...mergedMappings.values()];
  const candidates: RouteCandidate[] = [];
  for (const route of snapshot?.routes || []) {
    const canonical = canonicalRouteId(route);
    const routeMappings = mappings
      .filter((mapping) => mapping.routeId === canonical)
      .sort((a, b) => a.profile.localeCompare(b.profile));
    const byProfile = new Map<string, StoredRouteMapping>();
    for (const mapping of routeMappings) if (!byProfile.has(mapping.profile)) byProfile.set(mapping.profile, mapping);
    if (!byProfile.has("")) byProfile.set("", { routeId: canonical, profile: "", aaSlug: "", mappingSource: "explicit", note: null });
    for (const [profile, mapping] of byProfile) {
      if (profile && route.reasoning_efforts.length > 0 && !route.reasoning_efforts.includes(profile)) continue;
      const result = mapping.aaSlug
        ? queryMappedRouteCapability({ dbPath: capabilityDbPath, routeId: canonical, profile, mapping })
        : queryRouteCapability({ dbPath: capabilityDbPath, routeId: mapping.routeId, profile });
      const id = profile ? `${canonical}@${profile}` : canonical;
      const executable = route.disabled !== true;
      const card: ModelCard = {
        id,
        strengths: "",
        route_id: canonical,
        reasoning_effort: profile || undefined,
        source: "dynamic",
        provider: route.provider,
        executable,
        capability: evidence(result, mapping.routeId),
      };
      candidates.push({ card, executable, capability: result });
    }
  }
  applyPositioning(candidates);
  return applyOverrides(candidates, overrides, snapshot);
}
