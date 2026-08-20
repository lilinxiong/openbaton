import readline from "node:readline/promises";
import { artificialAnalysisDbPath } from "../lib/paths.js";
import { buildRouteCandidates } from "../lib/routes.js";
import { refreshRouteSnapshot } from "./routes.js";
import { runHost } from "./host.js";
import { readHostCapabilitySnapshot } from "../lib/host-capabilities.js";
import {
  emptyProjectOpsConfig,
  loadProjectOpsConfig,
  saveProjectOpsConfig,
  type OpsProfileId,
} from "../lib/ops-config.js";
import { findOpsRouteChoice, listOpsRouteChoices, type OpsRouteChoice } from "../lib/ops-routes.js";
import { resolveOcx, type OcxResolver, type OcxRunner } from "../lib/opencodex.js";
import type { WritableLike } from "../types.js";

export interface ConfigCommandOptions {
  cwd: string;
  stdout: WritableLike;
  stdin?: NodeJS.ReadableStream;
  env?: NodeJS.ProcessEnv;
  runner?: OcxRunner;
  resolve?: OcxResolver;
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

function optionalRouteFlag(args: string[], name: string): string | undefined {
  const values = repeated(args, name);
  if (!values.length) return undefined;
  const value = values[values.length - 1].trim();
  return value === "-" ? "" : value;
}

function cards(cwd: string) {
  return buildRouteCandidates(cwd, artificialAnalysisDbPath(cwd)).map((item) => item.card);
}

function formatChoice(item: OpsRouteChoice, profile: OpsProfileId): string {
  const quota = item.remaining_percent == null ? "quota unknown" : `quota ${item.remaining_percent.toFixed(0)}%`;
  const context = profile === "longctx" && item.context_window != null ? `  ${item.context_window}` : "";
  return `${item.route_id}    ${quota}${context}`;
}

function printChoices(stdout: WritableLike, profile: OpsProfileId, choices: OpsRouteChoice[]): void {
  if (profile === "runner") stdout.write("runner — 跑 test/build/lint（当前可调用）\n");
  else stdout.write("longctx — 检索/消化/写 commit message（≥1M，当前可调用）\n");
  stdout.write("  0. （空：由主 agent 执行）\n");
  if (!choices.length) {
    stdout.write(profile === "longctx"
      ? "  （当前 host 没有 ≥1M 的可调用 route）\n"
      : "  （当前 host 没有可调用的 runner route）\n");
    return;
  }
  choices.forEach((item, index) => {
    stdout.write(`  ${index + 1}. ${formatChoice(item, profile)}\n`);
  });
}

function parseChoice(line: string, choices: OpsRouteChoice[]): string {
  const text = line.trim();
  if (!text || text === "0") return "";
  const index = Number(text);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1].route_id;
  if (findOpsRouteChoice(choices, text)) return text;
  throw new Error(`invalid ${choices.length ? `choice (0-${choices.length})` : "choice; only 0 is available"}: ${text}`);
}

async function defaultReadLine(stdin: NodeJS.ReadableStream, stdout: WritableLike): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout as NodeJS.WritableStream });
  try {
    return await rl.question("> ");
  } finally {
    rl.close();
  }
}

function requireChoice(profile: OpsProfileId, route: string, choices: OpsRouteChoice[]): string {
  if (!route) return "";
  if (!findOpsRouteChoice(choices, route)) {
    throw new Error(`OPS_ROUTE_UNAVAILABLE: ${profile} route ${route} is not in the current filtered host list`);
  }
  return route;
}

export async function runConfig(args: string[], {
  cwd,
  stdout,
  stdin = process.stdin,
  env = process.env,
  runner,
  resolve,
  readLine,
}: ConfigCommandOptions): Promise<number> {
  const models = repeated(args, "model");
  const profiles = repeated(args, "profile");
  if (models.length) {
    const hostArgs = ["sync", ...models.flatMap((model) => ["--model", model])];
    for (const profile of profiles) hostArgs.push("--profile", profile);
    const code = runHost(hostArgs, { cwd, stdout: { write() {} }, env, runner, resolve });
    if (code !== 0 && !readHostCapabilitySnapshot(cwd)) {
      throw new Error("HOST_CAPABILITIES_REQUIRED: baton config could not sync the current Codex host surface");
    }
  }
  try {
    refreshRouteSnapshot({ cwd, stdout: { write() {} }, env, runner, resolve: resolve || resolveOcx });
  } catch (error) {
    if (!cards(cwd).length) throw error;
  }
  if (!readHostCapabilitySnapshot(cwd)) {
    throw new Error("HOST_CAPABILITIES_REQUIRED: run baton host sync, or pass --model EXACT_ROUTE to baton config");
  }
  const available = cards(cwd);
  const runnerChoices = listOpsRouteChoices(cwd, "runner", available);
  const longctxChoices = listOpsRouteChoices(cwd, "longctx", available);
  printChoices(stdout, "runner", runnerChoices);
  stdout.write("\n");
  printChoices(stdout, "longctx", longctxChoices);

  let runnerRoute = optionalRouteFlag(args, "runner");
  let longctxRoute = optionalRouteFlag(args, "longctx");
  const ask = readLine || (() => defaultReadLine(stdin, stdout));
  if (runnerRoute === undefined) {
    stdout.write("\nSelect runner (0 = empty):\n");
    runnerRoute = parseChoice(await ask(), runnerChoices);
  }
  if (longctxRoute === undefined) {
    stdout.write("\nSelect longctx (0 = empty):\n");
    longctxRoute = parseChoice(await ask(), longctxChoices);
  }
  runnerRoute = requireChoice("runner", runnerRoute, runnerChoices);
  longctxRoute = requireChoice("longctx", longctxRoute, longctxChoices);

  const current = loadProjectOpsConfig(cwd);
  const next = emptyProjectOpsConfig();
  next.runner.actions = current.runner.actions;
  next.longctx.actions = current.longctx.actions;
  next.longctx.min_context_tokens = current.longctx.min_context_tokens;
  next.runner.route = runnerRoute;
  next.longctx.route = longctxRoute;
  const file = saveProjectOpsConfig(cwd, next);
  stdout.write(`\nwrote ${file}\n`);
  stdout.write(`  runner: ${runnerRoute || "(empty; director)"}\n`);
  stdout.write(`  longctx: ${longctxRoute || "(empty; director)"}\n`);
  return 0;
}
