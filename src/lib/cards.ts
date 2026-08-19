/**
 * Model cards are the only routing input.
 * No default model. No parent-session inherit. No match → blocked.
 */

import type { ModelCard } from "../types.js";

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
  return score;
}

/**
 * Pick exactly one card. Ties and zeros are blocked — never a silent default.
 */
export function matchModelCard(text: unknown, cards: ModelCard[]): { model_id: string; score: number; card: ModelCard } {
  if (!cards || cards.length === 0) {
    throw new CardMatchError(
      "no model cards configured. Add cards with `baton cards add` or edit .baton/config.toml. baton will not invent a default model.",
      { code: "NO_CARDS" },
    );
  }
  const ranked = cards
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
  const found = cards.find((c) => c.id === modelId);
  if (!found) {
    throw new CardMatchError(
      `model "${modelId}" is not a configured card. Cards are the only routing input.`,
      { code: "UNKNOWN_CARD", candidates: cards.map((c) => c.id) },
    );
  }
  return found;
}
