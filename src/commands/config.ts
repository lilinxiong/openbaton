import {
  cliIds,
  getCliAdapter,
} from "../adapters/registry.js";
import type {
  CliAdapterProvider,
  CliId,
  CliModel,
  CliModelCatalog,
} from "../adapters/contract.js";
import {
  cliProfileForHost,
  effectiveMaxConcurrentForHost,
  effectiveMaxDepthForHost,
  loadConfig,
  persistableCliMaxConcurrent,
  reportedConcurrentLimit,
  saveConfig,
  type Config,
} from "../lib/config.js";
import { normalizeCliRuntimeCapabilities } from "../adapters/shared.js";
import { detectInvokingHost } from "../lib/hosts.js";
import {
  createTerminalPrompt,
  isInteractiveIo,
  type PromptChoice,
  type SelectPrompt,
} from "../lib/prompt.js";
import { publishRouteSnapshot } from "../lib/routes.js";
import type { WritableLike } from "../types.js";

export interface ConfigCommandOptions {
  cwd: string;
  stdout: WritableLike;
  stdin?: NodeJS.ReadableStream;
  env?: NodeJS.ProcessEnv;
  adapterProvider?: CliAdapterProvider;
  prompt?: SelectPrompt;
  /** Skip the CLI picker and configure these CLIs in order. */
  clis?: CliId[];
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

/** Reject arguments outside the current config grammar before reading state. */
function validateConfigArgs(args: string[]): void {
  const valueFlags = new Set(["cli", "runner", "longctx", "coding-model"]);
  const booleanFlags = new Set(["json"]);
  const allowed = new Set([...valueFlags, ...booleanFlags]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`unknown config argument: ${arg}`);
    const key = arg.slice(2);
    if (!allowed.has(key)) throw new Error(`unknown option: ${arg}`);
    if (valueFlags.has(key)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
    }
  }
}

function lastFlag(args: string[], name: string): string | undefined {
  const values = repeated(args, name);
  return values.length ? values[values.length - 1].trim() : undefined;
}

function optionalModelFlag(args: string[], name: string): string | undefined {
  const value = lastFlag(args, name);
  return value === "-" ? "" : value;
}

function parseCliChoice(value: string, env: NodeJS.ProcessEnv = process.env): CliId {
  const text = value.trim().toLowerCase();
  if (cliIds(env).includes(text)) return text as CliId;
  throw new Error(`invalid CLI choice: ${value}`);
}

function modelLabel(model: CliModel): string {
  return `${model.display_name} (${model.id})`;
}

function modelHint(model: CliModel): string | undefined {
  return model.description || undefined;
}

function modelByChoice(models: CliModel[], value: string): CliModel | null {
  const text = value.trim();
  if (!text || text === "0" || text === "-") return null;
  return models.find((model) => model.id === text) || null;
}

function requireModel(models: CliModel[], value: string, label: string): string {
  if (!value) return "";
  const model = modelByChoice(models, value);
  if (!model) throw new Error(`${label} model ${value} is not in the ${models.length}-model CLI response`);
  return model.id;
}

function parseModelSet(models: CliModel[], values: string[], label = "coding model"): string[] {
  const tokens = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (tokens.some((value) => value.toLowerCase() === "all")) return models.map((model) => model.id);
  if (tokens.length === 1 && ["0", "-", "none"].includes(tokens[0].toLowerCase())) return [];
  const chosen: string[] = [];
  for (const token of tokens) {
    const model = modelByChoice(models, token);
    if (!model) throw new Error(`${label} ${token} is not in the ${models.length}-model CLI response`);
    if (!chosen.includes(model.id)) chosen.push(model.id);
  }
  return chosen;
}

export function cliPromptChoices(env: NodeJS.ProcessEnv = process.env): PromptChoice<CliId>[] {
  return cliIds(env).map((id) => ({ value: id, label: id }));
}

