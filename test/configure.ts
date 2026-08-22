import fs from "node:fs";
import type { CliId } from "../src/lib/cli-models.js";
import { configPath } from "../src/lib/paths.js";
import { emptyConfig, loadConfig, saveConfig } from "../src/lib/config.js";

export function configureCli(
  cwd: string,
  env: NodeJS.ProcessEnv,
  cli: CliId,
  models: string[],
  { runner = "", longctx = "", enabled = true }: { runner?: string; longctx?: string; enabled?: boolean } = {},
): void {
  const config = fs.existsSync(configPath(cwd, { env })) ? loadConfig(cwd, { env }) : emptyConfig();
  config.cli.active = cli;
  for (const id of ["codex", "grok"] as const) {
    if (id === cli) continue;
    config.cli[id].enabled = false;
  }
  config.cli[cli] = {
    enabled,
    runner,
    longctx,
    subagent_models: [...new Set([...models, runner, longctx].filter(Boolean))],
  };
  config.ops.runner.route = enabled ? runner : "";
  config.ops.longctx.route = enabled ? longctx : "";
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
