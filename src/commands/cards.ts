import { loadConfig, saveConfig, type Card, type ConfigEnvOptions } from "../lib/config.js";
import { codexSkillInstalled, syncCodexCardAgents } from "../lib/codex-agents.js";
import { buildRouteCandidates } from "../lib/routes.js";
import { artificialAnalysisDbPath } from "../lib/paths.js";

export interface ListCardsOptions extends ConfigEnvOptions {}

export interface AddCardOptions extends ConfigEnvOptions {
  id?: string;
  strengths?: string;
  routeId?: string;
  reasoningEffort?: string;
  enabled?: boolean;
}

function optionalFlag(value: string | undefined): string | undefined {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : undefined;
}

export function listCards(cwd: string, options: ListCardsOptions = {}): Card[] {
  const cfg = loadConfig(cwd, { env: options.env });
  return buildRouteCandidates(cwd, cfg.models, artificialAnalysisDbPath(cwd)).map((candidate) => candidate.card);
}

export function addCard(cwd: string, options: AddCardOptions = {}): Card[] {
  const { id, strengths, routeId, reasoningEffort, enabled, env } = options;
  if (!id) throw new Error("cards add requires --id");
  const cfg = loadConfig(cwd, { env });
  const existing = cfg.models.find((model) => model.id === id);
  if (existing) {
    if (strengths !== undefined) existing.strengths = strengths;
    if (routeId !== undefined) {
      const nextRoute = optionalFlag(routeId);
      if (nextRoute) existing.route_id = nextRoute;
      else delete existing.route_id;
    }
    if (reasoningEffort !== undefined) {
      const nextEffort = optionalFlag(reasoningEffort);
      if (nextEffort) existing.reasoning_effort = nextEffort;
      else delete existing.reasoning_effort;
    }
    if (enabled !== undefined) existing.enabled = enabled;
  } else {
    const card: Card = { id, strengths: strengths || "" };
    const nextRoute = optionalFlag(routeId);
    const nextEffort = optionalFlag(reasoningEffort);
    if (nextRoute) card.route_id = nextRoute;
    if (nextEffort) card.reasoning_effort = nextEffort;
    if (enabled !== undefined) card.enabled = enabled;
    cfg.models.push(card);
  }
  saveConfig(cwd, cfg, { env });
  if (codexSkillInstalled(cwd, { env })) syncCodexCardAgents(cwd, cfg.models, { env });
  return listCards(cwd, { env });
}
