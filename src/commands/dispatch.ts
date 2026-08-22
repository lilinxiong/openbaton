import { loadConfig } from "../lib/config.js";
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
  baton dispatch defer TICKET --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
  baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found [--activity status|output|heartbeat] --json
  baton dispatch progress TICKET --phase PHASE --text "short status" [--next TEXT] [--blocker TEXT] [--needs-input] --json
  baton dispatch complete TICKET --text "short conclusion" --json
  baton dispatch fail TICKET --code CODE --message MESSAGE --json
  baton dispatch timeout TICKET --probe-sequence N [--message MESSAGE] --json
  baton dispatch close TICKET [--message MESSAGE] --json
  baton dispatch release TICKET [--agent-id ID] --json
  baton dispatch recover [--stale-ms N] --json
  baton dispatch status [--capacity N] --json

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

function capacity(cwd: string, env: NodeJS.ProcessEnv, value: string | boolean | undefined): number {
  if (value != null) return Number(value);
  const remembered = persistedCapacity(cwd);
  if (remembered != null) return remembered;
  return loadConfig(cwd, { env }).director.max_concurrent;
}

function dispatchHost(flags: FlagMap, cwd: string, env: NodeJS.ProcessEnv): HostId {
  return parseHostId(stringFlag(flags, "host") || loadConfig(cwd, { env }).cli.active);
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
    const result = reserveNext(cwd, {
      capacity: capacity(cwd, env, flags.capacity),
      limit: flags.limit == null ? Number.MAX_SAFE_INTEGER : Number(flags.limit),
      host: dispatchHost(flags, cwd, env),
    });
    print(stdout, result, json);
    return result.blocked.length && result.reserved.length === 0 ? 1 : 0;
  }

  if (sub === "bind") {
    const id = values[0];
    if (!id || !flags["agent-id"]) throw new Error(USAGE.trim());
    const ticket = bindAgent(cwd, id, { agentId: stringFlag(flags, "agent-id")!, host: dispatchHost(flags, cwd, env) });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
    return 0;
  }

  if (sub === "defer") {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const ticket = deferDispatch(cwd, id, {
      code: stringFlag(flags, "code"),
      message: stringFlag(flags, "message"),
      observedCapacity: flags["observed-capacity"] == null ? null : Number(flags["observed-capacity"]),
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
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
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
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
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
    return 0;
  }

  if (sub === "complete") {
    const id = values[0];
    if (!id || !flags.text) throw new Error(USAGE.trim());
    const ticket = finishAgent(cwd, id, { status: "completed", conclusion: stringFlag(flags, "text")! });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
    return 0;
  }

  if (["fail", "timeout", "close"].includes(sub)) {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const timeoutProbeSequence = sub === "timeout" ? stringFlag(flags, "probe-sequence") : undefined;
    if (sub === "timeout" && !timeoutProbeSequence) throw new Error(USAGE.trim());
    const status = sub === "fail" ? "errored" : sub === "timeout" ? "timed_out" : "closed";
    const ticket = finishAgent(cwd, id, {
      status,
      conclusion: stringFlag(flags, "text") || null,
      errorCode: stringFlag(flags, "code") || null,
      errorMessage: stringFlag(flags, "message") || null,
      probeSequence: timeoutProbeSequence ? Number(timeoutProbeSequence) : null,
    });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
    return 0;
  }

  if (sub === "release") {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const ticket = releaseAgent(cwd, id, { agentId: stringFlag(flags, "agent-id") || null });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
    return 0;
  }

  if (sub === "recover") {
    const recovered = recoverDispatches(cwd, { staleMs: flags["stale-ms"] == null ? 60_000 : Number(flags["stale-ms"]) });
    print(stdout, { ...recovered, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
    return 0;
  }

  if (sub === "status") {
    print(stdout, dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }), json);
    return 0;
  }

  throw new Error(USAGE.trim());
}
