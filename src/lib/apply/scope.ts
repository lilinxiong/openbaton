import path from "node:path";
import type { SafetyOperation } from "../safety.js";
import { wildcardStaticPrefix } from "../wildcard.js";

export type ApplyUnitMode = "write" | "read-only";

export const WRITE_OPERATIONS: readonly SafetyOperation[] = ["write", "create", "delete", "rename", "chmod"];
export const DEFAULT_WRITE_OPERATIONS: readonly SafetyOperation[] = ["write", "create"];

export interface ApplyUnitScope {
  mode: ApplyUnitMode;
  write_paths: string[];
  /** Operations authorized for this unit's declared paths. */
  allowed_operations?: SafetyOperation[];
}

export type ApplyUnitScopeMap = Map<string, ApplyUnitScope>;

function ensureScope(scopes: ApplyUnitScopeMap, id: string): ApplyUnitScope {
  let scope = scopes.get(id);
  if (!scope) {
    scope = { mode: "read-only", write_paths: [] };
    scopes.set(id, scope);
  }
  return scope;
}

/** Pair `--unit ID` with following `--write-path` / `--read-only`. Optional `--scope JSON`. */
export function parseApplyUnitScopes(args: string[]): ApplyUnitScopeMap {
  const scopes: ApplyUnitScopeMap = new Map();
  let current: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scope") {
      const raw = args[index + 1];
      if (raw === undefined || raw.startsWith("--")) throw new Error("TASK_SCOPE_REQUIRED: --scope requires a JSON object");
      index += 1;
      mergeScopeJson(scopes, raw);
      continue;
    }
    if (arg === "--unit") {
      const id = args[index + 1];
      if (id === undefined || id.startsWith("--")) throw new Error("TASK_SCOPE_REQUIRED: --unit requires a task id");
      index += 1;
      current = id.trim();
      if (!current) throw new Error("TASK_SCOPE_REQUIRED: --unit requires a task id");
      ensureScope(scopes, current);
      continue;
    }
    if (arg === "--write-path") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("TASK_SCOPE_REQUIRED: --write-path requires a path");
      index += 1;
      if (!current) throw new Error("TASK_SCOPE_REQUIRED: --write-path must follow --unit ID");
      const scope = ensureScope(scopes, current);
      scope.mode = "write";
      for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
        if (!scope.write_paths.includes(item)) scope.write_paths.push(item);
      }
      continue;
    }
    if (arg === "--write-ops") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("TASK_SCOPE_REQUIRED: --write-ops requires operations");
      index += 1;
      if (!current) throw new Error("TASK_SCOPE_REQUIRED: --write-ops must follow --unit ID");
      const scope = ensureScope(scopes, current);
      const operations = parseWriteOperations(value);
      scope.allowed_operations = [...new Set([...(scope.allowed_operations || []), ...operations])];
      continue;
    }
    if (arg === "--read-only") {
      if (!current) throw new Error("TASK_SCOPE_REQUIRED: --read-only must follow --unit ID");
      const scope = ensureScope(scopes, current);
      if (!scope.write_paths.length) scope.mode = "read-only";
    }
  }
  for (const [id, scope] of scopes) {
    if (scope.mode === "write" && !scope.write_paths.length) {
      throw new Error(`TASK_SCOPE_REQUIRED: --unit ${id} write scope needs --write-path`);
    }
    if (scope.mode === "write" && !(scope.allowed_operations?.length)) {
      scope.allowed_operations = [...DEFAULT_WRITE_OPERATIONS];
    }
  }
  return scopes;
}

function mergeScopeJson(scopes: ApplyUnitScopeMap, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TASK_SCOPE_REQUIRED: --scope must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TASK_SCOPE_REQUIRED: --scope must be a JSON object of task id → { mode, write_paths }");
  }
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const key = id.trim();
    if (!key) continue;
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const mode = row.mode === "write" || row.mode === "read-only" ? row.mode : (Array.isArray(row.write_paths) && row.write_paths.length ? "write" : "read-only");
    const paths = Array.isArray(row.write_paths)
      ? row.write_paths.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const scope = ensureScope(scopes, key);
    const operations = parseWriteOperationsValue(row.allowed_operations ?? row.write_operations);
    if (mode === "write") {
      scope.mode = "write";
      for (const item of paths) {
        if (!scope.write_paths.includes(item)) scope.write_paths.push(item);
      }
      scope.allowed_operations = [...new Set([...(scope.allowed_operations || []), ...(operations || DEFAULT_WRITE_OPERATIONS)])];
    } else if (!scope.write_paths.length) {
      scope.mode = "read-only";
    }
  }
}

