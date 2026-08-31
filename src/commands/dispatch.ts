import { parseHostId, resolveRuntimeHost, type HostId } from "../lib/hosts.js";
import {
  bindAgent,
  deferDispatch,
  dispatchSnapshot,
  finishAgent,
  releaseAgent,
  reportAgentProbe,
  reportAgentProgress,
  recoverDispatches,
  reserveNext,
} from "../lib/dispatch.js";
import { sessionUid } from "../lib/spawn.js";
import type { WritableLike } from "../types.js";
import type { NativeExecutionHandleKind } from "../adapters/contract.js";

const USAGE = `usage:
  baton dispatch next --host HOST [--capacity N] [--limit N] --json
  baton dispatch bind TICKET --execution-handle KIND=VALUE --host HOST --json
  baton dispatch defer TICKET --host HOST --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
  baton dispatch probe TICKET --host HOST --execution-handle KIND=VALUE --state pending_init|running|interrupted|shutdown|not_found [--activity status|output|heartbeat] --json
  baton dispatch progress TICKET --host HOST --phase PHASE --text "short status" [--next TEXT] [--blocker TEXT] [--needs-input] --json
  baton dispatch complete TICKET --host HOST --text "short conclusion" [--release] --json
  baton dispatch fail TICKET --host HOST --code CODE --message MESSAGE [--remaining-percent N] [--reset-at ISO] [--release] --json
  baton dispatch timeout TICKET --host HOST --probe-sequence N [--message MESSAGE] [--remaining-percent N] [--reset-at ISO] [--release] --json
  baton dispatch close TICKET --host HOST [--message MESSAGE] [--release] --json
  baton dispatch release TICKET --host HOST [--execution-handle KIND=VALUE] --json
  baton dispatch recover [--host HOST] [--stale-ms N] --json
  baton dispatch status --host HOST [--capacity N] --json

BATON_SESSION_ID is required for every capacity-sensitive operation.
Capacity is per (host, session_uid) root-agent tree: the root is excluded,
direct and nested descendants share one subagent pool, and capacity_sources in
the snapshot reports host_limit/configured_policy/operation_limit provenance.
--capacity is a non-persistent reduction for the current root-agent tree only;
it cannot raise a known host limit. max_depth is a separate policy.
Legacy dispatch-<host>.json values are inert rollback residue.
Tree capacity never bypasses workspace-wide safety/locks or host/profile model
availability/quota; native AGENT_LIMIT_REACHED is tree-local backpressure.
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

function validateFlags(args: string[]): void {
  const values = new Set([
    "host", "capacity", "limit", "execution-handle", "code", "message", "observed-capacity",
    "state", "activity", "phase", "text", "next", "blocker", "remaining-percent", "reset-at",
    "probe-sequence", "stale-ms",
  ]);
  const booleans = new Set(["json", "needs-input", "release"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (!values.has(key) && !booleans.has(key)) throw new Error(`unknown option: ${arg}`);
    if (values.has(key)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
    }
  }
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
  const raw = stringFlag(flags, "execution-handle");
  let kind: string | undefined;
  let value: string | undefined;
  if (raw) {
    const separator = raw.indexOf("=") >= 0 ? raw.indexOf("=") : raw.indexOf(":");
    if (separator <= 0 || separator === raw.length - 1) throw new Error(USAGE.trim());
    kind ||= raw.slice(0, separator);
    value ||= raw.slice(separator + 1);
  }
  if (!kind && !value) return undefined;
  if (!kind || !value || !/^[a-z][a-z0-9._-]*$/.test(kind)) {
    throw new Error(USAGE.trim());
  }
  return { kind: kind as NativeExecutionHandleKind, value, source: "manual" };
}

function print(stdout: WritableLike, value: unknown, json = true): void {
  if (json || (value && typeof value === "object")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else stdout.write(`${String(value)}\n`);
}

/**
 * Keep the command override tree-local and non-persistent. The shared
 * resolver applies it only as an additional reduction, records its provenance,
 * and bounds it by any known native/adapter host limit.
 */
function capacity(_cwd: string, _env: NodeJS.ProcessEnv, value: string | boolean | undefined, _host?: HostId): number | undefined {
  return value != null ? Number(value) : undefined;
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
  // Establish the root tree scope before any reservation, refill, status, or
  // ticket-targeted dispatch operation can inspect project state.
  sessionUid(env);
  const sub = args[0] || "status";
  const rest = args.slice(1);
  validateFlags(rest);
  const flags = parseFlags(rest);
  const values = positional(rest);
  if (["next", "recover", "status"].includes(sub)) {
    if (values.length) throw new Error(`unexpected argument: ${values[0]}`);
  } else if (["bind", "defer", "probe", "progress", "complete", "fail", "timeout", "close", "release"].includes(sub)) {
    if (values.length !== 1) throw new Error(USAGE.trim());
  }
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
      executionHandle: executionHandleFlag(flags),
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
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host, env) : undefined), host, env }) }, json);
    return 0;
  }

  if (sub === "probe") {
    const id = values[0];
    const executionHandle = executionHandleFlag(flags);
    const state = stringFlag(flags, "state");
    if (!id || !executionHandle || !state) throw new Error(USAGE.trim());
    const ticket = reportAgentProbe(cwd, id, {
      executionHandle,
      state: state as Parameters<typeof reportAgentProbe>[2]["state"],
      activity: (stringFlag(flags, "activity") || "status") as Parameters<typeof reportAgentProbe>[2]["activity"],
      host: stringFlag(flags, "host"),
      env,
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!, env) : undefined), host: stringFlag(flags, "host"), env }) }, json);
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
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!, env) : undefined), host: stringFlag(flags, "host"), env }) }, json);
    return 0;
  }

  if (sub === "complete") {
    const id = values[0];
    if (!id || !flags.text) throw new Error(USAGE.trim());
    const ticket = await finishAndMaybeRelease(cwd, id, flags, { status: "completed", conclusion: stringFlag(flags, "text")!, env });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!, env) : undefined), host: stringFlag(flags, "host"), env }) }, json);
    return 0;
  }

  if (["fail", "timeout", "close"].includes(sub)) {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const timeoutProbeSequence = sub === "timeout" ? stringFlag(flags, "probe-sequence") : undefined;
    if (sub === "timeout" && !timeoutProbeSequence) throw new Error(USAGE.trim());
    if (sub === "fail" && (!stringFlag(flags, "code")?.trim() || !stringFlag(flags, "message")?.trim())) {
      throw new Error(USAGE.trim());
    }
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
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!, env) : undefined), host: stringFlag(flags, "host"), env }) }, json);
    return 0;
  }

  if (sub === "release") {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const host = stringFlag(flags, "host");
    const ticket = releaseAgent(cwd, id, {
      executionHandle: executionHandleFlag(flags),
      env,
      ...(host ? { host } : {}),
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host, env) : undefined), host, env }) }, json);
    return 0;
  }

  if (sub === "recover") {
    const host = stringFlag(flags, "host");
    const recovered = recoverDispatches(cwd, { staleMs: flags["stale-ms"] == null ? 60_000 : Number(flags["stale-ms"]), host, env });
    print(stdout, { ...recovered, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host, env) : undefined), host, env }) }, json);
    return 0;
  }

  if (sub === "status") {
    // A dispatch snapshot is always one current root-agent tree. Requiring a
    // host here prevents the legacy workspace-wide aggregate shape from
    // masquerading as tree capacity when no host is supplied.
    const host = dispatchHost(flags, cwd, env);
    print(stdout, dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host, env) : undefined), host, env }), json);
    return 0;
  }

  throw new Error(USAGE.trim());
}
