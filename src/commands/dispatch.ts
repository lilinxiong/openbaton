import { effectiveMaxConcurrentForHost, loadConfig } from "../lib/config.js";
import { parseHostId, type HostId } from "../lib/hosts.js";
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

const USAGE = `usage:
  baton dispatch next --host HOST [--capacity N] [--limit N] --json
  baton dispatch bind TICKET --agent-id ID --host HOST --json
  baton dispatch defer TICKET --host HOST --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
  baton dispatch probe TICKET --host HOST --agent-id ID --state pending_init|running|interrupted|shutdown|not_found [--activity status|output|heartbeat] --json
  baton dispatch progress TICKET --host HOST --phase PHASE --text "short status" [--next TEXT] [--blocker TEXT] [--needs-input] --json
  baton dispatch complete TICKET --host HOST --text "short conclusion" [--release] --json
  baton dispatch fail TICKET --host HOST --code CODE --message MESSAGE [--release] --json
  baton dispatch timeout TICKET --host HOST --probe-sequence N [--message MESSAGE] [--release] --json
  baton dispatch close TICKET --host HOST [--message MESSAGE] [--release] --json
  baton dispatch release TICKET --host HOST [--agent-id ID] --json
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

function print(stdout: WritableLike, value: unknown, json = true): void {
  if (json || (value && typeof value === "object")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else stdout.write(`${String(value)}\n`);
}

function capacity(cwd: string, env: NodeJS.ProcessEnv, value: string | boolean | undefined, host?: HostId): number {
  if (value != null) return Number(value);
  const remembered = persistedCapacity(cwd, host);
  if (remembered != null) return remembered;
  const config = loadConfig(cwd, { env });
  return effectiveMaxConcurrentForHost(config, host, env);
}

function dispatchHost(flags: FlagMap, cwd: string, env: NodeJS.ProcessEnv): HostId {
  return parseHostId(stringFlag(flags, "host") || loadConfig(cwd, { env }).cli.active);
}

function finishAndMaybeRelease(
  cwd: string,
  id: string,
  flags: FlagMap,
  options: Parameters<typeof finishAgent>[2],
) {
  const host = stringFlag(flags, "host");
  const ticket = finishAgent(cwd, id, { ...options, ...(host ? { host } : {}) });
  if (!flags.release) return ticket;
  return releaseAgent(cwd, id, { agentId: stringFlag(flags, "agent-id") || ticket.agent_id, ...(host ? { host } : {}) });
}

interface DispatchCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
}

export function runDispatch(args: string[], { cwd, stdout, env = process.env }: DispatchCommandOptions): number {
  const sub = args[0] || "status";
  const rest = args.slice(1);
  const flags = parseFlags(rest);
  const values = positional(rest);
  const json = Boolean(flags.json);

  if (sub === "next") {
    const host = dispatchHost(flags, cwd, env);
    const result = reserveNext(cwd, {
      capacity: capacity(cwd, env, flags.capacity, host),
      limit: flags.limit == null ? Number.MAX_SAFE_INTEGER : Number(flags.limit),
      host,
    });
    print(stdout, result, json);
    return result.blocked.length && result.reserved.length === 0 ? 1 : 0;
  }

  if (sub === "bind") {
    const id = values[0];
    if (!id || !flags["agent-id"]) throw new Error(USAGE.trim());
    const host = dispatchHost(flags, cwd, env);
    const ticket = bindAgent(cwd, id, { agentId: stringFlag(flags, "agent-id")!, host });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host), host }) }, json);
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
    });
    const host = stringFlag(flags, "host");
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host) : undefined), host }) }, json);
    return 0;
  }

  if (sub === "probe") {
    const id = values[0];
    const agentId = stringFlag(flags, "agent-id");
    const state = stringFlag(flags, "state");
    if (!id || !agentId || !state) throw new Error(USAGE.trim());
    const ticket = reportAgentProbe(cwd, id, {
      agentId,
      state: state as Parameters<typeof reportAgentProbe>[2]["state"],
      activity: (stringFlag(flags, "activity") || "status") as Parameters<typeof reportAgentProbe>[2]["activity"],
      host: stringFlag(flags, "host"),
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!) : undefined), host: stringFlag(flags, "host") }) }, json);
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
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!) : undefined), host: stringFlag(flags, "host") }) }, json);
    return 0;
  }

  if (sub === "complete") {
    const id = values[0];
    if (!id || !flags.text) throw new Error(USAGE.trim());
    const ticket = finishAndMaybeRelease(cwd, id, flags, { status: "completed", conclusion: stringFlag(flags, "text")! });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!) : undefined), host: stringFlag(flags, "host") }) }, json);
    return 0;
  }

  if (["fail", "timeout", "close"].includes(sub)) {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const timeoutProbeSequence = sub === "timeout" ? stringFlag(flags, "probe-sequence") : undefined;
    if (sub === "timeout" && !timeoutProbeSequence) throw new Error(USAGE.trim());
    const status = sub === "fail" ? "errored" : sub === "timeout" ? "timed_out" : "closed";
    const ticket = finishAndMaybeRelease(cwd, id, flags, {
      status,
      conclusion: stringFlag(flags, "text") || null,
      errorCode: stringFlag(flags, "code") || null,
      errorMessage: stringFlag(flags, "message") || null,
      probeSequence: timeoutProbeSequence ? Number(timeoutProbeSequence) : null,
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, stringFlag(flags, "host") ? parseHostId(stringFlag(flags, "host")!) : undefined), host: stringFlag(flags, "host") }) }, json);
    return 0;
  }

  if (sub === "release") {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const host = stringFlag(flags, "host");
    const ticket = releaseAgent(cwd, id, { agentId: stringFlag(flags, "agent-id") || null, ...(host ? { host } : {}) });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host) : undefined), host }) }, json);
    return 0;
  }

  if (sub === "recover") {
    const host = stringFlag(flags, "host");
    const recovered = recoverDispatches(cwd, { staleMs: flags["stale-ms"] == null ? 60_000 : Number(flags["stale-ms"]), host });
    print(stdout, { ...recovered, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host) : undefined), host }) }, json);
    return 0;
  }

  if (sub === "status") {
    const host = stringFlag(flags, "host");
    print(stdout, dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity, host ? parseHostId(host) : undefined), host }), json);
    return 0;
  }

  throw new Error(USAGE.trim());
}
