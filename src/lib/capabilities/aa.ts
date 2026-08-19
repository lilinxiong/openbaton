const DEFAULT_BASE_URL = "https://artificialanalysis.ai/api/v2";
const FREE_MODELS_PATH = "/language/models/free";
const MAX_PAGES = 100;

export type AaErrorCode =
  | "AA_ERROR"
  | "AA_INVALID_MODEL"
  | "AA_UNAUTHORIZED"
  | "AA_FORBIDDEN"
  | "AA_RATE_LIMITED"
  | "AA_HTTP_ERROR"
  | "AA_API_KEY_MISSING"
  | "AA_FETCH_UNAVAILABLE"
  | "AA_NETWORK_ERROR"
  | "AA_INVALID_JSON"
  | "AA_INVALID_RESPONSE"
  | "AA_SNAPSHOT_CHANGED"
  | "AA_CONFLICTING_MODEL"
  | "AA_TOO_MANY_PAGES";

export interface ArtificialAnalysisErrorOptions {
  code?: AaErrorCode;
  status?: number | null;
  retryAfter?: string | null;
}

export class ArtificialAnalysisError extends Error {
  readonly code: AaErrorCode;
  readonly status: number | null;
  readonly retryAfter: string | null;

  constructor(message: string, { code = "AA_ERROR", status = null, retryAfter = null }: ArtificialAnalysisErrorOptions = {}) {
    super(message);
    this.name = "ArtificialAnalysisError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type AaNumericValue = number | null | AaNumericObject;
export interface AaNumericObject {
  [key: string]: AaNumericValue;
}

function numericObject(value: unknown): AaNumericObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AaNumericObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" || item === null) out[key] = item;
    else if (item && typeof item === "object" && !Array.isArray(item)) out[key] = numericObject(item);
  }
  return out;
}

function stable(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export interface AaModelCreator {
  [key: string]: string | null;
}

export interface NormalizedAaModel {
  id: string | number;
  slug: string;
  name: string;
  release_date: string | null;
  model_creator: AaModelCreator | null;
  evaluations: AaNumericObject;
  pricing: AaNumericObject;
  performance: AaNumericObject;
  cost: AaNumericObject;
}

function modelIdentity(model: NormalizedAaModel): string | undefined {
  return stable({
    id: model.id,
    slug: model.slug,
    name: model.name,
    release_date: model.release_date,
    model_creator: model.model_creator,
  });
}

function isAaModelId(value: unknown): value is string | number {
  return (typeof value === "string" && value !== "") || typeof value === "number";
}

export function normalizeArtificialAnalysisModel(raw: unknown): NormalizedAaModel {
  if (!raw || typeof raw !== "object") throw new ArtificialAnalysisError("Artificial Analysis returned an invalid model record", { code: "AA_INVALID_MODEL" });
  const record = raw as Record<string, unknown>;
  const id = record.id;
   const slug = String(record.slug || "").trim();
   const name = String(record.name || "").trim();
  if (!isAaModelId(id) || !slug || !name) {
    throw new ArtificialAnalysisError("Artificial Analysis model record is missing id, slug, or name", { code: "AA_INVALID_MODEL" });
  }
  const creator = record.model_creator && typeof record.model_creator === "object" ? (record.model_creator as Record<string, unknown>) : {};
  return {
    id,
    slug,
    name,
    release_date: typeof record.release_date === "string" ? record.release_date : null,
    model_creator: record.model_creator == null ? null : {
      ...Object.fromEntries(
        Object.entries(creator).filter((entry): entry is [string, string | null] => typeof entry[1] === "string" || entry[1] === null),
      ) as AaModelCreator,
    },
    evaluations: numericObject(record.evaluations),
    pricing: numericObject(record.pricing),
    performance: numericObject(record.performance),
    cost: numericObject(record.artificial_analysis_intelligence_index_cost || record.cost),
  };
}

export interface AaFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get?: (name: string) => string | null };
  json(): Promise<unknown>;
}

export type AaFetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<AaFetchResponse>;

export interface FetchArtificialAnalysisModelsOptions {
  apiKey?: string;
  fetchImpl?: AaFetchImpl;
  baseUrl?: string;
  now?: () => Date;
}

export interface AaFetchMetadata {
  provider: string;
  tier: string;
  indexVersion: string;
  fetchedAt: string;
  source: string;
  endpoint: string;
  duplicateRecords: number;
}

export interface AaFetchResult {
  models: NormalizedAaModel[];
  metadata: AaFetchMetadata;
}

