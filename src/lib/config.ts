import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodedError, UnknownRecord } from "../types.js";
import { parseToml, stringifyToml } from "./toml.js";
import { configPath } from "./paths.js";
import type { CliId } from "../adapters/registry.js";

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_DEPTH = 1;
export const CONFIG_SCHEMA_VERSION = 2;

export interface DirectorSettings {
  max_concurrent: number;
  max_depth: number;
}

export interface CliProfileSettings {
  enabled: boolean;
  runner: string;
  longctx: string;
  /** Ordered Coding routes. Array order is the user's priority. */
  coding_models: string[];
  /** CLI-reported values. Missing fields inherit director limits. */
  max_concurrent?: number;
  max_depth?: number;
}

export type CliProfiles = Partial<{ [K in CliId]: CliProfileSettings }>;

export type CliSettings = CliProfiles;

export interface Config {
  schema_version: number;
  director: DirectorSettings;
  cli: CliSettings;
}

export interface ConfigEnvOptions {
  env?: NodeJS.ProcessEnv;
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyConfig(): Config {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    director: {
      max_concurrent: DEFAULT_MAX_CONCURRENT,
      max_depth: DEFAULT_MAX_DEPTH,
    },
    cli: {},
  };
}

export function emptyCliProfile(): CliProfileSettings {
  return {
    enabled: false,
    runner: "",
    longctx: "",
    coding_models: [],
  };
}

function normalizeDirector(raw: unknown): DirectorSettings {
  const director = isUnknownRecord(raw) ? raw : {};
  const max = Number(director.max_concurrent);
  const depth = Number(director.max_depth);
  const settings: DirectorSettings = {
    max_concurrent: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_CONCURRENT,
    max_depth: Number.isFinite(depth) && depth >= 1 ? Math.floor(depth) : DEFAULT_MAX_DEPTH,
  };
  return settings;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

function normalizeCliProfile(value: unknown): CliProfileSettings {
  const profile = isUnknownRecord(value) ? value : {};
  const rawRunner = typeof profile.runner === "string" ? profile.runner.trim() : "";
  const rawLongctx = typeof profile.longctx === "string" ? profile.longctx.trim() : "";
  const codingModels = stringList(profile.coding_models);
  const maxConcurrent = positiveInteger(profile.max_concurrent);
  const maxDepth = positiveInteger(profile.max_depth);
  return {
    enabled: profile.enabled === true,
    runner: rawRunner,
    longctx: rawLongctx,
    coding_models: codingModels,
    ...(maxConcurrent !== undefined ? { max_concurrent: maxConcurrent } : {}),
    ...(maxDepth !== undefined ? { max_depth: maxDepth } : {}),
  };
}

/**
 * Patch one raw host profile without normalizing the rest of the document.
 */
export function patchRawCliProfile(
  cwd: string,
  host: CliId,
  fields: UnknownRecord,
  options: ConfigEnvOptions = {},
): string {
  const file = configPath(cwd, { env: options.env });
  if (!fs.existsSync(file)) {
    const error = new Error(`baton is not initialized here (missing ${file}). Run: baton init`) as CodedError;
    error.code = "BATON_NOT_INITIALIZED";
    throw error;
  }
  const raw = parseToml(fs.readFileSync(file, "utf8"));
  const cli = isUnknownRecord(raw.cli) ? raw.cli : {};
  const profile = isUnknownRecord(cli[host]) ? cli[host] : {};
  cli[host] = { ...profile, ...fields };
  raw.cli = cli;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, stringifyToml(raw), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return file;
}


function normalizeCli(value: unknown): CliSettings {
  const cli = isUnknownRecord(value) ? value : {};
  const profiles = {} as CliProfiles;
  for (const [id, rawProfile] of Object.entries(cli)) {
    if (!isUnknownRecord(rawProfile)) continue;
    profiles[id] = normalizeCliProfile(rawProfile);
  }
  return profiles;
}

/** Resolve a host-scoped profile. Host is required; there is no configured default CLI. */
export function cliProfileForHost(config: Pick<Config, "cli">, host: CliId): CliProfileSettings {
  return config.cli[host] || emptyCliProfile();
}

export function configuredCodingModelsForHost(config: Pick<Config, "cli">, host: CliId): string[] {
  const profile = cliProfileForHost(config, host);
  return profile.enabled ? [...profile.coding_models] : [];
}

function serializeConfig(cfg: Config): UnknownRecord {
  const profiles: UnknownRecord = {};
  for (const [id, profile] of Object.entries(cfg.cli)) {
    if (!profile) continue;
    profiles[id] = {
      enabled: profile.enabled,
      runner: profile.runner,
      longctx: profile.longctx,
      coding_models: profile.coding_models,
      ...(profile.max_concurrent !== undefined ? { max_concurrent: profile.max_concurrent } : {}),
      ...(profile.max_depth !== undefined ? { max_depth: profile.max_depth } : {}),
    };
  }
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    director: {
      max_concurrent: cfg.director.max_concurrent,
      max_depth: cfg.director.max_depth,
    },
    cli: profiles,
  };
}

export function normalizeConfig(raw: unknown): Config {
  const source = isUnknownRecord(raw) ? raw : {};
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    director: normalizeDirector(source.director),
    cli: normalizeCli(source.cli),
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
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, stringifyToml(serializeConfig(normalizeConfig(cfg))), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return file;
}

/** Use a CLI-reported override when present, otherwise director limits. */
export function effectiveMaxConcurrentForHost(
  cfg: Config,
  host?: CliId,
  _env: NodeJS.ProcessEnv = process.env,
): number {
  if (!host) return cfg.director.max_concurrent;
  return cfg.cli[host]?.max_concurrent ?? cfg.director.max_concurrent;
}

/** Host-specific depth when reported, otherwise director limits. */
export function effectiveMaxDepthForHost(cfg: Config, host?: CliId): number {
  if (!host) return cfg.director.max_depth;
  return cfg.cli[host]?.max_depth ?? cfg.director.max_depth;
}
