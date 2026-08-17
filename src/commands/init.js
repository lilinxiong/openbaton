import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, configPath, skillPath, displayHomePath } from "../lib/paths.js";
import { installHostSkills } from "../lib/hosts.js";
import { loadConfig } from "../lib/config.js";
import { syncGrokCardAgents } from "../lib/grok-agents.js";
import { syncCodexCardAgents } from "../lib/codex-agents.js";

export function initProject(cwd, { force = false, tools, env } = {}) {
  const dir = batonHomeDir(env);
  const created = [];
  const skipped = [];
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
  if (hosts.tools.includes("grok")) {
    const agents = syncGrokCardAgents(cwd, cards, { env });
    created.push(...agents.created);
  }
  if (hosts.tools.includes("codex")) {
    const agents = syncCodexCardAgents(cwd, cards, { env });
    created.push(...agents.created);
  }

  return { dir: displayHomePath(dir, { cwd, env }), created, skipped, tools: hosts.tools };
}
