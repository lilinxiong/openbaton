export const OPS_PROFILES = ["runner", "longctx"] as const;
export type OpsProfileId = (typeof OPS_PROFILES)[number];

export const RUNNER_ACTIONS = ["test", "build", "lint", "typecheck", "git-commit"] as const;
export const LONGCTX_ACTIONS = ["search", "digest", "git-summarize"] as const;
export const OPS_ACTIONS = [...RUNNER_ACTIONS, ...LONGCTX_ACTIONS] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];

export interface OpsProfile {
  route: string;
  actions: OpsAction[];
}

export interface OpsConfig {
  runner: OpsProfile;
  longctx: OpsProfile;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function actionsOf(profile: OpsProfileId, value: unknown): OpsAction[] {
  const allowed = new Set<string>(profile === "runner" ? RUNNER_ACTIONS : LONGCTX_ACTIONS);
  const raw = Array.isArray(value) ? value : [...allowed];
  const actions = [...new Set(raw.map((item) => String(item || "").trim()).filter((item) => allowed.has(item)))] as OpsAction[];
  return actions.length ? actions : [...allowed] as OpsAction[];
}

function profileOf(profile: OpsProfileId, value: unknown): OpsProfile {
  const raw = isUnknownRecord(value) ? value : {};
  const route = typeof raw.route === "string" ? raw.route.trim() : "";
  const parsed: OpsProfile = {
    route,
    actions: actionsOf(profile, raw.actions),
  };
  return parsed;
}

export function emptyOpsConfig(): OpsConfig {
  return {
    runner: { route: "", actions: [...RUNNER_ACTIONS] },
    longctx: { route: "", actions: [...LONGCTX_ACTIONS] },
  };
}

export function normalizeOpsConfig(value: unknown): OpsConfig {
  const ops = isUnknownRecord(value) ? value : {};
  const runnerRaw = isUnknownRecord(ops.runner) ? { ...ops.runner } : {};
  const longctxRaw = isUnknownRecord(ops.longctx) ? ops.longctx : {};
  const runnerActions = stringList(runnerRaw.actions);
  const longctxActions = stringList(longctxRaw.actions);
  if (longctxActions?.includes("git-commit") && runnerActions && !runnerActions.includes("git-commit")) {
    runnerRaw.actions = [...runnerActions, "git-commit"];
  }
  return {
    runner: profileOf("runner", runnerRaw),
    longctx: profileOf("longctx", longctxRaw),
  };
}

export function profileForAction(cfg: OpsConfig, action: OpsAction): OpsProfileId | null {
  if (cfg.runner.actions.includes(action as (typeof RUNNER_ACTIONS)[number])) return "runner";
  if (cfg.longctx.actions.includes(action as (typeof LONGCTX_ACTIONS)[number])) return "longctx";
  return null;
}

export function configuredRoute(cfg: OpsConfig, action: OpsAction): { profile: OpsProfileId; route: string } | null {
  const profile = profileForAction(cfg, action);
  if (!profile) return null;
  const route = cfg[profile].route.trim();
  if (!route) return null;
  return { profile, route };
}
