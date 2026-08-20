import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { AaNumericObject, NormalizedAaModel } from "./aa.js";
import { packageRoot } from "../paths.js";

const SCHEMA_PATH = path.join(packageRoot(), "data", "capabilities", "artificial-analysis", "schema.sql");
const DEFAULT_MAPPINGS_PATH = path.join(packageRoot(), "data", "capabilities", "artificial-analysis", "route-mappings.json");

const require = createRequire(import.meta.url);

interface CodedError extends Error {
  code?: string;
}

export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteDatabaseOptions = { readOnly?: boolean };
type SqliteDatabaseCtor = new (path: string, options?: SqliteDatabaseOptions) => SqliteDatabase;

function sqliteModule(): { DatabaseSync: SqliteDatabaseCtor } {
  try {
    return require("node:sqlite") as { DatabaseSync: SqliteDatabaseCtor };
  } catch {}
  try {
    const { Database } = require("bun:sqlite") as {
      Database: new (path: string, options?: { readonly?: boolean; create?: boolean }) => SqliteDatabase;
    };
    class BunDatabaseSync implements SqliteDatabase {
      private readonly database: SqliteDatabase;

      constructor(file: string, options: SqliteDatabaseOptions = {}) {
        this.database = new Database(file, options.readOnly ? { readonly: true } : { create: true });
      }

      exec(sql: string): unknown { return this.database.exec(sql); }
      prepare(sql: string): SqliteStatement { return this.database.prepare(sql); }
      close(): void { this.database.close(); }
    }
    return { DatabaseSync: BunDatabaseSync };
  } catch {
    const err: CodedError = new Error("capability cache requires node:sqlite or bun:sqlite support");
    err.code = "BATON_SQLITE_UNAVAILABLE";
    throw err;
  }
}

