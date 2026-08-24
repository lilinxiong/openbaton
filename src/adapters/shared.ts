import type { CodedError, UnknownRecord } from "../types.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { CliReasoningEffort, CliServiceTier } from "./contract.js";

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

export function codedError(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

export function terminate(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  if (!child.killed) child.kill("SIGTERM");
}
