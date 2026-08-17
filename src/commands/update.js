import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, skillPath, configPath, displayHomePath } from "../lib/paths.js";
import { loadConfig, saveConfig, normalizeConfig } from "../lib/config.js";
import { parseToml } from "../lib/toml.js";
import { refreshInstalledHostSkills } from "../lib/hosts.js";
import { grokSkillInstalled, syncGrokCardAgents } from "../lib/grok-agents.js";
import { codexSkillInstalled, syncCodexCardAgents } from "../lib/codex-agents.js";

/**
 * Refresh baton-owned files. Never clobber user model cards.
 * Refreshes installed host SKILL copies. Does not install new hosts.
 * Director files live in ~/.baton. Never creates project .baton.
 */
export function updateProject(cwd, { forceSkill = true, env } = {}) {
  const dir = batonHomeDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const tmplRoot = packageRoot();
  const actions = [];

  const destSkill = skillPath(cwd, { env });
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  if (!fs.existsSync(destSkill) || forceSkill) {
    fs.copyFileSync(skillTmpl, destSkill);
    actions.push(`updated ${displayHomePath(destSkill, { cwd, env })}`);
  }

  const destConfig = configPath(cwd, { env });
  const tmpl = parseToml(fs.readFileSync(path.join(tmplRoot, "templates", "config.toml"), "utf8"));
  if (!fs.existsSync(destConfig)) {
    fs.copyFileSync(path.join(tmplRoot, "templates", "config.toml"), destConfig);
    actions.push(`wrote ${displayHomePath(destConfig, { cwd, env })} (was missing)`);
  } else {
    const current = loadConfig(cwd, { env });
    const merged = normalizeConfig({
      director: { ...tmpl.director, ...current.director },
      models: current.models,
    });
    saveConfig(cwd, merged, { env });
    actions.push(`merged director defaults into ${displayHomePath(destConfig, { cwd, env })} (cards kept)`);
  }

  const hosts = refreshInstalledHostSkills(cwd, { env });
  actions.push(...hosts.actions);

  const cards = loadConfig(cwd, { env }).models;
  if (grokSkillInstalled(cwd, { env })) {
    const agents = syncGrokCardAgents(cwd, cards, { env });
    for (const f of agents.created) actions.push(`updated ${f}`);
    for (const f of agents.pruned) actions.push(`removed ${f}`);
  }
  if (codexSkillInstalled(cwd, { env })) {
    const agents = syncCodexCardAgents(cwd, cards, { env });
    for (const f of agents.created) actions.push(`updated ${f}`);
    for (const f of agents.pruned) actions.push(`removed ${f}`);
  }

  return { actions };
}
