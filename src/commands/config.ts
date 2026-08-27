import {
  CLI_IDS,
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
import type { CodedError, WritableLike } from "../types.js";

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

function lastFlag(args: string[], name: string): string | undefined {
  const values = repeated(args, name);
  return values.length ? values[values.length - 1].trim() : undefined;
}

function optionalModelFlag(args: string[], name: string): string | undefined {
  const value = lastFlag(args, name);
  return value === "-" ? "" : value;
}

function parseCliChoice(value: string): CliId {
  const text = value.trim().toLowerCase();
  if ((CLI_IDS as readonly string[]).includes(text)) return text as CliId;
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

export function cliPromptChoices(): PromptChoice<CliId>[] {
  return CLI_IDS.map((id) => ({ value: id, label: id }));
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
  enabled: boolean;
  runner: string | null;
  longctx: string | null;
  coding_models: string[];
  max_concurrent: number;
  max_depth: number;
  max_concurrent_source: "cli" | "director";
  max_depth_source: "cli" | "director";
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
    ask,
    single,
  }: {
    cwd: string;
    stdout: WritableLike;
    env: NodeJS.ProcessEnv;
    current: Config;
    catalog: CliModelCatalog;
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
    providerQuotas: [],
    quotaRefreshError: null,
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

  if (args.includes("--enable") && args.includes("--disable")) {
    throw new Error("--enable and --disable are mutually exclusive");
  }
  let enabled: boolean;
  if (args.includes("--enable")) enabled = true;
  else if (args.includes("--disable")) enabled = false;
  else {
    enabled = await ask().select({
      message: `Enable this ${cli} configuration?`,
      choices: [
        { value: true, label: "yes" },
        { value: false, label: "no" },
      ],
      initial: existing.enabled || existing.coding_models.length === 0,
    });
  }

  const capabilities = normalizeCliRuntimeCapabilities(catalog);
  const maxConcurrent = capabilities?.max_concurrent;
  const maxDepth = capabilities?.max_depth;
  current.cli[cli] = {
    enabled,
    runner,
    longctx,
    coding_models: codingModels,
    ...(maxConcurrent !== undefined ? { max_concurrent: maxConcurrent } : {}),
    ...(maxDepth !== undefined ? { max_depth: maxDepth } : {}),
  };
  return {
    cli,
    enabled,
    runner: runner || null,
    longctx: longctx || null,
    coding_models: codingModels,
    max_concurrent: effectiveMaxConcurrentForHost(current, cli),
    max_depth: effectiveMaxDepthForHost(current, cli),
    max_concurrent_source: maxConcurrent !== undefined ? "cli" : "director",
    max_depth_source: maxDepth !== undefined ? "cli" : "director",
    model_source: `${cli} catalog`,
    config: "",
  };
}

function writeProfile(stdout: WritableLike, result: CliProfileResult): void {
  stdout.write(`  cli: ${result.cli} (${result.enabled ? "enabled" : "disabled"})\n`);
  stdout.write(`  runner: ${result.runner || "(missing route blocks classified work)"}\n`);
  stdout.write(`  longctx: ${result.longctx || "(missing route blocks classified work)"}\n`);
  stdout.write(`  Coding priority: ${result.coding_models.length ? result.coding_models.join(" > ") : "(none)"}\n`);
  stdout.write(`  max_concurrent: ${result.max_concurrent} (${result.max_concurrent_source})\n`);
  stdout.write(`  max_depth: ${result.max_depth} (${result.max_depth_source})\n`);
}

export async function runConfig(args: string[], {
  cwd,
  stdout,
  stdin = process.stdin,
  env = process.env,
  adapterProvider = getCliAdapter,
  prompt,
  clis: presetClis,
}: ConfigCommandOptions): Promise<number> {
  // Reject the removed spelling before loading or writing anything so a
  // failed migration is always atomic from the user's perspective.
  if (args.includes("--subagent-model")) {
    const error = new Error("LEGACY_FLAG_REMOVED: use --coding-model; Coding models are an ordered priority list") as CodedError;
    error.code = "LEGACY_FLAG_REMOVED";
    throw error;
  }
  if (args[0] === "model-selection") {
    throw new Error("MODEL_SELECTION_REMOVED: Baton now selects automatically from cli.<id>.coding_models; configure the candidate set with `baton config`");
  }
  const current = structuredClone(loadConfig(cwd, { env }));
  const ask = (): SelectPrompt => requirePrompt(
    prompt, stdin, stdout, env,
    "--cli, --runner, --longctx, --coding-model, and --enable|--disable",
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
        choices: cliPromptChoices(),
        initial: initialClis,
        required: true,
      })
      : [parseCliChoice(flaggedCli)];
  if (!clis.length) throw new Error("select at least one CLI");

  const single = clis.length === 1;
  const results: CliProfileResult[] = [];
  for (let index = 0; index < clis.length; index += 1) {
    const cli = clis[index];
    if (!single) stdout.write(`\n── ${cli} (${index + 1}/${clis.length}) ──\n`);
    const catalog = await adapterProvider(cli).discoverModels({ cwd, env });
    results.push(await configureCliProfile(cli, args, {
      cwd, stdout, env, current, catalog, ask, single,
    }));
  }

  // Persist only the selected profiles; do not write a global active CLI or
  // rewrite director.max_concurrent to the last configured host's cap.
  // Discovery, validation, and every prompt above operate on this in-memory
  // copy. A multi-CLI failure therefore leaves the previous config bytes and
  // legacy fields untouched. This is the sole config write for the command.
  const file = saveConfig(cwd, current, { env });
  for (const result of results) result.config = file;

  const payload = single
    ? { ...results[0], config: file }
    : {
      profiles: results,
      max_concurrent: current.director.max_concurrent,
      max_depth: current.director.max_depth,
      config: file,
    };
  if (args.includes("--json")) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    stdout.write(`\nwrote ${file}\n`);
    for (const result of results) writeProfile(stdout, result);
    stdout.write(`  director fallback: max_concurrent=${current.director.max_concurrent}, max_depth=${current.director.max_depth}\n`);
    stdout.write("  later routing: automatic; no model confirmation UI\n");
  }
  return 0;
}
