import { effectiveMaxConcurrentForHost, loadConfig } from "../lib/config.js";
import { parseHostId, resolveRuntimeHost, type HostId } from "../lib/hosts.js";
import {
  bindAgent,
  deferDispatch,
  dispatchSnapshot,
  finishAgent,
  persistedCapacity,
  releaseAgent,
  reportAgentProbe,
  reportAgentProgress,
  recoverDispatches,
  reserveNext,
} from "../lib/dispatch.js";
import type { WritableLike } from "../types.js";
import type { NativeExecutionHandleKind } from "../adapters/contract.js";

const USAGE = `usage:
  baton dispatch next --host HOST [--capacity N] [--limit N] --json
  baton dispatch bind TICKET [--agent-id HOST_AGENT_ID] [--task-name CODEX_TASK_NAME] --host HOST --json
  baton dispatch defer TICKET --host HOST --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
  baton dispatch probe TICKET --host HOST [--execution-handle KIND=VALUE|--agent-id ID|--task-name NAME] --state pending_init|running|interrupted|shutdown|not_found [--activity status|output|heartbeat] --json
  baton dispatch progress TICKET --host HOST --phase PHASE --text "short status" [--next TEXT] [--blocker TEXT] [--needs-input] --json
  baton dispatch complete TICKET --host HOST --text "short conclusion" [--release] --json
  baton dispatch fail TICKET --host HOST --code CODE --message MESSAGE [--remaining-percent N] [--reset-at ISO] [--release] --json
  baton dispatch timeout TICKET --host HOST --probe-sequence N [--message MESSAGE] [--remaining-percent N] [--reset-at ISO] [--release] --json
  baton dispatch close TICKET --host HOST [--message MESSAGE] [--release] --json
  baton dispatch release TICKET --host HOST [--execution-handle KIND=VALUE|--task-name NAME|--agent-id ID] --json
  baton dispatch recover [--host HOST] [--stale-ms N] --json
  baton dispatch status [--host HOST] [--capacity N] --json

dispatch next remembers --capacity under ~/.baton/workspaces/<id>/runs/; later bind/complete/status/recover
calls inherit it without repeating the flag.
recover --stale-ms applies only to an unbound dispatch reservation. A bound running agent is probed and resumed, never expired by age.
`;

type FlagMap = Record<string, string | boolean>;

function parseFlags(args: string[]): FlagMap {
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else flags[key] = true;
  }
  return flags;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
    } else out.push(args[i]);
  }
  return out;
}

