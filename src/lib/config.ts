import fs from "node:fs";
import path from "node:path";
import type { CodedError, UnknownRecord } from "../types.js";
import { parseToml, stringifyToml } from "./toml.js";
import { configPath } from "./paths.js";
import {
  emptyOpsConfig,
  normalizeOpsConfig,
  type OpsConfig,
} from "./ops-config.js";
import {
  CLI_IDS,
  getCliAdapter,
  listCliAdapters,
  type CliId,
} from "../adapters/registry.js";

export const DEFAULT_MAX_CONCURRENT = getCliAdapter("codex").host.defaultMaxConcurrent;
export const GROK_HOST_MAX_CONCURRENT = getCliAdapter("grok").host.defaultMaxConcurrent;
export const DEFAULT_MAX_DEPTH = 1;

/** Host-native concurrent subagent cap used as Baton's director ceiling. */
export function hostMaxConcurrent(cli: CliId, env: NodeJS.ProcessEnv = process.env): number {
  const adapter = listCliAdapters().find((candidate) => candidate.id === cli);
  return adapter ? adapter.host.maxConcurrent(env) : DEFAULT_MAX_CONCURRENT;
}

export interface DirectorSettings {
  max_concurrent: number;
  max_depth: number;
  runner?: string;
}

export interface CliProfileSettings {
  enabled: boolean;
  runner: string;
  longctx: string;
  subagent_models: string[];
}

export type CliProfiles = { [K in CliId]: CliProfileSettings };

export type CliSettings = CliProfiles;

export interface Config {
  director: DirectorSettings;
  cli: CliSettings;
  ops: OpsConfig;
}

export interface ConfigEnvOptions {
  env?: NodeJS.ProcessEnv;
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyConfig(): Config {
  const cliProfiles = {} as CliProfiles;
  for (const adapter of listCliAdapters()) {
    cliProfiles[adapter.id] = {
      enabled: false,
      runner: "",
      longctx: "",
      subagent_models: [],
    };
  }
  return {
    director: {
      max_concurrent: DEFAULT_MAX_CONCURRENT,
      max_depth: DEFAULT_MAX_DEPTH,
    },
    cli: cliProfiles,
    ops: emptyOpsConfig(),
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeCliProfile(value: unknown, legacyOps: OpsConfig): CliProfileSettings {
  const hasProfile = isUnknownRecord(value);
  const profile = hasProfile ? value : {};
  // Legacy Baton configurations stored the runner/longctx labels under the
  // global ops table.  Migrate that table only when the host profile itself
  // is absent.  An explicitly present profile (including an empty disabled
  // profile) must never inherit another host's routes.
  const fallback = hasProfile ? emptyOpsConfig() : legacyOps;
  const rawRunner = typeof profile.runner === "string" ? profile.runner.trim() : "";
  const rawLongctx = typeof profile.longctx === "string" ? profile.longctx.trim() : "";
  const runner = rawRunner || fallback.runner.route;
  const longctx = rawLongctx || fallback.longctx.route;
  const configured = stringList(profile.subagent_models ?? profile.subagentModels);
  const migrated = [runner, longctx].filter(Boolean);
  const subagentModels = configured.length ? configured : [...new Set(migrated)];
  const hasEnabled = Object.hasOwn(profile, "enabled");
  return {
    enabled: hasEnabled ? profile.enabled === true : configured.length === 0 && migrated.length > 0,
    runner,
    longctx,
    subagent_models: subagentModels,
  };
}

function normalizeCli(value: unknown, legacyOps: OpsConfig): CliSettings {
  const cli = isUnknownRecord(value) ? value : {};
  // Legacy `active` keys are ignored; there is no configured default CLI.
  const profiles = {} as CliProfiles;
  for (const adapter of listCliAdapters()) {
    profiles[adapter.id] = normalizeCliProfile(
      cli[adapter.id],
      adapter.legacyOpsProfile ? legacyOps : emptyOpsConfig(),
    );
  }
  return profiles;
}

/** Resolve a host-scoped profile. Host is required; there is no configured default CLI. */
export function cliProfileForHost(config: Pick<Config, "cli">, host: CliId): CliProfileSettings {
  return config.cli[host];
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
    profiles[adapter.id] = {
      enabled: profile.enabled,
      runner: profile.runner,
      longctx: profile.longctx,
      subagent_models: profile.subagent_models,
    };
  }
  return {
    director: {
      max_concurrent: cfg.director.max_concurrent,
      max_depth: cfg.director.max_depth,
      ...(cfg.director.runner ? { runner: cfg.director.runner } : {}),
    },
    cli: profiles,
    ops: {
      runner: {
        actions: cfg.ops.runner.actions,
      },
      longctx: {
        actions: cfg.ops.longctx.actions,
      },
    },
  };
}

export function normalizeConfig(raw: unknown): Config {
  const source = isUnknownRecord(raw) ? raw : {};
  const ops = normalizeOpsConfig(source.ops);
  const cli = normalizeCli(source.cli, ops);
  return {
    director: normalizeDirector(source.director),
    cli,
    ops,
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

/** Host-specific cap. The old director value remains the compatibility
 * fallback for unqualified/legacy callers. */
export function effectiveMaxConcurrentForHost(
  cfg: Config,
  host?: CliId,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!host) return cfg.director.max_concurrent;
  return hostMaxConcurrent(host, env);
}
