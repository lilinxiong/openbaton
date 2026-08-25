import fs from "node:fs";
import path from "node:path";
import type { CodedError, UnknownRecord } from "../types.js";
import { parseToml, stringifyToml } from "./toml.js";
import { configPath } from "./paths.js";
import {
  CLI_IDS,
  getCliAdapter,
  listCliAdapters,
  type CliId,
} from "../adapters/registry.js";

export const DEFAULT_MAX_CONCURRENT = 4;
export const GROK_HOST_MAX_CONCURRENT = getCliAdapter("grok").host.defaultMaxConcurrent;
export const DEFAULT_MAX_DEPTH = 1;

/** Adapter-declared host fact retained for diagnostics. */
export function hostMaxConcurrent(cli: CliId, env: NodeJS.ProcessEnv = process.env): number {
  const adapter = listCliAdapters().find((candidate) => candidate.id === cli);
  return adapter ? adapter.host.maxConcurrent(env) : DEFAULT_MAX_CONCURRENT;
}

export interface DirectorSettings {
  max_concurrent: number;
  max_depth: number;
}

export interface CliProfileSettings {
  enabled: boolean;
  runner: string;
  longctx: string;
  subagent_models: string[];
  /** CLI-reported values. Missing fields inherit the director fallback. */
  max_concurrent?: number;
  max_depth?: number;
}

export type CliProfiles = Partial<{ [K in CliId]: CliProfileSettings }>;

export type CliSettings = CliProfiles;

export interface Config {
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
    subagent_models: [],
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
  const subagentModels = stringList(profile.subagent_models);
  const maxConcurrent = positiveInteger(profile.max_concurrent);
  const maxDepth = positiveInteger(profile.max_depth);
  return {
    enabled: profile.enabled === true,
    runner: rawRunner,
    longctx: rawLongctx,
    subagent_models: subagentModels,
    ...(maxConcurrent !== undefined ? { max_concurrent: maxConcurrent } : {}),
    ...(maxDepth !== undefined ? { max_depth: maxDepth } : {}),
  };
}

function normalizeCli(value: unknown): CliSettings {
  const cli = isUnknownRecord(value) ? value : {};
  const profiles = {} as CliProfiles;
  for (const adapter of listCliAdapters()) {
    const rawProfile = cli[adapter.id];
    if (!isUnknownRecord(rawProfile)) continue;
    profiles[adapter.id] = normalizeCliProfile(rawProfile);
  }
  return profiles;
}

/** Resolve a host-scoped profile. Host is required; there is no configured default CLI. */
export function cliProfileForHost(config: Pick<Config, "cli">, host: CliId): CliProfileSettings {
  return config.cli[host] || emptyCliProfile();
}

export function resolveCliHost(host: string): CliId {
  const value = String(host || "").trim().toLowerCase();
  if (!(CLI_IDS as readonly string[]).includes(value)) {
    throw new Error(`invalid host: ${host || "<empty>"} (expected ${CLI_IDS.join("|")})`);
  }
  return value as CliId;
}

export function configuredSubagentModelsForHost(config: Pick<Config, "cli">, host: CliId): string[] {
  const profile = cliProfileForHost(config, host);
  return profile.enabled ? [...profile.subagent_models] : [];
}

export function enabledForHost(config: Pick<Config, "cli">, host: CliId): boolean {
  return cliProfileForHost(config, host).enabled;
}

function serializeConfig(cfg: Config): UnknownRecord {
  const profiles: UnknownRecord = {};
  for (const adapter of listCliAdapters()) {
    const profile = cfg.cli[adapter.id];
    if (!profile) continue;
    profiles[adapter.id] = {
      enabled: profile.enabled,
      runner: profile.runner,
      longctx: profile.longctx,
      subagent_models: profile.subagent_models,
      ...(profile.max_concurrent !== undefined ? { max_concurrent: profile.max_concurrent } : {}),
      ...(profile.max_depth !== undefined ? { max_depth: profile.max_depth } : {}),
    };
  }
  return {
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
  fs.writeFileSync(file, stringifyToml(serializeConfig(normalizeConfig(cfg))), "utf8");
  return file;
}

export function effectiveMaxConcurrent(cfg: Config): number {
  return cfg.director.max_concurrent;
}

/** Use a CLI-reported override when present, otherwise the director fallback. */
export function effectiveMaxConcurrentForHost(
  cfg: Config,
  host?: CliId,
  _env: NodeJS.ProcessEnv = process.env,
): number {
  if (!host) return cfg.director.max_concurrent;
  return cfg.cli[host]?.max_concurrent ?? cfg.director.max_concurrent;
}

/** Host-specific depth when reported, otherwise the director fallback. */
export function effectiveMaxDepthForHost(cfg: Config, host?: CliId): number {
  if (!host) return cfg.director.max_depth;
  return cfg.cli[host]?.max_depth ?? cfg.director.max_depth;
}
