import { cliIds, getCliAdapter } from "../adapters/registry.js";
import type {
  CliAdapterProvider,
  CliId,
  CliModel,
  CliModelCatalog,
} from "../adapters/contract.js";
import {
  cliProfileForHost,
  loadConfig,
  saveConfig,
  DEFAULT_SUBAGENTS,
  MAX_SUBAGENTS,
  validateSubagents,
  type CliProfileSettings,
} from "../lib/config.js";
import { detectInvokingHost } from "../lib/hosts.js";
import {
  createTerminalPrompt,
  isInteractiveIo,
  type PromptChoice,
  type SelectPrompt,
} from "../lib/prompt.js";
import type { WritableLike } from "../types.js";

export interface ConfigCommandOptions {
  cwd: string;
  stdout: WritableLike;
  stderr?: WritableLike;
  stdin?: NodeJS.ReadableStream;
  env?: NodeJS.ProcessEnv;
  adapterProvider?: CliAdapterProvider;
  prompt?: SelectPrompt;
  clis?: CliId[];
}
const modelFlags = [
  "execution-model",
  "implementation-model",
  "investigation-model",
] as const;

function repeated(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === `--${name}`) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`--${name} requires a value`);
      values.push(value);
    }
  return values;
}
function validateArgs(args: string[]): void {
  const values = new Set(["cli", "max-subagents", ...modelFlags]);
  const flags = new Set(["enable", "disable", "json", "test-subagents"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--"))
      throw new Error(`unknown config argument: ${arg}`);
    const key = arg.slice(2);
    if (!values.has(key) && !flags.has(key))
      throw new Error(`unknown option: ${arg}`);
    if (values.has(key)) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
    }
  }
  if (args.includes("--enable") && args.includes("--disable"))
    throw new Error("--enable and --disable are mutually exclusive");
  const counts = repeated(args, "max-subagents");
  if (counts.length > 1) throw new Error("--max-subagents may be supplied once");
  if (counts.length) {
    const count = validateSubagents(Number(counts[0]));
    if (count > DEFAULT_SUBAGENTS && !args.includes("--test-subagents"))
      throw new Error("--max-subagents above 3 requires --test-subagents");
  }
}
function parseCli(value: string, env: NodeJS.ProcessEnv): CliId {
  const id = value.trim().toLowerCase();
  if (cliIds(env).includes(id)) return id;
  throw new Error(`invalid CLI choice: ${value}`);
}
function choices(models: CliModel[]): PromptChoice<string>[] {
  return models.map((model) => ({
    value: model.id,
    label: `${model.display_name} (${model.id})`,
    ...(model.description ? { hint: model.description } : {}),
  }));
}
function parseModels(
  models: CliModel[],
  raw: string[],
  label: string,
): string[] {
  const values = raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.some((value) => value.toLowerCase() === "all"))
    return models.map((model) => model.id);
  if (
    values.length === 1 &&
    ["-", "0", "none"].includes(values[0].toLowerCase())
  )
    return [];
  const selected: string[] = [];
  for (const value of values) {
    const model = models.find((item) => item.id === value);
    if (!model)
      throw new Error(
        `${label} ${value} is not in the ${models.length}-model CLI response`,
      );
    if (!selected.includes(model.id)) selected.push(model.id);
  }
  return selected;
}
function askFor(
  prompt: SelectPrompt | undefined,
  stdin: NodeJS.ReadableStream,
  stdout: WritableLike,
  env: NodeJS.ProcessEnv,
): SelectPrompt {
  if (prompt) return prompt;
  if (isInteractiveIo(stdin, stdout))
    return createTerminalPrompt({ stdin, stdout, env });
  throw new Error(
    "interactive config requires a TTY; pass --cli, model flags, and --enable or --disable",
  );
}
export function cliPromptChoices(
  env: NodeJS.ProcessEnv = process.env,
): PromptChoice<CliId>[] {
  return cliIds(env).map((value) => ({ value, label: value }));
}

async function configure(
  cli: CliId,
  catalog: CliModelCatalog,
  args: string[],
  current: CliProfileSettings,
  ask: () => SelectPrompt,
  interactive: boolean,
  capacity: () => Promise<number>,
): Promise<CliProfileSettings> {
  if (catalog.cli !== cli || (catalog.adapter_id && catalog.adapter_id !== cli))
    throw new Error(`${cli} returned a catalog for a different CLI`);
  const visible = catalog.models.filter((model) => !model.hidden);
  if (!visible.length)
    throw new Error(`${cli} returned no picker-visible models`);
  const selected = async (
    flag: (typeof modelFlags)[number],
    existing: string[],
  ): Promise<string[]> => {
    const supplied = repeated(args, flag);
    if (supplied.length)
      return parseModels(visible, supplied, flag.replace("-", " "));
    if (!interactive) return [...existing];
    return ask().multiSelect({
      message: `Select ${flag.replace("-model", "")} models in priority order`,
      choices: choices(visible),
      initial: existing.filter((id) =>
        visible.some((model) => model.id === id),
      ),
    });
  };
  const execution = await selected(
    "execution-model",
    current.execution_models || [],
  );
  const implementation = await selected(
    "implementation-model",
    current.implementation_models || [],
  );
  const investigation = await selected(
    "investigation-model",
    current.investigation_models || [],
  );
  const max_concurrent_subagents = await capacity();
  const enabled = args.includes("--enable")
    ? true
    : args.includes("--disable")
      ? false
      : interactive
        ? await ask().select({
            message: `Enable this ${cli} configuration?`,
            choices: [
              { value: true, label: "yes" },
              { value: false, label: "no" },
            ],
            initial: current.enabled,
          })
        : current.enabled;
  return {
    enabled,
    max_concurrent_subagents,
    ...(execution.length ? { execution_models: execution } : {}),
    ...(implementation.length ? { implementation_models: implementation } : {}),
    ...(investigation.length ? { investigation_models: investigation } : {}),
  };
}

