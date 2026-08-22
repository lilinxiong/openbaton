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
import { CLI_IDS, type CliId } from "./cli-models.js";

export const DEFAULT_MAX_CONCURRENT = 4;
export const GROK_HOST_MAX_CONCURRENT = 8;
export const DEFAULT_MAX_DEPTH = 1;

/** Host-native concurrent subagent cap used as Baton's director ceiling. */
export function hostMaxConcurrent(cli: CliId, env: NodeJS.ProcessEnv = process.env): number {
  if (cli !== "grok") return DEFAULT_MAX_CONCURRENT;
  const override = Number(String(env.GROK_MAX_CONCURRENT_SUBAGENTS || "").trim());
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  return GROK_HOST_MAX_CONCURRENT;
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

export interface CliSettings {
  active: CliId;
  codex: CliProfileSettings;
  grok: CliProfileSettings;
}

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
  return {
    director: {
      max_concurrent: DEFAULT_MAX_CONCURRENT,
      max_depth: DEFAULT_MAX_DEPTH,
    },
    cli: {
      active: "codex",
      codex: {
        enabled: false,
        runner: "",
        longctx: "",
        subagent_models: [],
      },
      grok: {
        enabled: false,
        runner: "",
        longctx: "",
        subagent_models: [],
      },
    },
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
  const profile = isUnknownRecord(value) ? value : {};
  const rawRunner = typeof profile.runner === "string" ? profile.runner.trim() : "";
  const rawLongctx = typeof profile.longctx === "string" ? profile.longctx.trim() : "";
  const runner = rawRunner || legacyOps.runner.route;
  const longctx = rawLongctx || legacyOps.longctx.route;
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
  const requested = String(cli.active || "codex").trim();
  const active = (CLI_IDS as readonly string[]).includes(requested) ? requested as CliId : "codex";
  return {
    active,
    codex: normalizeCliProfile(cli.codex, legacyOps),
    grok: normalizeCliProfile(cli.grok, emptyOpsConfig()),
  };
}

export function activeCliProfile(config: Pick<Config, "cli">): CliProfileSettings {
  return config.cli[config.cli.active];
}

export function configuredSubagentModels(config: Pick<Config, "cli">): string[] {
  const profile = activeCliProfile(config);
  return profile.enabled ? [...profile.subagent_models] : [];
}

function serializeConfig(cfg: Config): UnknownRecord {
  return {
    director: {
      max_concurrent: cfg.director.max_concurrent,
      max_depth: cfg.director.max_depth,
      ...(cfg.director.runner ? { runner: cfg.director.runner } : {}),
    },
    cli: {
      active: cfg.cli.active,
      codex: {
        enabled: cfg.cli.codex.enabled,
        runner: cfg.cli.codex.runner,
        longctx: cfg.cli.codex.longctx,
        subagent_models: cfg.cli.codex.subagent_models,
      },
      grok: {
        enabled: cfg.cli.grok.enabled,
        runner: cfg.cli.grok.runner,
        longctx: cfg.cli.grok.longctx,
        subagent_models: cfg.cli.grok.subagent_models,
      },
    },
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
  const active = cli[cli.active];
  ops.runner.route = active.enabled ? active.runner : "";
  ops.longctx.route = active.enabled ? active.longctx : "";
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
