export type WorkerBriefMode = "read-only" | "write";

export interface WorkerBriefHandoff {
  existingChanges?: string;
  checks?: string;
  unresolvedIssues?: string;
}

export interface WorkerBrief {
  goal: string;
  decisions: string[];
  scope: string[];
  acceptance: string[];
  context: string[];
  constraints: string[];
  mode: WorkerBriefMode;
  handoff?: WorkerBriefHandoff;
}

const MAX_TEXT_LENGTH = 20_000;
const MAX_LIST_ITEMS = 128;

function invalid(path: string, message: string): never {
  throw new Error(`WORKER_BRIEF_INVALID: ${path} ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("brief", "must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, required = false): string | undefined {
  if (value === undefined) {
    if (required) invalid(path, "is required");
    return undefined;
  }
  if (typeof value !== "string") invalid(path, "must be a string");
  if (!value.trim()) invalid(path, "must not be empty");
  if (value.length > MAX_TEXT_LENGTH) invalid(path, `must be at most ${MAX_TEXT_LENGTH} characters`);
  return value;
}

function textList(value: unknown, path: string, required = false): string[] {
  if (value === undefined) {
    if (required) invalid(path, "is required");
    return [];
  }
  if (!Array.isArray(value)) invalid(path, "must be an array of strings");
  if (required && value.length === 0) invalid(path, "must not be empty");
  if (value.length > MAX_LIST_ITEMS) invalid(path, `must contain at most ${MAX_LIST_ITEMS} items`);
  return value.map((item, index) => text(item, `${path}[${index}]`, true)!);
}

function scopeList(value: unknown): string[] {
  const scope = textList(value, "scope");
  for (const [index, item] of scope.entries()) {
    if (item.startsWith("/") || item.startsWith("\\") || /^[A-Za-z]:/.test(item) || item.includes("\0")) {
      invalid(`scope[${index}]`, "must be a relative module or directory path");
    }
    if (item.split(/[\\/]+/).includes("..")) invalid(`scope[${index}]`, "must not contain '..'");
  }
  return scope;
}

function handoff(value: unknown): WorkerBriefHandoff | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  for (const key of Object.keys(input)) if (!["existingChanges", "checks", "unresolvedIssues"].includes(key)) invalid(`handoff.${key}`, "is not a supported field");
  const result: WorkerBriefHandoff = {};
  const existingChanges = text(input.existingChanges, "handoff.existingChanges");
  const checks = text(input.checks, "handoff.checks");
  const unresolvedIssues = text(input.unresolvedIssues, "handoff.unresolvedIssues");
  if (existingChanges !== undefined) result.existingChanges = existingChanges;
  if (checks !== undefined) result.checks = checks;
  if (unresolvedIssues !== undefined) result.unresolvedIssues = unresolvedIssues;
  return Object.keys(result).length ? result : undefined;
}

export function parseBrief(value: unknown): WorkerBrief {
  const input = record(value);
  const fields = new Set(["goal", "decisions", "scope", "acceptance", "context", "constraints", "mode", "handoff"]);
  for (const key of Object.keys(input)) if (!fields.has(key)) invalid(key, "is not a supported field");
  const mode = input.mode === undefined ? "read-only" : input.mode;
  if (mode !== "read-only" && mode !== "write") invalid("mode", "must be 'read-only' or 'write'");
  const scope = scopeList(input.scope);
  if (mode === "write" && !scope.length) invalid("scope", "is required when mode is 'write'");
  const parsedHandoff = handoff(input.handoff);
  return {
    goal: text(input.goal, "goal", true)!,
    decisions: textList(input.decisions, "decisions"),
    scope,
    acceptance: textList(input.acceptance, "acceptance", true),
    context: textList(input.context, "context"),
    constraints: textList(input.constraints, "constraints"),
    mode,
    ...(parsedHandoff ? { handoff: parsedHandoff } : {}),
  };
}

function section(title: string, items: string[]): string[] {
  return items.length ? [`${title}:`, ...items.map((item) => `- ${item}`), ""] : [];
}

export function formatBrief(brief: WorkerBrief): string {
  const lines = [
    "[Baton worker brief]",
    "This brief is the complete task context. Do not assume access to or rely on the full parent conversation.",
    "Execute the decisions already made below. Return any decision outside this brief's boundary to the root agent.",
    "Do not commit or push.",
    "",
    `Goal: ${brief.goal}`,
    `Mode: ${brief.mode}`,
    "",
    ...section("Established decisions", brief.decisions),
    ...section("Scope", brief.scope),
    ...section("Acceptance criteria", brief.acceptance),
    ...section("Context", brief.context),
    ...section("Constraints", brief.constraints),
  ];
  if (brief.handoff) {
    lines.push("Handoff:");
    if (brief.handoff.existingChanges) lines.push(`Existing changes: ${brief.handoff.existingChanges}`);
    if (brief.handoff.checks) lines.push(`Checks: ${brief.handoff.checks}`);
    if (brief.handoff.unresolvedIssues) lines.push(`Unresolved issues: ${brief.handoff.unresolvedIssues}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
