import fs from "node:fs";
import path from "node:path";
import { hostHome, displayHomePath } from "./paths.js";
import { listCliAdapters, runtimeSkillSource } from "../adapters/registry.js";
import type { ConfigEnvOptions } from "./config.js";
import type { CodedError } from "../types.js";

export { hostHome } from "./paths.js";

export type HostId = ReturnType<typeof listCliAdapters>[number]["host"]["id"];

/** Host ids are the ids declared by the registered CLI adapters. */
export function hostIds(env: NodeJS.ProcessEnv = process.env): readonly HostId[] {
  return listCliAdapters(env).map((adapter) => adapter.host.id) as HostId[];
}

export function isHostId(value: string, env: NodeJS.ProcessEnv = process.env): value is HostId {
  return listCliAdapters(env).some((adapter) => adapter.host.id === value);
}

export function parseHostId(value: string, env: NodeJS.ProcessEnv = process.env): HostId {
  const host = String(value || "").trim().toLowerCase();
  if (isHostId(host, env)) return host;
  throw new Error(`invalid host: ${value || "<empty>"} (expected ${listCliAdapters(env).map((a) => a.id).join("|") || "none"})`);
}

export interface ResolveRuntimeHostOptions extends ConfigEnvOptions {
  cwd: string;
  explicitHost?: string | null;
}

const HOST_REQUIRED_MESSAGE = "HOST_REQUIRED: pass --host or set BATON_HOST";

function hostRequiredError(): CodedError {
  const err = new Error(HOST_REQUIRED_MESSAGE) as CodedError;
  err.code = "HOST_REQUIRED";
  return err;
}

/** Host ids that appear to be the current invoking runtime from environment signals. */
export function detectInvokingHosts(env: NodeJS.ProcessEnv = process.env): HostId[] {
  return listCliAdapters(env)
    .filter((adapter) => adapter.host.isInvoking?.(env))
    .map((adapter) => adapter.host.id);
}

/** Resolve the invoking host from BATON_HOST or a unique runtime signal. */
export function detectInvokingHost(env: NodeJS.ProcessEnv = process.env): HostId | null {
  const explicit = String(env.BATON_HOST || "").trim().toLowerCase();
  if (explicit) return parseHostId(explicit, env);
  const matches = detectInvokingHosts(env);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw hostRequiredError();
  }
  return null;
}

/** Resolve host from --host, BATON_HOST, or a unique runtime signal. Fail closed otherwise. */
export function resolveRuntimeHost(options: ResolveRuntimeHostOptions): HostId {
  const env = options.env || process.env;
  const fromFlag = String(options.explicitHost || "").trim();
  if (fromFlag) return parseHostId(fromFlag, env);
  const fromEnv = String(env.BATON_HOST || "").trim();
  if (fromEnv) return parseHostId(fromEnv, env);
  const matches = detectInvokingHosts(env);
  if (matches.length === 1) return matches[0];
  throw hostRequiredError();
}

export interface HostEnvOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallHostSkillsOptions extends HostEnvOptions {
  force?: boolean;
}

export interface RefreshHostSkillsOptions {
  env?: NodeJS.ProcessEnv;
}

export interface HostFileResult {
  created: string[];
  skipped: string[];
}

export interface HostInstallResult extends HostFileResult {
  tools: HostId[];
}

export interface HostRefreshResult {
  actions: string[];
}

export function hostSkillDest(tool: HostId, options: HostEnvOptions = {}): string {
  const adapter = listCliAdapters(options.env).find((candidate) => candidate.id === tool);
  if (!adapter) throw new Error(`invalid host: ${tool}`);
  return path.join(hostHome(options.env), adapter.host.skillPath);
}

export function skillTemplatePath(tool: HostId, env: NodeJS.ProcessEnv = process.env): string {
  const manifestSource = runtimeSkillSource(tool, env);
  if (!fs.existsSync(manifestSource)) {
    throw new Error(`ADAPTER_RUNTIME_SKILL_MISSING: ${manifestSource}`);
  }
  return manifestSource;
}

function shown(dest: string, options: HostEnvOptions): string {
  return displayHomePath(dest, { cwd: options.cwd, env: options.env });
}

function copySkill(
  src: string,
  dest: string,
  options: HostEnvOptions & { force?: boolean; created: string[]; skipped: string[] },
): boolean {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const label = shown(dest, options);
  if (fs.existsSync(dest) && !options.force) {
    options.skipped.push(label);
    return false;
  }
  fs.copyFileSync(src, dest);
  options.created.push(label);
  return true;
}

export function installHostSkills(cwd: string, options: InstallHostSkillsOptions = {}): HostInstallResult {
  const { force = false, env } = options;
  const hostTools: HostId[] = [...hostIds(env)];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const tool of hostTools) {
    const dest = hostSkillDest(tool, { cwd, env });
    copySkill(skillTemplatePath(tool, env), dest, { force, cwd, env, created, skipped });
  }
  return { tools: hostTools, created, skipped };
}

export function refreshInstalledHostSkills(cwd: string, options: RefreshHostSkillsOptions = {}): HostRefreshResult {
  const actions: string[] = [];
  for (const tool of hostIds(options.env)) {
    const dest = hostSkillDest(tool, { cwd, env: options.env });
    if (!fs.existsSync(dest)) continue;
    fs.copyFileSync(skillTemplatePath(tool, options.env), dest);
    actions.push(`updated ${shown(dest, { cwd, env: options.env })}`);
  }
  return { actions };
}
