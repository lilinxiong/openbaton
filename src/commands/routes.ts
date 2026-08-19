import { loadConfig } from "../lib/config.js";
import { artificialAnalysisDbPath } from "../lib/paths.js";
import { runOcx, type OcxResolver, type OcxRunner } from "../lib/opencodex.js";
import { buildRouteCandidates, publishRouteSnapshot, readRouteSnapshot } from "../lib/routes.js";
import type { WritableLike } from "../types.js";

export interface RouteCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
  runner?: OcxRunner;
  resolve?: OcxResolver;
}

export function runRoutes(args: string[], { cwd, stdout, env = process.env, runner, resolve }: RouteCommandOptions): number {
  const sub = args[0] || "status";
  if (sub === "refresh") {
    const result = runOcx(["models", "live", "--json"], { cwd, env, runner, resolve });
    if (result.status !== 0) throw new Error(`OpenCodex model discovery failed (${result.status})`);
    let catalog: unknown;
    try { catalog = JSON.parse(result.stdout); } catch { throw new Error("OpenCodex model discovery returned invalid JSON"); }
    stdout.write(`${JSON.stringify(publishRouteSnapshot(cwd, catalog), null, 2)}\n`);
    return 0;
  }
  if (sub === "status") {
    stdout.write(`${JSON.stringify(readRouteSnapshot(cwd), null, 2)}\n`);
    return readRouteSnapshot(cwd) ? 0 : 1;
  }
  if (sub === "candidates") {
    const cfg = loadConfig(cwd, { env });
    stdout.write(`${JSON.stringify(buildRouteCandidates(cwd, cfg.models, artificialAnalysisDbPath(cwd)), null, 2)}\n`);
    return 0;
  }
  throw new Error("usage: baton routes refresh|status|candidates");
}
