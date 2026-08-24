import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, skillPath, configPath, displayHomePath } from "../lib/paths.js";
import { loadConfig, saveConfig, normalizeConfig } from "../lib/config.js";
import { parseToml } from "../lib/toml.js";
import { refreshInstalledHostSkills } from "../lib/hosts.js";
import { installCodexHooks, type CodexHooksInstallResult } from "../lib/codex-hooks.js";
import { installClaudeHooks, type ClaudeHooksInstallResult } from "../lib/claude-hooks.js";

export interface UpdateProjectOptions {
  forceSkill?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface UpdateProjectResult {
  actions: string[];
  /** Codex guard, retained under its original name for compatibility. */
  guard: CodexHooksInstallResult;
  claudeGuard: ClaudeHooksInstallResult;
}

/**
 * Refresh Baton-owned host files and user-global director/ops settings.
 * Refreshes installed host SKILL copies. Does not install new hosts.
 * Configuration lives in ~/.baton. Never creates project-local Baton config or runtime state.
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
  const defaults = normalizeConfig(tmpl);
  if (!fs.existsSync(destConfig)) {
    fs.copyFileSync(path.join(tmplRoot, "templates", "config.toml"), destConfig);
    actions.push(`wrote ${displayHomePath(destConfig, { cwd, env })} (was missing)`);
  } else {
    const current = loadConfig(cwd, { env });
    const merged = normalizeConfig({
      director: { ...defaults.director, ...current.director },
      cli: current.cli,
      ops: {
        runner: { ...defaults.ops.runner, ...current.ops.runner },
        longctx: { ...defaults.ops.longctx, ...current.ops.longctx },
      },
    });
    saveConfig(cwd, merged, { env });
    actions.push(`merged global director/CLI/ops defaults into ${displayHomePath(destConfig, { cwd, env })} (models come from the selected CLI)`);
  }

  const hosts = refreshInstalledHostSkills(cwd, { env });
  actions.push(...hosts.actions);
  const guard = installCodexHooks({ cwd, env });
  actions.push(`${guard.action} Codex Baton host guard at ${guard.display_path}; trust it from /hooks`);
  const claudeGuard = installClaudeHooks({ cwd, env });
  actions.push(`${claudeGuard.action} Claude Code Baton host guard at ${claudeGuard.display_path}; user settings hooks apply without a trust prompt`);

  return { actions, guard, claudeGuard };
}