export function scopeRecord(scopes: ApplyUnitScopeMap): Record<string, ApplyUnitScope> {
  return Object.fromEntries([...scopes.entries()].map(([id, scope]) => [id, {
    mode: scope.mode,
    write_paths: [...scope.write_paths],
    ...(scope.mode === "write" ? { allowed_operations: [...(scope.allowed_operations || DEFAULT_WRITE_OPERATIONS)] } : {}),
  }]));
}

export function scopesFromRecord(value: unknown): ApplyUnitScopeMap {
  const scopes: ApplyUnitScopeMap = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) return scopes;
  for (const [id, row] of Object.entries(value as Record<string, unknown>)) {
    const key = id.trim();
    if (!key) continue;
    const body = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
    const paths = Array.isArray(body.write_paths)
      ? body.write_paths.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const mode: ApplyUnitMode = body.mode === "read-only"
      ? "read-only"
      : body.mode === "write" || paths.length ? "write" : "read-only";
    const operations = parseWriteOperationsValue(body.allowed_operations ?? body.write_operations);
    if (mode === "write" && !paths.length) {
      throw new Error(`TASK_SCOPE_REQUIRED: --unit ${key} write scope needs --write-path`);
    }
    scopes.set(key, {
      mode,
      write_paths: mode === "write" ? paths : [],
      ...(mode === "write" ? { allowed_operations: operations || [...DEFAULT_WRITE_OPERATIONS] } : {}),
    });
  }
  return scopes;
}

function parseWriteOperationsValue(value: unknown): SafetyOperation[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!values.length || values.some((item) => !WRITE_OPERATIONS.includes(item as SafetyOperation))) {
    throw new Error("TASK_SCOPE_REQUIRED: --write-ops must contain write,create,delete,rename,chmod");
  }
  return [...new Set(values as SafetyOperation[])];
}

function parseWriteOperations(value: string): SafetyOperation[] {
  const operations = parseWriteOperationsValue(value.split(","));
  if (!operations) throw new Error("TASK_SCOPE_REQUIRED: --write-ops requires operations");
  return operations;
}

export interface WriteScopeDeclaration {
  key: string;
  write_paths: string[];
  /** Exact isolated namespace; absent values retain shared-worktree safety. */
  repository_id?: string;
  execution_root?: string;
}

function distinctWriteNamespace(left: WriteScopeDeclaration, right: WriteScopeDeclaration): boolean {
  return Boolean(left.repository_id && left.execution_root && right.repository_id && right.execution_root
    && (left.repository_id !== right.repository_id || left.execution_root !== right.execution_root));
}

function scopePath(value: string): string {
  let normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  normalized = path.posix.normalize(normalized);
  normalized = normalized.replace(/\/+$/, "");
  if (normalized.endsWith("/**")) normalized = normalized.slice(0, -3);
  else if (normalized.endsWith("/*")) normalized = normalized.slice(0, -2);
  normalized = wildcardStaticPrefix(normalized);
  return normalized || ".";
}

/** True when two declared paths could address the same file or directory. */
export function writePathsOverlap(left: string, right: string): boolean {
  const a = scopePath(left);
  const b = scopePath(right);
  return a === b || a === "." || b === "." || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Reject all pairwise same-wave path conflicts before a ticket is persisted. */
export function assertDisjointWriteScopes(scopes: Iterable<WriteScopeDeclaration>): void {
  const entries = [...scopes].filter((scope) => scope.write_paths.length);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (distinctWriteNamespace(entries[left]!, entries[right]!)) continue;
      for (const leftPath of entries[left].write_paths) {
        for (const rightPath of entries[right].write_paths) {
          if (!writePathsOverlap(leftPath, rightPath)) continue;
          throw new Error(`WRITE_SCOPE_CONFLICT: ${entries[left].key}:${leftPath} overlaps ${entries[right].key}:${rightPath}`);
        }
      }
    }
  }
}
/** True only when two declarations can mutate the same namespaced path. */
export function writeScopesOverlap(left: WriteScopeDeclaration, right: WriteScopeDeclaration): boolean {
  if (distinctWriteNamespace(left, right)) return false;
  return left.write_paths.some((leftPath) => right.write_paths.some((rightPath) => writePathsOverlap(leftPath, rightPath)));
}
