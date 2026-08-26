import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, configPath, skillPath, displayHomePath } from "../lib/paths.js";
import { installHostSkills, type HostId } from "../lib/hosts.js";
import type { CliId } from "../adapters/contract.js";
import { explicitGuardMode, hasLegacyCodingModels, loadConfig, patchRawCliProfile, saveConfig } from "../lib/config.js";
import { codexHooksStatus, installCodexHooks, type CodexHooksInstallResult } from "../lib/codex-hooks.js";
import { installClaudeHooks, type ClaudeHooksInstallResult } from "../lib/claude-hooks.js";
import { installGrokHooks, type GrokHooksInstallResult } from "../lib/grok-hooks.js";
import { buildInstallManifest, writeInstallManifest } from "../lib/install-manifest.js";

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
  /** Codex guard result. */
  guard: CodexHooksInstallResult;
  /** Every guard-capable host that Baton installed a hook layer for. */
  guards: Array<
    | ({ host: "codex" } & CodexHooksInstallResult)
    | ({ host: "claude" } & ClaudeHooksInstallResult)
    | ({ host: "grok" } & GrokHooksInstallResult)
  >;
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

  const configExisted = fs.existsSync(destConfig) && !force;
  if (!configExisted) {
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

  const hasLegacyModels = hasLegacyCodingModels(cwd, { env });
  const rawCodexGuardMode = explicitGuardMode(cwd, "codex", { env });
  const cfg = loadConfig(cwd, { env });
  if (cli) {
    // Initializing a named host creates exactly that selected profile. Keep
    // any previously selected labels/limits, but never synthesize profiles
    // for the other registered CLIs or fill limits from host defaults.
    const existing = cfg.cli[cli];
    cfg.cli[cli] = {
      enabled: true,
      runner: existing?.runner || "",
      longctx: existing?.longctx || "",
      coding_models: existing?.coding_models ? [...existing.coding_models] : [],
      guard_mode: cli === "codex" ? (rawCodexGuardMode || "off") : cli === "cursor" ? "off" : (existing?.guard_mode || "enforce"),
      ...(existing?.max_concurrent !== undefined ? { max_concurrent: existing.max_concurrent } : {}),
      ...(existing?.max_depth !== undefined ? { max_depth: existing.max_depth } : {}),
    };
  }
  // An ordinary init must not silently perform the Coding model migration.
  // A selected host is an explicit config operation and may persist the
  // normalized profile; a fresh/forced config is also necessarily new.
  if (!configExisted || (!hasLegacyModels && cli)) saveConfig(cwd, cfg, { env });
  else if (hasLegacyModels && cli) {
    const existed = Boolean(loadConfig(cwd, { env }).cli[cli]);
    patchRawCliProfile(cwd, cli, existed
      ? { enabled: true }
      : {
        enabled: true,
        runner: "",
        longctx: "",
        coding_models: [],
        guard_mode: cli === "codex" || cli === "cursor" ? "off" : "enforce",
      }, { env });
  }

  const hosts = installHostSkills(cwd, { force, env });
  created.push(...hosts.created);
  skipped.push(...hosts.skipped);
  const legacyGuard = codexHooksStatus({ cwd, env });
  const guardMode = rawCodexGuardMode || (legacyGuard.baton_entries > 0 ? "enforce" : "off");
  if (!rawCodexGuardMode && cfg.cli.codex) {
    cfg.cli.codex.guard_mode = guardMode;
    if (hasLegacyModels) patchRawCliProfile(cwd, "codex", { guard_mode: guardMode }, { env });
    else saveConfig(cwd, cfg, { env });
  }
  const guard = installCodexHooks({ cwd, env, guardMode });
  const claudeGuard = installClaudeHooks({ cwd, env });
  const grokGuard = installGrokHooks({ cwd, env });
  const guards: InitProjectResult["guards"] = [
    { host: "codex", ...guard },
    { host: "claude", ...claudeGuard },
    { host: "grok", ...grokGuard },
  ];
  for (const item of guards) {
    if (item.changed) created.push(item.display_path);
  }
  writeInstallManifest(buildInstallManifest(cwd, hosts.tools, env), env);

  return { dir: displayHomePath(dir, { cwd, env }), created, skipped, tools: hosts.tools, guard, guards };
}