async function configureCapacity(
  cli: CliId,
  args: string[],
  current: CliProfileSettings,
  interactive: boolean,
  ask: () => SelectPrompt,
  adapter: ReturnType<CliAdapterProvider>,
  options: ConfigCommandOptions,
): Promise<number> {
  const report = (message: string) => (options.stderr || process.stderr).write(`${message}\n`);
  const supplied = repeated(args, "max-subagents");
  const requested = supplied.length ? validateSubagents(Number(supplied[0])) : undefined;
  let test = args.includes("--test-subagents");
  if (!test && requested !== undefined) return requested;
  if (!test && !interactive) return current.max_concurrent_subagents ?? DEFAULT_SUBAGENTS;
  try {
    if (!test) test = await ask().select({
      message: `Test subagent capacity for ${cli}? (uses model calls; up to ${MAX_SUBAGENTS} probes)`,
      choices: [{ value: false, label: "Skip test — use 3" }, { value: true, label: "Test capacity" }],
      initial: false,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "cancelled") throw error;
    report("Subagent test cancelled; using default 3.");
    return DEFAULT_SUBAGENTS;
  }
  if (!test) return DEFAULT_SUBAGENTS;
  if (!adapter.testSubagents) {
    report(`${cli} does not support a capacity test; using default 3 (untested).`);
    return DEFAULT_SUBAGENTS;
  }
  report(`Testing ${cli} in a fresh session, up to ${MAX_SUBAGENTS} subagents. Ctrl-C cancels this test and uses 3.`);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  let result;
  try {
    result = await adapter.testSubagents({ cwd: options.cwd, env: options.env, signal: controller.signal });
    if (controller.signal.aborted) throw new Error("SUBAGENT_TEST_CANCELLED");
    validateSubagents(result.capacity);
    if (result.ceiling_reached !== (result.capacity === MAX_SUBAGENTS)) throw new Error("invalid test ceiling");
  } catch (error) {
    report(`Subagent test inconclusive (${error instanceof Error ? error.message : String(error)}); using default 3 (untested).`);
    return DEFAULT_SUBAGENTS;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
  report(`Tested capacity: ${result.ceiling_reached ? "at least " : ""}${result.capacity}. All probes closed. Applies to this CLI test session.`);
  if (requested !== undefined) {
    if (requested > result.capacity) throw new Error(`--max-subagents must be from 1 to ${result.capacity} (tested capacity)`);
    return requested;
  }
  if (!interactive) return result.capacity;
  try {
    const chosen = await ask().select({
      message: `Select concurrent subagents (1–${result.capacity})`,
      choices: Array.from({ length: result.capacity }, (_, index) => ({ value: index + 1, label: String(index + 1) })),
      initial: Math.min(current.max_concurrent_subagents ?? DEFAULT_SUBAGENTS, result.capacity),
    });
    validateSubagents(chosen);
    if (chosen > result.capacity) throw new Error("selection exceeds tested capacity");
    return chosen;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "cancelled") throw error;
    report("Subagent selection cancelled; using default 3.");
    return DEFAULT_SUBAGENTS;
  }
}

export async function runConfig(
  args: string[],
  options: ConfigCommandOptions,
): Promise<number> {
  validateArgs(args);
  const {
    cwd,
    stdout,
    stdin = process.stdin,
    env = process.env,
    adapterProvider,
    prompt,
    clis: preset,
  } = options;
  const flagged = repeated(args, "cli");
  if (flagged.length > 1) throw new Error("--cli may be supplied once");
  const interactive = !preset?.length && !flagged.length;
  const ask = () => askFor(prompt, stdin, stdout, env);
  let selected: CliId[];
  if (preset?.length) selected = preset;
  else if (flagged.length) selected = [parseCli(flagged[0], env)];
  else {
    let initial: CliId[] = [];
    try {
      const detected = detectInvokingHost(env);
      if (detected) initial = [detected];
    } catch {
      /* select explicitly */
    }
    selected = await ask().multiSelect({
      message: "Select CLI",
      choices: cliPromptChoices(env),
      initial,
      required: true,
    });
  }
  if (!selected.length) throw new Error("select at least one CLI");
  const config = structuredClone(loadConfig(cwd, { env }));
  const discover = adapterProvider || ((cli: CliId) => getCliAdapter(cli, env));
  const profiles: Array<{ cli: CliId; profile: CliProfileSettings }> = [];
  for (const cli of selected) {
    const adapter = discover(cli);
    const catalog = await adapter.discoverModels({ cwd, env });
    const profile = await configure(
      cli,
      catalog,
      args,
      cliProfileForHost(config, cli),
      ask,
      interactive,
      () => configureCapacity(cli, args, cliProfileForHost(config, cli), interactive, ask, adapter, options),
    );
    config.cli[cli] = profile;
    profiles.push({ cli, profile });
  }
  const file = saveConfig(cwd, config, { env });
  const payload =
    selected.length === 1
      ? { cli: profiles[0].cli, ...profiles[0].profile, config: file }
      : { profiles, config: file };
  if (args.includes("--json"))
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    stdout.write(`wrote ${file}\n`);
    for (const { cli, profile } of profiles)
      stdout.write(
        `  ${cli}: ${profile.enabled ? "enabled" : "disabled"}; subagents=${profile.max_concurrent_subagents}; execution=${profile.execution_models?.join(" > ") || "(none)"}; implementation=${profile.implementation_models?.join(" > ") || "(none)"}; investigation=${profile.investigation_models?.join(" > ") || "(none)"}\n`,
      );
  }
  return 0;
}
