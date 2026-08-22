/**
 * Model cards are derived only from the active CLI's configured allowlist.
 * No parent-session inheritance and no model outside that allowlist.
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
    coding: hits(/\b(code|coding|implement|implementation|fix|bug|test|refactor|build|compile|api|feature)\b|实现|开发|修复|测试|重构|编译|构建|接口|功能|代码/g),
    agentic: hits(/\b(repo|repository|multi-file|migrate|migration|integrate|integration|debug|investigate|workflow|tools?|long-running)\b|仓库|多文件|迁移|集成|调试|排查|工作流|工具|长时间/g),
    intelligence: hits(/\b(architecture|design|analy[sz]e|analysis|research|reason|complex|plan|strategy|review|verify|validate|audit|calculate|reconcile|recommend|priority|trade-?offs?|evidence|report)\b|架构|设计|分析|研究|推理|复杂|计划|策略|审查|验证|校验|审计|计算|建议|优先级|权衡|证据|报告/g),
    cost: hits(/\b(cheap|cost|budget|batch|bulk|routine|many|high-volume)\b|便宜|成本|预算|批量|常规|大量|高并发/g),
    speed: hits(/\b(fast|quick|latency|interactive|small|tiny|typo|urgent)\b|快速|低延迟|交互|小型|紧急|尽快|简单/g),
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
 * Pick exactly one configured card. Ties are resolved deterministically so
 * runtime routing never opens a human model selector.
 */
export function matchModelCard(text: unknown, cards: ModelCard[]): { model_id: string; score: number; card: ModelCard } {
  const ranked = rankModelCards(text, cards);
  const eligible = ranked.map((item) => item.card);
  if (eligible.length === 0) {
    throw new CardMatchError(
      "no enabled CLI subagent models are configured. Run `baton config`.",
      { code: "NO_CARDS" },
    );
  }
  const best = ranked[0];
  if (!best) throw new CardMatchError("no configured CLI model matched", { code: "NO_CARD_MATCH" });
  return { model_id: best.card.id, score: best.score, card: best.card };
}

/** Deterministic automatic ordering over the configured candidate set. */
export function rankModelCards(text: unknown, cards: ModelCard[]): Array<{ card: ModelCard; score: number }> {
  return (cards || [])
    .filter((card) => card.executable !== false)
    .map((card) => ({ card, score: scoreCard(text, card) }))
    .sort((a, b) => b.score - a.score
      || Number(b.card.is_default) - Number(a.card.is_default)
      || a.card.id.localeCompare(b.card.id));
}

export function requireCardId(modelId: string, cards: ModelCard[]): ModelCard {
  const found = cards.find((card) => card.id === modelId);
  if (!found) {
    throw new CardMatchError(
      `model "${modelId}" is not in the active CLI subagent candidate set.`,
      { code: "UNKNOWN_CARD", candidates: cards.map((c) => c.id) },
    );
  }
  if (found.executable === false) {
    throw new CardMatchError(
      `model "${modelId}" is not available in the active CLI model catalog.`,
      { code: "NO_EXECUTABLE_ROUTE", candidates: [found.id] },
    );
  }
  return found;
}
