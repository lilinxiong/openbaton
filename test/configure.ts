import fs from "node:fs";
import { getCliAdapter } from "../src/adapters/registry.js";
import type { CliAdapterProvider, CliId, CliModelCatalog } from "../src/adapters/contract.js";
import { configPath } from "../src/lib/paths.js";
import { emptyConfig, loadConfig, saveConfig } from "../src/lib/config.js";

/** Inject a concrete selected-host adapter while keeping command tests off the live CLI. */
export function adapterProviderFor(
  source: CliModelCatalog | ((cli: CliId) => CliModelCatalog),
): CliAdapterProvider {
  return (cli) => ({
    ...getCliAdapter(cli),
    discoverModels: async () => structuredClone(typeof source === "function" ? source(cli) : source),
  });
}

export function configureCli(
  cwd: string,
  env: NodeJS.ProcessEnv,
  cli: CliId,
  models: string[],
  { runner = "", longctx = "", enabled = true }: { runner?: string; longctx?: string; enabled?: boolean } = {},
): void {
  const config = fs.existsSync(configPath(cwd, { env })) ? loadConfig(cwd, { env }) : emptyConfig();
  config.cli[cli] = {
    enabled,
    runner,
    longctx,
    coding_models: [...new Set([...models, runner, longctx].filter(Boolean))],
    guard_mode: cli === "claude" || cli === "grok" ? "enforce" : "off",
  };
  saveConfig(cwd, config, { env });
}

export function configureCodex(
  cwd: string,
  env: NodeJS.ProcessEnv,
  models: string[],
  options: { runner?: string; longctx?: string; enabled?: boolean } = {},
): void {
  configureCli(cwd, env, "codex", models, options);
}
