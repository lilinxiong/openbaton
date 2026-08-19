import fs from "node:fs";
import path from "node:path";
import { parseToml, stringifyToml } from "./toml.js";
import { configPath } from "./paths.js";

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_DEPTH = 1;

export function emptyConfig() {
  return {
    director: {
      max_concurrent: DEFAULT_MAX_CONCURRENT,
      max_depth: DEFAULT_MAX_DEPTH,
    },
    models: [],
  };
}

export function normalizeConfig(raw) {
  const cfg = emptyConfig();
  const director = raw.director && typeof raw.director === "object" ? raw.director : {};
  const max = Number(director.max_concurrent);
  cfg.director.max_concurrent = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_CONCURRENT;
  const depth = Number(director.max_depth);
  cfg.director.max_depth = Number.isFinite(depth) && depth >= 1 ? Math.floor(depth) : DEFAULT_MAX_DEPTH;
  if (typeof director.runner === "string" && director.runner.trim()) {
    cfg.director.runner = director.runner.trim();
  }
  const models = Array.isArray(raw.models) ? raw.models : [];
  cfg.models = models
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      const card = {
        id: String(m.id || "").trim(),
        strengths: String(m.strengths || "").trim(),
      };
      if (typeof m.auth_provider === "string" && m.auth_provider.trim()) {
        card.auth_provider = m.auth_provider.trim();
      }
      if (typeof m.route_id === "string" && m.route_id.trim()) {
        card.route_id = m.route_id.trim();
      }
      if (typeof m.reasoning_effort === "string" && m.reasoning_effort.trim()) {
        card.reasoning_effort = m.reasoning_effort.trim();
      }
      return card;
    })
    .filter((m) => m.id);
  return cfg;
}

export function loadConfig(cwd, { env } = {}) {
  const file = configPath(cwd, { env });
  if (!fs.existsSync(file)) {
    const err = new Error(`baton is not initialized here (missing ${file}). Run: baton init`);
    err.code = "BATON_NOT_INITIALIZED";
    throw err;
  }
  const raw = parseToml(fs.readFileSync(file, "utf8"));
  return normalizeConfig(raw);
}

export function saveConfig(cwd, cfg, { env } = {}) {
  const file = configPath(cwd, { env });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const normalized = normalizeConfig(cfg);
  const out = {
    director: normalized.director,
    models: normalized.models,
  };
  fs.writeFileSync(file, stringifyToml(out), "utf8");
  return file;
}

export function effectiveMaxConcurrent(cfg) {
  return cfg.director.max_concurrent;
}
