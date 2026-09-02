import { defaultCompiledApplyHandler } from "../lib/apply/compiled-cli.js";
import {
  CodedError,
  WritableLike
} from "../types.js";
import {
  CompiledApplyHandler,
  CompiledApplyInvocation,
  CompiledApplyMode,
  CompiledApplyOperation
} from "../cli.js";
import {
  firstPositionalArg,
  validateCommandArgs
} from "../cli-flags.js";
import fs from "node:fs";
import path from "node:path";
/**
 * `baton compiled-apply` command: invocation parsing and handler wiring.
 * Split from cli.ts.
 */

export const COMPILED_APPLY_FLAGS = new Set(["plan-file", "run", "status", "accept-gate", "text", "reconcile", "task"]);

export function hasCompiledApplyFlag(args: string[]): boolean {
  return args.some((arg) => arg.startsWith("--") && COMPILED_APPLY_FLAGS.has(arg.slice(2)));
}

export function compiledApplyError(message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = "COMPILED_APPLY_INVALID";
  return error;
}

export function safeCompiledScalar(raw: string | undefined, flag: string, allowStdin = false): string {
  if (raw === undefined || raw.startsWith("--")) throw compiledApplyError(`--${flag} requires a value`);
  const value = raw.trim();
  if (!value) throw compiledApplyError(`--${flag} requires a non-empty value`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw compiledApplyError(`--${flag} contains unsafe control characters`);
  if (!allowStdin && value === "-") throw compiledApplyError(`--${flag} contains an unsafe value`);
  return value;
}

/** Gate evidence is sanitized by the parent acceptance API.  Preserve the
 * original text here so multiline evidence can be normalized at that single
 * ownership boundary instead of being rejected by argument parsing. */
export function safeCompiledText(raw: string | undefined): string {
  if (raw === undefined || raw.startsWith("--")) throw compiledApplyError("--text requires a value");
  const value = raw.trim();
  if (!value) throw compiledApplyError("--text requires a non-empty value");
  return value;
}

export function compiledApplyFlagValue(args: string[], key: string): string | undefined {
  const marker = `--${key}`;
  for (let index = 0; index < args.length; index += 1) if (args[index] === marker) return args[index + 1];
  return undefined;
}

export function parseCompiledApplyInvocation(args: string[], cwd: string, env: NodeJS.ProcessEnv): CompiledApplyInvocation {
  // Keep this allowlist separate from the legacy parser: compiled flags are a
  // new protocol, while manual apply retains its established grammar.
  validateCommandArgs(args, {
    value: ["host", "plan-file", "run", "accept-gate", "text", "task"],
    boolean: ["dispatch", "json", "status", "reconcile", "unit", "write-path", "write-ops", "read-only"],
    positional: "single",
  });

  const singletonFlags = new Set(["host", "plan-file", "run", "status", "accept-gate", "text", "reconcile", "task", "dispatch", "json"]);
  const seen = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (!singletonFlags.has(key)) continue;
    if (seen.has(key)) throw compiledApplyError(`duplicate --${key}`);
    seen.add(key);
  }

  const scope = ["unit", "write-path", "write-ops", "read-only"].find((key) => args.includes(`--${key}`));
  if (scope) throw compiledApplyError(`compiled apply forbids manual scope --${scope}`);

  const planFileRaw = compiledApplyFlagValue(args, "plan-file");
  const runRaw = compiledApplyFlagValue(args, "run");
  const gateRaw = compiledApplyFlagValue(args, "accept-gate");
  const textRaw = compiledApplyFlagValue(args, "text");
  const taskRaw = compiledApplyFlagValue(args, "task");
  const planFile = planFileRaw === undefined ? null : safeCompiledScalar(planFileRaw, "plan-file", true);
  const run = runRaw === undefined ? null : safeCompiledScalar(runRaw, "run");
  const gate = gateRaw === undefined ? null : safeCompiledScalar(gateRaw, "accept-gate");
  const text = textRaw === undefined ? null : safeCompiledText(textRaw);
  const task = taskRaw === undefined ? null : safeCompiledScalar(taskRaw, "task");
  const status = args.includes("--status");
  const reconcile = args.includes("--reconcile");
  const changeRaw = firstPositionalArg(args);
  const change = changeRaw === null ? null : safeCompiledScalar(changeRaw, "change");
  const modeCount = Number(planFile !== null) + Number(status) + Number(gate !== null) + Number(reconcile);
  if (modeCount !== 1) throw compiledApplyError("compiled apply requires exactly one operation: --plan-file, --status, --accept-gate, or --reconcile");
  if (planFile !== null && (status || gate !== null || reconcile)) throw compiledApplyError("compiled apply operation modes are mutually exclusive");
  if (status && (gate !== null || reconcile) || gate !== null && reconcile) throw compiledApplyError("compiled apply operation modes are mutually exclusive");
  if ((status || gate !== null || reconcile) && !run) throw compiledApplyError("--run is required for compiled run operations");
  if (text !== null && gate === null) throw compiledApplyError("--text only accompanies --accept-gate");
  if (gate !== null && text === null) throw compiledApplyError("--accept-gate requires --text SUMMARY");
  if (task !== null && !reconcile) throw compiledApplyError("--task only accompanies --reconcile");
  if (args.includes("--dispatch") && planFile === null) throw compiledApplyError("--dispatch only accompanies --plan-file");

  const hostRaw = compiledApplyFlagValue(args, "host");
  const host = hostRaw === undefined ? null : safeCompiledScalar(hostRaw, "host");
  const mode: CompiledApplyMode = planFile !== null ? (run ? "successor" : "initial") : status ? "status" : gate !== null ? "accept-gate" : "reconcile";
  const operation: CompiledApplyOperation = mode === "status" ? "status" : mode === "accept-gate" ? "accept-gate" : mode === "reconcile" ? "reconcile" : "plan";
  return {
    operation, mode, change, run, run_id: run, plan_file: planFile, plan: null,
    dispatch: args.includes("--dispatch"), status, accept_gate: gate, text, reconcile, task,
    json: args.includes("--json"), host, cwd, env,
  };
}

export async function readCompiledPlan(planFile: string, cwd: string, stdin: NodeJS.ReadableStream, injectedStdin: string | undefined): Promise<string> {
  if (planFile !== "-") return fs.readFileSync(path.isAbsolute(planFile) ? planFile : path.resolve(cwd, planFile), "utf8");
  if (injectedStdin !== undefined) return injectedStdin;
  const chunks: string[] = [];
  for await (const chunk of stdin as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return chunks.join("");
}

export function writeCompiledHandlerResult(stdout: WritableLike, result: unknown): void {
  if (result === undefined) return;
  if (typeof result === "string") {
    stdout.write(result.endsWith("\n") ? result : `${result}\n`);
    return;
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function cmdCompiledApply(
  args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream, injectedStdin: string | undefined, handler?: CompiledApplyHandler,
): Promise<number> {
  const invocation = parseCompiledApplyInvocation(args, cwd, env);
  const input = invocation.plan_file === null
    ? invocation
    : { ...invocation, plan: await readCompiledPlan(invocation.plan_file, cwd, stdin, injectedStdin) };
  // Keep the injectable boundary for tests and embedding callers.  Normal
  // CLI use gets the production protocol handler only when no override was
  // supplied.
  const result = await (handler || defaultCompiledApplyHandler)(input);
  writeCompiledHandlerResult(stdout, result);
  return 0;
}
