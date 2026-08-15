import fs from "node:fs";
import path from "node:path";
import { packageRoot, skillPath, configPath, batonDir } from "../lib/paths.js";
import { loadConfig, saveConfig, normalizeConfig } from "../lib/config.js";
import { parseToml } from "../lib/toml.js";
import { refreshInstalledHostSkills } from "../lib/hosts.js";
import { grokSkillInstalled, syncGrokCardAgents } from "../lib/grok-agents.js";

/**
 * Refresh baton-owned files. Never clobber user model cards.
 * Refreshes installed host SKILL copies. Does not install new hosts.
 */
export function updateProject(cwd, { forceSkill = true } = {}) {
  fs.mkdirSync(batonDir(cwd), { recursive: true });
  const tmplRoot = packageRoot();
  const actions = [];

  const destSkill = skillPath(cwd);
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  if (!fs.existsSync(destSkill) || forceSkill) {
    fs.copyFileSync(skillTmpl, destSkill);
    actions.push(`updated ${path.relative(cwd, destSkill)}`);
  }

  const destConfig = configPath(cwd);
  const tmpl = parseToml(fs.readFileSync(path.join(tmplRoot, "templates", "config.toml"), "utf8"));
  if (!fs.existsSync(destConfig)) {
    fs.copyFileSync(path.join(tmplRoot, "templates", "config.toml"), destConfig);
    actions.push(`wrote ${path.relative(cwd, destConfig)} (was missing)`);
  } else {
    const current = loadConfig(cwd);
    const merged = normalizeConfig({
      director: { ...tmpl.director, ...current.director },
      models: current.models,
    });
    saveConfig(cwd, merged);
    actions.push(`merged director defaults into ${path.relative(cwd, destConfig)} (cards kept)`);
  }

  const hosts = refreshInstalledHostSkills(cwd);
  actions.push(...hosts.actions);

  if (grokSkillInstalled(cwd)) {
    const agents = syncGrokCardAgents(cwd, loadConfig(cwd).models);
    for (const f of agents.created) actions.push(`updated ${f}`);
    for (const f of agents.pruned) actions.push(`removed ${f}`);
  }

  return { actions };
}
