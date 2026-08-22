import readline from "node:readline/promises";
import {
  CLI_IDS,
  discoverCliModels,
  type CliId,
  type CliModel,
  type CliModelDiscovery,
} from "../lib/cli-models.js";
import { hostMaxConcurrent, loadConfig, saveConfig } from "../lib/config.js";
import { publishRouteSnapshot } from "../lib/routes.js";
import type { WritableLike } from "../types.js";

export interface ConfigCommandOptions {
  cwd: string;
  stdout: WritableLike;
  stdin?: NodeJS.ReadableStream;
  env?: NodeJS.ProcessEnv;
  discover?: CliModelDiscovery;
  readLine?: () => Promise<string>;
}

function repeated(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function lastFlag(args: string[], name: string): string | undefined {
  const values = repeated(args, name);
  return values.length ? values[values.length - 1].trim() : undefined;
}

function optionalModelFlag(args: string[], name: string): string | undefined {
  const value = lastFlag(args, name);
  return value === "-" ? "" : value;
}

async function defaultReadLine(stdin: NodeJS.ReadableStream, stdout: WritableLike): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout as NodeJS.WritableStream });
  try {
    return await rl.question("> ");
  } finally {
    rl.close();
  }
}

function printClis(stdout: WritableLike): void {
  stdout.write("CLIs\n");
  CLI_IDS.forEach((cli, index) => stdout.write(`  ${index + 1}. ${cli}\n`));
}

function parseCliChoice(value: string): CliId {
  const text = value.trim().toLowerCase();
  const index = Number(text);
  if (Number.isInteger(index) && index >= 1 && index <= CLI_IDS.length) return CLI_IDS[index - 1];
  if ((CLI_IDS as readonly string[]).includes(text)) return text as CliId;
  throw new Error(`invalid CLI choice: ${value}`);
}

function modelLabel(model: CliModel): string {
  return `${model.display_name} (${model.id})${model.description ? ` — ${model.description}` : ""}`;
}

function printModels(stdout: WritableLike, cli: CliId, models: CliModel[]): void {
  stdout.write(`models: ${cli} catalog (picker-visible)\n`);
  models.forEach((model, index) => stdout.write(`  ${index + 1}. ${modelLabel(model)}\n`));
}

function modelByChoice(models: CliModel[], value: string): CliModel | null {
  const text = value.trim();
  if (!text || text === "0" || text === "-") return null;
  const index = Number(text);
  if (Number.isInteger(index) && index >= 1 && index <= models.length) return models[index - 1];
  return models.find((model) => model.id === text) || null;
}

function requireModel(models: CliModel[], value: string, label: string): string {
  if (!value) return "";
  const model = modelByChoice(models, value);
  if (!model) throw new Error(`${label} model ${value} is not in the ${models.length}-model CLI response`);
  return model.id;
}

function selectedModel(models: CliModel[], value: string, label: string): string {
  const text = value.trim();
  if (!text || text === "0" || text === "-") return "";
  return requireModel(models, text, label);
}

function parseModelSet(models: CliModel[], values: string[]): string[] {
  const tokens = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (tokens.some((value) => value.toLowerCase() === "all")) return models.map((model) => model.id);
  if (tokens.length === 1 && ["0", "-", "none"].includes(tokens[0].toLowerCase())) return [];
  const chosen: string[] = [];
  for (const token of tokens) {
    const model = modelByChoice(models, token);
    if (!model) throw new Error(`subagent model ${token} is not in the ${models.length}-model CLI response`);
    if (!chosen.includes(model.id)) chosen.push(model.id);
  }
  return chosen;
}

function parseEnabled(value: string, current: boolean): boolean {
  const text = value.trim().toLowerCase();
  if (!text) return current;
  if (["y", "yes", "1", "on", "true", "enable", "enabled"].includes(text)) return true;
  if (["n", "no", "0", "off", "false", "disable", "disabled"].includes(text)) return false;
  throw new Error(`invalid enabled choice: ${value}`);
}

