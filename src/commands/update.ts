import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, skillPath, configPath, displayHomePath } from "../lib/paths.js";
import { explicitGuardMode, hasLegacyCodingModels, loadConfig, patchRawCliProfile, saveConfig, normalizeConfig } from "../lib/config.js";
import { parseToml } from "../lib/toml.js";
import { refreshInstalledHostSkills } from "../lib/hosts.js";
import { codexHooksStatus, installCodexHooks, type CodexHooksInstallResult } from "../lib/codex-hooks.js";
import { installClaudeHooks, type ClaudeHooksInstallResult } from "../lib/claude-hooks.js";
import { installGrokHooks, type GrokHooksInstallResult } from "../lib/grok-hooks.js";
import { buildInstallManifest, writeInstallManifest } from "../lib/install-manifest.js";
import { HOST_IDS } from "../lib/hosts.js";

export interface UpdateProjectOptions {
  forceSkill?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface UpdateProjectResult {
  actions: string[];
  /** Codex guard result. */
  guard: CodexHooksInstallResult;
  claudeGuard: ClaudeHooksInstallResult;
  grokGuard: GrokHooksInstallResult;
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
  const rawCodexGuardMode = explicitGuardMode(cwd, "codex", { env });
  const actions: string[] = [];

  const destSkill = skillPath(cwd, { env });
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  if (!fs.existsSync(destSkill) || forceSkill) {
    fs.copyFileSync(skillTmpl, destSkill);
    actions.push(`updated ${displayHomePath(destSkill, { cwd, env })}`);
  }

  const destConfig = configPath(cwd, { env });
  const tmpl = parseToml(fs.readFileSync(path.join(tmplRoot, "templates", "config.toml"), "utf8"));
  const defaults = normalizeConfig(tmpl);
  const hasLegacyModels = hasLegacyCodingModels(cwd, { env });
  if (!fs.existsSync(destConfig)) {
    fs.copyFileSync(path.join(tmplRoot, "templates", "config.toml"), destConfig);
    actions.push(`wrote ${displayHomePath(destConfig, { cwd, env })} (was missing)`);
  } else {
    const current = loadConfig(cwd, { env });
    const merged = normalizeConfig({
      director: { ...defaults.director, ...current.director },
      cli: current.cli,
    });
    if (hasLegacyModels) {
      actions.push(`retained legacy model fields in ${displayHomePath(destConfig, { cwd, env })}; run baton config to migrate Coding models`);
    } else {
      saveConfig(cwd, merged, { env });
      actions.push(`merged global director/CLI defaults into ${displayHomePath(destConfig, { cwd, env })} (models come from the selected CLI)`);
    }
  }

  const current = loadConfig(cwd, { env });
  // Do not rewrite a legacy model list merely because `baton update` ran.
  // `baton config` is the explicit migration boundary.
  if (!hasLegacyModels) saveConfig(cwd, current, { env });
  const hosts = refreshInstalledHostSkills(cwd, { env });
  actions.push(...hosts.actions);
  const existingGuard = codexHooksStatus({ cwd, env });
  const guardMode = rawCodexGuardMode || (existingGuard.baton_entries > 0 ? "enforce" : "off");
  if (!rawCodexGuardMode && current.cli.codex) {
    current.cli.codex.guard_mode = guardMode;
    if (hasLegacyModels) patchRawCliProfile(cwd, "codex", { guard_mode: guardMode }, { env });
    else saveConfig(cwd, current, { env });
  }
  const guard = installCodexHooks({ cwd, env, guardMode });
  actions.push(guard.guard_mode === "off"
    ? `${guard.action} Codex Baton host guard at ${guard.display_path}; zero Baton hooks (audit-only, no trust step)`
    : `${guard.action} Codex Baton host guard at ${guard.display_path}; trust it from /hooks`);
  const claudeGuard = installClaudeHooks({ cwd, env });
  actions.push(`${claudeGuard.action} Claude Code Baton host guard at ${claudeGuard.display_path}; user settings hooks apply without a trust prompt`);
  const grokGuard = installGrokHooks({ cwd, env });
  actions.push(`${grokGuard.action} Grok Baton host guard at ${grokGuard.display_path}; global Grok hooks apply without a trust prompt`);
  writeInstallManifest(buildInstallManifest(cwd, HOST_IDS, env), env);

  return { actions, guard, claudeGuard, grokGuard };
}
