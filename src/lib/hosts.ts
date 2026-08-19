import fs from "node:fs";
import path from "node:path";
import { packageRoot, hostHome, displayHomePath } from "./paths.js";

export { hostHome } from "./paths.js";

export const HOST_IDS = ["claude", "cursor", "grok", "codex", "agents"] as const;
export const HOME_HOST_IDS = ["grok", "codex"] as const;

export type HostId = (typeof HOST_IDS)[number];
export type HomeHostId = (typeof HOME_HOST_IDS)[number];

export const HOST_SKILL_REL: Record<HostId, string> = {
  claude: ".claude/skills/baton/SKILL.md",
  cursor: ".cursor/skills/baton/SKILL.md",
  grok: ".grok/skills/baton/SKILL.md",
  codex: ".codex/skills/baton/SKILL.md",
  agents: ".agents/skills/baton/SKILL.md",
};

export const AGENTS_MD = "AGENTS.md";
export const AGENTS_POINTER_MARK = "<!-- baton -->";

export const AGENTS_POINTER = `${AGENTS_POINTER_MARK}
Director: use the baton skill (\`~/.baton/SKILL.md\`) for card-routed host-native spawn.`;

export interface HostEnvOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallHostSkillsOptions extends HostEnvOptions {
  force?: boolean;
  tools?: string | readonly string[];
}

export interface RefreshHostSkillsOptions {
  env?: NodeJS.ProcessEnv;
}

export interface AgentsPointerOptions {
  createIfMissing?: boolean;
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

function isHostId(value: string): value is HostId {
  return (HOST_IDS as readonly string[]).includes(value);
}

export function isHomeHost(tool: string): tool is HomeHostId {
  return (HOME_HOST_IDS as readonly string[]).includes(tool);
}

export function hostSkillDest(tool: string, options: HostEnvOptions = {}): string {
  if (!isHostId(tool)) throw new Error(`unknown host: ${tool}`);
  const relPath = HOST_SKILL_REL[tool];
  if (isHomeHost(tool)) return path.join(hostHome(options.env), relPath);
  return path.join(options.cwd ?? "", relPath);
}

export function normalizeTools(tools?: string | readonly string[] | null): HostId[] {
  if (tools == null) return [...HOST_IDS];
  const list = Array.isArray(tools) ? tools : String(tools).split(",");
  const out: HostId[] = [];
  const unknown: string[] = [];
  for (const raw of list) {
    const id = String(raw || "").trim().toLowerCase();
    if (!id) continue;
    if (!isHostId(id)) unknown.push(id);
    else if (!out.includes(id)) out.push(id);
  }
  if (unknown.length) {
    throw new Error(`unknown --tools: ${unknown.join(", ")}. Valid: ${HOST_IDS.join(", ")}`);
  }
  if (!out.length) {
    throw new Error(`--tools is empty. Valid: ${HOST_IDS.join(", ")}`);
  }
  return out;
}

export function skillTemplatePath(tool: string): string {
  const root = packageRoot();
  const hostTmpl = path.join(root, "templates", "hosts", tool, "SKILL.md");
  if (fs.existsSync(hostTmpl)) return hostTmpl;
  return path.join(root, "SKILL.md");
}

export function agentsTemplatePath(): string {
  return path.join(packageRoot(), "templates", "hosts", "AGENTS.md");
}

export function hasBatonPointer(text: unknown): boolean {
  return /<!--\s*baton\s*-->|\.baton\/SKILL\.md|skills\/baton/i.test(String(text || ""));
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
  const { force = false, tools, env } = options;
  const hostTools = normalizeTools(tools);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const tool of hostTools) {
    const dest = hostSkillDest(tool, { cwd, env });
    copySkill(skillTemplatePath(tool), dest, { force, cwd, env, created, skipped });
  }
  const wantPointer = hostTools.some((tool) => !isHomeHost(tool));
  if (wantPointer) {
    const agents = ensureAgentsPointer(cwd, {
      createIfMissing: hostTools.includes("agents"),
    });
    created.push(...agents.created);
    skipped.push(...agents.skipped);
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
  const agents = ensureAgentsPointer(cwd, { createIfMissing: false });
  for (const file of agents.created) actions.push(`updated ${file}`);
  return { actions };
}

export function ensureAgentsPointer(cwd: string, options: AgentsPointerOptions = {}): HostFileResult {
  const createIfMissing = options.createIfMissing ?? false;
  const dest = path.join(cwd, AGENTS_MD);
  const created: string[] = [];
  const skipped: string[] = [];
  if (fs.existsSync(dest)) {
    const current = fs.readFileSync(dest, "utf8");
    if (hasBatonPointer(current)) {
      skipped.push(path.relative(cwd, dest) || dest);
      return { created, skipped };
    }
    const prefix = current.endsWith("\n") || current.length === 0 ? current : `${current}\n`;
    fs.writeFileSync(dest, `${prefix}\n${AGENTS_POINTER}\n`, "utf8");
    created.push(path.relative(cwd, dest) || dest);
    return { created, skipped };
  }
  if (!createIfMissing) return { created, skipped };
  const tmpl = agentsTemplatePath();
  const body = fs.existsSync(tmpl) ? fs.readFileSync(tmpl, "utf8") : `# Agents\n\n${AGENTS_POINTER}\n`;
  fs.writeFileSync(dest, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  created.push(path.relative(cwd, dest) || dest);
  return { created, skipped };
}
