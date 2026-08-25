/**
 * The only routing authority for an executable request is the director's
 * structured classification. Operation is audit metadata; it never selects
 * a profile.
 */
export type AgentExecutionClass =
  | "mechanical"
  | "long-context"
  | "general"
  | "implementation"
  | "analysis"
  | "discussion";

export interface AgentTaskClassification {
  kind: AgentExecutionClass;
  operation?: string | null;
  capabilities?: string[];
  /** Internal normalized marker; raw callers must use `capabilities`. */
  commit_only?: boolean;
}

export interface NormalizedAgentTaskClassification extends AgentTaskClassification {
  operation: string | null;
  source: "structured";
}

const CLASSES = new Set<AgentExecutionClass>([
  "mechanical",
  "long-context",
  "general",
  "implementation",
  "analysis",
  "discussion",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function capabilities(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result = value.map((item) => stringValue(item)).filter((item): item is string => item !== null);
  return result.length === value.length ? result : null;
}

/**
 * Parse the current structured contract only. Unknown keys and legacy aliases
 * are rejected so callers cannot silently fall back to prose or an older
 * wire shape.
 */
export function normalizeAgentTaskClassification(value: unknown): NormalizedAgentTaskClassification | null {
  if (typeof value === "string") {
    if (!CLASSES.has(value as AgentExecutionClass)) return null;
    return { kind: value as AgentExecutionClass, operation: null, source: "structured" };
  }
  if (!record(value)) return null;
  const allowed = new Set(["kind", "operation", "capabilities", "commit_only", "source"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (value.source !== undefined && value.source !== "structured") return null;
  if (value.commit_only !== undefined && value.source !== "structured") return null;
  if (typeof value.kind !== "string" || !CLASSES.has(value.kind as AgentExecutionClass)) return null;
  const operation = stringValue(value.operation);
  if (value.operation !== undefined && value.operation !== null && operation === null) return null;
  const rawCapabilities = capabilities(value.capabilities);
  if (rawCapabilities === null) return null;
  const explicitCommitCapability = rawCapabilities.some((item) => item === "commit");
  const normalizedCommitCapability = value.source === "structured" && value.commit_only === true;
  if (value.commit_only !== undefined && value.commit_only !== true && value.commit_only !== false) return null;
  return {
    kind: value.kind as AgentExecutionClass,
    operation,
    ...(rawCapabilities.length ? { capabilities: rawCapabilities } : {}),
    ...(explicitCommitCapability || normalizedCommitCapability ? { commit_only: true } : {}),
    source: "structured",
  };
}

/** Whether the structured class explicitly grants the commit-only capability. */
export function isCommitOnlyClassification(value: unknown): boolean {
  return normalizeAgentTaskClassification(value)?.commit_only === true;
}
