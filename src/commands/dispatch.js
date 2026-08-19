import { loadConfig } from "../lib/config.js";
import {
  bindAgent,
  dispatchSnapshot,
  finishAgent,
  recoverDispatches,
  reserveNext,
} from "../lib/dispatch.js";

const USAGE = `usage:
  baton dispatch next --host codex [--capacity N] [--limit N] --json
  baton dispatch bind TICKET --agent-id ID --host codex --json
  baton dispatch complete TICKET --text "short conclusion" --json
  baton dispatch fail TICKET --code CODE --message MESSAGE --json
  baton dispatch timeout TICKET [--message MESSAGE] --json
  baton dispatch close TICKET [--message MESSAGE] --json
  baton dispatch recover [--stale-ms N] --json
  baton dispatch status [--capacity N] --json
`;

function parseFlags(args) {
  const flags = {};
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

function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
    } else out.push(args[i]);
  }
  return out;
}

function print(stdout, value, json = true) {
  if (json || (value && typeof value === "object")) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else stdout.write(`${String(value)}\n`);
}

function capacity(cwd, env, value) {
  if (value != null) return Number(value);
  return loadConfig(cwd, { env }).director.max_concurrent;
}

export function runDispatch(args, { cwd, stdout, env = process.env } = {}) {
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
    const ticket = bindAgent(cwd, id, { agentId: flags["agent-id"], host: String(flags.host || "codex") });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
    return 0;
  }

  if (sub === "complete") {
    const id = values[0];
    if (!id || !flags.text) throw new Error(USAGE.trim());
    const ticket = finishAgent(cwd, id, { status: "completed", conclusion: flags.text });
    print(stdout, { ticket, snapshot: dispatchSnapshot(cwd, { capacity: capacity(cwd, env, flags.capacity) }) }, json);
    return 0;
  }

  if (["fail", "timeout", "close"].includes(sub)) {
    const id = values[0];
    if (!id) throw new Error(USAGE.trim());
    const status = sub === "fail" ? "errored" : sub === "timeout" ? "timed_out" : "closed";
    const ticket = finishAgent(cwd, id, {
      status,
      conclusion: flags.text || null,
      errorCode: flags.code || null,
      errorMessage: flags.message || null,
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
