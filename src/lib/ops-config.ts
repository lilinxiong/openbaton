export const OPS_PROFILES = ["runner", "longctx"] as const;
export type OpsProfileId = (typeof OPS_PROFILES)[number];

/** A configured route label for one director-supplied execution class. */
export interface OpsProfile {
  route: string;
}

export interface OpsConfig {
  runner: OpsProfile;
  longctx: OpsProfile;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function profileOf(value: unknown): OpsProfile {
  const raw = isUnknownRecord(value) ? value : {};
  return { route: typeof raw.route === "string" ? raw.route.trim() : "" };
}

export function emptyOpsConfig(): OpsConfig {
  return {
    runner: { route: "" },
    longctx: { route: "" },
  };
}

export function normalizeOpsConfig(value: unknown): OpsConfig {
  const ops = isUnknownRecord(value) ? value : {};
  return {
    runner: profileOf(ops.runner),
    longctx: profileOf(ops.longctx),
  };
}

/** Resolve the profile from the director's structured execution class only. */
export function profileForClassification(classification: unknown): OpsProfileId | null {
  if (classification === "mechanical") return "runner";
  if (classification === "long-context") return "longctx";
  return null;
}

export function configuredRouteForClassification(
  cfg: OpsConfig,
  classification: string,
): { profile: OpsProfileId; route: string } | null {
  const profile = profileForClassification(classification);
  if (!profile) return null;
  const route = cfg[profile].route.trim();
  return route ? { profile, route } : null;
}
