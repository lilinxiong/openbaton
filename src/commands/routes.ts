import fs from "node:fs";
import { artificialAnalysisDbPath, routeSnapshotPath } from "../lib/paths.js";
import { resolveOcx, runOcx, type OcxResolution, type OcxResolver, type OcxRunner } from "../lib/opencodex.js";
import { buildRouteCandidates, publishRouteSnapshot, readRouteSnapshot, routeSnapshotSchemaVersion } from "../lib/routes.js";
import type { WritableLike } from "../types.js";

export interface RouteCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
  runner?: OcxRunner;
  resolve?: OcxResolver;
}

function engineVersion(result: { status: number; stdout: string }): string | null {
  return result.status === 0 ? String(result.stdout || "").trim() || null : null;
}

function resolvedEngine(options: RouteCommandOptions): OcxResolution | null {
  return (options.resolve || resolveOcx)({ env: options.env, cwd: options.cwd });
}

export function refreshRouteSnapshot(options: RouteCommandOptions) {
  const { cwd, env = process.env, runner } = options;
  const resolved = resolvedEngine(options);
  if (!resolved) throw new Error("OpenCodex model discovery is unavailable");
  const version = runOcx(["--version"], { cwd, env, runner, resolved });
  const result = runOcx(["models", "live", "--json"], { cwd, env, runner, resolved });
  if (result.status !== 0) throw new Error(`OpenCodex model discovery failed (${result.status})`);
  let catalog: unknown;
  try { catalog = JSON.parse(result.stdout); } catch { throw new Error("OpenCodex model discovery returned invalid JSON"); }
  return publishRouteSnapshot(cwd, catalog, new Date(), { engineVersion: engineVersion(version) });
}

/**
 * Refresh only when an existing snapshot is legacy or its recorded OpenCodex
 * runtime changed. A missing snapshot remains an explicit `routes refresh`
 * precondition, and bunx is never invoked from the ordinary hot path.
 */
export function ensureRouteSnapshotFresh(options: RouteCommandOptions): void {
  const schema = routeSnapshotSchemaVersion(options.cwd);
  if (schema == null && !fs.existsSync(routeSnapshotPath(options.cwd))) return;
  const resolved = resolvedEngine(options);
  if (!resolved || resolved.source === "bunx") return;
  if (schema !== 2) {
    refreshRouteSnapshot({ ...options, resolve: () => resolved });
    return;
  }
  const snapshot = readRouteSnapshot(options.cwd);
  if (!snapshot?.engine_version) return;
  const current = runOcx(["--version"], {
    cwd: options.cwd,
    env: options.env || process.env,
    runner: options.runner,
    resolved,
  });
  const currentVersion = engineVersion(current);
  if (currentVersion && currentVersion !== snapshot.engine_version) {
    refreshRouteSnapshot({ ...options, resolve: () => resolved });
  }
}

export function runRoutes(args: string[], { cwd, stdout, env = process.env, runner, resolve }: RouteCommandOptions): number {
  const sub = args[0] || "status";
  if (sub === "refresh") {
    stdout.write(`${JSON.stringify(refreshRouteSnapshot({ cwd, stdout, env, runner, resolve }), null, 2)}\n`);
    return 0;
  }
  if (sub === "status") {
    stdout.write(`${JSON.stringify(readRouteSnapshot(cwd), null, 2)}\n`);
    return readRouteSnapshot(cwd) ? 0 : 1;
  }
  if (sub === "candidates") {
    stdout.write(`${JSON.stringify(buildRouteCandidates(cwd, artificialAnalysisDbPath(cwd)), null, 2)}\n`);
    return 0;
  }
  throw new Error("usage: baton routes refresh|status|candidates");
}
