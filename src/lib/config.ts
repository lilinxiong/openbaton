import fs from "node:fs";
import path from "node:path";
import type { CodedError, UnknownRecord } from "../types.js";
import { parseToml, stringifyToml } from "./toml.js";
import { configPath } from "./paths.js";
import {
  emptyOpsConfig,
  LONGCTX_MIN_CONTEXT_DEFAULT,
  normalizeOpsConfig,
  type OpsConfig,
} from "./ops-config.js";

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_DEPTH = 1;

export interface DirectorSettings {
  max_concurrent: number;
  max_depth: number;
  model_selection: boolean;
  runner?: string;
}

export interface Config {
  director: DirectorSettings;
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
      model_selection: false,
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
    model_selection: director.model_selection === true,
  };
  const runner = optionalTrimmedString(director.runner);
  if (runner) settings.runner = runner;
  return settings;
}

function serializeConfig(cfg: Config): UnknownRecord {
  return {
    director: { ...cfg.director },
    ops: {
      runner: {
        route: cfg.ops.runner.route,
        actions: cfg.ops.runner.actions,
      },
      longctx: {
        route: cfg.ops.longctx.route,
        min_context_tokens: cfg.ops.longctx.min_context_tokens || LONGCTX_MIN_CONTEXT_DEFAULT,
        actions: cfg.ops.longctx.actions,
      },
    },
  };
}

export function normalizeConfig(raw: unknown): Config {
  const source = isUnknownRecord(raw) ? raw : {};
  return {
    director: normalizeDirector(source.director),
    ops: normalizeOpsConfig(source.ops),
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
