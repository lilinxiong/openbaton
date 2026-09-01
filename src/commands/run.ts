import fs from "node:fs";
import path from "node:path";
import type { WritableLike } from "../types.js";
import {
  parsePlanDelta,
  parseTaskSeal,
  parseTaskSourceDescriptor,
  type PlanDelta,
  type TaskSeal,
  type TaskSourceDescriptor,
  type WorktreeExecutionMode,
} from "../lib/rolling-plan.js";
import {
  acceptRollingGate,
  appendRollingControl,
  formatRollingControlStatus,
  freezeRollingUnitBundle,
  reconcileRollingTasks,
  sealRollingTask,
  startRollingControl,
  statusRollingControl,
} from "../lib/rolling-control.js";
import { cleanupWorktreeAttempt } from "../lib/worktree-lifecycle.js";

export type RollingRunOperation = "start" | "append-plan" | "status" | "accept-gate" | "seal-task" | "reconcile" | "freeze" | "cleanup";

export interface RollingRunInvocation {
  operation: RollingRunOperation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  run_id: string;
  host: string | null;
  worktree_mode: WorktreeExecutionMode | null;
  source_file: string | null;
  source: TaskSourceDescriptor | null;
  plan_delta_file: string | null;
  delta: PlanDelta | null;
  accept_gate: string | null;
  text: string | null;
  seal_task: string | null;
  seal_file: string | null;
  seal: TaskSeal | null;
  reconcile: boolean;
  task: string | null;
  cleanup_unit: string | null;
  freeze_unit: string | null;
  attempt: string | null;
  validation: string | null;
  allow_noop: boolean;
  release_downstream_base: boolean;
  discard_rejected_evidence: boolean;
  release_user_retention: boolean;
  dispatch: boolean;
  json: boolean;
}

export type RollingRunHandler = (input: RollingRunInvocation) => unknown | Promise<unknown>;

interface RunCommandOptions {
  cwd: string;
  stdout: WritableLike;
  stdin: NodeJS.ReadableStream;
  injectedStdin?: string;
  env: NodeJS.ProcessEnv;
  handler?: RollingRunHandler;
}

type Coded = Error & { code?: string };

function invalid(message: string): never {
  const error = new Error(message) as Coded;
  error.code = "ROLLING_RUN_INVALID";
  throw error;
}

function scalar(value: string | undefined, flag: string, allowStdin = false): string {
  if (value === undefined || value.startsWith("--")) invalid(`--${flag} requires a value`);
  const clean = value.trim();
  if (!clean) invalid(`--${flag} requires a non-empty value`);
  if (/[/\\\p{Cc}\p{Cf}]/u.test(clean) && !["source-file", "plan-delta-file", "append-plan", "seal-file"].includes(flag)) {
    invalid(`--${flag} contains unsafe characters`);
  }
  if (!allowStdin && clean === "-") invalid(`--${flag} does not accept stdin`);
  return clean;
}

function valueAt(args: readonly string[], key: string): string | undefined {
  const marker = `--${key}`;
  const index = args.indexOf(marker);
  return index < 0 ? undefined : args[index + 1];
}

function validateTokens(args: readonly string[]): void {
  const valueFlags = new Set(["host", "run-id", "worktree-mode", "source-file", "plan-delta-file", "append-plan", "accept-gate", "text", "seal-task", "seal-file", "task", "freeze-unit", "cleanup-unit", "attempt", "validation"]);
  const booleanFlags = new Set(["status", "reconcile", "allow-noop", "release-downstream-base", "discard-rejected-evidence", "release-user-retention", "dispatch", "json"]);
  const seen = new Set<string>();
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positional += 1;
      if (positional > 1) invalid(`unexpected argument: ${value}`);
      continue;
    }
    const key = value.slice(2);
    if (!valueFlags.has(key) && !booleanFlags.has(key)) invalid(`unknown option: ${value}`);
    if (seen.has(key)) invalid(`duplicate --${key}`);
    seen.add(key);
    if (valueFlags.has(key)) {
      if (args[index + 1] === undefined || args[index + 1]!.startsWith("--")) invalid(`${value} requires a value`);
      index += 1;
    }
  }
  if (positional !== 1) invalid("baton run requires exactly one target: start or RUN_ID");
}

