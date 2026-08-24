import fs from "node:fs";
import path from "node:path";
import { packageRoot, hostHome, displayHomePath } from "./paths.js";
import { listCliAdapters } from "../adapters/registry.js";

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
