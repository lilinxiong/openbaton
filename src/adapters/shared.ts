import type { CodedError, UnknownRecord } from "../types.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  CliReasoningEffort,
  CliRuntimeCapabilities,
  CliServiceTier,
} from "./contract.js";

export function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

export function normalizeReasoningEfforts(value: unknown): CliReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, CliReasoningEffort>();
  for (const item of value) {
    const data = record(item);
    const id = String(data?.reasoningEffort ?? data?.reasoning_effort ?? data?.id ?? item ?? "").trim();
    if (!id) continue;
    byId.set(id, {
      id,
      description: String(data?.description || "").trim(),
    });
  }
  return [...byId.values()];
}

export function normalizeServiceTiers(value: unknown): CliServiceTier[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, CliServiceTier>();
  for (const item of value) {
    const data = record(item);
    const id = String(data?.id ?? item ?? "").trim();
    if (!id) continue;
    byId.set(id, {
      id,
      name: String(data?.name || id).trim(),
      description: String(data?.description || "").trim(),
    });
  }
  return [...byId.values()];
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

export function mergeCliRuntimeCapabilities(
  current: CliRuntimeCapabilities | undefined,
  next: CliRuntimeCapabilities | undefined,
): CliRuntimeCapabilities | undefined {
  if (!current) return next;
  if (!next) return current;
  return { ...current, ...next };
}

export function codedError(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

export function terminate(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  if (!child.killed) child.kill("SIGTERM");
}
