import fs from "node:fs";
import path from "node:path";
import { createCliAdapterRegistrySnapshot, getCliAdapter, type CliAdapterProvider, type CliId } from "./adapters/registry.js";
import { runConfig } from "./commands/config.js";
import { runHost } from "./commands/host.js";
import { initProject } from "./commands/init.js";
import { runUninstall } from "./commands/uninstall.js";
import { updateProject } from "./commands/update.js";
import { prepareBrief, type WorkerBrief } from "./lib/brief.js";
import {
  appendNativeResult,
  recentNativeResults,
  summarizeNativeResult,
  resolveNativeHost,
  selectNativeModel,
  selectNativeModels,
  type NativeResultStatus,
  type WorkMode,
} from "./lib/native.js";
import { summarizeObservations } from "./lib/observation.js";
import { mergeSelection, parseSpawnRequest, type SpawnRequest } from "./lib/spawn-request.js";
import type { SelectPrompt } from "./lib/prompt.js";
import type { WritableLike } from "./types.js";

interface RunOptions {
  cwd?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: NodeJS.ReadableStream | string;
  env?: NodeJS.ProcessEnv;
  adapterProvider?: CliAdapterProvider;
  prompt?: SelectPrompt;
}

type Flags = Record<string, string | boolean | Array<string | boolean>>;

export const VERSION = "2.0.1";

const HELP = `baton — host-native subagent selection

Usage:
  baton init [--force] [--cli HOST]
  baton update
  baton config [configuration flags]
  baton host detect [--json]
  baton uninstall [--host HOST] [--dry-run] [--clean]
  baton models [--host HOST] [--json]
  baton match [--host HOST] [--work-mode execution|implementation|investigation]
              [--model ID] [--effort LEVEL] [--context-tokens N]
              [--unavailable-model ID ...] [--service-tier T] [--json]
  baton spawn (--brief FILE | --briefs FILE) [same selection flags]
              [--brief-budget-chars N] [--json]
  baton record --host HOST --handle H --model ID
               --status completed|blocked|failed --text TEXT [--json]
  baton status [--host HOST] [--limit N | --handle H] [--full] [--json]
  baton observe --file FILE [--file FILE ...] [--json]
  baton help | --help | -h
  baton version | --version | -v
`;

function parseArgs(args: string[], values: readonly string[], booleans: readonly string[] = []): Flags {
  const valueSet = new Set(values);
  const booleanSet = new Set(booleans);
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    if (!valueSet.has(key) && !booleanSet.has(key)) throw new Error(`unknown option: ${arg}`);
    let value: string | boolean = true;
    if (!booleanSet.has(key)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      value = next;
      index += 1;
    }
    const prior = flags[key];
    flags[key] = prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
  }
  return flags;
}

function one(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  const last = Array.isArray(value) ? value.at(-1) : value;
  return typeof last === "string" ? last : undefined;
}

function many(flags: Flags, name: string): string[] {
  const value = flags[name];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
}