function apiFailure(response: AaFetchResponse): ArtificialAnalysisError {
  const status = Number(response?.status) || null;
  const retryAfter = response?.headers?.get?.("retry-after") || null;
  if (status === 401) return new ArtificialAnalysisError("Artificial Analysis rejected the API key", { code: "AA_UNAUTHORIZED", status });
  if (status === 403) return new ArtificialAnalysisError("Artificial Analysis account tier does not allow this endpoint", { code: "AA_FORBIDDEN", status });
  if (status === 429) return new ArtificialAnalysisError("Artificial Analysis rate limit reached", { code: "AA_RATE_LIMITED", status, retryAfter });
  return new ArtificialAnalysisError(`Artificial Analysis request failed with HTTP ${status || "unknown"}`, { code: "AA_HTTP_ERROR", status, retryAfter });
}

export async function fetchArtificialAnalysisModels({
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  now = () => new Date(),
}: FetchArtificialAnalysisModelsOptions = {}): Promise<AaFetchResult> {
  const key = String(apiKey || "").trim();
  if (!key) throw new ArtificialAnalysisError("Artificial Analysis API key is required", { code: "AA_API_KEY_MISSING" });
  if (typeof fetchImpl !== "function") throw new ArtificialAnalysisError("fetch is unavailable", { code: "AA_FETCH_UNAVAILABLE" });

  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const models: NormalizedAaModel[] = [];
  const modelBySlug = new Map<string, NormalizedAaModel>();
  const slugById = new Map<string, string>();
  let page = 1;
  let tier: string | null = null;
  let indexVersion: unknown = null;
  let duplicateRecords = 0;

  while (page <= MAX_PAGES) {
    const url = `${root}${FREE_MODELS_PATH}?page=${page}`;
    let response: AaFetchResponse;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", "x-api-key": key },
      });
    } catch {
      throw new ArtificialAnalysisError("Artificial Analysis request failed before receiving a response", { code: "AA_NETWORK_ERROR" });
    }
    if (!response?.ok) throw apiFailure(response);

    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ArtificialAnalysisError("Artificial Analysis returned invalid JSON", { code: "AA_INVALID_JSON", status: response.status });
    }
    const pagination = body?.pagination as { has_more?: unknown } | undefined;
    if (!body || !Array.isArray(body.data) || !pagination) {
      throw new ArtificialAnalysisError("Artificial Analysis returned an invalid response envelope", { code: "AA_INVALID_RESPONSE", status: response.status });
    }
    if (page === 1) {
      tier = String(body.tier || "unknown");
      indexVersion = body.intelligence_index_version ?? null;
    } else if (String(body.tier || "unknown") !== tier || (body.intelligence_index_version ?? null) !== indexVersion) {
      throw new ArtificialAnalysisError("Artificial Analysis snapshot changed while pages were being fetched", { code: "AA_SNAPSHOT_CHANGED", status: response.status });
    }
    for (const item of body.data) {
      const model = normalizeArtificialAnalysisModel(item);
      const idKey = String(model.id);
      const knownSlug = slugById.get(idKey);
      if (knownSlug && knownSlug !== model.slug) {
        throw new ArtificialAnalysisError("Artificial Analysis returned one model id with conflicting slugs", { code: "AA_CONFLICTING_MODEL", status: response.status });
      }
      const existing = modelBySlug.get(model.slug);
      if (existing) {
        if (modelIdentity(existing) !== modelIdentity(model)) throw new ArtificialAnalysisError("Artificial Analysis returned conflicting identities for one model slug", { code: "AA_CONFLICTING_MODEL", status: response.status });
        duplicateRecords += 1;
        continue;
      }
      modelBySlug.set(model.slug, model);
      slugById.set(idKey, model.slug);
      models.push(model);
    }
    if (!pagination.has_more) break;
    page += 1;
  }

  if (page > MAX_PAGES) throw new ArtificialAnalysisError("Artificial Analysis pagination exceeded the safety limit", { code: "AA_TOO_MANY_PAGES" });
  return {
    models,
    metadata: {
      provider: "artificial-analysis",
      tier: tier ?? "unknown",
      indexVersion: String(indexVersion ?? "unknown"),
      fetchedAt: now().toISOString(),
      source: "artificialanalysis",
      endpoint: `${root}${FREE_MODELS_PATH}`,
      duplicateRecords,
    },
  };
}

export const ARTIFICIAL_ANALYSIS_BASE_URL = DEFAULT_BASE_URL;
export const ARTIFICIAL_ANALYSIS_FREE_MODELS_PATH = FREE_MODELS_PATH;