function stable(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function checksum(value: unknown): string {
  return crypto.createHash("sha256").update(stable(value) ?? "").digest("hex");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedNumber(value: unknown, ...keys: string[]): number | null {
  let current: unknown = value;
  for (const key of keys) current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : null;
  return numberOrNull(current);
}

export interface RouteMappingInput {
  routeId?: unknown;
  route_id?: unknown;
  aaSlug?: unknown;
  aa_slug?: unknown;
  profile?: unknown;
  source?: unknown;
  mapping_source?: unknown;
  note?: unknown;
}

export interface RouteMapping {
  routeId: string;
  profile: string;
  aaSlug: string;
  source: string;
  note: string | null;
}

function normalizeMapping(mapping: RouteMappingInput): RouteMapping {
  const routeId = String(mapping?.routeId || mapping?.route_id || "").trim();
  const aaSlug = String(mapping?.aaSlug || mapping?.aa_slug || "").trim();
  const profile = String(mapping?.profile || "").trim();
  if (!routeId || !aaSlug) throw new Error("route mapping requires routeId and aaSlug");
  return {
    routeId,
    profile,
    aaSlug,
    source: String(mapping?.source || mapping?.mapping_source || "explicit").trim() || "explicit",
    note: mapping?.note == null ? null : String(mapping.note),
  };
}

export function loadRouteMappings(file: string = DEFAULT_MAPPINGS_PATH): RouteMapping[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const mappings = Array.isArray(parsed) ? parsed : (parsed as { mappings?: unknown }).mappings;
  if (!Array.isArray(mappings)) throw new Error("route mappings file must contain a mappings array");
  const seen = new Set<string>();
  return mappings.map((item: RouteMappingInput) => {
    const mapping = normalizeMapping(item);
    const key = `${mapping.routeId}\0${mapping.profile}`;
    if (seen.has(key)) throw new Error(`duplicate route mapping: ${mapping.routeId} profile=${mapping.profile || "default"}`);
    seen.add(key);
    return mapping;
  });
}

export interface StorageModelInput {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  release_date?: unknown;
  releaseDate?: unknown;
  model_creator?: Record<string, unknown> | null;
  creator?: Record<string, unknown> | null;
  evaluations?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  performance?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  intelligence_index?: unknown;
  coding_index?: unknown;
  agentic_index?: unknown;
  blended_cost_1m?: unknown;
  intelligenceIndexCost?: Record<string, unknown>;
}

export type StoredCapabilityModel = Omit<NormalizedAaModel, "id"> & { id: string };

function modelForStorage(model: StorageModelInput): StoredCapabilityModel {
  const evaluations = model.evaluations && typeof model.evaluations === "object"
    ? model.evaluations
    : {
        artificial_analysis_intelligence_index: numberOrNull(model.intelligence_index),
        artificial_analysis_coding_index: numberOrNull(model.coding_index),
        artificial_analysis_agentic_index: numberOrNull(model.agentic_index),
      };
  const pricing = model.pricing && typeof model.pricing === "object"
    ? model.pricing
    : { blended_cost_1m: numberOrNull(model.blended_cost_1m) };
  const creator: Record<string, unknown> | null = model.model_creator ?? model.creator ?? null;
  return {
    id: model.id == null ? `local:${model.slug}` : String(model.id),
    slug: String(model.slug || "").trim(),
    name: String(model.name || "").trim(),
    release_date: (model.release_date ?? model.releaseDate ?? null) as string | null,
    model_creator: creator == null ? null : creator as NormalizedAaModel["model_creator"],
    evaluations: evaluations as AaNumericObject,
    pricing: pricing as AaNumericObject,
    performance: (model.performance && typeof model.performance === "object" ? model.performance : {}) as AaNumericObject,
    cost: (model.cost ?? model.intelligenceIndexCost ?? {}) as AaNumericObject,
  };
}

function deduplicateModels(models: StorageModelInput[]): { models: StoredCapabilityModel[]; duplicateRecords: number } {
  const bySlug = new Map<string, StoredCapabilityModel>();
  let duplicateRecords = 0;
  for (const item of models) {
    const model = modelForStorage(item);
    const previous = bySlug.get(model.slug);
    if (!previous) {
      bySlug.set(model.slug, model);
      continue;
    }
    const previousIdentity = stable({ id: previous.id, slug: previous.slug, name: previous.name, release_date: previous.release_date, model_creator: previous.model_creator });
    const modelIdentity = stable({ id: model.id, slug: model.slug, name: model.name, release_date: model.release_date, model_creator: model.model_creator });
    if (previousIdentity !== modelIdentity) throw new Error(`conflicting duplicate capability model identity: ${model.slug}`);
    duplicateRecords += 1;
  }
  return { models: [...bySlug.values()], duplicateRecords };
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export interface CapabilitySnapshotMetadata {
  provider?: unknown;
  tier?: unknown;
  indexVersion?: unknown;
  fetchedAt?: unknown;
  source?: unknown;
  endpoint?: unknown;
  duplicateRecords?: unknown;
}

export interface WriteCapabilitySnapshotOptions {
  dbPath: string;
  manifestPath?: string | null;
  models: StorageModelInput[];
  metadata: CapabilitySnapshotMetadata;
  mappings?: RouteMappingInput[];
}

export interface CapabilitySnapshotManifest {
  schemaVersion: number;
  provider: string;
  tier: string;
  indexVersion: unknown;
  fetchedAt: string;
  source: string;
  endpoint: string | null;
  modelCount: number;
  mappingCount: number;
  duplicateRecords: number;
  snapshotChecksum: string;
}

export function writeCapabilitySnapshot({ dbPath, manifestPath = null, models, metadata, mappings = [] }: WriteCapabilitySnapshotOptions): CapabilitySnapshotManifest {
  if (!dbPath) throw new Error("dbPath is required");
  if (!Array.isArray(models)) throw new Error("models must be an array");
  const normalizedMappings = mappings.map(normalizeMapping);
  const deduplicated = deduplicateModels(models);
  const sortedModels = deduplicated.models.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  const sortedMappings = normalizedMappings.slice().sort((a, b) => `${a.routeId}\0${a.profile}`.localeCompare(`${b.routeId}\0${b.profile}`));
  const snapshotChecksum = checksum({ metadata, models: sortedModels, mappings: sortedMappings });
  const manifest = {
    schemaVersion: 1,
    provider: String(metadata?.provider || "artificial-analysis"),
    tier: String(metadata?.tier || "unknown"),
    indexVersion: metadata?.indexVersion ?? null,
    fetchedAt: String(metadata?.fetchedAt || ""),
    source: String(metadata?.source || "artificialanalysis"),
    endpoint: metadata?.endpoint == null ? null : String(metadata.endpoint),
    modelCount: sortedModels.length,
    mappingCount: sortedMappings.length,
    duplicateRecords: Number(metadata?.duplicateRecords || 0) + deduplicated.duplicateRecords,
    snapshotChecksum,
  };

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tempPath = `${dbPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let db: SqliteDatabase | null = null;
  try {
    const { DatabaseSync } = sqliteModule();
    db = new DatabaseSync(tempPath);
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
    db.exec("BEGIN IMMEDIATE");
    const insertMeta = db.prepare("INSERT INTO snapshot_metadata VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertMeta.run(
      manifest.provider, manifest.tier, String(manifest.indexVersion ?? ""), manifest.fetchedAt,
      manifest.source, manifest.endpoint, manifest.modelCount, manifest.duplicateRecords, manifest.snapshotChecksum,
    );
    const insertModel = db.prepare(`
      INSERT INTO models VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    for (const model of sortedModels) {
      const evaluations = model.evaluations || {};
      const pricing = model.pricing || {};
      const performance = model.performance || {};
      const cost = model.cost || {};
      insertModel.run(
        model.id, model.slug, model.name, model.release_date ?? null,
        model.model_creator?.id ?? model.model_creator?.slug ?? null, model.model_creator?.name ?? null,
        numberOrNull(evaluations.artificial_analysis_intelligence_index),
        numberOrNull(evaluations.artificial_analysis_coding_index),
        numberOrNull(evaluations.artificial_analysis_agentic_index),
        nestedNumber(cost, "total_cost"), nestedNumber(cost, "cost_per_task", "total_cost"),
        numberOrNull(pricing.price_1m_input_tokens), numberOrNull(pricing.price_1m_output_tokens),
        numberOrNull(pricing.price_1m_cache_hit_tokens), numberOrNull(pricing.price_1m_cache_write_tokens),
        numberOrNull(performance.median_output_tokens_per_second),
        numberOrNull(performance.median_time_to_first_token_seconds),
        numberOrNull(performance.median_time_to_first_answer_token_seconds),
        numberOrNull(performance.median_end_to_end_response_time_seconds),
        JSON.stringify(evaluations), JSON.stringify(pricing), JSON.stringify(performance), JSON.stringify(cost),
      );
    }
    const insertMapping = db.prepare("INSERT INTO route_mappings(route_id, profile, aa_slug, mapping_source, note) VALUES (?, ?, ?, ?, ?)");
    for (const mapping of sortedMappings) insertMapping.run(mapping.routeId, mapping.profile, mapping.aaSlug, mapping.source, mapping.note);
    db.exec("COMMIT");
    db.close();
    db = null;
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, dbPath);
    if (manifestPath) atomicWriteJson(manifestPath, manifest);
    return manifest;
  } catch (error) {
    if (db) {
      try { db.exec("ROLLBACK"); } catch {}
      try { db.close(); } catch {}
    }
    throw error;
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

export interface ModelRow {
  aa_id: string;
  slug: string;
  name: string;
  release_date: string | null;
  creator_id: string | null;
  creator_name: string | null;
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
  evaluations_json: string;
  pricing_json: string;
  performance_json: string;
  cost_json: string;
}

export interface RouteMappingRow {
  route_id: string;
  profile: string;
  aa_slug: string;
  mapping_source: string;
  note: string | null;
}

export interface StoredRouteMapping {
  routeId: string;
  profile: string;
  aaSlug: string;
  mappingSource: string;
  note: string | null;
}

export function listStoredRouteMappings({ dbPath }: { dbPath: string }): StoredRouteMapping[] {
  if (!fs.existsSync(dbPath)) return [];
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT * FROM route_mappings ORDER BY route_id, profile").all() as unknown as RouteMappingRow[];
    return rows.map((row) => ({
      routeId: row.route_id,
      profile: row.profile,
      aaSlug: row.aa_slug,
      mappingSource: row.mapping_source,
      note: row.note,
    }));
  } finally {
    db.close();
  }
}

export interface QueriedCapabilityModel {
  id: string;
  slug: string;
  name: string;
  release_date: string | null;
  model_creator: { id: string | null; name: string | null } | null;
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
  blended_cost_1m: number | null;
  evaluations: Record<string, unknown>;
  pricing: Record<string, unknown>;
  performance: Record<string, unknown>;
  cost: Record<string, unknown>;
}

function modelFromRow(row: ModelRow | null | undefined): QueriedCapabilityModel | null {
  if (!row) return null;
  const evaluations = JSON.parse(row.evaluations_json) as Record<string, unknown>;
  const pricing = JSON.parse(row.pricing_json) as Record<string, unknown>;
  const performance = JSON.parse(row.performance_json) as Record<string, unknown>;
  const cost = JSON.parse(row.cost_json) as Record<string, unknown>;
  return {
    id: row.aa_id,
    slug: row.slug,
    name: row.name,
    release_date: row.release_date,
    model_creator: row.creator_id || row.creator_name ? { id: row.creator_id, name: row.creator_name } : null,
    intelligence_index: row.intelligence_index,
    coding_index: row.coding_index,
    agentic_index: row.agentic_index,
    blended_cost_1m: numberOrNull(pricing.blended_cost_1m ?? pricing.price_1m_blended_3_to_1 ?? pricing.price_1m_blended_7_to_2_to_1),
    evaluations,
    pricing,
    performance,
    cost,
  };
}

export type RouteCapabilityResult =
  | { routeId: string; profile: string; aaSlug?: string; ranked: false; unranked: true; reason: string }
  | {
      routeId: string;
      profile: string;
      aaSlug: string;
      mappingSource: string;
      ranked: boolean;
      unranked: boolean;
      reason: string | null;
      referenceOnly?: boolean;
      referenceReasons?: string[];
      referenceRouteId?: string;
      referenceProfile?: string;
      model?: QueriedCapabilityModel;
    };

/**
 * Artificial Analysis slugs use hyphens where OpenCodex model ids commonly
 * use dots. This is a deterministic identity normalization, not fuzzy search.
 */
export function normalizedAaSlug(routeId: string, profile = ""): string {
  const base = String(routeId || "").trim().toLowerCase().replaceAll(".", "-");
  const effort = String(profile || "").trim().toLowerCase();
  return effort ? `${base}-${effort}` : base;
}

export function queryRouteCapability({ dbPath, routeId, profile = "" }: { dbPath: string; routeId: string; profile?: string }): RouteCapabilityResult {
  const route = String(routeId || "").trim();
  const requestedProfile = String(profile || "").trim();
  if (!route) throw new Error("routeId is required");
  if (!fs.existsSync(dbPath)) return { routeId: route, profile: requestedProfile, ranked: false, unranked: true, reason: "cache_missing" };
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const mapping = db.prepare("SELECT * FROM route_mappings WHERE route_id = ? AND profile = ?").get(route, requestedProfile) as RouteMappingRow | undefined;
    const directSlug = normalizedAaSlug(route, requestedProfile);
    const aaSlug = mapping?.aa_slug || directSlug;
    const row = db.prepare("SELECT * FROM models WHERE slug = ?").get(aaSlug) as ModelRow | undefined;
    if (!row) {
      return mapping
        ? { routeId: route, profile: requestedProfile, aaSlug, ranked: false, unranked: true, reason: "aa_model_not_in_snapshot" }
        : { routeId: route, profile: requestedProfile, ranked: false, unranked: true, reason: "no_canonical_mapping" };
    }
    const model = modelFromRow(row);
    const values = Object.values(model?.evaluations ?? {}).filter((value) => typeof value === "number");
    return {
      routeId: route,
      profile: requestedProfile,
      aaSlug,
      mappingSource: mapping?.mapping_source || "normalized-model-id",
      ranked: values.length > 0,
      unranked: values.length === 0,
      reason: values.length > 0 ? null : "aa_model_has_no_ranked_metrics",
      model: model ?? undefined,
    };
  } finally {
    db.close();
  }
}

/**
 * Query model metrics using an explicit in-repo mapping. This lets mapping-only
 * releases take effect immediately without forcing a remote AA snapshot refresh.
 */
export function queryMappedRouteCapability({
  dbPath,
  routeId,
  profile = "",
  mapping,
}: {
  dbPath: string;
  routeId: string;
  profile?: string;
  mapping: StoredRouteMapping;
}): RouteCapabilityResult {
  const route = String(routeId || "").trim();
  const requestedProfile = String(profile || "").trim();
  if (!route) throw new Error("routeId is required");
  if (!fs.existsSync(dbPath)) return { routeId: route, profile: requestedProfile, ranked: false, unranked: true, reason: "cache_missing" };
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM models WHERE slug = ?").get(mapping.aaSlug) as ModelRow | undefined;
    if (!row) return { routeId: route, profile: requestedProfile, aaSlug: mapping.aaSlug, ranked: false, unranked: true, reason: "aa_model_not_in_snapshot" };
    const model = modelFromRow(row);
    const values = Object.values(model?.evaluations ?? {}).filter((value) => typeof value === "number");
    return {
      routeId: route,
      profile: requestedProfile,
      aaSlug: mapping.aaSlug,
      mappingSource: mapping.mappingSource,
      ranked: values.length > 0,
      unranked: values.length === 0,
      reason: values.length > 0 ? null : "aa_model_has_no_ranked_metrics",
      model: model ?? undefined,
    };
  } finally {
    db.close();
  }
}

