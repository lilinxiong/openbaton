/**
 * Baton CLI flag grammar: `--key value` consumes the next argument, repeated
 * keys accumulate in order, and `--key=value` is intentionally NOT supported.
 * node:util parseArgs cannot express this grammar without changing accepted
 * syntax, so the parser stays hand-rolled but lives in its own module.
 */
import { normalizeAgentTaskClassification } from "./lib/ops/task.js";
import { DEFAULT_WRITE_OPERATIONS, WRITE_OPERATIONS, type ApplyUnitScope } from "./lib/apply/scope.js";
import { type SafetyOperation } from "./lib/safety.js";

export type FlagValue = string | boolean;
export type FlagMap = Record<string, FlagValue | FlagValue[]>;

export function parseFlags(args: string[]): FlagMap {
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      i += 1;
      rememberFlag(flags, key, next);
    } else {
      rememberFlag(flags, key, true);
    }
  }
  return flags;
}

export type PositionalPolicy = "allow" | "single" | "none";

/** Parse only the current command grammar; unknown options must reach the ordinary parser error. */
export function validateCommandArgs(
  args: string[],
  {
    value = [],
    boolean = [],
    positional = "allow",
  }: { value?: readonly string[]; boolean?: readonly string[]; positional?: PositionalPolicy },
): void {
  const valueFlags = new Set(value);
  const booleanFlags = new Set(boolean);
  let positionalCount = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionalCount += 1;
      if (positional === "none") throw new Error(`unexpected argument: ${arg}`);
      if (positional === "single" && positionalCount > 1) throw new Error(`unexpected argument: ${arg}`);
      continue;
    }
    const key = arg.slice(2);
    if (!key || (!valueFlags.has(key) && !booleanFlags.has(key))) throw new Error(`unknown option: ${arg}`);
    if (valueFlags.has(key)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
    }
  }
}

export interface ClassificationFlags {
  present: boolean;
  value: ReturnType<typeof normalizeAgentTaskClassification>;
}

/** Parse the director-owned structured execution contract from CLI flags. */
export function parseClassificationFlags(flags: FlagMap): ClassificationFlags {
  const rawFlag = stringFlag(flags, "classification");
  const operation = stringFlag(flags, "operation");
  const present = rawFlag !== undefined || operation !== undefined;
  if (!present) return { present: false, value: null };
  if (rawFlag === undefined) throw new Error("--operation requires --classification mechanical|long-context|implementation|analysis|discussion|general");
  let raw: unknown = rawFlag;
  const trimmed = rawFlag.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new Error("--classification must be a class name or JSON object with kind");
    }
  }
  const normalized = normalizeAgentTaskClassification(raw);
  if (!normalized) throw new Error("--classification must be mechanical, long-context, implementation, analysis, discussion, or general");
  return {
    present: true,
    value: operation === undefined ? normalized : { ...normalized, operation: operation.trim() || null },
  };
}

export function parseClassificationAssignments(values: string[], flagName: string): Map<string, ReturnType<typeof normalizeAgentTaskClassification>> {
  const result = new Map<string, ReturnType<typeof normalizeAgentTaskClassification>>();
  for (const value of values) {
    const index = value.indexOf("=");
    const key = index > 0 ? value.slice(0, index).trim() : "";
    const classification = index > 0 ? value.slice(index + 1).trim() : "";
    if (!key || !classification) throw new Error(`${flagName} must use KEY=mechanical|long-context|implementation|analysis|discussion|general`);
    if (result.has(key)) throw new Error(`duplicate ${flagName} assignment: ${key}`);
    const parsed = normalizeAgentTaskClassification(classification);
    if (!parsed) throw new Error(`${flagName} must use KEY=mechanical|long-context|implementation|analysis|discussion|general`);
    result.set(key, parsed);
  }
  return result;
}

export function parseOperationAssignments(values: string[], flagName: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const index = value.indexOf("=");
    const key = index > 0 ? value.slice(0, index).trim() : "";
    const operation = index > 0 ? value.slice(index + 1).trim() : "";
    if (!key || !operation) throw new Error(`${flagName} must use KEY=LABEL`);
    if (result.has(key)) throw new Error(`duplicate ${flagName} assignment: ${key}`);
    result.set(key, operation);
  }
  return result;
}

export function stringFlag(flags: FlagMap, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      if (typeof value[i] === "string") return value[i] as string;
    }
  }
  return undefined;
}

export function rememberFlag(flags: FlagMap, key: string, value: FlagValue): void {
  const prev = flags[key];
  if (prev === undefined) flags[key] = value;
  else if (Array.isArray(prev)) prev.push(value);
  else flags[key] = [prev, value];
}

export function flagOn(flags: FlagMap, key: string): boolean {
  const value = flags[key];
  if (value === true || value === "true") return true;
  if (Array.isArray(value)) return value.some((item) => item === true || item === "true");
  return false;
}

