import { hostIds, resolveRuntimeHost, type HostId } from "../lib/hosts.js";
import {
  applyUninstallPlan,
  buildUninstallPlan,
  UNINSTALL_CONFIRMATION_REQUIRED,
  type UninstallPlan,
} from "../lib/uninstall.js";
import { withActivationLock } from "../lib/activation.js";
import type { WritableLike } from "../types.js";

export interface UninstallCommandOptions {
  cwd: string;
  stdout: WritableLike;
  stderr?: WritableLike;
  env?: NodeJS.ProcessEnv;
  /** Injectable confirmation for interactive callers/tests. */
  confirm?: () => boolean | Promise<boolean>;
  /** Set false for non-interactive CLI invocations without --yes. */
  interactive?: boolean;
}

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return String(value).trim() || null;
}

function selectedHosts(args: string[], cwd: string, env: NodeJS.ProcessEnv, clean: boolean): HostId[] {
  const explicit = flagValue(args, "--host");
  if (clean && explicit) throw new Error("UNINSTALL_CLEAN_HOST_INVALID: --clean always removes recognized integrations for every host; omit --host");
  if (clean) return [...hostIds(env)];
  return [resolveRuntimeHost({ cwd, env, explicitHost: explicit })];
}

function printPlan(stdout: WritableLike, plan: UninstallPlan, json: boolean, applied: boolean): void {
  if (json) {
    stdout.write(`${JSON.stringify({ ...plan, applied }, null, 2)}\n`);
    return;
  }
  stdout.write(`Baton uninstall ${applied ? "applied" : "plan"}: ${plan.clean ? "clean" : "selected host"}\n`);
  for (const target of plan.targets) stdout.write(`  ${target.action.padEnd(14)} ${target.path} (${target.reason})\n`);
  if (plan.active_tickets.length) stdout.write(`  active tickets: ${plan.active_tickets.map((item) => item.ticket_id).join(", ")}\n`);
  for (const constraint of plan.constraints) stdout.write(`  constraint: ${constraint}\n`);
}

function withGlobalHostLocks<T>(
  cwd: string,
  env: NodeJS.ProcessEnv,
  hosts: readonly HostId[],
  operation: () => T,
  index = 0,
): T {
  const host = hosts[index];
  if (!host) return operation();
  return withActivationLock(
    cwd,
    env,
    () => withGlobalHostLocks(cwd, env, hosts, operation, index + 1),
    { host, scope: "global" },
  );
}

export async function runUninstall(args: string[], options: UninstallCommandOptions): Promise<number> {
  const env = options.env || process.env;
  const valueFlags = new Set(["host"]);
  const booleanFlags = new Set(["clean", "dry-run", "json", "yes"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`unknown uninstall argument: ${arg}`);
    const key = arg.slice(2);
    if (!valueFlags.has(key) && !booleanFlags.has(key)) throw new Error(`unknown option: ${arg}`);
    if (valueFlags.has(key)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
    }
  }
  const clean = args.includes("--clean");
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const hosts = selectedHosts(args, options.cwd, env, clean);
  // Always resolve ownership and dispatch safety before asking for consent.
  // In particular, an active clean ticket must not trigger an interactive
  // prompt because the operation is already blocked.
  const plan = buildUninstallPlan({ cwd: options.cwd, env, hosts, clean, dry_run: dryRun });
  if (clean && !args.includes("--yes") && !dryRun) {
    if (!options.confirm || options.interactive === false) {
      const error = new Error(`${UNINSTALL_CONFIRMATION_REQUIRED}: pass --yes or provide interactive confirmation`) as Error & { code: string };
      error.code = UNINSTALL_CONFIRMATION_REQUIRED;
      throw error;
    }
    if (!(await options.confirm())) return 1;
  }
  if (dryRun) {
    printPlan(options.stdout, plan, json, false);
    return 0;
  }
  // Confirmation is intentionally outside the locks. After consent, clean
  // acquires every host's reservation boundary, rebuilds the entire plan, and
  // re-scans active tickets before any deletion. This closes the window in
  // which another CLI process could reserve work between the prompt and apply.
  const appliedPlan = clean
    ? withGlobalHostLocks(options.cwd, env, plan.hosts, () => {
      const fresh = buildUninstallPlan({
        cwd: options.cwd,
        env,
        hosts: plan.hosts,
        clean: true,
        dry_run: false,
      });
      applyUninstallPlan(fresh, { env });
      return fresh;
    })
    : applyUninstallPlan(plan, { env });
  printPlan(options.stdout, appliedPlan, json, true);
  return 0;
}
