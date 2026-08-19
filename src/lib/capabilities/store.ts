import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = fileURLToPath(new URL("../../../data/capabilities/artificial-analysis/schema.sql", import.meta.url));
const DEFAULT_MAPPINGS_PATH = fileURLToPath(new URL("../../../data/capabilities/artificial-analysis/route-mappings.json", import.meta.url));

const require = createRequire(import.meta.url);

function sqliteModule() {
  try {
    return require("node:sqlite");
  } catch {
    const err = new Error("capability cache requires a Node.js runtime with node:sqlite support");
    err.code = "BATON_SQLITE_UNAVAILABLE";
    throw err;
  }
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function checksum(value) {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedNumber(value, ...keys) {
  let current = value;
  for (const key of keys) current = current && typeof current === "object" ? current[key] : null;
  return numberOrNull(current);
}

function normalizeMapping(mapping) {
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

export function loadRouteMappings(file = DEFAULT_MAPPINGS_PATH) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const mappings = Array.isArray(parsed) ? parsed : parsed.mappings;
  if (!Array.isArray(mappings)) throw new Error("route mappings file must contain a mappings array");
  const seen = new Set();
  return mappings.map((item) => {
    const mapping = normalizeMapping(item);
    const key = `${mapping.routeId}\0${mapping.profile}`;
    if (seen.has(key)) throw new Error(`duplicate route mapping: ${mapping.routeId} profile=${mapping.profile || "default"}`);
    seen.add(key);
    return mapping;
  });
}

function modelForStorage(model) {
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
  return {
    id: model.id == null ? `local:${model.slug}` : String(model.id),
    slug: String(model.slug || "").trim(),
    name: String(model.name || "").trim(),
    release_date: model.release_date ?? model.releaseDate ?? null,
    model_creator: model.model_creator ?? model.creator ?? null,
    evaluations,
    pricing,
    performance: model.performance && typeof model.performance === "object" ? model.performance : {},
    cost: model.cost ?? model.intelligenceIndexCost ?? {},
  };
}

function deduplicateModels(models) {
  const bySlug = new Map();
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

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function writeCapabilitySnapshot({ dbPath, manifestPath = null, models, metadata, mappings = [] }) {
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
  let db = null;
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

function modelFromRow(row) {
  if (!row) return null;
  const evaluations = JSON.parse(row.evaluations_json);
  const pricing = JSON.parse(row.pricing_json);
  const performance = JSON.parse(row.performance_json);
  const cost = JSON.parse(row.cost_json);
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

export function queryRouteCapability({ dbPath, routeId, profile = "" }) {
  const route = String(routeId || "").trim();
  const requestedProfile = String(profile || "").trim();
  if (!route) throw new Error("routeId is required");
  if (!fs.existsSync(dbPath)) return { routeId: route, profile: requestedProfile, ranked: false, unranked: true, reason: "cache_missing" };
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let mapping = db.prepare("SELECT * FROM route_mappings WHERE route_id = ? AND profile = ?").get(route, requestedProfile);
    if (!mapping && requestedProfile) mapping = db.prepare("SELECT * FROM route_mappings WHERE route_id = ? AND profile = ''").get(route);
    if (!mapping) return { routeId: route, profile: requestedProfile, ranked: false, unranked: true, reason: "no_canonical_mapping" };
    const row = db.prepare("SELECT * FROM models WHERE slug = ?").get(mapping.aa_slug);
    if (!row) return { routeId: route, profile: requestedProfile, aaSlug: mapping.aa_slug, ranked: false, unranked: true, reason: "aa_model_not_in_snapshot" };
    const model = modelFromRow(row);
    const values = Object.values(model.evaluations).filter((value) => typeof value === "number");
    return {
      routeId: route,
      profile: requestedProfile,
      aaSlug: mapping.aa_slug,
      mappingSource: mapping.mapping_source,
      ranked: values.length > 0,
      unranked: values.length === 0,
      reason: values.length > 0 ? null : "aa_model_has_no_ranked_metrics",
      model,
    };
  } finally {
    db.close();
  }
}

export function readCapabilityStatus({ dbPath }) {
  if (!fs.existsSync(dbPath)) return { exists: false, modelCount: 0, mappingCount: 0 };
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const meta = db.prepare("SELECT * FROM snapshot_metadata WHERE singleton = 1").get();
    const mappingCount = db.prepare("SELECT COUNT(*) AS count FROM route_mappings").get().count;
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