function modelChoices(models: CliModel[]): PromptChoice<string>[] {
  return models.map((model) => ({
    value: model.id,
    label: modelLabel(model),
    hint: modelHint(model),
  }));
}

function optionalModelChoices(models: CliModel[]): PromptChoice<string>[] {
  return [
    { value: "", label: "(missing route blocks classified work)" },
    ...modelChoices(models),
  ];
}

function requirePrompt(
  prompt: SelectPrompt | undefined,
  stdin: NodeJS.ReadableStream,
  stdout: WritableLike,
  env: NodeJS.ProcessEnv,
  missing: string,
): SelectPrompt {
  if (prompt) return prompt;
  if (isInteractiveIo(stdin, stdout)) return createTerminalPrompt({ stdin, stdout, env });
  throw new Error(`interactive config requires a TTY. Pass ${missing} for non-interactive use`);
}

interface CliProfileResult {
  cli: CliId;
  runner: string | null;
  longctx: string | null;
  coding_models: string[];
  /** Active descendants in one root-agent tree; the root is excluded. */
  max_concurrent_subagents: number;
  max_depth: number;
  max_concurrent_subagents_source: "adapter" | "director_policy";
  max_depth_source: "cli" | "director";
  capacity_scope: "root_agent_tree";
  model_source: string;
  config: string;
}

async function configureCliProfile(
  cli: CliId,
  args: string[],
  {
    cwd,
    stdout,
    env,
    current,
    catalog,
    hostLimit,
    ask,
    single,
  }: {
    cwd: string;
    stdout: WritableLike;
    env: NodeJS.ProcessEnv;
    current: Config;
    catalog: CliModelCatalog;
    hostLimit?: number;
    ask: () => SelectPrompt;
    single: boolean;
  },
): Promise<CliProfileResult> {
  if (!catalog.models.length) throw new Error(`${cli} returned no picker-visible models`);
  publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), {
    cli,
    host: cli,
    env,
    engineVersion: catalog.version,
  });

  const existing = cliProfileForHost(current, cli);

  let runner = single ? optionalModelFlag(args, "runner") : undefined;
  if (runner === undefined) {
    runner = await ask().select({
      message: "Select runner (missing route blocks classified mechanical work; label only)",
      choices: optionalModelChoices(catalog.models),
      initial: existing.runner,
    });
  }
  runner = requireModel(catalog.models, runner, "runner");

  let longctx = single ? optionalModelFlag(args, "longctx") : undefined;
  if (longctx === undefined) {
    longctx = await ask().select({
      message: "Select longctx (missing route blocks classified long-context work; label only)",
      choices: optionalModelChoices(catalog.models),
      initial: existing.longctx,
    });
  }
  longctx = requireModel(catalog.models, longctx, "longctx");

  const codingFlags = single ? repeated(args, "coding-model") : [];
  let codingModels: string[];
  if (!codingFlags.length) {
    codingModels = await ask().multiSelect({
      message: "Select Coding models in priority order",
      choices: modelChoices(catalog.models),
      initial: existing.coding_models.filter((id) => catalog.models.some((model) => model.id === id)),
    });
  } else {
    codingModels = parseModelSet(catalog.models, codingFlags);
  }

  const capabilities = normalizeCliRuntimeCapabilities(catalog);
  // Persist catalog > adapter quota > previously reported value; else -1.
  const catalogLimit = reportedConcurrentLimit(capabilities?.max_concurrent_subagents);
  const hostReported = reportedConcurrentLimit(hostLimit);
  const maxConcurrent = persistableCliMaxConcurrent(
    catalogLimit,
    hostReported,
    existing.max_concurrent,
  );
  const maxDepth = capabilities?.max_depth;
  current.cli[cli] = {
    runner,
    longctx,
    coding_models: codingModels,
    max_concurrent: maxConcurrent,
    ...(maxDepth !== undefined ? { max_depth: maxDepth } : {}),
  };
  return {
    cli,
    runner: runner || null,
    longctx: longctx || null,
    coding_models: codingModels,
    max_concurrent_subagents: effectiveMaxConcurrentForHost(current, cli),
    max_depth: effectiveMaxDepthForHost(current, cli),
    max_concurrent_subagents_source: reportedConcurrentLimit(maxConcurrent) !== undefined
      ? "adapter"
      : "director_policy",
    max_depth_source: maxDepth !== undefined ? "cli" : "director",
    capacity_scope: "root_agent_tree",
    model_source: `${cli} catalog`,
    config: "",
  };
}

