import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, skillPath, configPath, displayHomePath } from "../lib/paths.js";
import { loadConfig, saveConfig, normalizeConfig, isUnknownRecord } from "../lib/config.js";
import { parseToml } from "../lib/toml.js";
import { refreshInstalledHostSkills } from "../lib/hosts.js";
import { grokSkillInstalled, syncGrokCardAgents } from "../lib/grok-agents.js";
import { codexSkillInstalled, syncCodexCardAgents } from "../lib/codex-agents.js";

export interface UpdateProjectOptions {
  forceSkill?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface UpdateProjectResult {
  actions: string[];
}

/**
 * Refresh baton-owned files. Never clobber user model cards.
 * Refreshes installed host SKILL copies. Does not install new hosts.
 * Director files live in ~/.baton. Never creates project .baton.
 */
export function updateProject(cwd: string, options: UpdateProjectOptions = {}): UpdateProjectResult {
  const { forceSkill = true, env } = options;
  const dir = batonHomeDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const tmplRoot = packageRoot();
  const actions: string[] = [];

  const destSkill = skillPath(cwd, { env });
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  if (!fs.existsSync(destSkill) || forceSkill) {
    fs.copyFileSync(skillTmpl, destSkill);
    actions.push(`updated ${displayHomePath(destSkill, { cwd, env })}`);
  }

  const destConfig = configPath(cwd, { env });
  const tmpl = parseToml(fs.readFileSync(path.join(tmplRoot, "templates", "config.toml"), "utf8"));
  const tmplDirector = isUnknownRecord(tmpl.director) ? tmpl.director : {};
  const templateCards = normalizeConfig({ models: Array.isArray(tmpl.models) ? tmpl.models : [] }).models;
  if (!fs.existsSync(destConfig)) {
    fs.copyFileSync(path.join(tmplRoot, "templates", "config.toml"), destConfig);
    actions.push(`wrote ${displayHomePath(destConfig, { cwd, env })} (was missing)`);
  } else {
    const current = loadConfig(cwd, { env });
    const enrichedCards = current.models.map((card) => {
      const builtin = templateCards.find((item) => item.id === card.id);
      if (!builtin) return card;
      return {
        ...card,
        auth_provider: card.auth_provider || builtin.auth_provider,
        route_id: card.route_id || builtin.route_id,
        reasoning_effort: card.reasoning_effort || builtin.reasoning_effort,
      };
    });
    const merged = normalizeConfig({
      director: { ...tmplDirector, ...current.director },
      models: enrichedCards,
    });
    saveConfig(cwd, merged, { env });
    actions.push(`merged director defaults and missing builtin routes into ${displayHomePath(destConfig, { cwd, env })} (cards kept; user values preserved)`);
  }

  const hosts = refreshInstalledHostSkills(cwd, { env });
  actions.push(...hosts.actions);

  const cards = loadConfig(cwd, { env }).models;
  if (grokSkillInstalled(cwd, { env })) {
    const agents = syncGrokCardAgents(cwd, cards, { env });
    for (const file of agents.created) actions.push(`updated ${file}`);
    for (const file of agents.pruned) actions.push(`removed ${file}`);
  }
  if (codexSkillInstalled(cwd, { env })) {
    const agents = syncCodexCardAgents(cwd, cards, { env });
    for (const file of agents.created) actions.push(`updated ${file}`);
    for (const file of agents.pruned) actions.push(`removed ${file}`);
  }

  return { actions };
}
