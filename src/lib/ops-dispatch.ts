import { execFileSync } from "node:child_process";
import { canonicalWorkspaceRoot } from "./paths.js";
import { loadConfig } from "./config.js";
import { configuredRoute, type OpsAction, type OpsProfileId } from "./ops-config.js";
import { inferOpsAction } from "./ops-task.js";
import { findOpsRouteChoice, listOpsRouteChoices } from "./ops-routes.js";
import { readRouteSnapshot } from "./routes.js";
import type { ModelCard, ModelSelectionApproval } from "../types.js";

export type OpsResolution =
  | { kind: "not-ops" }
  | { kind: "director"; action: OpsAction; reason: string }
  | { kind: "empty-index"; action: "git-commit" }
  | { kind: "unavailable"; action: OpsAction; profile: OpsProfileId; route: string; reason: string }
  | {
    kind: "dispatch";
    action: OpsAction;
    profile: OpsProfileId;
    route: string;
    card: ModelCard;
    approval: ModelSelectionApproval;
  };

export function hasStagedDiff(cwd: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: canonicalWorkspaceRoot(cwd),
      stdio: "ignore",
    });
    return false;
  } catch (error) {
    return (error as { status?: number }).status === 1;
  }
}

function cardForRoute(cards: ModelCard[], routeId: string, cwd: string): ModelCard | null {
  const snapshot = readRouteSnapshot(cwd);
  const route = snapshot?.routes.find((item) => item.route_id === routeId);
  const preferred = route?.default_reasoning_effort;
  const effort = preferred && route?.reasoning_efforts.includes(preferred) ? preferred : route?.reasoning_efforts[0];
  return (effort && cards.find((card) => card.route_id === routeId && card.reasoning_effort === effort))
    || cards.find((card) => card.route_id === routeId && !card.reasoning_effort)
    || cards.find((card) => card.route_id === routeId)
    || null;
}

export function resolveOpsDispatch(
  cwd: string,
  description: unknown,
  cards: ModelCard[],
  { env }: { env?: NodeJS.ProcessEnv } = {},
): OpsResolution {
  const action = inferOpsAction(description);
  if (!action) return { kind: "not-ops" };
  const configured = configuredRoute(loadConfig(cwd, { env }).ops, action);
  if (!configured) {
    return { kind: "director", action, reason: "ops route is empty; director executes this mechanical unit" };
  }
  if (action === "git-commit" && !hasStagedDiff(cwd)) return { kind: "empty-index", action };
  const choices = listOpsRouteChoices(cwd, configured.profile, cards);
  if (!findOpsRouteChoice(choices, configured.route)) {
    return {
      kind: "unavailable",
      action,
      profile: configured.profile,
      route: configured.route,
      reason: `OPS_ROUTE_UNAVAILABLE: ${configured.profile} route ${configured.route} is not executable in the synced OpenCodex snapshot`,
    };
  }
  const card = cardForRoute(cards, configured.route, cwd);
  if (!card?.route_id) {
    return {
      kind: "unavailable",
      action,
      profile: configured.profile,
      route: configured.route,
      reason: `OPS_ROUTE_UNAVAILABLE: no card for ${configured.route}`,
    };
  }
  const approval: ModelSelectionApproval = {
    proposal_id: "ops-config",
    approval_id: `ops-${configured.profile}-${action}`,
    approved_at: new Date().toISOString(),
    confirmed_by: "ops-config",
    catalog_fingerprint: readRouteSnapshot(cwd)?.fingerprint || "",
    recommended_model_id: card.id,
    selected_model_id: card.id,
    changed_by_user: false,
    ops_profile: configured.profile,
    ops_action: action,
  };
  return {
    kind: "dispatch",
    action,
    profile: configured.profile,
    route: configured.route,
    card,
    approval,
  };
}
