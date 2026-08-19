import fs from "node:fs";
import path from "node:path";
import type { CodedError, DirectorConfig, ModelCard, UnknownRecord } from "../types.js";
import { parseToml, stringifyToml } from "./toml.js";
import { configPath } from "./paths.js";

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_DEPTH = 1;

export type Config = DirectorConfig;
export type Card = ModelCard;

export interface DirectorSettings {
  max_concurrent: number;
  max_depth: number;
  runner?: string;
}

export interface ConfigEnvOptions {
  env?: NodeJS.ProcessEnv;
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyConfig(): Config {
  return {
    director: {
      max_concurrent: DEFAULT_MAX_CONCURRENT,
      max_depth: DEFAULT_MAX_DEPTH,
    },
    models: [],
  };
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeDirector(raw: unknown): DirectorSettings {
  const director = isUnknownRecord(raw) ? raw : {};
  const max = Number(director.max_concurrent);
  const depth = Number(director.max_depth);
  const settings: DirectorSettings = {
    max_concurrent: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_CONCURRENT,
    max_depth: Number.isFinite(depth) && depth >= 1 ? Math.floor(depth) : DEFAULT_MAX_DEPTH,
  };
  const runner = optionalTrimmedString(director.runner);
  if (runner) settings.runner = runner;
  return settings;
}

function normalizeCard(raw: unknown): Card | null {
  if (!isUnknownRecord(raw)) return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const card: Card = {
    id,
    strengths: String(raw.strengths || "").trim(),
  };
  const routeId = optionalTrimmedString(raw.route_id);
  const reasoningEffort = optionalTrimmedString(raw.reasoning_effort);
  if (routeId) card.route_id = routeId;
  if (reasoningEffort) card.reasoning_effort = reasoningEffort;
  if (typeof raw.enabled === "boolean") card.enabled = raw.enabled;
  return card;
}

function serializeConfig(cfg: Config): UnknownRecord {
  return {
    director: { ...cfg.director },
    models: cfg.models.map((card) => {
      const row: UnknownRecord = {
        id: card.id,
        strengths: card.strengths,
      };
      if (card.route_id) row.route_id = card.route_id;
      if (card.reasoning_effort) row.reasoning_effort = card.reasoning_effort;
      if (card.enabled !== undefined) row.enabled = card.enabled;
      return row;
    }),
  };
}

export function normalizeConfig(raw: unknown): Config {
  const source = isUnknownRecord(raw) ? raw : {};
  return {
    director: normalizeDirector(source.director),
    models: Array.isArray(source.models)
      ? source.models.map(normalizeCard).filter((card): card is Card => card !== null)
      : [],
  };
}

export function loadConfig(cwd: string, options: ConfigEnvOptions = {}): Config {
  const file = configPath(cwd, { env: options.env });
  if (!fs.existsSync(file)) {
    const err = new Error(`baton is not initialized here (missing ${file}). Run: baton init`) as CodedError;
    err.code = "BATON_NOT_INITIALIZED";
    throw err;
  }
  return normalizeConfig(parseToml(fs.readFileSync(file, "utf8")));
}

export function saveConfig(cwd: string, cfg: unknown, options: ConfigEnvOptions = {}): string {
  const file = configPath(cwd, { env: options.env });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyToml(serializeConfig(normalizeConfig(cfg))), "utf8");
  return file;
}

export function effectiveMaxConcurrent(cfg: Config): number {
  return cfg.director.max_concurrent;
}
