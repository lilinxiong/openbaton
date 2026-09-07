import { hostIds, resolveRuntimeHost, type HostId } from "../lib/hosts.js";
import {
  applyUninstallPlan,
  buildUninstallPlan,
  type UninstallPlan,
} from "../lib/uninstall.js";
import type { WritableLike } from "../types.js";

export interface UninstallCommandOptions {
  cwd: string;
  stdout: WritableLike;
  stderr?: WritableLike;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
}

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return result;
}
function validate(args: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--"))
      throw new Error(`unknown uninstall argument: ${arg}`);
    if (arg === "--host") {
      if (!args[++index] || args[index].startsWith("--"))
        throw new Error("--host requires a value");
      continue;
    }
    if (!["--clean", "--dry-run", "--json"].includes(arg))
      throw new Error(`unknown option: ${arg}`);
  }
}
function print(
  stdout: WritableLike,
  plan: UninstallPlan,
  json: boolean,
  applied: boolean,
): void {
  if (json) {
    stdout.write(`${JSON.stringify({ ...plan, applied }, null, 2)}\n`);
    return;
  }
  stdout.write(
    `Baton uninstall ${applied ? "applied" : "plan"}${plan.clean ? " (clean)" : ""}:\n`,
  );
  for (const target of plan.targets)
    stdout.write(
      `  ${target.action.padEnd(14)} ${target.path} (${target.reason})\n`,
    );
}
export async function runUninstall(
  args: string[],
  options: UninstallCommandOptions,
): Promise<number> {
  validate(args);
  const env = options.env || process.env;
  const clean = args.includes("--clean");
  const dryRun = args.includes("--dry-run");
  const explicit = value(args, "--host");
  if (clean && explicit)
    throw new Error("--clean cannot be combined with --host");
  const hosts: HostId[] = clean
    ? [...hostIds(env)]
    : [resolveRuntimeHost({ cwd: options.cwd, env, explicitHost: explicit })];
  const plan = buildUninstallPlan({
    cwd: options.cwd,
    env,
    hosts,
    clean,
    dry_run: dryRun,
  });
  if (dryRun) {
    print(options.stdout, plan, args.includes("--json"), false);
    return 0;
  }
  if (plan.targets.some((target) => target.action === "conflict")) {
    print(options.stdout, plan, args.includes("--json"), false);
    return 1;
  }
  applyUninstallPlan(plan, { env });
  print(options.stdout, plan, args.includes("--json"), true);
  return 0;
}
