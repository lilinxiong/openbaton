import { getCliAdapter } from "../adapters/registry.js";
import type { CliAdapterProvider } from "../adapters/contract.js";
import { parseHostId, resolveRuntimeHost, type HostId } from "../lib/hosts.js";
import {
  buildRouteCandidates,
  publishRouteSnapshot,
  readRouteSnapshot,
} from "../lib/routes.js";
import { resetRouteAvailability } from "../lib/model-availability.js";
import type { WritableLike } from "../types.js";

export interface RouteCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
  adapterProvider?: CliAdapterProvider;
  host?: HostId;
}

export async function refreshRouteSnapshot(options: RouteCommandOptions) {
  const { cwd, env = process.env } = options;
  const adapterProvider = options.adapterProvider || ((cli: string) => getCliAdapter(cli, env));
  const cli = options.host ?? resolveRuntimeHost({ cwd, env });
  const catalog = await adapterProvider(cli).discoverModels({ cwd, env });
  return publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), {
    cli,
    host: cli,
    env,
    engineVersion: catalog.version,
  });
}

export async function runRoutes(args: string[], {
  cwd,
  stdout,
  env = process.env,
  adapterProvider,
  host: configuredHost,
}: RouteCommandOptions): Promise<number> {
  const sub = args[0] || "status";
  if (!("refresh" === sub || "status" === sub || "candidates" === sub || "reset" === sub)) {
    throw new Error("usage: baton models refresh|status|candidates|reset ROUTE");
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg !== "--host") {
      const isRoute = sub === "reset" && index === 1 && !arg.startsWith("--");
      if (isRoute) continue;
      throw new Error(`unknown option: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--host requires a value");
    index += 1;
  }
  const flagIndex = args.indexOf("--host");
  const flagHost = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  const host = flagHost
    ? parseHostId(flagHost, env)
    : (configuredHost ?? resolveRuntimeHost({ cwd, env }));
  if (sub === "refresh") {
    stdout.write(`${JSON.stringify(await refreshRouteSnapshot({ cwd, stdout, env, adapterProvider, host }), null, 2)}\n`);
    return 0;
  }
  if (sub === "status") {
    const snapshot = readRouteSnapshot(cwd, { host, env });
    stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot ? 0 : 1;
  }
  if (sub === "candidates") {
    stdout.write(`${JSON.stringify(buildRouteCandidates(cwd, { host, env }), null, 2)}\n`);
    return 0;
  }
  if (sub === "reset") {
    const routeId = String(args[1] || "").trim();
    if (!routeId || routeId.startsWith("--")) {
      throw new Error("usage: baton models reset ROUTE --host HOST [--json]");
    }
    const reset = resetRouteAvailability(cwd, { host, routeId }, { env });
    const result = { host, route_id: routeId, reset };
    if (args.includes("--json")) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${reset ? "reset" : "already available"}: ${host}/${routeId}\n`);
    return 0;
  }
  throw new Error("usage: baton models refresh|status|candidates|reset ROUTE");
}
