import type { ModelCard } from "../types.js";

/** The selected CLI profile's allowlist is the complete subagent policy. */
export const SUBAGENT_MODEL_POLICY_ID = "configured-cli-subagent-allowlist-v1";

/** Kept as an empty compatibility export; Baton has no hard-coded model bans. */
export const FORBIDDEN_SUBAGENT_MODEL_FAMILIES = [] as const;
export const SUBAGENT_MODEL_FAMILY_FORBIDDEN = "SUBAGENT_MODEL_FAMILY_FORBIDDEN";

export type ForbiddenSubagentModelFamily = string;

export interface SubagentModelPolicyDecision {
  allowed: true;
  code: "ALLOWED";
  family: null;
  reason: string;
}

export interface SubagentModelPolicyExclusion {
  family: string;
  card_count: number;
  routes: string[];
  code: typeof SUBAGENT_MODEL_FAMILY_FORBIDDEN;
  reason: string;
}

/** @deprecated Hard-coded family exclusions were removed with CLI-owned models. */
export class SubagentModelPolicyError extends Error {
  readonly code = SUBAGENT_MODEL_FAMILY_FORBIDDEN;
  readonly family: string;

  constructor(family: string, modelId: string) {
    super(`${SUBAGENT_MODEL_FAMILY_FORBIDDEN}: ${modelId} belongs to forbidden subagent model family ${family}`);
    this.name = "SubagentModelPolicyError";
    this.family = family;
  }
}

export function subagentModelPolicy(_routeId: unknown, _modelId?: unknown): SubagentModelPolicyDecision {
  return {
    allowed: true,
    code: "ALLOWED",
    family: null,
    reason: "model eligibility is controlled by the active CLI subagent_models allowlist",
  };
}

export function isSubagentModelAllowed(_card: Pick<ModelCard, "id" | "route_id">): boolean {
  return true;
}

export function assertSubagentModelAllowed(_routeId: unknown, _modelId?: unknown): void {}

export function summarizeSubagentModelPolicyExclusions(_cards: ModelCard[]): SubagentModelPolicyExclusion[] {
  return [];
}
