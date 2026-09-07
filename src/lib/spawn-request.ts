import { parseBrief, type WorkerBrief } from "./brief.js";
import type { NativeModelRequirements } from "./native.js";

export interface SpawnRequest {
  brief: WorkerBrief;
  selection: NativeModelRequirements;
}

function invalid(message: string): never {
  throw new Error(`WORKER_SELECTION_INVALID: ${message}`);
}

/** A plain brief inherits CLI defaults; an envelope explicitly overrides them. */
export function parseSpawnRequest(value: unknown): SpawnRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("brief" in value)) {
    return { brief: parseBrief(value), selection: {} };
  }
  const envelope = value as Record<string, unknown>;
  for (const key of Object.keys(envelope)) {
    if (key !== "brief" && key !== "selection") invalid(`unknown envelope field ${key}`);
  }
  const raw = envelope.selection === undefined ? {} : envelope.selection;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("selection must be an object");
  const selection: NativeModelRequirements = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "work_mode":
        if (value !== "execution" && value !== "implementation" && value !== "investigation") invalid("invalid work_mode");
        selection.workMode = value;
        break;
      case "model":
      case "effort":
      case "service_tier": {
        if (value !== null && (typeof value !== "string" || !value.trim())) invalid(`${key} must be a non-empty string or null`);
        const field = key === "service_tier" ? "serviceTier" : key;
        selection[field] = value === null ? undefined : (value as string).trim();
        break;
      }
      case "context_tokens":
        if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) invalid("context_tokens must be a positive integer or null");
        selection.contextTokens = value === null ? undefined : value as number;
        break;
      case "unavailable_models":
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) invalid("unavailable_models must be an array of non-empty strings");
        selection.unavailableModels = [...new Set((value as string[]).map((item) => item.trim()))];
        break;
      default:
        invalid(`unknown selection field ${key}`);
    }
  }
  return { brief: parseBrief(envelope.brief), selection };
}

export function mergeSelection(defaults: NativeModelRequirements, overrides: NativeModelRequirements): NativeModelRequirements {
  return {
    ...defaults,
    ...overrides,
    // A task cannot re-enable a model the caller already knows is unavailable.
    unavailableModels: [...new Set([...(defaults.unavailableModels || []), ...(overrides.unavailableModels || [])])],
  };
}