function generatedRunId(): string {
  const time = new Date().toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14);
  return `rolling-${time}-${Math.random().toString(16).slice(2, 10)}`;
}

function parseInvocation(args: string[], cwd: string, env: NodeJS.ProcessEnv): RollingRunInvocation {
  validateTokens(args);
  const target = args.find((value) => !value.startsWith("--") && !args[args.indexOf(value) - 1]?.startsWith("--"));
  // The generic positional scan above is exact, but flag values are also
  // ordinary strings. Walk the grammar again to find the sole real target.
  let positional: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]!.startsWith("--")) {
      const key = args[index]!.slice(2);
      if (!["status", "reconcile", "allow-noop", "release-downstream-base", "discard-rejected-evidence", "release-user-retention", "dispatch", "json"].includes(key)) index += 1;
      continue;
    }
    positional = args[index]!;
  }
  if (!positional) invalid(`missing run target${target ? `: ${target}` : ""}`);

  const starting = positional === "start";
  const hostRaw = valueAt(args, "host");
  const host = hostRaw === undefined ? null : scalar(hostRaw, "host");
  const worktreeModeRaw = valueAt(args, "worktree-mode");
  const worktreeMode = worktreeModeRaw === undefined ? null : scalar(worktreeModeRaw, "worktree-mode");
  if (worktreeMode !== null && worktreeMode !== "isolated-worktree" && worktreeMode !== "shared-worktree") {
    invalid("--worktree-mode must be isolated-worktree or shared-worktree");
  }
  const runIdRaw = valueAt(args, "run-id");
  const sourceRaw = valueAt(args, "source-file");
  const initialDeltaRaw = valueAt(args, "plan-delta-file");
  const appendRaw = valueAt(args, "append-plan");
  const gateRaw = valueAt(args, "accept-gate");
  const textRaw = valueAt(args, "text");
  const sealTaskRaw = valueAt(args, "seal-task");
  const sealFileRaw = valueAt(args, "seal-file");
  const taskRaw = valueAt(args, "task");
  const cleanupUnitRaw = valueAt(args, "cleanup-unit");
  const freezeUnitRaw = valueAt(args, "freeze-unit");
  const attemptRaw = valueAt(args, "attempt");
  const validationRaw = valueAt(args, "validation");
  const status = args.includes("--status");
  const reconcile = args.includes("--reconcile");
  const modes = Number(starting) + Number(appendRaw !== undefined) + Number(status) + Number(gateRaw !== undefined) + Number(sealTaskRaw !== undefined || sealFileRaw !== undefined) + Number(reconcile) + Number(freezeUnitRaw !== undefined) + Number(cleanupUnitRaw !== undefined);
  if (modes !== 1) invalid("rolling run operations are mutually exclusive: start, --append-plan, --status, --accept-gate, --seal-task, --reconcile, --freeze-unit, or --cleanup-unit");

  if (starting) {
    if (!host) invalid("baton run start requires --host HOST");
    if (sourceRaw === undefined) invalid("baton run start requires --source-file PATH|-");
    if (appendRaw !== undefined || status || gateRaw !== undefined || sealTaskRaw !== undefined || sealFileRaw !== undefined || reconcile || taskRaw !== undefined || freezeUnitRaw !== undefined || cleanupUnitRaw !== undefined || attemptRaw !== undefined || validationRaw !== undefined) invalid("baton run start received a flag for another operation");
  } else {
    if (host !== null || worktreeMode !== null || runIdRaw !== undefined || sourceRaw !== undefined || initialDeltaRaw !== undefined) invalid("existing rolling run operations use accepted run identity and forbid --host, --worktree-mode, --run-id, --source-file, and --plan-delta-file");
  }
  if (textRaw !== undefined && gateRaw === undefined && freezeUnitRaw === undefined) invalid("--text only accompanies --accept-gate or --freeze-unit");
  if ((gateRaw !== undefined || freezeUnitRaw !== undefined) && textRaw === undefined) invalid("--accept-gate and --freeze-unit require --text SUMMARY");
  if (textRaw !== undefined && !textRaw.trim()) invalid("--text SUMMARY must not be empty");
  if ((sealTaskRaw === undefined) !== (sealFileRaw === undefined)) invalid("--seal-task and --seal-file are required together");
  if (taskRaw !== undefined && !reconcile) invalid("--task only accompanies --reconcile");
  if ((cleanupUnitRaw !== undefined || freezeUnitRaw !== undefined) !== (attemptRaw !== undefined)) invalid("--cleanup-unit and --freeze-unit require --attempt");
  if (validationRaw !== undefined && freezeUnitRaw === undefined) invalid("--validation only accompanies --freeze-unit");
  if (args.includes("--allow-noop") && freezeUnitRaw === undefined) invalid("--allow-noop only accompanies --freeze-unit");
  const cleanupReleaseFlags = args.includes("--release-downstream-base") || args.includes("--discard-rejected-evidence") || args.includes("--release-user-retention");
  if (cleanupReleaseFlags && cleanupUnitRaw === undefined) invalid("cleanup release flags only accompany --cleanup-unit");
  if (args.includes("--dispatch") && !(starting || appendRaw !== undefined || gateRaw !== undefined)) invalid("--dispatch only accompanies start, --append-plan, or --accept-gate");

  const stdinUsers = [sourceRaw, initialDeltaRaw, appendRaw, sealFileRaw].filter((value) => value === "-");
  if (stdinUsers.length > 1) invalid("one invocation may consume stdin for only one document");
  const operation: RollingRunOperation = starting ? "start" : appendRaw !== undefined ? "append-plan" : status ? "status" : gateRaw !== undefined ? "accept-gate" : reconcile ? "reconcile" : freezeUnitRaw !== undefined ? "freeze" : cleanupUnitRaw !== undefined ? "cleanup" : "seal-task";
  return {
    operation,
    cwd,
    env,
    run_id: starting ? (runIdRaw === undefined ? generatedRunId() : scalar(runIdRaw, "run-id")) : scalar(positional, "run-id"),
    host,
    worktree_mode: worktreeMode as WorktreeExecutionMode | null,
    source_file: sourceRaw === undefined ? null : scalar(sourceRaw, "source-file", true),
    source: null,
    plan_delta_file: initialDeltaRaw === undefined ? (appendRaw === undefined ? null : scalar(appendRaw, "append-plan", true)) : scalar(initialDeltaRaw, "plan-delta-file", true),
    delta: null,
    accept_gate: gateRaw === undefined ? null : scalar(gateRaw, "accept-gate"),
    text: textRaw === undefined ? null : textRaw.trim(),
    seal_task: sealTaskRaw === undefined ? null : scalar(sealTaskRaw, "seal-task"),
    seal_file: sealFileRaw === undefined ? null : scalar(sealFileRaw, "seal-file", true),
    seal: null,
    reconcile,
    task: taskRaw === undefined ? null : scalar(taskRaw, "task"),
    cleanup_unit: cleanupUnitRaw === undefined ? null : scalar(cleanupUnitRaw, "cleanup-unit"),
    freeze_unit: freezeUnitRaw === undefined ? null : scalar(freezeUnitRaw, "freeze-unit"),
    attempt: attemptRaw === undefined ? null : scalar(attemptRaw, "attempt"),
    validation: validationRaw === undefined ? null : scalar(validationRaw, "validation"),
    allow_noop: args.includes("--allow-noop"),
    release_downstream_base: args.includes("--release-downstream-base"),
    discard_rejected_evidence: args.includes("--discard-rejected-evidence"),
    release_user_retention: args.includes("--release-user-retention"),
    dispatch: args.includes("--dispatch"),
    json: args.includes("--json"),
  };
}

