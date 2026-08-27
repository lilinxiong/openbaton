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
 * Read only explicit scheduling fields from a CLI response. The discovery
 * protocol may put them directly on the response or in a capabilities table.
 * Missing or invalid values stay unknown; Baton never fills them from adapter
 * guesses here.
 */
export function normalizeCliRuntimeCapabilities(value: unknown): CliRuntimeCapabilities | undefined {
  const root = record(value);
  if (!root) return undefined;
  const nested = record(root.capabilities)
    || record(root.agentCapabilities)
    || record(root.agent_capabilities);
  const sources = nested ? [nested, root] : [root];
  let maxConcurrent: number | undefined;
  let maxDepth: number | undefined;
  for (const source of sources) {
    maxConcurrent ??= positiveInteger(
      source.max_concurrent
      ?? source.maxConcurrent
      ?? source.maxConcurrentSubagents
      ?? source.max_concurrent_subagents,
    );
    maxDepth ??= positiveInteger(source.max_depth ?? source.maxDepth);
  }
  if (maxConcurrent === undefined && maxDepth === undefined) return undefined;
  return {
    ...(maxConcurrent !== undefined ? { max_concurrent: maxConcurrent } : {}),
    ...(maxDepth !== undefined ? { max_depth: maxDepth } : {}),
  };
}
