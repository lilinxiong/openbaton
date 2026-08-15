import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonDir, configPath, skillPath } from "../lib/paths.js";
import { installHostSkills } from "../lib/hosts.js";
import { loadConfig } from "../lib/config.js";
import { syncGrokCardAgents } from "../lib/grok-agents.js";

export function initProject(cwd, { force = false, tools } = {}) {
  const dir = batonDir(cwd);
  const created = [];
  const skipped = [];
  fs.mkdirSync(dir, { recursive: true });

  const tmplRoot = packageRoot();
  const configTmpl = path.join(tmplRoot, "templates", "config.toml");
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  const destConfig = configPath(cwd);
  const destSkill = skillPath(cwd);

  if (!fs.existsSync(destConfig) || force) {
    fs.copyFileSync(configTmpl, destConfig);
    created.push(rel(cwd, destConfig));
  } else {
    skipped.push(rel(cwd, destConfig));
  }

  if (!fs.existsSync(destSkill) || force) {
    fs.copyFileSync(skillTmpl, destSkill);
    created.push(rel(cwd, destSkill));
  } else {
    skipped.push(rel(cwd, destSkill));
  }

  const hosts = installHostSkills(cwd, { force, tools });
  created.push(...hosts.created);
  skipped.push(...hosts.skipped);

  if (hosts.tools.includes("grok")) {
    const agents = syncGrokCardAgents(cwd, loadConfig(cwd).models);
    created.push(...agents.created);
  }

  return { dir: rel(cwd, dir), created, skipped, tools: hosts.tools };
}

function rel(cwd, p) {
  return path.relative(cwd, p) || p;
}
