import { loadConfig } from "../lib/config.js";
import {
  bindAgent,
  dispatchSnapshot,
  finishAgent,
  persistedCapacity,
  recoverDispatches,
  reserveNext,
} from "../lib/dispatch.js";
import type { WritableLike } from "../types.js";

const USAGE = `usage:
  baton dispatch next --host codex [--capacity N] [--limit N] --json
  baton dispatch bind TICKET --agent-id ID --host codex --json
  baton dispatch complete TICKET --text "short conclusion" --json
  baton dispatch fail TICKET --code CODE --message MESSAGE --json
  baton dispatch timeout TICKET [--message MESSAGE] --json
  baton dispatch close TICKET [--message MESSAGE] --json
  baton dispatch recover [--stale-ms N] --json
  baton dispatch status [--capacity N] --json

dispatch next remembers --capacity under ~/.baton/workspaces/<id>/runs/; later bind/complete/status/recover
calls inherit it without repeating the flag.
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
      host: String(flags.host || "codex"),
    });
    print(stdout, result, json);
    return result.blocked.length && result.reserved.length === 0 ? 1 : 0;
  }

  if (sub === "bind") {
    const id = values[0];
    if (!id || !flags["agent-id"]) throw new Error(USAGE.trim());
    const ticket = bindAgent(cwd, id, { agentId: stringFlag(flags, "agent-id")!, host: String(flags.host || "codex") });
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
    const status = sub === "fail" ? "errored" : sub === "timeout" ? "timed_out" : "closed";
    const ticket = finishAgent(cwd, id, {
      status,
      conclusion: stringFlag(flags, "text") || null,
      errorCode: stringFlag(flags, "code") || null,
      errorMessage: stringFlag(flags, "message") || null,
    });
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
