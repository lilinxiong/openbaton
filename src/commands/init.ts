import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonHomeDir, configPath, skillPath, displayHomePath } from "../lib/paths.js";
import { installHostSkills, type HostId } from "../lib/hosts.js";
import { parseCliId, type CliId } from "../adapters/registry.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { buildInstallManifest, writeInstallManifest } from "../lib/install/manifest.js";
import { installBundledAdapters } from "../lib/install/adapter-install.js";

export interface InitProjectOptions {
  force?: boolean;
  /** Optional adapter selected for profile initialization. Validated after
   * bundled adapters have landed in the user's adapter namespace. */
  cli?: CliId | string;
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

  // Adapter packages are part of the Baton distribution but are installed in
  // the user's adapter namespace before host discovery resolves their hosts.
  const adapters = installBundledAdapters(env);
  created.push(...adapters.installed, ...adapters.updated);
  skipped.push(...adapters.kept, ...adapters.conflicts);
  const selectedCli = cli === undefined ? undefined : parseCliId(cli, env);

  const tmplRoot = packageRoot();
  const configTmpl = path.join(tmplRoot, "templates", "config.toml");
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  const destConfig = configPath(cwd, { env });
  const destSkill = skillPath(cwd, { env });

  const skippedOwnership: string[] = [];
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
    skippedOwnership.push(destSkill);
  }

  const cfg = loadConfig(cwd, { env });
  if (selectedCli) {
    // Initializing a named host creates exactly that selected profile. Keep
    // any previously selected labels/limits, but never synthesize profiles
    // for the other registered CLIs or fill limits from host defaults.
    const existing = cfg.cli[selectedCli];
    cfg.cli[selectedCli] = {
      runner: existing?.runner || "",
      longctx: existing?.longctx || "",
      coding_models: existing?.coding_models ? [...existing.coding_models] : [],
      ...(existing?.max_concurrent !== undefined ? { max_concurrent: existing.max_concurrent } : {}),
      ...(existing?.max_depth !== undefined ? { max_depth: existing.max_depth } : {}),
    };
  }
  // An ordinary init must not silently rewrite the Coding model profile.
  // A selected host is an explicit config operation and may persist the
  // normalized profile; a fresh/forced config is also necessarily new.
  if (!configExisted || selectedCli) saveConfig(cwd, cfg, { env });

  const hosts = installHostSkills(cwd, { force, env });
  created.push(...hosts.created);
  skipped.push(...hosts.skipped);
  skippedOwnership.push(...hosts.skippedFiles);
  writeInstallManifest(buildInstallManifest(cwd, hosts.tools, env, adapters.ownership, skippedOwnership), env);

  return { dir: displayHomePath(dir, { cwd, env }), created, skipped, tools: hosts.tools };
}
