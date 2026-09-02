/**
 * Scope/ownership normalization and dependency-map machinery for apply
 * plans. Split from apply-plan.ts (leaf module).
 */

import path from "node:path";
import { isNonEmptyString } from "./validate-utils.js";
import { wildcardStaticPrefix } from "./wildcard.js";
import {
  ApplyExecutionPlan,
  ApplyPlanActiveOwnership,
  ApplyPlanConflictGraphOptions,
  ApplyPlanDiagnostic,
  ApplyPlanOwnershipNamespace,
  ApplyPlanParentGate,
  ApplyPlanRuntimeState,
  ApplyPlanScopeFact,
  ApplyPlanScopeKind,
  ApplyPlanTaskStatus,
  ApplyPlanUnit
} from "./apply-plan.js";

export const RUNTIME_STATES: readonly ApplyPlanRuntimeState[] = ["planned", "ready", "running", "succeeded", "failed", "blocked", "cancelled", "stale", "superseded", "materialized", "terminal"];
export const TASK_STATES: readonly ApplyPlanTaskStatus[] = ["pending", "running", "done", "failed", "skipped"];
export const HEX_SHA256 = /^[0-9a-f]{64}$/;
export const DEFAULT_ACCEPTED_UNIT_STATES: readonly ApplyPlanRuntimeState[] = ["succeeded"];
export const DEFAULT_ACCEPTED_GATE_STATES: readonly ApplyPlanRuntimeState[] = ["succeeded"];
export const DEFAULT_EXCLUDED_UNIT_STATES: readonly ApplyPlanRuntimeState[] = ["running", "failed", "blocked", "cancelled", "stale", "superseded", "materialized", "terminal", "succeeded"];

export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function string(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
export function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(string); }
export function ownKeys(value: Record<string, unknown>): string[] { return Object.keys(value); }
export function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, out: ApplyPlanDiagnostic[]): void {
  const known = new Set(allowed);
  for (const key of ownKeys(value)) if (!known.has(key)) out.push({ code: "UNKNOWN_FIELD", path: `${path}.${key}`, message: `unknown field ${key}` });
}
export function issue(out: ApplyPlanDiagnostic[], code: string, message: string, path?: string, refs?: string[]): void { out.push({ code, message, ...(path ? { path } : {}), ...(refs ? { refs } : {}) }); }

export function pathOverlap(left: string, right: string): boolean {
  const clean = (item: string) => item.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const a = clean(left); const b = clean(right);
  return a === b || a === "." || b === "." || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function normalizeScopePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const value = path.posix.normalize(trimmed.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""));
  const withoutWildcard = wildcardStaticPrefix(value);
  const normalized = path.posix.normalize(withoutWildcard || ".");
  return normalized === "." ? "." : normalized;
}

export function normalizeScopeKind(kind: string | undefined, source: string): ApplyPlanScopeKind {
  if (kind === "rename-source" || kind === "rename-target" || kind === "wildcard" || kind === "path") return kind;
  if (source.includes("*") || source.includes("?") || source.includes("[")) return "wildcard";
  return "path";
}

export function normalizeScopeFacts(unitId: string, facts: readonly ApplyPlanScopeFact[]): ApplyPlanScopeFact[] {
  return facts
    .map((entry) => {
      const normalizedPath = normalizeScopePath(entry.path);
      if (!normalizedPath) return null;
      return { unit_id: unitId, path: normalizedPath, kind: normalizeScopeKind(entry.kind, entry.path) };
    })
    .filter((entry): entry is ApplyPlanScopeFact => Boolean(entry))
    .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind) || left.unit_id.localeCompare(right.unit_id));
}

export function normalizedFactsFromPlanUnit(unit: ApplyPlanUnit): ApplyPlanScopeFact[] {
  if (unit.mode !== "patch-only") return [];
  const renamePair = unit.allowed_operations?.includes("rename") ? /\s*([^\s]+)\s*->\s*([^\s]+)\s*/ : null;
  const paths = unit.write_paths || [];
  const facts: ApplyPlanScopeFact[] = [];
  for (const item of paths) {
    if (!renamePair) {
      facts.push({ unit_id: unit.id, path: item, kind: "path" });
      continue;
    }
    const match = String(item).match(renamePair);
    if (!match) {
      facts.push({ unit_id: unit.id, path: item, kind: "path" });
      continue;
    }
    facts.push({ unit_id: unit.id, path: match[1], kind: "rename-source" });
    facts.push({ unit_id: unit.id, path: match[2], kind: "rename-target" });
  }
  return normalizeScopeFacts(unit.id, facts);
}

