import fs from "node:fs";
import { configPath } from "../src/lib/paths.js";
import { emptyConfig, loadConfig, saveConfig } from "../src/lib/config.js";

export function configureCodex(
  cwd: string,
  env: NodeJS.ProcessEnv,
  models: string[],
  { runner = "", longctx = "", enabled = true }: { runner?: string; longctx?: string; enabled?: boolean } = {},
): void {
  const config = fs.existsSync(configPath(cwd, { env })) ? loadConfig(cwd, { env }) : emptyConfig();
  config.cli.active = "codex";
  config.cli.codex = {
    enabled,
    runner,
    longctx,
    subagent_models: [...new Set([...models, runner, longctx].filter(Boolean))],
  };
  config.ops.runner.route = enabled ? runner : "";
  config.ops.longctx.route = enabled ? longctx : "";
  saveConfig(cwd, config, { env });
}
