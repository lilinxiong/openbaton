import { artificialAnalysisDbPath } from "../lib/paths.js";
import { getCliAdapter } from "../adapters/registry.js";
import type { CliAdapterProvider } from "../adapters/contract.js";
import { parseHostId, resolveRuntimeHost, type HostId } from "../lib/hosts.js";
import {
  buildRouteCandidates,
  publishRouteSnapshot,
  readRouteSnapshot,
} from "../lib/routes.js";
import type { WritableLike } from "../types.js";

export interface RouteCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
  adapterProvider?: CliAdapterProvider;
  host?: HostId;
}

export async function refreshRouteSnapshot(options: RouteCommandOptions) {
  const { cwd, env = process.env, adapterProvider = getCliAdapter } = options;
  const cli = options.host ?? resolveRuntimeHost({ cwd, env });
  const catalog = await adapterProvider(cli).discoverModels({ cwd, env });
  return publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), {
    cli,
    host: cli,
    env,
    engineVersion: catalog.version,
    providerQuotas: [],
    quotaRefreshError: null,
  });
}

/**
 * Ordinary commands consume the catalog captured by `baton config`. Refresh is
 * explicit so a command never launches a different CLI behind the user's back.
 */
export function ensureRouteSnapshotFresh(_options: RouteCommandOptions): void {}

export async function runRoutes(args: string[], {
  cwd,
  stdout,
  env = process.env,
  adapterProvider,
  host: configuredHost,
}: RouteCommandOptions): Promise<number> {
  const flagIndex = args.indexOf("--host");
  const flagHost = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  const host = flagHost
    ? parseHostId(flagHost)
    : (configuredHost ?? resolveRuntimeHost({ cwd, env }));
  const sub = args[0] || "status";
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
    stdout.write(`${JSON.stringify(buildRouteCandidates(cwd, artificialAnalysisDbPath(cwd), { host, env }), null, 2)}\n`);
    return 0;
  }
  throw new Error("usage: baton models refresh|status|candidates");
}
