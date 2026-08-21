import { isSubagentModelAllowed } from "./model-policy.js";
import { taskCapabilityExclusion } from "./task-suitability.js";
import { quotaForProvider } from "./provider-quotas.js";
import { quotaPoolForCandidate } from "./quota-pools.js";
import { readRouteSnapshot, type ExecutableRoute } from "./routes.js";
import { LONGCTX_CONTEXT_FLOOR, type OpsProfileId } from "./ops-config.js";
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

export function isLongContextRoute(route: ExecutableRoute): boolean {
  const context = routeContext(route);
  return context != null && context >= LONGCTX_CONTEXT_FLOOR;
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
): { remaining_percent: number | null; quota_label: string | null; exhausted: boolean } {
  const snapshot = readRouteSnapshot(cwd);
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
  return !remainingFor(cwd, cards, route).exhausted;
}

export function listOpsRouteChoices(
  cwd: string,
  profile: OpsProfileId,
  cards: ModelCard[],
): OpsRouteChoice[] {
  const snapshot = readRouteSnapshot(cwd);
  const routes = (snapshot?.routes || []).filter((route) => commonEligible(cwd, cards, route));
  const filtered = profile === "longctx"
    ? routes.filter(isLongContextRoute)
    : routes.filter((route) => !isLongContextRoute(route));

  const unique = new Map<string, OpsRouteChoice>();
  for (const route of filtered) {
    const quota = remainingFor(cwd, cards, route);
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