function required(flags: Flags, name: string): string {
  const value = one(flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parseWorkMode(value: string | undefined): WorkMode | undefined {
  if (value === undefined) return undefined;
  if (value === "execution" || value === "implementation" || value === "investigation") return value;
  throw new Error("--work-mode must be execution, implementation, or investigation");
}

function parseContextTokens(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--context-tokens must be a positive integer");
  return parsed;
}

function parseBriefBudgetChars(value: string | undefined): number {
  if (value === undefined) return 12_000;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--brief-budget-chars must be a positive integer");
  return parsed;
}

const SELECTION_VALUES = ["host", "work-mode", "model", "effort", "context-tokens", "unavailable-model", "service-tier"];

function selectionInput(flags: Flags, cwd: string, env: NodeJS.ProcessEnv, adapterProvider?: CliAdapterProvider) {
  return {
    cwd,
    env,
    host: one(flags, "host"),
    workMode: parseWorkMode(one(flags, "work-mode")),
    model: one(flags, "model"),
    effort: one(flags, "effort"),
    contextTokens: parseContextTokens(one(flags, "context-tokens")),
    unavailableModels: many(flags, "unavailable-model"),
    serviceTier: one(flags, "service-tier"),
    adapterProvider,
  };
}

function output(stdout: WritableLike, value: unknown, json: boolean, lines: string[]): void {
  stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${lines.join("\n")}\n`);
}

function readSpawnBriefs(flags: Flags): SpawnRequest[] {
  const briefFile = one(flags, "brief");
  const briefsFile = one(flags, "briefs");
  if (briefFile && briefsFile) throw new Error("--brief and --briefs are mutually exclusive");
  if (!briefFile && !briefsFile) throw new Error("--brief or --briefs is required");
  const parsed = JSON.parse(fs.readFileSync(briefFile || briefsFile!, "utf8"));
  if (briefFile) return [parseSpawnRequest(parsed)];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("WORKER_BRIEFS_INVALID: briefs must be a non-empty JSON array");
  }
  if (parsed.length > 128) throw new Error("WORKER_BRIEFS_INVALID: briefs must contain at most 128 items");
  return parsed.map(parseSpawnRequest);
}

function handoffPayload(
  brief: WorkerBrief,
  selected: Awaited<ReturnType<typeof selectNativeModel>>,
  prepared: ReturnType<typeof prepareBrief>,
) {
  return {
    host: selected.host,
    model_id: selected.model_id,
    ...(selected.reasoning_effort ? { reasoning_effort: selected.reasoning_effort } : {}),
    ...(selected.service_tier ? { service_tier: selected.service_tier } : {}),
    prompt: prepared.prompt,
    fork_context: false,
    scope: brief.scope,
    mode: brief.mode,
    spawned: false,
    work_mode: selected.work_mode,
    ...(selected.context_tokens === undefined ? {} : { context_tokens: selected.context_tokens, context_capacity: selected.context_capacity }),
    ...(selected.disclosures.length ? { disclosures: selected.disclosures } : {}),
    ...(prepared.diagnostics ? { brief_diagnostics: prepared.diagnostics } : {}),
  };
}

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const cwd = options.cwd || process.cwd();
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const env = options.env || process.env;
  const stdin = typeof options.stdin === "string" ? process.stdin : options.stdin || process.stdin;
  const [command = "help", ...args] = argv;
  try {
    if (["help", "--help", "-h"].includes(command)) {
      if (args.length) throw new Error(`unknown argument: ${args[0]}`);
      stdout.write(HELP);
      return 0;
    }
    if (["version", "--version", "-v"].includes(command)) {
      if (args.length) throw new Error(`unknown argument: ${args[0]}`);
      stdout.write(`baton ${VERSION}\n`);
      return 0;
    }
    if (command === "init") {
      const flags = parseArgs(args, ["cli"], ["force"]);
      const result = await initProject(cwd, { force: Boolean(flags.force), cli: one(flags, "cli"), env });
      stdout.write(`initialized ${result.dir}\n`);
      for (const file of result.created) stdout.write(`  wrote ${file}\n`);
      for (const file of result.skipped) stdout.write(`  kept ${file}\n`);
      return 0;
    }
    if (command === "update") {
      parseArgs(args, []);
      const result = updateProject(cwd, { env });
      stdout.write("updated Baton global files\n");
      for (const action of result.actions) stdout.write(`  ${action}\n`);
      return 0;
    }
    if (command === "config") {
      return await runConfig(args, { cwd, stdout, stdin, env, adapterProvider: options.adapterProvider, prompt: options.prompt });
    }
    if (command === "host") return runHost(args, { cwd, stdout, env });
    if (command === "uninstall") {
      return await runUninstall(args, { cwd, stdout, env });
    }
    if (command === "models") {
      const flags = parseArgs(args, ["host"], ["json"]);
      const snapshot = createCliAdapterRegistrySnapshot(env);
      const host = resolveNativeHost(one(flags, "host"), env, snapshot);
      const provider = options.adapterProvider || ((id: CliId) => getCliAdapter(id, env, snapshot));
      const catalog = await provider(host).discoverModels({ cwd, env });
      if ((catalog.cli && catalog.cli !== host) || (catalog.adapter_id && catalog.adapter_id !== host)) {
        throw new Error(`CATALOG_HOST_MISMATCH: requested ${host}`);
      }
      output(stdout, catalog, Boolean(flags.json), [
        `${host} models:`,
        ...catalog.models.filter((model) => !model.hidden).map((model) => `  ${model.id}`),
      ]);
      return 0;
    }
    if (command === "match") {
      const flags = parseArgs(args, SELECTION_VALUES, ["json"]);
      const selected = await selectNativeModel(selectionInput(flags, cwd, env, options.adapterProvider));
      output(stdout, selected, Boolean(flags.json), [
        `host: ${selected.host}`,
        `model: ${selected.model_id}`,
        `effort: ${selected.reasoning_effort || "unspecified (host default)"}`,
        `service tier: ${selected.service_tier || "catalog default"}`,
        `context capacity: ${selected.context_capacity}`,
        ...selected.disclosures.map((item) => `note: ${item}`),
      ]);
      return 0;
    }
    if (command === "spawn") {
      const flags = parseArgs(args, ["brief", "briefs", "brief-budget-chars", ...SELECTION_VALUES], ["json"]);
      const briefs = readSpawnBriefs(flags);
      const briefBudgetChars = parseBriefBudgetChars(one(flags, "brief-budget-chars"));
      const prepared = briefs.map(({ brief }) => prepareBrief(brief, briefBudgetChars));
      const input = selectionInput(flags, cwd, env, options.adapterProvider);
      const selected = await selectNativeModels(input, briefs.map(({ selection }) => mergeSelection(input, selection)));
      const handoffs = briefs.map(({ brief }, index) => handoffPayload(brief, selected[index], prepared[index]));
      const payload = one(flags, "briefs") ? { handoffs } : handoffs[0];
      stdout.write(`${JSON.stringify(payload, null, flags.json ? undefined : 2)}\n`);
      return 0;
    }
    if (command === "observe") {
      const flags = parseArgs(args, ["file"], ["json"]);
      required(flags, "file");
      const report = summarizeObservations(many(flags, "file").map((file) => JSON.parse(fs.readFileSync(path.resolve(cwd, file), "utf8"))));
      output(stdout, report, Boolean(flags.json), report.groups.map((group) =>
        `${group.candidate_identifier} / ${group.workload_id || "unspecified workload"}: accepted ${group.accepted_runs}/${group.run_count}; median ${group.median_elapsed_ms ?? "unknown"} ms (${group.elapsed_samples} samples); tokens ${group.total_tokens ?? "unknown"}`));
      return 0;
    }
    if (command === "record") {
      const flags = parseArgs(args, ["host", "handle", "model", "status", "text"], ["json"]);
      const host = resolveNativeHost(required(flags, "host"), env);
      const status = required(flags, "status");
      if (!(["completed", "blocked", "failed"] as string[]).includes(status)) {
        throw new Error("--status must be completed, blocked, or failed");
      }
      const result = appendNativeResult({
        cwd,
        host,
        model: required(flags, "model"),
        native_handle: required(flags, "handle"),
        status: status as NativeResultStatus,
        result: required(flags, "text"),
      }, env);
      output(stdout, result, Boolean(flags.json), [`recorded ${result.native_handle}: ${result.status}`]);
      return 0;
    }
    if (command === "status") {
      const flags = parseArgs(args, ["host", "limit", "handle"], ["full", "json"]);
      const host = resolveNativeHost(one(flags, "host"), env);
      const handle = one(flags, "handle");
      if (handle !== undefined && !handle.trim()) throw new Error("--handle must not be empty");
      if (handle !== undefined && one(flags, "limit") !== undefined) throw new Error("--handle and --limit are mutually exclusive");
      const limit = one(flags, "limit") === undefined ? (handle === undefined ? 20 : 1) : Number(one(flags, "limit"));
      const records = recentNativeResults(cwd, host, env, limit, handle);
      const results = flags.full || handle !== undefined ? records : records.map(summarizeNativeResult);
      const payload = { cwd: path.resolve(cwd), host, results };
      output(stdout, payload, Boolean(flags.json), [
        `recent results for ${host}: ${results.length}`,
        ...results.map((item) => `  ${item.status} ${item.model} ${item.native_handle}: ${item.result}${"result_truncated" in item ? "… (use --handle for full result)" : ""}`),
      ]);
      return 0;
    }
    stderr.write(`unknown command: ${command}\n\n${HELP}`);
    return 2;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
