/**
 * Minimum model requirement derivation and task-size estimation. Split from
 * selection.ts (leaf module; type-only imports point back).
 */
import type { UnknownRecord } from "../../types.js";
import { canonicalCapability } from "./candidates.js";
import { classifyTask } from "../cards.js";
import {
  COMPLEXITY_VALUES,
  EFFORT_VALUES,
  RequirementValue,
  SelectionUnit
} from "../selection.js";
import type {
  MinimumModelRequirements,
  MinimumModelRequirementsInput,
  SelectionCodeScope,
  SelectionRequirementEvidence,
  TaskComplexityEstimate,
  TaskContextEstimate,
} from "../selection.js";

export function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => {
      if (typeof item === "string" || typeof item === "number") return String(item).trim();
      const record = recordValue(item);
      return String(record?.id ?? record?.name ?? record?.capability ?? record?.kind ?? record?.path ?? record?.value ?? "").trim();
    }).filter(Boolean))].sort();
  }
  if (value && typeof value === "object") {
    return Object.entries(value as UnknownRecord)
      .filter(([, enabled]) => enabled === true || typeof enabled === "string")
      .map(([key, enabled]) => typeof enabled === "string" && enabled.trim() ? enabled.trim() : key)
      .filter(Boolean)
      .sort();
  }
  return [];
}

export function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.trim().toLowerCase() === "true") return true;
      if (value.trim().toLowerCase() === "false") return false;
    }
    const record = recordValue(value);
    const nested = record && (record.required ?? record.enabled ?? record.supported ?? record.value);
    if (typeof nested === "boolean") return nested;
  }
  return null;
}

export function normalizedRequirementString(value: unknown): string | null {
  const record = recordValue(value);
  const nested = record && (record.minimum ?? record.minimum_effort ?? record.effort ?? record.level
    ?? record.scope ?? record.kind ?? record.type ?? record.value ?? record.name ?? record.id);
  const text = String(nested ?? value ?? "").trim().toLowerCase().replaceAll(/[_ ]+/g, "-");
  return text || null;
}

