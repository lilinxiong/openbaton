import type { ModelCard } from "../types.js";

export const SUBAGENT_MODEL_POLICY_ID = "builtin-no-gpt-5.5-gpt-5.6-sol-terra-v2";
export const SUBAGENT_MODEL_FAMILY_FORBIDDEN = "SUBAGENT_MODEL_FAMILY_FORBIDDEN";

export const FORBIDDEN_SUBAGENT_MODEL_FAMILIES = [
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const;

export type ForbiddenSubagentModelFamily = typeof FORBIDDEN_SUBAGENT_MODEL_FAMILIES[number];

export interface SubagentModelPolicyDecision {
  allowed: boolean;
  code: "ALLOWED" | typeof SUBAGENT_MODEL_FAMILY_FORBIDDEN;
  family: ForbiddenSubagentModelFamily | null;
  reason: string;
}

export interface SubagentModelPolicyExclusion {
  family: ForbiddenSubagentModelFamily;
  card_count: number;
  routes: string[];
  code: typeof SUBAGENT_MODEL_FAMILY_FORBIDDEN;
  reason: string;
}

export class SubagentModelPolicyError extends Error {
  readonly code = SUBAGENT_MODEL_FAMILY_FORBIDDEN;
  readonly family: ForbiddenSubagentModelFamily;

  constructor(family: ForbiddenSubagentModelFamily, modelId: string) {
    super(`${SUBAGENT_MODEL_FAMILY_FORBIDDEN}: ${modelId} belongs to forbidden subagent model family ${family}`);
    this.name = "SubagentModelPolicyError";
    this.family = family;
  }
}

function routeSegments(value: unknown): string[] {
  const exactRoute = String(value || "").trim().split("@", 1)[0];
  return exactRoute.split("/").filter(Boolean);
}

/**
 * Built-in subagent eligibility policy. The catalog remains visible, but every
 * provider route, variant and reasoning profile in these model families is
 * forbidden from proposal candidates, explicit selection and dispatch.
 */
export function subagentModelPolicy(routeId: unknown, modelId: unknown = routeId): SubagentModelPolicyDecision {
  const segments = [...routeSegments(routeId), ...routeSegments(modelId)];
  const family = FORBIDDEN_SUBAGENT_MODEL_FAMILIES.find((item) =>
    segments.some((segment) => segment === item || segment.startsWith(`${item}-`)),
  ) || null;
  if (!family) {
    return { allowed: true, code: "ALLOWED", family: null, reason: "model family is eligible for subagent selection" };
  }
  return {
    allowed: false,
    code: SUBAGENT_MODEL_FAMILY_FORBIDDEN,
    family,
    reason: `${family} and all provider routes, variants, and reasoning profiles in that family are forbidden for subagents`,
  };
}

export function isSubagentModelAllowed(card: Pick<ModelCard, "id" | "route_id">): boolean {
  return subagentModelPolicy(card.route_id, card.id).allowed;
}

export function assertSubagentModelAllowed(routeId: unknown, modelId: unknown = routeId): void {
  const decision = subagentModelPolicy(routeId, modelId);
  if (!decision.allowed) throw new SubagentModelPolicyError(decision.family!, String(modelId || routeId || "unknown"));
}

export function summarizeSubagentModelPolicyExclusions(cards: ModelCard[]): SubagentModelPolicyExclusion[] {
  const groups = new Map<ForbiddenSubagentModelFamily, { cards: Set<string>; routes: Set<string>; reason: string }>(
    FORBIDDEN_SUBAGENT_MODEL_FAMILIES.map((family) => [family, {
      cards: new Set<string>(),
      routes: new Set<string>(),
      reason: `${family} and all provider routes, variants, and reasoning profiles in that family are forbidden for subagents`,
    }]),
  );
  for (const card of cards) {
    if (!card.route_id || card.executable === false) continue;
    const decision = subagentModelPolicy(card.route_id, card.id);
    if (decision.allowed || !decision.family) continue;
    const group = groups.get(decision.family) || { cards: new Set<string>(), routes: new Set<string>(), reason: decision.reason };
    group.cards.add(card.id);
    group.routes.add(card.route_id);
    groups.set(decision.family, group);
  }
  return [...groups.entries()].map(([family, group]): SubagentModelPolicyExclusion => ({
    family,
    card_count: group.cards.size,
    routes: [...group.routes].sort(),
    code: SUBAGENT_MODEL_FAMILY_FORBIDDEN,
    reason: group.reason,
  })).sort((a, b) => a.family.localeCompare(b.family));
}
