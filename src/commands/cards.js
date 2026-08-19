import { loadConfig, saveConfig } from "../lib/config.js";
import { grokSkillInstalled, writeGrokCardAgent } from "../lib/grok-agents.js";
import { codexSkillInstalled, writeCodexCardAgent } from "../lib/codex-agents.js";

export function listCards(cwd, { env } = {}) {
  return loadConfig(cwd, { env }).models;
}

export function addCard(cwd, { id, strengths, routeId, reasoningEffort, env } = {}) {
  if (!id || !strengths) {
    throw new Error("cards add requires --id and --strengths");
  }
  const cfg = loadConfig(cwd, { env });
  const existing = cfg.models.find((m) => m.id === id);
  if (existing) {
    existing.strengths = strengths;
    if (routeId !== undefined) existing.route_id = String(routeId || "").trim() || undefined;
    if (reasoningEffort !== undefined) existing.reasoning_effort = String(reasoningEffort || "").trim() || undefined;
  } else {
    const card = { id, strengths };
    if (routeId) card.route_id = String(routeId).trim();
    if (reasoningEffort) card.reasoning_effort = String(reasoningEffort).trim();
    cfg.models.push(card);
  }
  saveConfig(cwd, cfg, { env });
  const card = cfg.models.find((m) => m.id === id);
  if (card && grokSkillInstalled(cwd, { env })) {
    writeGrokCardAgent(cwd, card, { env });
  }
  if (card && codexSkillInstalled(cwd, { env })) {
    writeCodexCardAgent(cwd, card, { env });
  }
  return cfg.models;
}