async function stdinText(stdin: NodeJS.ReadableStream, injected?: string): Promise<string> {
  if (injected !== undefined) return injected;
  const chunks: string[] = [];
  for await (const chunk of stdin as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return chunks.join("");
}

async function documentText(file: string, options: RunCommandOptions): Promise<string> {
  if (file === "-") return stdinText(options.stdin, options.injectedStdin);
  const absolute = path.isAbsolute(file) ? file : path.resolve(options.cwd, file);
  return fs.readFileSync(absolute, "utf8");
}

async function loadDocuments(invocation: RollingRunInvocation, options: RunCommandOptions): Promise<RollingRunInvocation> {
  const next = { ...invocation };
  if (next.source_file) next.source = parseTaskSourceDescriptor(await documentText(next.source_file, options));
  if (next.plan_delta_file) next.delta = parsePlanDelta(await documentText(next.plan_delta_file, options));
  if (next.seal_file) next.seal = parseTaskSeal(await documentText(next.seal_file, options));
  if (next.seal && next.seal_task !== next.seal.task_key) invalid(`--seal-task ${next.seal_task} does not match seal task_key ${next.seal.task_key}`);
  return next;
}

export const defaultRollingRunHandler: RollingRunHandler = async (input) => {
  if (input.operation === "start") return startRollingControl({ cwd: input.cwd, env: input.env, run_id: input.run_id, host: input.host!, worktree_mode: input.worktree_mode || undefined, source: input.source!, delta: input.delta, dispatch: input.dispatch });
  if (input.operation === "append-plan") return appendRollingControl({ cwd: input.cwd, env: input.env, run_id: input.run_id, delta: input.delta!, dispatch: input.dispatch });
  if (input.operation === "status") return statusRollingControl({ cwd: input.cwd, env: input.env, run_id: input.run_id });
  if (input.operation === "accept-gate") return acceptRollingGate({ cwd: input.cwd, env: input.env, run_id: input.run_id, gate_ref: input.accept_gate!, evidence: input.text!, dispatch: input.dispatch });
  if (input.operation === "seal-task") return sealRollingTask({ cwd: input.cwd, env: input.env, run_id: input.run_id, seal: input.seal! });
  if (input.operation === "reconcile") return reconcileRollingTasks({ cwd: input.cwd, env: input.env, run_id: input.run_id, task_key: input.task });
  if (input.operation === "freeze") return freezeRollingUnitBundle({ cwd: input.cwd, env: input.env, run_id: input.run_id, unit_key: input.freeze_unit!, attempt_id: input.attempt!, conclusion: input.text!, validation_summaries: input.validation ? [input.validation] : [], allow_noop: input.allow_noop });
  return cleanupWorktreeAttempt({ cwd: input.cwd, env: input.env, run_id: input.run_id, unit_key: input.cleanup_unit!, attempt_id: input.attempt!, release_downstream_base: input.release_downstream_base, discard_rejected_evidence: input.discard_rejected_evidence, release_user_retention: input.release_user_retention });
};

function writeResult(stdout: WritableLike, result: unknown, json: boolean): void {
  if (!json && record(result)) {
    const status = result.code === "ROLLING_RUN_STATUS" ? result : record(result.status) ? result.status : null;
    if (status?.code === "ROLLING_RUN_STATUS") {
      if (result.code && result.code !== "ROLLING_RUN_STATUS") stdout.write(`${result.code}\n`);
      stdout.write(formatRollingControlStatus(status as never));
      return;
    }
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function runRollingRun(args: string[], options: RunCommandOptions): Promise<number> {
  const parsed = parseInvocation(args, options.cwd, options.env);
  const invocation = await loadDocuments(parsed, options);
  const result = await (options.handler || defaultRollingRunHandler)(invocation);
  writeResult(options.stdout, result, invocation.json);
  return 0;
}
