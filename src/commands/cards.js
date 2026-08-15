import { loadConfig, saveConfig } from "../lib/config.js";
import { grokSkillInstalled, writeGrokCardAgent } from "../lib/grok-agents.js";

export function listCards(cwd) {
  return loadConfig(cwd).models;
}

export function addCard(cwd, { id, strengths }) {
  if (!id || !strengths) {
    throw new Error("cards add requires --id and --strengths");
  }
  const cfg = loadConfig(cwd);
  const existing = cfg.models.find((m) => m.id === id);
  if (existing) {
    existing.strengths = strengths;
  } else {
    cfg.models.push({ id, strengths });
  }
  saveConfig(cwd, cfg);
  if (grokSkillInstalled(cwd)) {
    const card = cfg.models.find((m) => m.id === id);
    if (card) writeGrokCardAgent(cwd, card);
  }
  return cfg.models;
}