export async function runConfig(args: string[], {
  cwd,
  stdout,
  stdin = process.stdin,
  env = process.env,
  discover = discoverCliModels,
  readLine,
}: ConfigCommandOptions): Promise<number> {
  if (args[0] === "model-selection") {
    throw new Error("MODEL_SELECTION_REMOVED: Baton now selects automatically from cli.<id>.subagent_models; configure the candidate set with `baton config`");
  }
  const current = loadConfig(cwd, { env });
  const ask = readLine || (() => defaultReadLine(stdin, stdout));

  let cliValue = lastFlag(args, "cli");
  if (cliValue === undefined) {
    printClis(stdout);
    stdout.write("\nSelect CLI:\n");
    cliValue = await ask();
  }
  const cli = parseCliChoice(cliValue);
  const catalog = await discover(cli, { cwd, env });
  if (!catalog.models.length) throw new Error(`${cli} returned no picker-visible models`);
  publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), {
    cli,
    engineVersion: catalog.version,
    providerQuotas: [],
    quotaRefreshError: null,
  });

  stdout.write("\n");
  printModels(stdout, cli, catalog.models);
  const existing = current.cli[cli];

  let runner = optionalModelFlag(args, "runner");
  if (runner === undefined) {
    stdout.write("\nSelect runner (0 = empty; this is a label, not a capability claim):\n");
    runner = selectedModel(catalog.models, await ask(), "runner");
  }
  runner = requireModel(catalog.models, runner, "runner");

  let longctx = optionalModelFlag(args, "longctx");
  if (longctx === undefined) {
    stdout.write("\nSelect longctx (0 = empty; no context-window support is assumed):\n");
    longctx = selectedModel(catalog.models, await ask(), "longctx");
  }
  longctx = requireModel(catalog.models, longctx, "longctx");

  const subagentFlags = repeated(args, "subagent-model");
  let subagentModels: string[];
  if (!subagentFlags.length) {
    stdout.write("\nSelect models callable by subagents (comma-separated indexes/ids, `all`, or 0):\n");
    subagentModels = parseModelSet(catalog.models, [await ask()]);
  } else {
    subagentModels = parseModelSet(catalog.models, subagentFlags);
  }
  // runner and longctx are themselves subagent routes when configured, so the
  // persisted allowlist must truthfully include them.
  for (const model of [runner, longctx]) {
    if (model && !subagentModels.includes(model)) subagentModels.push(model);
  }

  if (args.includes("--enable") && args.includes("--disable")) {
    throw new Error("--enable and --disable are mutually exclusive");
  }
  let enabled: boolean;
  if (args.includes("--enable")) enabled = true;
  else if (args.includes("--disable")) enabled = false;
  else {
    stdout.write(`\nEnable this ${cli} configuration? [y/n] (current: ${existing.enabled ? "on" : "off"}):\n`);
    enabled = parseEnabled(await ask(), existing.enabled);
  }

  current.cli.active = cli;
  current.cli[cli] = { enabled, runner, longctx, subagent_models: subagentModels };
  current.ops.runner.route = enabled ? runner : "";
  current.ops.longctx.route = enabled ? longctx : "";
  current.director.max_concurrent = hostMaxConcurrent(cli, env);
  const file = saveConfig(cwd, current, { env });
  const result = {
    cli,
    enabled,
    runner: runner || null,
    longctx: longctx || null,
    subagent_models: subagentModels,
    max_concurrent: current.director.max_concurrent,
    model_source: `${cli} catalog`,
    config: file,
  };
  if (args.includes("--json")) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    stdout.write(`\nwrote ${file}\n`);
    stdout.write(`  cli: ${cli} (${enabled ? "enabled" : "disabled"})\n`);
    stdout.write(`  runner: ${runner || "(empty; director)"}\n`);
    stdout.write(`  longctx: ${longctx || "(empty; director)"}\n`);
    stdout.write(`  subagent models: ${subagentModels.length ? subagentModels.join(", ") : "(none)"}\n`);
    stdout.write(`  max_concurrent: ${current.director.max_concurrent}\n`);
    stdout.write("  later routing: automatic; no model confirmation UI\n");
  }
  return 0;
}
