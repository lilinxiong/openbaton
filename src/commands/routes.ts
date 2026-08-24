import { artificialAnalysisDbPath } from "../lib/paths.js";
import { discoverCliModels, type CliModelDiscovery } from "../lib/cli-models.js";
import { loadConfig } from "../lib/config.js";
import { parseHostId, type HostId } from "../lib/hosts.js";
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
  discover?: CliModelDiscovery;
  host?: HostId;
}

export async function refreshRouteSnapshot(options: RouteCommandOptions) {
  const { cwd, env = process.env, discover = discoverCliModels } = options;
  const config = loadConfig(cwd, { env });
  const cli = options.host || config.cli.active;
  const catalog = await discover(cli, { cwd, env });
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
  discover,
  host: configuredHost,
}: RouteCommandOptions): Promise<number> {
  const flagIndex = args.indexOf("--host");
  const flagHost = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  const host = flagHost ? parseHostId(flagHost) : configuredHost;
  const sub = args[0] || "status";
  if (sub === "refresh") {
    stdout.write(`${JSON.stringify(await refreshRouteSnapshot({ cwd, stdout, env, discover, host }), null, 2)}\n`);
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
