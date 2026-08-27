import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, skillPath, configPath, displayHomePath } from "../lib/paths.js";
import { loadConfig, saveConfig, normalizeConfig } from "../lib/config.js";
import { parseToml } from "../lib/toml.js";
import { refreshInstalledHostSkills } from "../lib/hosts.js";
import { buildInstallManifest, writeInstallManifest } from "../lib/install-manifest.js";
import { hostIds } from "../lib/hosts.js";
import { installBundledAdapters } from "../lib/adapter-install.js";

export interface UpdateProjectOptions {
  forceSkill?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface UpdateProjectResult {
  actions: string[];
}

/**
 * Refresh Baton-owned host files and user-global director/CLI settings.
 * Refreshes installed host SKILL copies. Does not install new hosts.
 * Configuration lives in ~/.baton. Never creates project-local Baton config or runtime state.
 */
export function updateProject(cwd: string, options: UpdateProjectOptions = {}): UpdateProjectResult {
  const { forceSkill = true, env } = options;
  const dir = batonHomeDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const tmplRoot = packageRoot();
  const actions: string[] = [];

  const adapters = installBundledAdapters(env);
  actions.push(...adapters.installed, ...adapters.updated, ...adapters.kept, ...adapters.conflicts);

  const destSkill = skillPath(cwd, { env });
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  if (!fs.existsSync(destSkill) || forceSkill) {
    fs.copyFileSync(skillTmpl, destSkill);
    actions.push(`updated ${displayHomePath(destSkill, { cwd, env })}`);
  }

  const destConfig = configPath(cwd, { env });
  const tmpl = parseToml(fs.readFileSync(path.join(tmplRoot, "templates", "config.toml"), "utf8"));
  const defaults = normalizeConfig(tmpl);
  if (!fs.existsSync(destConfig)) {
    fs.copyFileSync(path.join(tmplRoot, "templates", "config.toml"), destConfig);
    actions.push(`wrote ${displayHomePath(destConfig, { cwd, env })} (was missing)`);
  } else {
    const current = loadConfig(cwd, { env });
    const merged = normalizeConfig({
      director: { ...defaults.director, ...current.director },
      cli: current.cli,
    });
    saveConfig(cwd, merged, { env });
    actions.push(`merged global director/CLI defaults into ${displayHomePath(destConfig, { cwd, env })}`);
  }

  const current = loadConfig(cwd, { env });
  saveConfig(cwd, current, { env });
  const hosts = refreshInstalledHostSkills(cwd, { env });
  actions.push(...hosts.actions);
  writeInstallManifest(buildInstallManifest(cwd, hostIds(env), env, adapters.ownership), env);

  return { actions };
}
