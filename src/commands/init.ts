import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, configPath, skillPath, displayHomePath } from "../lib/paths.js";
import { installHostSkills, type HostId } from "../lib/hosts.js";
import { loadConfig } from "../lib/config.js";
import { syncCodexCardAgents } from "../lib/codex-agents.js";

export interface InitProjectOptions {
  force?: boolean;
  tools?: string | readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface InitProjectResult {
  dir: string;
  created: string[];
  skipped: string[];
  tools: HostId[];
}

export async function initProject(cwd: string, options: InitProjectOptions = {}): Promise<InitProjectResult> {
  const { force = false, tools, env } = options;
  const dir = batonHomeDir(env);
  const created: string[] = [];
  const skipped: string[] = [];
  fs.mkdirSync(dir, { recursive: true });

  const tmplRoot = packageRoot();
  const configTmpl = path.join(tmplRoot, "templates", "config.toml");
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  const destConfig = configPath(cwd, { env });
  const destSkill = skillPath(cwd, { env });

  if (!fs.existsSync(destConfig) || force) {
    fs.copyFileSync(configTmpl, destConfig);
    created.push(displayHomePath(destConfig, { cwd, env }));
  } else {
    skipped.push(displayHomePath(destConfig, { cwd, env }));
  }

  if (!fs.existsSync(destSkill) || force) {
    fs.copyFileSync(skillTmpl, destSkill);
    created.push(displayHomePath(destSkill, { cwd, env }));
  } else {
    skipped.push(displayHomePath(destSkill, { cwd, env }));
  }

  const hosts = installHostSkills(cwd, { force, tools, env });
  created.push(...hosts.created);
  skipped.push(...hosts.skipped);

  const cards = loadConfig(cwd, { env }).models;
  if (hosts.tools.includes("codex")) {
    const agents = syncCodexCardAgents(cwd, cards, { env });
    created.push(...agents.created);
  }

  return { dir: displayHomePath(dir, { cwd, env }), created, skipped, tools: hosts.tools };
}