function writeProfile(stdout: WritableLike, result: CliProfileResult): void {
  stdout.write(`  cli: ${result.cli}\n`);
  stdout.write(`  runner: ${result.runner || "(missing route blocks classified work)"}\n`);
  stdout.write(`  longctx: ${result.longctx || "(missing route blocks classified work)"}\n`);
  stdout.write(`  Coding priority: ${result.coding_models.length ? result.coding_models.join(" > ") : "(none)"}\n`);
  stdout.write(`  max_concurrent_subagents: ${result.max_concurrent_subagents} (${result.max_concurrent_subagents_source}; root-agent tree, root excluded)\n`);
  stdout.write(`  max_depth: ${result.max_depth} (${result.max_depth_source})\n`);
}

export async function runConfig(args: string[], {
  cwd,
  stdout,
  stdin = process.stdin,
  env = process.env,
  adapterProvider,
  prompt,
  clis: presetClis,
}: ConfigCommandOptions): Promise<number> {
  validateConfigArgs(args);
  const current = structuredClone(loadConfig(cwd, { env }));
  const discoverAdapter = adapterProvider || ((cli: CliId) => getCliAdapter(cli, env));
  const ask = (): SelectPrompt => requirePrompt(
    prompt, stdin, stdout, env,
    "--cli, --runner, --longctx, and --coding-model",
  );

  const flaggedCli = lastFlag(args, "cli");
  let initialClis: CliId[] = [];
  if (!presetClis?.length && flaggedCli === undefined) {
    try {
      const detected = detectInvokingHost(env);
      if (detected) initialClis = [detected];
    } catch {
      // Ambiguous runtime hosts: leave the picker unselected.
    }
  }
  const clis = presetClis?.length
    ? presetClis
    : flaggedCli === undefined
      ? await ask().multiSelect({
        message: "Select CLI",
        choices: cliPromptChoices(env),
        initial: initialClis,
        required: true,
      })
      : [parseCliChoice(flaggedCli, env)];
  if (!clis.length) throw new Error("select at least one CLI");

  const single = clis.length === 1;
  const results: CliProfileResult[] = [];
  for (let index = 0; index < clis.length; index += 1) {
    const cli = clis[index];
    const selectedAdapter = discoverAdapter(cli);
    if (!single) stdout.write(`\n── ${cli} (${index + 1}/${clis.length}) ──\n`);
    const catalog = await selectedAdapter.discoverModels({ cwd, env });
    const hostLimit = getCliAdapter(cli, env).host.defaultMaxConcurrent;
    results.push(await configureCliProfile(cli, args, {
      cwd, stdout, env, current, catalog, hostLimit, ask, single,
    }));
  }

  const file = saveConfig(cwd, current, { env });
  for (const result of results) result.config = file;

  const payload = single
    ? { ...results[0], config: file }
    : {
      profiles: results,
      max_concurrent_subagents: current.director.max_concurrent,
      max_concurrent_subagents_source: "director_policy",
      max_depth: current.director.max_depth,
      capacity_scope: "root_agent_tree",
      config: file,
    };
  if (args.includes("--json")) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    stdout.write(`\nwrote ${file}\n`);
    for (const result of results) writeProfile(stdout, result);
    stdout.write(`  director policy (per root-agent tree): max_concurrent_subagents=${current.director.max_concurrent}, max_depth=${current.director.max_depth}\n`);
    stdout.write("  later routing: automatic; no model confirmation UI\n");
  }
  return 0;
}