export function inferCodeScope(text: string, input: MinimumModelRequirementsInput): SelectionCodeScope {
  const explicitValue = input.code_scope ?? input.codeScope ?? input.scope;
  const explicit = normalizedRequirementString(explicitValue);
  if (explicit) {
    if (explicit === "repo" || explicit === "repository" || explicit === "codebase" || explicit === "repository-wide") return "repository-wide";
    if (explicit === "single" || explicit === "single-file" || explicit === "file") return "single-file";
    if (explicit === "multi" || explicit === "multi-file" || explicit === "multiple-files") return "multi-file";
    if (explicit === "none" || explicit === "unspecified" || explicit === "unknown") return "unspecified";
  }
  const value = text.toLowerCase();
  const pathValues = [
    ...stringArray(input.write_paths),
    ...stringArray(input.files),
    ...stringArray(input.paths),
    ...stringArray(input.writePaths),
    ...stringArray(input.filePaths),
    ...stringArray(input.code_paths),
    ...stringArray(input.codePaths),
    ...stringArray(input.code_scope && typeof input.code_scope === "object" ? input.code_scope : undefined),
  ];
  if (pathValues.length > 1) return "multi-file";
  if (/\b(?:whole|entire|all|repository|repo|codebase)[ -]?wide\b|\b(?:monorepo|whole repo|entire repository|entire codebase)\b|全仓(?:库)?|整个仓库|跨模块/.test(value)) return "repository-wide";
  if (/\b(?:multi[- ]file|multiple files|several files|cross[- ]module)\b|多文件|跨模块/.test(value)) return "multi-file";
  if (pathValues.length === 1 || /(?:^|[\s`'"(])(?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|mjs|cjs|java|kt|kts|swift|go|rs|py|rb|php|cpp|cc|h|hpp|md|json|yaml|yml)(?:$|[\s`'"),.:])/.test(value)) return "single-file";
  return "unspecified";
}

export function inferExecutionMode(input: MinimumModelRequirementsInput): string | null {
  const execution = recordValue(input.execution) || recordValue(input.execution_requirements) || recordValue(input.executionRequirements);
  const explicit = normalizedRequirementString(input.execution_mode || input.executionMode || input.execution_mode_name || input.executionModeName
    || input.mode || execution?.execution_mode || execution?.executionMode || execution?.mode);
  if (explicit) return explicit;
  if (input.commit_only === true || input.commitOnly === true || execution?.commit_only === true || execution?.commitOnly === true) return "commit-only";
  if (input.read_only === true || input.readOnly === true || execution?.read_only === true || execution?.readOnly === true) return "read-only";
  if (stringArray(input.write_paths).length || stringArray(input.writePaths).length || stringArray(input.files).length
    || stringArray(execution?.write_paths).length || stringArray(execution?.writePaths).length) return "write";
  return null;
}

export function capabilityNames(input: MinimumModelRequirementsInput): string[] {
  const execution = recordValue(input.execution) || recordValue(input.execution_requirements) || recordValue(input.executionRequirements);
  return stringArray(
    input.required_execution_capabilities
      || input.requiredExecutionCapabilities
      || input.execution_capabilities
      || input.executionCapabilities
      || execution?.required_execution_capabilities
      || execution?.requiredExecutionCapabilities
      || execution?.capabilities,
  ).map(canonicalCapability);
}

export function otherRequirementNames(input: MinimumModelRequirementsInput): string[] {
  const execution = recordValue(input.execution) || recordValue(input.execution_requirements) || recordValue(input.executionRequirements);
  return [...new Set(stringArray(
    input.other_execution_requirements
      || input.otherExecutionRequirements
      || input.other_requirements
      || input.otherRequirements
      || input.other
      || input.requirements
      || execution?.other_execution_requirements
      || execution?.otherExecutionRequirements
      || execution?.other
      || execution?.requirements,
  ))].sort();
}

export function evidenceEntry(
  field: string,
  value: RequirementValue,
  source: string,
  detail: string,
): SelectionRequirementEvidence {
  return { field, value, source, detail };
}

/**
 * Derive the immutable minimum route contract from task text and optional
 * execution metadata.  The fixed evidence order and sorted list fields make
 * repeated derivation byte-stable and suitable for proposal persistence.
 */
export function deriveMinimumModelRequirements(
  text: unknown,
  overrides: MinimumModelRequirementsInput = {},
): MinimumModelRequirements {
  const taskRecord = recordValue(text);
  const value = taskRecord
    ? String(taskRecord.prompt || taskRecord.description || taskRecord.text || taskRecord.objective || "")
    : String(text || "");
  if (taskRecord) overrides = { ...taskRecord, ...overrides };
  const complexityEstimate = estimateTaskComplexity(value);
  const contextEstimate = estimateTaskContext(value);
  const metadata = recordValue(overrides.metadata) || {};
  const merged = { ...metadata, ...overrides } as MinimumModelRequirementsInput;
  const complexityRaw = normalizedRequirementString(merged.complexity ?? merged.task_complexity ?? merged.complexity_class ?? merged.complexity_reason);
  const complexity = complexityRaw && COMPLEXITY_VALUES.has(complexityRaw as SelectionUnit["complexity_reason"])
    ? complexityRaw as SelectionUnit["complexity_reason"]
    : complexityEstimate.reason;
  const effortRaw = normalizedRequirementString(merged.reasoning_effort || merged.reasoning || merged.minimum_reasoning_effort
    || merged.minimumReasoningEffort || merged.required_reasoning_effort || merged.requiredReasoningEffort);
  const reasoning = effortRaw && EFFORT_VALUES.has(effortRaw as SelectionUnit["target_reasoning_effort"])
    ? effortRaw as SelectionUnit["target_reasoning_effort"]
    : complexityEstimate.effort;
  const explicitContextRaw = merged.estimated_context_tokens
    ?? merged.estimatedContextTokens
    ?? merged.estimated_context
    ?? merged.context_tokens
    ?? merged.contextTokens
    ?? merged.estimated_context_length
    ?? merged.estimatedContextLength
    ?? merged.required_context_tokens
    ?? merged.requiredContextTokens;
  const explicitContext = Number(explicitContextRaw);
  const estimatedContextTokens = Number.isFinite(explicitContext) && explicitContext > 0
    ? Math.floor(explicitContext)
    : contextEstimate.tokens;
  const codeScope = inferCodeScope(value, merged);
  const executionMetadata = recordValue(merged.execution)
    || recordValue(merged.execution_requirements)
    || recordValue(merged.executionRequirements);
  const nativeExecution = firstBoolean(
    merged.native_execution,
    merged.nativeExecution,
    merged.native,
    merged.requires_native_execution,
    merged.requiresNativeExecution,
    executionMetadata?.native_execution,
    executionMetadata?.nativeExecution,
    executionMetadata?.native,
  ) ?? true;
  const tool = firstBoolean(
    merged.tool,
    merged.tool_use,
    merged.toolUse,
    merged.tools,
    merged.requires_tool,
    merged.requiresTool,
    merged.requires_tool_use,
    merged.requiresToolUse,
    executionMetadata?.tool,
    executionMetadata?.tool_use,
    executionMetadata?.toolUse,
  ) ?? true;
  const executionMode = inferExecutionMode(merged);
  const explicitCapabilities = capabilityNames(merged);
  const requiredCapabilities = new Set(explicitCapabilities);
  if (nativeExecution) requiredCapabilities.add("native-execution");
  if (tool) requiredCapabilities.add("tool-use");
  if (executionMode) requiredCapabilities.add(executionMode);
  const requiredExecutionCapabilities = [...requiredCapabilities].sort();
  const otherExecutionRequirements = otherRequirementNames(merged);
  const suppliedEvidence = Array.isArray(merged.evidence)
    ? merged.evidence
      .filter((item): item is SelectionRequirementEvidence => Boolean(item && typeof item === "object"))
      .map((item) => ({
        field: String(item.field || "").trim(),
        value: item.value,
        source: String(item.source || "explicit").trim() || "explicit",
        detail: String(item.detail || "").trim(),
      }))
      .filter((item) => item.field)
      .sort((left, right) => left.field.localeCompare(right.field) || left.source.localeCompare(right.source) || left.detail.localeCompare(right.detail))
    : [];
  const explicitComplexity = merged.complexity ?? merged.task_complexity ?? merged.complexity_class ?? merged.complexity_reason;
  const explicitCodeScope = merged.code_scope ?? merged.codeScope ?? merged.scope;
  const explicitReasoning = merged.reasoning ?? merged.reasoning_effort ?? merged.minimum_reasoning_effort
    ?? merged.minimumReasoningEffort ?? merged.required_reasoning_effort ?? merged.requiredReasoningEffort;
  const evidence = [
    evidenceEntry("complexity", complexity, explicitComplexity != null ? "explicit" : "task-text", `task complexity classified as ${complexity}`),
    evidenceEntry("estimated_context_tokens", estimatedContextTokens, explicitContextRaw != null ? "explicit" : `context-${contextEstimate.reason}`, `estimated context is ${estimatedContextTokens} tokens`),
    evidenceEntry("code_scope", codeScope, explicitCodeScope != null ? "explicit" : "task-text", `code scope classified as ${codeScope}`),
    evidenceEntry("reasoning", reasoning, explicitReasoning != null ? "explicit" : "task-complexity", `minimum reasoning effort is ${reasoning}`),
    evidenceEntry("native_execution", nativeExecution, "execution-contract", nativeExecution ? "delegated work requires native execution" : "native execution is not required"),
    evidenceEntry("tool", tool, "execution-contract", tool ? "delegated work requires tool use" : "tool use is not required"),
    evidenceEntry("execution_mode", executionMode, executionMode ? "execution-metadata" : "execution-default", executionMode ? `execution mode is ${executionMode}` : "no execution mode was declared"),
    evidenceEntry("required_execution_capabilities", requiredExecutionCapabilities, requiredCapabilities.size ? "execution-metadata" : "execution-default", requiredExecutionCapabilities.length ? `required capabilities: ${requiredExecutionCapabilities.join(", ")}` : "no additional execution capabilities were declared"),
    evidenceEntry("other_execution_requirements", otherExecutionRequirements, otherExecutionRequirements.length ? "execution-metadata" : "execution-default", otherExecutionRequirements.length ? `other requirements: ${otherExecutionRequirements.join(", ")}` : "no other execution requirements were declared"),
    ...suppliedEvidence,
  ];
  return {
    complexity,
    estimated_context_tokens: estimatedContextTokens,
    code_scope: codeScope,
    reasoning,
    reasoning_effort: reasoning,
    native_execution: nativeExecution,
    tool,
    tool_use: tool,
    execution_mode: executionMode,
    required_execution_capabilities: requiredExecutionCapabilities,
    other_execution_requirements: otherExecutionRequirements,
    evidence,
  };
}

/** Compatibility aliases for callers that describe this as a task contract. */


export function estimateTaskComplexity(text: unknown): TaskComplexityEstimate {
  const value = String(text || "").toLowerCase();
  const dimensions = classifyTask(value);
  if ((dimensions.speed > 0 && dimensions.agentic === 0 && dimensions.intelligence === 0)
    || (/\b(?:simple|tiny|small|typo|rename-only|routine)\b|小改|简单任务|拼写|仅重命名|常规/.test(value)
    && dimensions.agentic === 0 && dimensions.intelligence === 0)) {
    return { effort: "low", reason: "simple" };
  }
  if (/\b(?:monorepo|multi-file|cross-module|migration|migrate|architecture|repository-wide|codebase-wide|complex integration)\b|全仓(?:库)?|多文件|跨模块|迁移|架构|复杂集成/.test(value)
    || dimensions.agentic >= 2
    || (dimensions.agentic >= 1 && dimensions.intelligence >= 1 && dimensions.coding >= 1)) {
    return { effort: "max", reason: "very-complex" };
  }
  if (dimensions.agentic + dimensions.intelligence + dimensions.coding >= 2
    || /\b(?:debug|investigate|refactor|review|audit|verify)\b|调试|排查|重构|审查|审计|验证/.test(value)) {
    return { effort: "high", reason: "complex" };
  }
  return { effort: "medium", reason: "standard" };
}

export function estimateTaskContext(text: unknown): TaskContextEstimate {
  const value = String(text || "").toLowerCase();
  const explicit = value.match(/(?:context|上下文)(?:\s*(?:window|窗口))?\s*(?:of|为|是|[:=])?\s*(\d+(?:\.\d+)?)\s*([km])/i)
    || value.match(/(\d+(?:\.\d+)?)\s*([km])\s*(?:context|上下文)/i);
  if (explicit) {
    const scale = explicit[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
    return { tokens: Math.max(1, Math.round(Number(explicit[1]) * scale)), reason: "explicit" };
  }
  if (/\b(?:whole|entire|all|large)\s+(?:repo|repository|codebase)\b|\b(?:repo|repository|codebase)-wide\b|\b(?:monorepo|multi-file|cross-module|migration|migrate|long[- ]context|search and digest|comprehensive audit)\b|全仓(?:库)?|整个仓库|全量|大型仓库|多文件|跨模块|迁移|长上下文|全面审计|检索并汇总/.test(value)
    || value.length >= 200_000) {
    return { tokens: 1_000_000, reason: "large-scope" };
  }
  if (/\b(?:tiny|small|single-file|one-file|typo|rename-only)\b|小改|简单任务|单文件|拼写|仅重命名/.test(value)) {
    return { tokens: 128_000, reason: "small-scope" };
  }
  return { tokens: 262_144, reason: "standard" };
}