function stringFlag(flags: FlagMap, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function executionHandleFlag(flags: FlagMap): { kind: NativeExecutionHandleKind; value: string; source: "manual" } | undefined {
  const raw = stringFlag(flags, "execution-handle") || stringFlag(flags, "handle");
  let kind = stringFlag(flags, "execution-handle-kind") || stringFlag(flags, "handle-kind");
  let value = stringFlag(flags, "execution-handle-value") || stringFlag(flags, "handle-value");
  if (raw) {
    const separator = raw.indexOf("=") >= 0 ? raw.indexOf("=") : raw.indexOf(":");
    if (separator <= 0 || separator === raw.length - 1) throw new Error(USAGE.trim());
    kind ||= raw.slice(0, separator);
    value ||= raw.slice(separator + 1);
  }
  if (!kind && !value) return undefined;
  if (!kind || !value || !["task_name", "agent_id", "session_id", "task_id", "opaque"].includes(kind)) {
    throw new Error(USAGE.trim());
  }
  return { kind: kind as NativeExecutionHandleKind, value, source: "manual" };
}

function print(stdout: WritableLike, value: unknown, json = true): void {
  if (json || (value && typeof value === "object")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else stdout.write(`${String(value)}\n`);
}

function capacity(cwd: string, env: NodeJS.ProcessEnv, value: string | boolean | undefined, host?: HostId): number {
  if (value != null) return Number(value);
  const remembered = persistedCapacity(cwd, host, env);
  if (remembered != null) return remembered;
  const config = loadConfig(cwd, { env });
  return effectiveMaxConcurrentForHost(config, host, env);
}

function dispatchHost(flags: FlagMap, cwd: string, env: NodeJS.ProcessEnv): HostId {
  return resolveRuntimeHost({ cwd, env, explicitHost: stringFlag(flags, "host") });
}

async function finishAndMaybeRelease(
  cwd: string,
  id: string,
  flags: FlagMap,
  options: Parameters<typeof finishAgent>[2],
) {
  const host = stringFlag(flags, "host");
  const ticket = await finishAgent(cwd, id, { ...options, env: options.env || process.env, ...(host ? { host } : {}) });
  if (!flags.release) return ticket;
  return releaseAgent(cwd, id, {
    agentId: stringFlag(flags, "agent-id"),
    taskName: stringFlag(flags, "task-name"),
    executionHandle: executionHandleFlag(flags),
    env: options.env || process.env,
    ...(host ? { host } : {}),
  });
}

interface DispatchCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
}

export async function runDispatch(args: string[], { cwd, stdout, env = process.env }: DispatchCommandOptions): Promise<number> {
  const sub = args[0] || "status";
  const rest = args.slice(1);
  const flags = parseFlags(rest);
  const values = positional(rest);
  const json = Boolean(flags.json);

  if (sub === "next") {
    const host = dispatchHost(flags, cwd, env);
    const result = await reserveNext(cwd, {
      capacity: capacity(cwd, env, flags.capacity, host),
      limit: flags.limit == null ? Number.MAX_SAFE_INTEGER : Number(flags.limit),
      host,
      env,
    });
    print(stdout, result, json);
    return result.blocked.length && result.reserved.length === 0 ? 1 : 0;
  }

  if (sub === "bind") {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const host = dispatchHost(flags, cwd, env);
    const ticket = bindAgent(cwd, id, {
      agentId: stringFlag(flags, "agent-id"),
      taskName: stringFlag(flags, "task-name"),
      host,
      env,
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host), host, env }) }, json);
    return 0;
  }

  if (sub === "defer") {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const ticket = deferDispatch(cwd, id, {
      code: stringFlag(flags, "code"),
      message: stringFlag(flags, "message"),
      observedCapacity: flags["observed-capacity"] == null ? null : Number(flags["observed-capacity"]),
      host: stringFlag(flags, "host"),
      env,
    });
    const host = stringFlag(flags, "host");
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host) : undefined), host, env }) }, json);
    return 0;
  }

  if (sub === "probe") {
    const id = values[0];
    const agentId = stringFlag(flags, "agent-id");
    const taskName = stringFlag(flags, "task-name");
    const executionHandle = executionHandleFlag(flags);
    const state = stringFlag(flags, "state");
    if (!id || (!agentId && !taskName && !executionHandle) || !state) throw new Error(USAGE.trim());
    const ticket = reportAgentProbe(cwd, id, {
      agentId,
      taskName,
      executionHandle,
      state: state as Parameters<typeof reportAgentProbe>[2]["state"],
      activity: (stringFlag(flags, "activity") || "status") as Parameters<typeof reportAgentProbe>[2]["activity"],
      host: stringFlag(flags, "host"),
      env,
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!) : undefined), host: stringFlag(flags, "host"), env }) }, json);
    return 0;
  }

  if (sub === "progress") {
    const id = values[0];
    const phase = stringFlag(flags, "phase");
    const summary = stringFlag(flags, "text");
    if (!id || !phase || !summary) throw new Error(USAGE.trim());
    const ticket = reportAgentProgress(cwd, id, {
      phase: phase as Parameters<typeof reportAgentProgress>[2]["phase"],
      summary,
      nextStep: stringFlag(flags, "next") || null,
      blocker: stringFlag(flags, "blocker") || null,
      needsDirector: Boolean(flags["needs-input"]),
      host: stringFlag(flags, "host"),
      env,
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!) : undefined), host: stringFlag(flags, "host"), env }) }, json);
    return 0;
  }

  if (sub === "complete") {
    const id = values[0];
    if (!id || !flags.text) throw new Error(USAGE.trim());
    const ticket = await finishAndMaybeRelease(cwd, id, flags, { status: "completed", conclusion: stringFlag(flags, "text")!, env });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!) : undefined), host: stringFlag(flags, "host"), env }) }, json);
    return 0;
  }

  if (["fail", "timeout", "close"].includes(sub)) {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const timeoutProbeSequence = sub === "timeout" ? stringFlag(flags, "probe-sequence") : undefined;
    if (sub === "timeout" && !timeoutProbeSequence) throw new Error(USAGE.trim());
    const status = sub === "fail" ? "errored" : sub === "timeout" ? "timed_out" : "closed";
    const ticket = await finishAndMaybeRelease(cwd, id, flags, {
      status,
      conclusion: stringFlag(flags, "text") || null,
      errorCode: stringFlag(flags, "code") || null,
      errorMessage: stringFlag(flags, "message") || null,
      remainingPercent: stringFlag(flags, "remaining-percent") == null ? null : Number(stringFlag(flags, "remaining-percent")),
      resetAt: stringFlag(flags, "reset-at") || null,
      probeSequence: timeoutProbeSequence ? Number(timeoutProbeSequence) : null,
      env,
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!) : undefined), host: stringFlag(flags, "host"), env }) }, json);
    return 0;
  }

  if (sub === "release") {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const host = stringFlag(flags, "host");
    const ticket = releaseAgent(cwd, id, {
      agentId: stringFlag(flags, "agent-id"),
      taskName: stringFlag(flags, "task-name"),
      executionHandle: executionHandleFlag(flags),
      env,
      ...(host ? { host } : {}),
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host) : undefined), host, env }) }, json);
    return 0;
  }

  if (sub === "recover") {
    const host = stringFlag(flags, "host");
    const recovered = recoverDispatches(cwd, { staleMs: flags["stale-ms"] == null ? 60_000 : Number(flags["stale-ms"]), host, env });
    print(stdout, { ...recovered, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host) : undefined), host, env }) }, json);
    return 0;
  }

  if (sub === "status") {
    const host = stringFlag(flags, "host");
    print(stdout, dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host) : undefined), host, env }), json);
    return 0;
  }

  throw new Error(USAGE.trim());
}
