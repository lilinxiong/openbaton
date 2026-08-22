import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, configPath, skillPath, displayHomePath } from "../lib/paths.js";
import { installHostSkills, type HostId } from "../lib/hosts.js";
import type { CliId } from "../lib/cli-models.js";
import { hostMaxConcurrent, loadConfig, saveConfig } from "../lib/config.js";

export interface InitProjectOptions {
  force?: boolean;
  cli?: CliId;
  env?: NodeJS.ProcessEnv;
}

export interface InitProjectResult {
  dir: string;
  created: string[];
  skipped: string[];
  tools: HostId[];
}

export async function initProject(cwd: string, options: InitProjectOptions = {}): Promise<InitProjectResult> {
  const { force = false, cli, env } = options;
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

  const hosts = installHostSkills(cwd, { force, env });
  created.push(...hosts.created);
  skipped.push(...hosts.skipped);

  if (cli) {
    const cfg = loadConfig(cwd, { env });
    cfg.cli.active = cli;
    cfg.director.max_concurrent = hostMaxConcurrent(cli, env);
    saveConfig(cwd, cfg, { env });
  }

  return { dir: displayHomePath(dir, { cwd, env }), created, skipped, tools: hosts.tools };
}
