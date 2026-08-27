import type { CliRuntimeCapabilities } from "./contract.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

/**
 * Capability names accepted at the adapter boundary. The first spelling is
 * canonical; the remaining names are legacy discovery spellings and must not
 * leak into the public `CliRuntimeCapabilities` shape.
 */
const MAX_CONCURRENT_SUBAGENT_KEYS = [
  "max_concurrent_subagents",
  "maxConcurrentSubagents",
  "max_concurrent",
  "maxConcurrent",
] as const;

function firstPositiveInteger(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = positiveInteger(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Read only explicit scheduling fields from a CLI response. The discovery
 * protocol may put them directly on the response or in a capabilities table.
 * Missing or invalid values stay unknown; Baton never fills them from adapter
 * guesses here.
 */
export function normalizeCliRuntimeCapabilities(value: unknown): CliRuntimeCapabilities | undefined {
  const root = record(value);
  if (!root) return undefined;
  // Keep the established precedence (nested capability tables before direct
  // response fields), while checking every known table rather than dropping
  // a capability just because an earlier table only reports max_depth.
  const sources = [
    record(root.capabilities),
    record(root.agentCapabilities),
    record(root.agent_capabilities),
    root,
  ].filter((source): source is Record<string, unknown> => source !== null);
  let maxConcurrentSubagents: number | undefined;
  let maxDepth: number | undefined;
  for (const source of sources) {
    maxConcurrentSubagents ??= firstPositiveInteger(source, MAX_CONCURRENT_SUBAGENT_KEYS);
    maxDepth ??= firstPositiveInteger(source, ["max_depth", "maxDepth"]);
  }
  if (maxConcurrentSubagents === undefined && maxDepth === undefined) return undefined;
  return {
    ...(maxConcurrentSubagents !== undefined ? { max_concurrent_subagents: maxConcurrentSubagents } : {}),
    ...(maxDepth !== undefined ? { max_depth: maxDepth } : {}),
  };
}
