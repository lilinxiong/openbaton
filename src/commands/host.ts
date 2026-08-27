import type { WritableLike } from "../types.js";
import { detectInvokingHosts, parseHostId, resolveRuntimeHost, type HostId } from "../lib/hosts.js";

interface HostCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

export function runHost(args: string[], { cwd, stdout, env = process.env }: HostCommandOptions): number {
  const sub = args[0] || "detect";
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--json") throw new Error(`unknown option: ${args[index]}`);
  }
  const flags = parseFlags(args.slice(1));
  const json = Boolean(flags.json);

  if (sub !== "detect") throw new Error("usage: baton host detect [--json]");

  const matches = detectInvokingHosts(env);
  const fromEnv = String(env.BATON_HOST || "").trim();
  const invoking = fromEnv
    ? parseHostId(fromEnv, env)
    : matches.length === 1
      ? matches[0]
      : null;

  let resolved: HostId | null = null;
  let source: "baton_host_env" | "runtime_signal" | null = null;
  try {
    resolved = resolveRuntimeHost({ cwd, env });
    source = fromEnv ? "baton_host_env" : "runtime_signal";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("HOST_REQUIRED")) throw error;
  }

  const payload = {
    invoking,
    matches,
    resolved,
    source,
  };

  if (json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    const resolvedLabel = payload.resolved || "(none)";
    const sourceLabel = payload.source ? ` (${payload.source})` : "";
    stdout.write(`invoking: ${payload.invoking || "(none)"}\nresolved: ${resolvedLabel}${sourceLabel}\n`);
  }
  return 0;
}
