import fs from "node:fs";
import { parseToml, stringifyToml } from "./toml.js";
import { projectOpsConfigPath } from "./paths.js";

export const OPS_PROFILES = ["runner", "longctx"] as const;
export type OpsProfileId = (typeof OPS_PROFILES)[number];

export const RUNNER_ACTIONS = ["test", "build", "lint", "typecheck"] as const;
export const LONGCTX_ACTIONS = ["search", "digest", "git-summarize", "git-commit"] as const;
export const OPS_ACTIONS = [...RUNNER_ACTIONS, ...LONGCTX_ACTIONS] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];

export const LONGCTX_CONTEXT_FLOOR = 900_000;
export const LONGCTX_MIN_CONTEXT_DEFAULT = 1_048_576;

export interface OpsProfile {
  route: string;
  actions: OpsAction[];
  min_context_tokens?: number;
}

export interface ProjectOpsConfig {
  runner: OpsProfile;
  longctx: OpsProfile;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  if (profile === "longctx") {
    const min = Number(raw.min_context_tokens);
    parsed.min_context_tokens = Number.isFinite(min) && min > 0 ? Math.floor(min) : LONGCTX_MIN_CONTEXT_DEFAULT;
  }
  return parsed;
}

export function emptyProjectOpsConfig(): ProjectOpsConfig {
  return {
    runner: { route: "", actions: [...RUNNER_ACTIONS] },
    longctx: { route: "", actions: [...LONGCTX_ACTIONS], min_context_tokens: LONGCTX_MIN_CONTEXT_DEFAULT },
  };
}

export function normalizeProjectOpsConfig(value: unknown): ProjectOpsConfig {
  const root = isUnknownRecord(value) ? value : {};
  const ops = isUnknownRecord(root.ops) ? root.ops : root;
  return {
    runner: profileOf("runner", ops.runner),
    longctx: profileOf("longctx", ops.longctx),
  };
}

export function loadProjectOpsConfig(cwd: string): ProjectOpsConfig {
  const file = projectOpsConfigPath(cwd);
  if (!fs.existsSync(file)) return emptyProjectOpsConfig();
  return normalizeProjectOpsConfig(parseToml(fs.readFileSync(file, "utf8")));
}

export function saveProjectOpsConfig(cwd: string, cfg: ProjectOpsConfig): string {
  const file = projectOpsConfigPath(cwd);
  const normalized = normalizeProjectOpsConfig(cfg);
  const body = stringifyToml({
    ops: {
      runner: { route: normalized.runner.route, actions: normalized.runner.actions },
      longctx: {
        route: normalized.longctx.route,
        min_context_tokens: normalized.longctx.min_context_tokens || LONGCTX_MIN_CONTEXT_DEFAULT,
        actions: normalized.longctx.actions,
      },
    },
  });
  const header = "# Project ops policy. Empty route = the director executes that class.\n# Not skill/runtime state; those stay in ~/.baton and ~/.codex.\n";
  fs.writeFileSync(file, `${header}${body}`, "utf8");
  return file;
}

export function profileForAction(cfg: ProjectOpsConfig, action: OpsAction): OpsProfileId | null {
  if (cfg.runner.actions.includes(action as (typeof RUNNER_ACTIONS)[number])) return "runner";
  if (cfg.longctx.actions.includes(action as (typeof LONGCTX_ACTIONS)[number])) return "longctx";
  return null;
}

export function configuredRoute(cfg: ProjectOpsConfig, action: OpsAction): { profile: OpsProfileId; route: string } | null {
  const profile = profileForAction(cfg, action);
  if (!profile) return null;
  const route = cfg[profile].route.trim();
  if (!route) return null;
  return { profile, route };
}
