import fs from "node:fs";
import path from "node:path";
import { packageRoot, hostHome, displayHomePath } from "./paths.js";
import { listCliAdapters } from "../adapters/registry.js";
import type { ConfigEnvOptions } from "./config.js";
import type { CodedError } from "../types.js";

export { hostHome } from "./paths.js";

export type HostId = ReturnType<typeof listCliAdapters>[number]["host"]["id"];

/** Host ids are the ids declared by the registered CLI adapters. */
export const HOST_IDS = listCliAdapters().map((adapter) => adapter.host.id) as readonly HostId[];

export function isHostId(value: string): value is HostId {
  return (HOST_IDS as readonly string[]).includes(value);
}

export function parseHostId(value: string): HostId {
  const host = String(value || "").trim().toLowerCase();
  if (isHostId(host)) return host;
  throw new Error(`invalid host: ${value || "<empty>"} (expected ${HOST_IDS.join("|")})`);
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
  return listCliAdapters()
    .filter((adapter) => adapter.host.isInvoking?.(env))
    .map((adapter) => adapter.host.id);
}

/** Resolve the invoking host from BATON_HOST or a unique runtime signal. */
export function detectInvokingHost(env: NodeJS.ProcessEnv = process.env): HostId | null {
  const explicit = String(env.BATON_HOST || "").trim().toLowerCase();
  if (explicit) return parseHostId(explicit);
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
  if (fromFlag) return parseHostId(fromFlag);
  const fromEnv = String(env.BATON_HOST || "").trim();
  if (fromEnv) return parseHostId(fromEnv);
  const matches = detectInvokingHosts(env);
  if (matches.length === 1) return matches[0];
  throw hostRequiredError();
}

export function inferHostFromTickets(tickets: Array<{ target_host?: string | null; dispatch_host?: string | null; host?: string | null; selection?: { host?: string | null } | null }>): HostId | null {
  const hosts = new Set<HostId>();
  for (const ticket of tickets) {
    const value = ticket.target_host || ticket.dispatch_host || ticket.host || ticket.selection?.host;
    if (value) hosts.add(parseHostId(String(value)));
  }
  if (hosts.size === 1) return [...hosts][0];
  return null;
}

export const HOST_SKILL_REL: Record<HostId, string> = Object.fromEntries(
  listCliAdapters().map((adapter) => [adapter.host.id, adapter.host.skillPath]),
) as Record<HostId, string>;

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
  return path.join(hostHome(options.env), HOST_SKILL_REL[tool]);
}

export function skillTemplatePath(tool: HostId): string {
  const root = packageRoot();
  const hostTmpl = path.join(root, "templates", "hosts", tool, "SKILL.md");
  if (fs.existsSync(hostTmpl)) return hostTmpl;
  return path.join(root, "SKILL.md");
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
  const hostTools: HostId[] = [...HOST_IDS];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const tool of hostTools) {
    const dest = hostSkillDest(tool, { cwd, env });
    copySkill(skillTemplatePath(tool), dest, { force, cwd, env, created, skipped });
  }
  return { tools: hostTools, created, skipped };
}

export function refreshInstalledHostSkills(cwd: string, options: RefreshHostSkillsOptions = {}): HostRefreshResult {
  const actions: string[] = [];
  for (const tool of HOST_IDS) {
    const dest = hostSkillDest(tool, { cwd, env: options.env });
    if (!fs.existsSync(dest)) continue;
    fs.copyFileSync(skillTemplatePath(tool), dest);
    actions.push(`updated ${shown(dest, { cwd, env: options.env })}`);
  }
  return { actions };
}
