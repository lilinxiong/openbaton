import { isSubagentModelAllowed } from "./model-policy.js";
import { taskCapabilityExclusion } from "./task-suitability.js";
import { quotaForProvider } from "./provider-quotas.js";
import { quotaPoolForCandidate } from "./quota-pools.js";
import { readRouteSnapshot, type ExecutableRoute } from "./routes.js";
import type { OpsProfileId } from "./ops-config.js";
import type { CliId } from "../adapters/contract.js";
import { cliProfileForHost, loadConfig } from "./config.js";
import type { ModelCard } from "../types.js";

export interface OpsRouteChoice {
  route_id: string;
  provider: string | null;
  context_window: number | null;
  remaining_percent: number | null;
  quota_label: string | null;
}

function routeContext(route: ExecutableRoute): number | null {
  const value = Number(route.context_window);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return /\[1m\]/i.test(route.route_id) ? 1_048_576 : null;
}

function cardForRoute(cards: ModelCard[], routeId: string): ModelCard | null {
  return cards.find((card) => card.route_id === routeId && !card.reasoning_effort)
    || cards.find((card) => card.route_id === routeId)
    || null;
}

function remainingFor(
  cwd: string,
  cards: ModelCard[],
  route: ExecutableRoute,
  host?: string,
): { remaining_percent: number | null; quota_label: string | null; exhausted: boolean } {
  const snapshot = readRouteSnapshot(cwd, { host });
  if (!snapshot) return { remaining_percent: null, quota_label: null, exhausted: false };
  const card = cardForRoute(cards, route.route_id);
  const quota = quotaForProvider(snapshot, route.provider || card?.provider);
  const pool = quotaPoolForCandidate({
    model_id: card?.id || route.route_id,
    route_id: route.route_id,
    provider: route.provider || card?.provider || null,
    quota,
  });
  return {
    remaining_percent: pool.remaining_percent,
    quota_label: pool.label,
    exhausted: pool.status === "exhausted",
  };
}

function commonEligible(
  cwd: string,
  cards: ModelCard[],
  route: ExecutableRoute,
  host?: string,
): boolean {
  if (route.disabled) return false;
  const card = cardForRoute(cards, route.route_id) || {
    id: route.route_id,
    route_id: route.route_id,
    strengths: "",
    provider: route.provider,
    executable: true,
  };
  if (card.executable === false) return false;
  if (!isSubagentModelAllowed(card)) return false;
  if (taskCapabilityExclusion(card)) return false;
  return !remainingFor(cwd, cards, route, host).exhausted;
}

export function listOpsRouteChoices(
  cwd: string,
  _profile: OpsProfileId,
  cards: ModelCard[],
  { env = process.env, host }: { env?: NodeJS.ProcessEnv; host?: CliId } = {},
): OpsRouteChoice[] {
  const snapshot = readRouteSnapshot(cwd, { host, env });
  let allowed = new Set<string>();
  try {
    const config = loadConfig(cwd, { env });
    const cli = cliProfileForHost(config, host);
    if (cli.enabled && snapshot?.cli === (host || config.cli.active)) allowed = new Set(cli.subagent_models);
  } catch (error) {
    if ((error as { code?: string }).code === "BATON_NOT_INITIALIZED") return [];
    throw error;
  }
  const routes = (snapshot?.routes || []).filter((route) => allowed.has(route.route_id) && commonEligible(cwd, cards, route, host));
  // runner and longctx are user labels. They do not assert or filter model
  // capabilities such as context-window size.
  const filtered = routes;

  const unique = new Map<string, OpsRouteChoice>();
  for (const route of filtered) {
    const quota = remainingFor(cwd, cards, route, host);
    unique.set(route.route_id, {
      route_id: route.route_id,
      provider: route.provider,
      context_window: routeContext(route),
      remaining_percent: quota.remaining_percent,
      quota_label: quota.quota_label,
    });
  }
  return [...unique.values()].sort((a, b) =>
    (b.remaining_percent ?? -1) - (a.remaining_percent ?? -1)
    || a.route_id.localeCompare(b.route_id));
}

export function findOpsRouteChoice(choices: OpsRouteChoice[], routeId: string): OpsRouteChoice | null {
  return choices.find((item) => item.route_id === routeId) || null;
}
