import type { WritableLike } from "../types.js";
import { detectInvokingHost, detectInvokingHosts, resolveRuntimeHost } from "../lib/hosts.js";

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
  const flags = parseFlags(args.slice(1));
  const json = Boolean(flags.json);

  if (sub !== "detect") throw new Error("usage: baton host detect [--json]");

  const detected = detectInvokingHost(env);
  const matches = detectInvokingHosts(env);
  const resolved = resolveRuntimeHost({ cwd, env });
  const payload = {
    invoking: detected,
    matches,
    resolved,
    source: detected
      ? (String(env.BATON_HOST || "").trim() ? "baton_host_env" : "runtime_signal")
      : (String(env.BATON_HOST || "").trim() ? "baton_host_env" : "legacy_cli_active"),
  };

  if (json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else stdout.write(`invoking: ${payload.invoking || "(none)"}\nresolved: ${payload.resolved} (${payload.source})\n`);
  return 0;
}
