import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { routeSnapshotPath } from "./paths.js";
import { queryRouteCapability, type RouteCapabilityResult } from "./capabilities/store.js";
import type { ModelCard } from "../types.js";

export interface ExecutableRoute {
  id: string;
  provider: string | null;
}

export interface RouteSnapshot {
  schema_version: 1;
  generation: number;
  fingerprint: string;
  fetched_at: string;
  source: "opencodex";
  routes: ExecutableRoute[];
}

function stableRoutes(routes: ExecutableRoute[]): string {
  return JSON.stringify(routes.slice().sort((a, b) => a.id.localeCompare(b.id)));
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
    byId.set(id, { id, provider });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function publishRouteSnapshot(cwd: string, catalog: unknown, now: Date = new Date()): { changed: boolean; snapshot: RouteSnapshot } {
  const routes = normalizeRouteCatalog(catalog);
  const fingerprint = crypto.createHash("sha256").update(stableRoutes(routes)).digest("hex");
  const file = routeSnapshotPath(cwd);
  let previous: RouteSnapshot | null = null;
  if (fs.existsSync(file)) previous = JSON.parse(fs.readFileSync(file, "utf8")) as RouteSnapshot;
  if (previous?.fingerprint === fingerprint) return { changed: false, snapshot: previous };
  const snapshot: RouteSnapshot = { schema_version: 1, generation: (previous?.generation || 0) + 1, fingerprint, fetched_at: now.toISOString(), source: "opencodex", routes };
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
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as RouteSnapshot : null;
}

export interface RouteCandidate {
  card: ModelCard;
  executable: boolean;
  capability: RouteCapabilityResult | null;
}

export function buildRouteCandidates(cwd: string, cards: ModelCard[], capabilityDbPath: string): RouteCandidate[] {
  const snapshot = readRouteSnapshot(cwd);
  const available = new Set<string>();
  for (const route of snapshot?.routes || []) {
    available.add(route.id);
    if (route.provider) available.add(`${route.provider}/${route.id}`);
  }
  return cards.map((card) => {
    let capability = card.route_id ? queryRouteCapability({ dbPath: capabilityDbPath, routeId: card.route_id, profile: card.reasoning_effort || "" }) : null;
    if (capability?.unranked && capability.reason === "no_canonical_mapping") {
      capability = queryRouteCapability({ dbPath: capabilityDbPath, routeId: card.id, profile: card.reasoning_effort || "" });
    }
    return { card, executable: Boolean(card.route_id && available.has(card.route_id)), capability };
  });
}
