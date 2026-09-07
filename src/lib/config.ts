import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodedError, UnknownRecord } from "../types.js";
import type { CliId } from "../adapters/registry.js";
import { configPath } from "./paths.js";
import { parseToml, stringifyToml } from "./toml.js";

export const CONFIG_SCHEMA_VERSION = 4;
export interface CliProfileSettings {
  enabled: boolean;
  execution_models?: string[];
  implementation_models?: string[];
  investigation_models?: string[];
}
export type CliProfiles = Partial<Record<CliId, CliProfileSettings>>;
export interface Config {
  schema_version: number;
  cli: CliProfiles;
}
export interface ConfigEnvOptions {
  env?: NodeJS.ProcessEnv;
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function emptyConfig(): Config {
  return { schema_version: CONFIG_SCHEMA_VERSION, cli: {} };
}
export function emptyCliProfile(): CliProfileSettings {
  return { enabled: false };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.map((item) => String(item || "").trim()).filter(Boolean),
        ),
      ]
    : [];
}
function normalizeCliProfile(value: unknown): CliProfileSettings {
  const profile = isUnknownRecord(value) ? value : {};
  const optional = (
    name: "execution_models" | "implementation_models" | "investigation_models",
  ) => {
    const models = stringList(profile[name]);
    return models.length ? { [name]: models } : {};
  };
  return {
    enabled: profile.enabled === true,
    ...optional("execution_models"),
    ...optional("implementation_models"),
    ...optional("investigation_models"),
  };
}
export function normalizeConfig(raw: unknown): Config {
  const source = isUnknownRecord(raw) ? raw : {};
  const cli = isUnknownRecord(source.cli) ? source.cli : {};
  const profiles: CliProfiles = {};
  for (const [id, value] of Object.entries(cli))
    if (isUnknownRecord(value)) profiles[id] = normalizeCliProfile(value);
  return { schema_version: CONFIG_SCHEMA_VERSION, cli: profiles };
}
export function cliProfileForHost(
  config: Pick<Config, "cli">,
  host: CliId,
): CliProfileSettings {
  return config.cli[host] || emptyCliProfile();
}
function serializeConfig(config: Config): UnknownRecord {
  const cli: UnknownRecord = {};
  for (const [id, profile] of Object.entries(config.cli))
    if (profile)
      cli[id] = {
        enabled: profile.enabled,
        ...(profile.execution_models?.length
          ? { execution_models: profile.execution_models }
          : {}),
        ...(profile.implementation_models?.length
          ? { implementation_models: profile.implementation_models }
          : {}),
        ...(profile.investigation_models?.length
          ? { investigation_models: profile.investigation_models }
          : {}),
      };
  return { schema_version: CONFIG_SCHEMA_VERSION, cli };
}
export function loadConfig(
  cwd: string,
  options: ConfigEnvOptions = {},
): Config {
  const file = configPath(cwd, { env: options.env });
  if (!fs.existsSync(file)) {
    const error = new Error(
      `baton is not initialized here (missing ${file}). Run: baton init`,
    ) as CodedError;
    error.code = "BATON_NOT_INITIALIZED";
    throw error;
  }
  return normalizeConfig(parseToml(fs.readFileSync(file, "utf8")));
}
export function saveConfig(
  cwd: string,
  config: unknown,
  options: ConfigEnvOptions = {},
): string {
  const file = configPath(cwd, { env: options.env });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(
      temporary,
      stringifyToml(serializeConfig(normalizeConfig(config))),
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return file;
}
