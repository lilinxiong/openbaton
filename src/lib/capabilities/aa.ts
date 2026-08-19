const DEFAULT_BASE_URL = "https://artificialanalysis.ai/api/v2";
const FREE_MODELS_PATH = "/language/models/free";
const MAX_PAGES = 100;

export class ArtificialAnalysisError extends Error {
  constructor(message, { code = "AA_ERROR", status = null, retryAfter = null } = {}) {
    super(message);
    this.name = "ArtificialAnalysisError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function numericObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" || item === null) out[key] = item;
    else if (item && typeof item === "object" && !Array.isArray(item)) out[key] = numericObject(item);
  }
  return out;
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function modelIdentity(model) {
  return stable({
    id: model.id,
    slug: model.slug,
    name: model.name,
    release_date: model.release_date,
    model_creator: model.model_creator,
  });
}

export function normalizeArtificialAnalysisModel(raw) {
  if (!raw || typeof raw !== "object") throw new ArtificialAnalysisError("Artificial Analysis returned an invalid model record", { code: "AA_INVALID_MODEL" });
  const id = raw.id;
  const slug = String(raw.slug || "").trim();
  const name = String(raw.name || "").trim();
  if ((id === undefined || id === null || id === "") || !slug || !name) {
    throw new ArtificialAnalysisError("Artificial Analysis model record is missing id, slug, or name", { code: "AA_INVALID_MODEL" });
  }
  const creator = raw.model_creator && typeof raw.model_creator === "object" ? raw.model_creator : {};
  return {
    id,
    slug,
    name,
    release_date: typeof raw.release_date === "string" ? raw.release_date : null,
    model_creator: raw.model_creator == null ? null : {
      ...Object.fromEntries(Object.entries(creator).filter(([, value]) => typeof value === "string" || value === null)),
    },
    evaluations: numericObject(raw.evaluations),
    pricing: numericObject(raw.pricing),
    performance: numericObject(raw.performance),
    cost: numericObject(raw.artificial_analysis_intelligence_index_cost || raw.cost),
  };
}

function apiFailure(response) {
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
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new ArtificialAnalysisError("Artificial Analysis API key is required", { code: "AA_API_KEY_MISSING" });
  if (typeof fetchImpl !== "function") throw new ArtificialAnalysisError("fetch is unavailable", { code: "AA_FETCH_UNAVAILABLE" });

  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const models = [];
  const modelBySlug = new Map();
  const slugById = new Map();
  let page = 1;
  let tier = null;
  let indexVersion = null;
  let duplicateRecords = 0;

  while (page <= MAX_PAGES) {
    const url = `${root}${FREE_MODELS_PATH}?page=${page}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", "x-api-key": key },
      });
    } catch {
      throw new ArtificialAnalysisError("Artificial Analysis request failed before receiving a response", { code: "AA_NETWORK_ERROR" });
    }
    if (!response?.ok) throw apiFailure(response);

    let body;
    try {
      body = await response.json();
    } catch {
      throw new ArtificialAnalysisError("Artificial Analysis returned invalid JSON", { code: "AA_INVALID_JSON", status: response.status });
    }
    if (!body || !Array.isArray(body.data) || !body.pagination) {
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
    if (!body.pagination.has_more) break;
    page += 1;
  }

  if (page > MAX_PAGES) throw new ArtificialAnalysisError("Artificial Analysis pagination exceeded the safety limit", { code: "AA_TOO_MANY_PAGES" });
  return {
    models,
    metadata: {
      provider: "artificial-analysis",
      tier,
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