/** All values of a repeatable flag, in order. Comma-separated values are split by callers. */
export function multiFlag(flags: FlagMap, key: string): string[] {
  const value = flags[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export function parseStandaloneUnits(values: string[]): Array<{ key: string; description: string }> {
  const units: Array<{ key: string; description: string }> = [];
  const keys = new Set<string>();
  for (const value of values) {
    const index = value.indexOf("=");
    const key = index > 0 ? value.slice(0, index).trim() : "";
    const description = index > 0 ? value.slice(index + 1).trim() : "";
    if (!key || !description) throw new Error("--unit must use KEY=BUSINESS_TASK");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`invalid --unit key: ${key}`);
    if (keys.has(key)) throw new Error(`duplicate --unit key: ${key}`);
    keys.add(key);
    units.push({ key, description });
  }
  return units;
}

export interface StandaloneWriteScopeFlags {
  globalPaths: string[];
  globalOperations: SafetyOperation[];
  unitScopes: Map<string, ApplyUnitScope>;
}

/** Parse standalone write declarations while retaining each unit's boundary.
 * The one-unit form keeps the historical global flags. For multiple units,
 * --unit KEY=TASK selects the unit for following --write-path/--write-ops;
 * KEY=PATH/KEY=OPS assignment forms are accepted as an order-independent
 * convenience for callers constructing argv programmatically. */
export function parseStandaloneWriteScopes(args: string[], units: Array<{ key: string; description: string }>): StandaloneWriteScopeFlags {
  const known = new Set(units.map((unit) => unit.key));
  const globalPaths: string[] = [];
  const globalOperations: SafetyOperation[] = [];
  const unitScopes = new Map<string, ApplyUnitScope>();
  let explicitGlobalOperations = false;
  let current: string | null = null;
  const operationsFor = (raw: string): SafetyOperation[] => {
    const values = raw.split(",").map((item) => item.trim()).filter(Boolean) as SafetyOperation[];
    if (!values.length || values.some((item) => !WRITE_OPERATIONS.includes(item))) {
      throw new Error("--write-ops must contain write,create,delete,rename,chmod");
    }
    return [...new Set(values)];
  };
  const scopeFor = (key: string): ApplyUnitScope => {
    let scope = unitScopes.get(key);
    if (!scope) {
      scope = { mode: "write", write_paths: [] };
      unitScopes.set(key, scope);
    }
    return scope;
  };
  const assignment = (value: string, kind: "path" | "ops"): { key: string; value: string } | null => {
    const index = value.indexOf("=");
    if (index <= 0 || !known.has(value.slice(0, index).trim())) return null;
    return { key: value.slice(0, index).trim(), value: value.slice(index + 1).trim() };
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--unit") {
      const raw = args[index + 1];
      if (raw) {
        const key = raw.slice(0, raw.indexOf("=")).trim();
        if (known.has(key)) current = key;
        index += 1;
      }
      continue;
    }
    if (arg !== "--write-path" && arg !== "--write-ops") continue;
    const raw = args[index + 1];
    if (raw === undefined || raw.startsWith("--")) continue;
    index += 1;
    const kind = arg === "--write-path" ? "path" : "ops";
    const parsed = assignment(raw, kind);
    const key = units.length > 1 ? (parsed?.key || current) : null;
    const value = parsed?.value || raw;
    if (key && known.has(key)) {
      const scope = scopeFor(key);
      if (kind === "path") {
        for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
          if (!scope.write_paths.includes(item)) scope.write_paths.push(item);
        }
      } else {
        scope.allowed_operations = [...new Set([...(scope.allowed_operations || []), ...operationsFor(value)])];
      }
    } else if (kind === "path") {
      for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) if (item) globalPaths.push(item);
    } else {
      explicitGlobalOperations = true;
      globalOperations.push(...operationsFor(value));
    }
  }
  if (!globalOperations.length) globalOperations.push(...DEFAULT_WRITE_OPERATIONS);
  if (explicitGlobalOperations && !globalPaths.length) {
    throw new Error("TASK_SCOPE_REQUIRED: write operations require --write-path");
  }
  for (const scope of unitScopes.values()) {
    if (!scope.write_paths.length) {
      throw new Error("TASK_SCOPE_REQUIRED: per-unit write operations require --write-path");
    }
    if (!scope.allowed_operations?.length) scope.allowed_operations = [...DEFAULT_WRITE_OPERATIONS];
  }
  return { globalPaths, globalOperations: [...new Set(globalOperations)], unitScopes };
}

export function firstPositionalArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    return args[i];
  }
  return null;
}

export function positionalText(args: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    parts.push(args[i]);
  }
  return parts.join(" ").trim();
}