export type CapabilityStatusResult =
  | { exists: false; modelCount: number; mappingCount: number }
  | {
      exists: true;
      provider: string;
      tier: string;
      indexVersion: string;
      fetchedAt: string;
      source: string;
      endpoint: string | null;
      modelCount: number;
      duplicateRecords: number;
      snapshotChecksum: string;
      metadata: {
        provider: string;
        tier: string;
        indexVersion: string;
        fetchedAt: string;
        source: string;
        endpoint: string | null;
        modelCount: number;
        duplicateRecords: number;
        snapshotChecksum: string;
      };
      mappingCount: number;
    };

interface SnapshotMetadataRow {
  provider: string;
  tier: string;
  index_version: string;
  fetched_at: string;
  source: string;
  endpoint: string | null;
  model_count: number;
  duplicate_records: number;
  snapshot_checksum: string;
}

export function readCapabilityStatus({ dbPath }: { dbPath: string }): CapabilityStatusResult {
  if (!fs.existsSync(dbPath)) return { exists: false, modelCount: 0, mappingCount: 0 };
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const meta = db.prepare("SELECT * FROM snapshot_metadata WHERE singleton = 1").get() as SnapshotMetadataRow;
    const mappingCount = (db.prepare("SELECT COUNT(*) AS count FROM route_mappings").get() as { count: number }).count;
    const metadata = {
      provider: meta.provider,
      tier: meta.tier,
      indexVersion: meta.index_version,
      fetchedAt: meta.fetched_at,
      source: meta.source,
      endpoint: meta.endpoint,
      modelCount: meta.model_count,
      duplicateRecords: meta.duplicate_records,
      snapshotChecksum: meta.snapshot_checksum,
    };
    return {
      exists: true,
      ...metadata,
      metadata,
      mappingCount,
    };
  } finally {
    db.close();
  }
}

export const ARTIFICIAL_ANALYSIS_SCHEMA_PATH = SCHEMA_PATH;
export const ARTIFICIAL_ANALYSIS_MAPPINGS_PATH = DEFAULT_MAPPINGS_PATH;