export function scopeConflicts(left: ApplyPlanScopeFact, right: ApplyPlanScopeFact): boolean {
  const a = normalizeScopePath(left.path);
  const b = normalizeScopePath(right.path);
  if (!a || !b) return false;
  return a === b || a === "." || b === "." || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function sortByPlanOrder(values: string[], order: readonly string[]): string[] {
  const index = new Map(order.map((unit, at) => [unit, at]));
  return [...values].sort((left, right) => (index.get(left) ?? Number.MAX_SAFE_INTEGER) - (index.get(right) ?? Number.MAX_SAFE_INTEGER));
}

export function normalizeOwnershipFacts(item: ApplyPlanActiveOwnership): ApplyPlanScopeFact[] {
  const facts = item.facts;
  if (facts.length) return normalizeScopeFacts(item.key, facts);
  return [];
}

export function isActiveOwnershipBlocking(item: ApplyPlanActiveOwnership): boolean {
  if (item.released === true) return false;
  if (item.slot_released_at !== undefined && item.slot_released_at !== null && item.slot_released_at.length > 0) return false;
  if (item.terminal_unreleased === false) return false;
  return true;
}

export function ownershipNamespace(
  values: ApplyPlanConflictGraphOptions["ownershipByUnit"],
  unitId: string,
): ApplyPlanOwnershipNamespace | undefined {
  return values instanceof Map ? values.get(unitId) : values?.[unitId];
}

export function overlapPaths(left: readonly ApplyPlanScopeFact[], right: readonly ApplyPlanScopeFact[]): string[] {
  const paths = new Set<string>();
  for (const source of left) for (const target of right) {
    if (scopeConflicts(source, target)) paths.add([source.path, target.path].sort().join(" <-> "));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export function namespaceRelation(
  left: ApplyPlanOwnershipNamespace | undefined,
  right: ApplyPlanOwnershipNamespace | undefined,
): "same-root" | "cross-root" | "different-repository" | "unknown" {
  if (!left || !right) return "unknown";
  if (left.repository_id !== right.repository_id) return "different-repository";
  return left.execution_root === right.execution_root ? "same-root" : "cross-root";
}

export function isRuntimeAccepted(state: ApplyPlanRuntimeState | undefined, accepted: Set<ApplyPlanRuntimeState>): boolean {
  return accepted.has(state || "planned");
}

export function isRuntimeExcluded(state: ApplyPlanRuntimeState | undefined, excluded: Set<ApplyPlanRuntimeState>): boolean {
  return excluded.has(state || "planned");
}

export function isBetterCandidate(left: string[], right: string[], critical: Record<string, number>, order: readonly string[]): boolean {
  if (left.length !== right.length) return left.length > right.length;
  const leftScore = left.reduce((total, id) => total + (critical[id] ?? 0), 0);
  const rightScore = right.reduce((total, id) => total + (critical[id] ?? 0), 0);
  if (leftScore !== rightScore) return leftScore > rightScore;
  if (right.length === 0) return true;
  for (let index = 0; index < left.length; index += 1) {
    const leftOrder = order.indexOf(left[index]);
    const rightOrder = order.indexOf(right[index]);
    if (leftOrder !== rightOrder) return leftOrder < rightOrder;
  }
  return false;
}

export function isLexEarlier(left: readonly string[], right: readonly string[], order: readonly string[]): boolean {
  if (right.length === 0) return left.length > 0;
  const index = new Map(order.map((id, at) => [id, at]));
  for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
    const leftOrder = index.get(left[at]!) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = index.get(right[at]!) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder < rightOrder;
  }
  return left.length < right.length;
}

export function buildDependencyMaps(plan: ApplyExecutionPlan) {
  const unitMap = new Map<string, ApplyPlanUnit>();
  const gateMap = new Map<string, ApplyPlanParentGate>();
  for (const unit of plan.units) unitMap.set(unit.id, unit);
  for (const gate of plan.parent_gates || []) gateMap.set(gate.id, gate as ApplyPlanParentGate);
  return { unitMap, gateMap };
}
