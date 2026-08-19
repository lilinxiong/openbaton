/**
 * Model cards are the only routing input.
 * No default model. No parent-session inherit. No match → blocked.
 */

import type { CardCapabilityEvidence, ModelCard } from "../types.js";

interface CardMatchExtras {
  code?: string;
  candidates?: string[];
}

export class CardMatchError extends Error {
  readonly code: string;
  readonly candidates: string[];

  constructor(message: string, extras: CardMatchExtras = {}) {
    super(message);
    this.name = "CardMatchError";
    this.code = extras.code || "NO_CARD_MATCH";
    this.candidates = extras.candidates || [];
  }
}

export function tokenize(text: unknown): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9+>]+/i)
    .filter((t) => t.length > 1);
}

export function scoreCard(text: unknown, card: ModelCard): number {
  const hayTokens = new Set(tokenize(`${card.strengths} ${card.id}`));
  const needles = tokenize(text);
  let score = 0;
  for (const n of needles) {
    if (hayTokens.has(n)) score += 2;
    for (const h of hayTokens) {
      if (h !== n && Math.min(h.length, n.length) >= 4 && (h.includes(n) || n.includes(h))) {
        score += 1;
      }
    }
  }
  const hay = String(text || "").toLowerCase();
  for (const phrase of String(card.strengths || "").split(/[,;]/)) {
    const p = phrase.trim().toLowerCase();
    if (p.length >= 4 && hay.includes(p)) score += 4;
  }
  const capability = card.capability;
  if (capability?.ranked) score += scoreCapability(text, capability);
  return score;
}

interface TaskDimensions {
  coding: number;
  agentic: number;
  intelligence: number;
  cost: number;
  speed: number;
}

export function classifyTask(text: unknown): TaskDimensions {
  const value = String(text || "").toLowerCase();
  const hits = (pattern: RegExp) => (value.match(pattern) || []).length;
  return {
    coding: hits(/\b(code|coding|implement|implementation|fix|bug|test|refactor|build|compile|api|feature)\b/g),
    agentic: hits(/\b(repo|repository|multi-file|migrate|migration|integrate|integration|debug|investigate|workflow|tools?|long-running)\b/g),
    intelligence: hits(/\b(architecture|design|analy[sz]e|analysis|research|reason|complex|plan|strategy|review)\b/g),
    cost: hits(/\b(cheap|cost|budget|batch|bulk|routine|many|high-volume)\b/g),
    speed: hits(/\b(fast|quick|latency|interactive|small|tiny|typo|urgent)\b/g),
  };
}

function scoreCapability(text: unknown, capability: CardCapabilityEvidence): number {
  const task = classifyTask(text);
  const total = task.coding + task.agentic + task.intelligence + task.cost + task.speed;
  if (total === 0) return 0;
  const relative = capability.relative || {};
  const metric = (value: number | null, rank: number | undefined) => rank ?? (value == null ? 0 : Math.max(0, Math.min(1, value / 100)));
  const score =
    task.coding * metric(capability.coding_index, relative.coding) +
    task.agentic * metric(capability.agentic_index, relative.agentic) +
    task.intelligence * metric(capability.intelligence_index, relative.intelligence) +
    task.cost * (relative.cost_efficiency || 0) +
    task.speed * (((relative.throughput || 0) + (relative.latency || 0)) / 2);
  return Math.round(score * 100);
}

/**
 * Pick exactly one card. Ties and zeros are blocked — never a silent default.
 */
export function matchModelCard(text: unknown, cards: ModelCard[]): { model_id: string; score: number; card: ModelCard } {
  const eligible = (cards || []).filter((card) =>
    card.enabled !== false && card.executable !== false && (!card.capability || card.capability.ranked),
  );
  if (eligible.length === 0) {
    throw new CardMatchError(
      "no ranked executable cards are available. Refresh routes/capabilities or add an explicit override in ~/.baton/config.toml. baton will not invent a default model.",
      { code: "NO_CARDS" },
    );
  }
  const ranked = eligible
    .map((card) => ({ card, score: scoreCard(text, card) }))
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));

  const best = ranked[0];
  if (!best || best.score <= 0) {
    throw new CardMatchError(
      `no model card matches this unit. Describe the work in card strengths, or add a card. Refusing to inherit a parent/default model.\nunit: ${text}`,
      { code: "NO_CARD_MATCH", candidates: ranked.map((r) => r.card.id) },
    );
  }
  const tied = ranked.filter((r) => r.score === best.score);
  if (tied.length > 1) {
    throw new CardMatchError(
      `ambiguous card match (${tied.map((t) => t.card.id).join(", ")}). Narrow the unit or the strengths. No silent default.`,
      { code: "AMBIGUOUS_CARD", candidates: tied.map((t) => t.card.id) },
    );
  }
  return { model_id: best.card.id, score: best.score, card: best.card };
}

export function requireCardId(modelId: string, cards: ModelCard[]): ModelCard {
  const matches = cards.filter((c) => c.enabled !== false && (
    c.id === modelId || (!c.reasoning_effort && (c.route_id === modelId || c.route_id?.endsWith(`/${modelId}`)))
  ));
  if (matches.length > 1) {
    throw new CardMatchError(
      `model "${modelId}" matches multiple provider routes (${matches.map((card) => card.id).join(", ")}). Use an exact provider/route id.`,
      { code: "AMBIGUOUS_CARD", candidates: matches.map((card) => card.id) },
    );
  }
  const found = matches[0];
  if (!found) {
    throw new CardMatchError(
      `model "${modelId}" is not a configured card. Cards are the only routing input.`,
      { code: "UNKNOWN_CARD", candidates: cards.map((c) => c.id) },
    );
  }
  if (found.executable === false) {
    throw new CardMatchError(
      `model "${modelId}" has no executable route in the current OpenCodex snapshot.`,
      { code: "NO_EXECUTABLE_ROUTE", candidates: [found.id] },
    );
  }
  return found;
}
