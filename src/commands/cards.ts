import { loadConfig, saveConfig, type Card, type ConfigEnvOptions } from "../lib/config.js";
import { grokSkillInstalled, writeGrokCardAgent } from "../lib/grok-agents.js";
import { codexSkillInstalled, writeCodexCardAgent } from "../lib/codex-agents.js";

export interface ListCardsOptions extends ConfigEnvOptions {}

export interface AddCardOptions extends ConfigEnvOptions {
  id?: string;
  strengths?: string;
  routeId?: string;
  reasoningEffort?: string;
}

function optionalFlag(value: string | undefined): string | undefined {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : undefined;
}

export function listCards(cwd: string, options: ListCardsOptions = {}): Card[] {
  return loadConfig(cwd, { env: options.env }).models;
}

export function addCard(cwd: string, options: AddCardOptions = {}): Card[] {
  const { id, strengths, routeId, reasoningEffort, env } = options;
  if (!id || !strengths) {
    throw new Error("cards add requires --id and --strengths");
  }
  const cfg = loadConfig(cwd, { env });
  const existing = cfg.models.find((model) => model.id === id);
  if (existing) {
    existing.strengths = strengths;
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
  } else {
    const card: Card = { id, strengths };
    const nextRoute = optionalFlag(routeId);
    const nextEffort = optionalFlag(reasoningEffort);
    if (nextRoute) card.route_id = nextRoute;
    if (nextEffort) card.reasoning_effort = nextEffort;
    cfg.models.push(card);
  }
  saveConfig(cwd, cfg, { env });
  const card = cfg.models.find((model) => model.id === id);
  if (card && grokSkillInstalled(cwd, { env })) {
    writeGrokCardAgent(cwd, card, { env });
  }
  if (card && codexSkillInstalled(cwd, { env })) {
    writeCodexCardAgent(cwd, card, { env });
  }
  return cfg.models;
}
