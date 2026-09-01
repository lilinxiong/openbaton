/**
 * The in-memory contract for an OpenSpec apply run.
 *
 * This module deliberately has no persistence or scheduling side effects.  It
 * validates the director's plan before a dispatcher is allowed to consume it.
 */
import crypto from "node:crypto";
import path from "node:path";
import type { SafetyOperation } from "./safety.js";

export const APPLY_EXECUTION_PLAN_SCHEMA_VERSION = 1 as const;
export const APPLY_PLAN_OPERATIONS: readonly SafetyOperation[] = ["write", "create", "delete", "rename", "chmod"];

export type ApplyPlanUnitMode = "patch-only" | "verification-only";
export type ApplyPlanRuntimeState =
  | "planned"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "stale"
  | "superseded"
  | "materialized"
  | "terminal";
export type ApplyPlanTaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface ApplyPlanIdentity {
  plan_id: string;
  change_id: string;
  created_at?: string;
  owner?: string;
}

export interface ApplyPlanSourceSnapshot {
  repo_root: string;
  revision: string;
  tasks_path?: string;
  fingerprint?: string;
}

export interface ApplyPlanRevisionLineage {
  base: string;
  parent?: string;
  head?: string;
  ancestors?: string[];
}

export interface ApplyPlanTaskCompletion {
  status: ApplyPlanTaskStatus;
  unit_ids?: string[];
  completed_at?: string;
  conclusion?: string;
}

export interface ApplyPlanUnit {
  id: string;
  mode: ApplyPlanUnitMode;
  task_ids: string[];
  description?: string;
  prompt?: string;
  write_paths?: string[];
  allowed_operations?: SafetyOperation[];
  depends_on?: string[];
  parent_gate_ids?: string[];
  runtime_state?: ApplyPlanRuntimeState;
  remaining_critical_path?: number;
  /** A patch payload is intentionally metadata only; this module never applies it. */
  patch?: string;
  verification?: string[];
}

export interface ApplyPlanParentGate {
  id: string;
  depends_on?: string[];
  unit_ids?: string[];
  task_ids?: string[];
  runtime_state?: ApplyPlanRuntimeState;
}

export interface ApplyPlanTaskMapping {
  task_id: string;
  unit_ids: string[];
  gate_ids?: string[];
}

export interface ApplyExecutionPlan {
  schema_version: 1;
  identity: ApplyPlanIdentity;
  source_snapshot: ApplyPlanSourceSnapshot;
  selected_tasks: string[];
  units: ApplyPlanUnit[];
  parent_gates?: ApplyPlanParentGate[];
  task_mappings?: ApplyPlanTaskMapping[];
  task_completion?: Record<string, ApplyPlanTaskCompletion>;
  revision_lineage?: ApplyPlanRevisionLineage;
  runtime_state?: ApplyPlanRuntimeState;
  fingerprint?: string;
}

export interface ApplyPlanOverlapEdge {
  from: string;
  to: string;
  paths: string[];
}

export interface ApplyPlanDiagnostic {
  code: string;
  message: string;
  path?: string;
  refs?: string[];
}

export interface ApplyPlanValidationResult {
  valid: boolean;
  diagnostics: ApplyPlanDiagnostic[];
  overlap_edges: ApplyPlanOverlapEdge[];
  remaining_critical_path: Record<string, number>;
  plan?: ApplyExecutionPlan;
}

export class ApplyPlanValidationError extends Error {
  readonly diagnostics: ApplyPlanDiagnostic[];
  constructor(diagnostics: ApplyPlanDiagnostic[]) {
    super(diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
    this.name = "ApplyPlanValidationError";
    this.diagnostics = diagnostics;
  }
}

export class ApplyPlanSearchError extends Error {
  readonly code = "APPLY_FRONTIER_SEARCH_LIMIT";
  constructor(limit: number) {
    super(`exact apply frontier search exceeded ${limit} nodes`);
    this.name = "ApplyPlanSearchError";
  }
}

export type ApplyPlanScopeKind = "path" | "wildcard" | "rename-source" | "rename-target";

export interface ApplyPlanScopeFact {
  unit_id: string;
  path: string;
  kind: ApplyPlanScopeKind;
}

export interface ApplyPlanScopeSource {
  unit_id: string;
  facts: readonly ApplyPlanScopeFact[];
}

export interface ApplyPlanActiveOwnership {
  key: string;
  /** Repository/root namespace which owns these paths. Both fields are required together. */
  repository_id?: string;
  execution_root?: string;
  base_tree?: string;
  released?: boolean;
  terminal?: boolean;
  terminal_unreleased?: boolean;
  slot_released_at?: string | null;
  facts: readonly ApplyPlanScopeFact[];
}

export interface ApplyPlanOwnershipNamespace {
  repository_id: string;
  execution_root: string;
  base_tree?: string;
}

export interface ApplyPlanIntegrationConflictRisk {
  from: string;
  to: string;
  repository_id: string;
  execution_roots: [string, string];
  paths: string[];
}

export interface ApplyPlanDependencyReadyOptions {
  acceptedUnitStates?: readonly ApplyPlanRuntimeState[];
  acceptedGateStates?: readonly ApplyPlanRuntimeState[];
  excludedUnitStates?: readonly ApplyPlanRuntimeState[];
  excludedUnitIds?: readonly string[];
}

export interface ApplyPlanConflictGraphOptions {
  /** Explicit scope declarations; defaults are derived from patch-only write paths. */
  declaredScopeFacts?: ReadonlyMap<string, readonly ApplyPlanScopeFact[]> | readonly ApplyPlanScopeFact[];
  /** Active foreign ownership facts across root trees; terminal/unreleased owners always conflict. */
  activeOwnership?: readonly ApplyPlanActiveOwnership[];
  /** Exact repository/root namespace for each candidate unit. */
  ownershipByUnit?: Readonly<Record<string, ApplyPlanOwnershipNamespace>> | ReadonlyMap<string, ApplyPlanOwnershipNamespace>;
  /** Override unit order for deterministic tie-break and stable comparisons. */
  stableOrder?: readonly string[];
}

export interface ApplyPlanConflictGraphResult {
  conflicts: ReadonlyMap<string, string[]>;
  blockedByActiveOwnership: ReadonlySet<string>;
  /** Non-blocking overlaps isolated by distinct roots in the same repository. */
  integration_conflict_risks: ApplyPlanIntegrationConflictRisk[];
}

export interface ApplyPlanIndependentSetOptions {
  capacity?: number;
  criticalPathByUnit?: Record<string, number>;
  excludedUnitIds?: readonly string[];
  /** Fail closed instead of silently returning a suboptimal frontier. */
  maxSearchNodes?: number;
}

export interface ApplyPlanIndependentSetResult {
  selected: string[];
}

const RUNTIME_STATES: readonly ApplyPlanRuntimeState[] = ["planned", "ready", "running", "succeeded", "failed", "blocked", "cancelled", "stale", "superseded", "materialized", "terminal"];
const TASK_STATES: readonly ApplyPlanTaskStatus[] = ["pending", "running", "done", "failed", "skipped"];
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_ACCEPTED_UNIT_STATES: readonly ApplyPlanRuntimeState[] = ["succeeded"];
const DEFAULT_ACCEPTED_GATE_STATES: readonly ApplyPlanRuntimeState[] = ["succeeded"];
const DEFAULT_EXCLUDED_UNIT_STATES: readonly ApplyPlanRuntimeState[] = ["running", "failed", "blocked", "cancelled", "stale", "superseded", "materialized", "terminal", "succeeded"];

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function string(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(string); }
function ownKeys(value: Record<string, unknown>): string[] { return Object.keys(value); }
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, out: ApplyPlanDiagnostic[]): void {
  const known = new Set(allowed);
  for (const key of ownKeys(value)) if (!known.has(key)) out.push({ code: "UNKNOWN_FIELD", path: `${path}.${key}`, message: `unknown field ${key}` });
}
function issue(out: ApplyPlanDiagnostic[], code: string, message: string, path?: string, refs?: string[]): void { out.push({ code, message, ...(path ? { path } : {}), ...(refs ? { refs } : {}) }); }

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]));
}

/** Stable JSON used for both receipts and plan fingerprints. */
export function canonicalizeApplyPlan(value: ApplyExecutionPlan | unknown): string {
  return JSON.stringify(sortedObject(value));
}

function fingerprintValue(value: ApplyExecutionPlan | unknown): string {
  const copy = record(value) ? { ...value } : value;
  if (record(copy)) delete copy.fingerprint;
  return crypto.createHash("sha256").update(canonicalizeApplyPlan(copy)).digest("hex");
}

export function fingerprintApplyExecutionPlan(plan: ApplyExecutionPlan): string { return fingerprintValue(plan); }
export const applyPlanFingerprint = fingerprintApplyExecutionPlan;

function pathOverlap(left: string, right: string): boolean {
  const clean = (item: string) => item.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const a = clean(left); const b = clean(right);
  return a === b || a === "." || b === "." || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizeScopePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const value = path.posix.normalize(trimmed.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""));
  const wildcard = value.search(/[*?\[]/);
  const withoutWildcard = wildcard >= 0 ? value.slice(0, wildcard).replace(/\/+$/, "") : value;
  const normalized = path.posix.normalize(withoutWildcard || ".");
  return normalized === "." ? "." : normalized;
}

function normalizeScopeKind(kind: string | undefined, source: string): ApplyPlanScopeKind {
  if (kind === "rename-source" || kind === "rename-target" || kind === "wildcard" || kind === "path") return kind;
  if (source.includes("*") || source.includes("?") || source.includes("[")) return "wildcard";
  return "path";
}

function normalizeScopeFacts(unitId: string, facts: readonly ApplyPlanScopeFact[]): ApplyPlanScopeFact[] {
  return facts
    .map((entry) => {
      const normalizedPath = normalizeScopePath(entry.path);
      if (!normalizedPath) return null;
      return { unit_id: unitId, path: normalizedPath, kind: normalizeScopeKind(entry.kind, entry.path) };
    })
    .filter((entry): entry is ApplyPlanScopeFact => Boolean(entry))
    .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind) || left.unit_id.localeCompare(right.unit_id));
}

function normalizedFactsFromPlanUnit(unit: ApplyPlanUnit): ApplyPlanScopeFact[] {
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

function scopeConflicts(left: ApplyPlanScopeFact, right: ApplyPlanScopeFact): boolean {
  const a = normalizeScopePath(left.path);
  const b = normalizeScopePath(right.path);
  if (!a || !b) return false;
  return a === b || a === "." || b === "." || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function sortByPlanOrder(values: string[], order: readonly string[]): string[] {
  const index = new Map(order.map((unit, at) => [unit, at]));
  return [...values].sort((left, right) => (index.get(left) ?? Number.MAX_SAFE_INTEGER) - (index.get(right) ?? Number.MAX_SAFE_INTEGER));
}

function normalizeOwnershipFacts(item: ApplyPlanActiveOwnership): ApplyPlanScopeFact[] {
  const facts = item.facts;
  if (facts.length) return normalizeScopeFacts(item.key, facts);
  return [];
}

function isActiveOwnershipBlocking(item: ApplyPlanActiveOwnership): boolean {
  if (item.released === true) return false;
  if (item.slot_released_at !== undefined && item.slot_released_at !== null && item.slot_released_at.length > 0) return false;
  if (item.terminal_unreleased === false) return false;
  return true;
}

function ownershipNamespace(
  values: ApplyPlanConflictGraphOptions["ownershipByUnit"],
  unitId: string,
): ApplyPlanOwnershipNamespace | undefined {
  return values instanceof Map ? values.get(unitId) : values?.[unitId];
}

function overlapPaths(left: readonly ApplyPlanScopeFact[], right: readonly ApplyPlanScopeFact[]): string[] {
  const paths = new Set<string>();
  for (const source of left) for (const target of right) {
    if (scopeConflicts(source, target)) paths.add([source.path, target.path].sort().join(" <-> "));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function namespaceRelation(
  left: ApplyPlanOwnershipNamespace | undefined,
  right: ApplyPlanOwnershipNamespace | undefined,
): "same-root" | "cross-root" | "different-repository" | "unknown" {
  if (!left || !right) return "unknown";
  if (left.repository_id !== right.repository_id) return "different-repository";
  return left.execution_root === right.execution_root ? "same-root" : "cross-root";
}

function isRuntimeAccepted(state: ApplyPlanRuntimeState | undefined, accepted: Set<ApplyPlanRuntimeState>): boolean {
  return accepted.has(state || "planned");
}

function isRuntimeExcluded(state: ApplyPlanRuntimeState | undefined, excluded: Set<ApplyPlanRuntimeState>): boolean {
  return excluded.has(state || "planned");
}

function isBetterCandidate(left: string[], right: string[], critical: Record<string, number>, order: readonly string[]): boolean {
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

function isLexEarlier(left: readonly string[], right: readonly string[], order: readonly string[]): boolean {
  if (right.length === 0) return left.length > 0;
  const index = new Map(order.map((id, at) => [id, at]));
  for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
    const leftOrder = index.get(left[at]!) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = index.get(right[at]!) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder < rightOrder;
  }
  return left.length < right.length;
}

function buildDependencyMaps(plan: ApplyExecutionPlan) {
  const unitMap = new Map<string, ApplyPlanUnit>();
  const gateMap = new Map<string, ApplyPlanParentGate>();
  for (const unit of plan.units) unitMap.set(unit.id, unit);
  for (const gate of plan.parent_gates || []) gateMap.set(gate.id, gate as ApplyPlanParentGate);
  return { unitMap, gateMap };
}

export function deriveDependencyReadyUndispatchedUnits(plan: ApplyExecutionPlan, options: ApplyPlanDependencyReadyOptions = {}): string[] {
  const acceptedUnitStates = new Set(options.acceptedUnitStates?.length ? options.acceptedUnitStates : DEFAULT_ACCEPTED_UNIT_STATES);
  const acceptedGateStates = new Set(options.acceptedGateStates?.length ? options.acceptedGateStates : DEFAULT_ACCEPTED_GATE_STATES);
  const excludedUnitStates = new Set(options.excludedUnitStates?.length ? options.excludedUnitStates : DEFAULT_EXCLUDED_UNIT_STATES);
  const excludedUnitIds = new Set(options.excludedUnitIds || []);
  const { unitMap, gateMap } = buildDependencyMaps(plan);
  const gateReady = new Map<string, boolean>();
  const gateEvaluated = new Set<string>();

  const isGateAccepted = (gateId: string): boolean => {
    if (gateReady.has(gateId)) return gateReady.get(gateId)!;
    if (gateEvaluated.has(gateId)) return false;
    gateEvaluated.add(gateId);
    const gate = gateMap.get(gateId);
    if (!gate) return false;
    if (!isRuntimeAccepted(gate.runtime_state, acceptedGateStates)) return false;
    const dependsOn = gate.depends_on || [];
    const dependenciesAccepted = dependsOn.every((id) => unitMap.has(id)
      ? isRuntimeAccepted(unitMap.get(id)?.runtime_state, acceptedUnitStates)
      : isGateAccepted(id));
    const result = dependenciesAccepted && dependsOn.every((id) => {
      if (unitMap.has(id)) return isRuntimeAccepted(unitMap.get(id)?.runtime_state, acceptedUnitStates);
      return isGateAccepted(id);
    });
    gateReady.set(gateId, result);
    return result;
  };

  const ready: string[] = [];
  for (const unit of plan.units) {
    if (excludedUnitIds.has(unit.id)) continue;
    if (isRuntimeExcluded(unit.runtime_state, excludedUnitStates)) continue;
    const dependsOn = unit.depends_on || [];
    const readyByUnits = dependsOn.every((id) => {
      if (!unitMap.has(id)) return false;
      return isRuntimeAccepted(unitMap.get(id)?.runtime_state, acceptedUnitStates);
    });
    const readyByGate = (unit.parent_gate_ids || []).every((gateId) => isGateAccepted(gateId));
    if (readyByUnits && readyByGate) ready.push(unit.id);
  }
  return ready;
}

export function buildFrontierConflictGraph(plan: ApplyExecutionPlan, frontier: readonly string[], options: ApplyPlanConflictGraphOptions = {}): ApplyPlanConflictGraphResult {
  const stableOrder = options.stableOrder && options.stableOrder.length ? options.stableOrder : plan.units.map((unit) => unit.id);
  const declared = new Map<string, ApplyPlanScopeFact[]>();
  const explicit = options.declaredScopeFacts;
  const explicitMap = new Map<string, ApplyPlanScopeFact[]>();
  if (explicit instanceof Map) {
    for (const [unitId, facts] of explicit.entries()) explicitMap.set(unitId, [...facts]);
  } else if (Array.isArray(explicit)) {
    for (const fact of explicit) {
      const existing = explicitMap.get(fact.unit_id);
      if (existing) {
        existing.push(fact);
      } else {
        explicitMap.set(fact.unit_id, [fact]);
      }
    }
  }
  const unitMap = new Map(plan.units.map((unit) => [unit.id, unit]));

  for (const unitId of frontier) {
    const unit = unitMap.get(unitId);
    if (!unit) continue;
    const fromPlan = normalizedFactsFromPlanUnit(unit);
    const fromOverride = normalizeScopeFacts(unitId, explicitMap.get(unitId) || []);
    declared.set(unitId, fromOverride.length ? fromOverride : fromPlan);
  }

  const conflicts = new Map<string, Set<string>>();
  const integrationRisks: ApplyPlanIntegrationConflictRisk[] = [];
  for (const unitId of frontier) conflicts.set(unitId, new Set());
  for (let left = 0; left < frontier.length; left += 1) {
    for (let right = left + 1; right < frontier.length; right += 1) {
      const leftFacts = declared.get(frontier[left]) || [];
      const rightFacts = declared.get(frontier[right]) || [];
      const paths = overlapPaths(leftFacts, rightFacts);
      if (!paths.length) continue;
      const leftNamespace = ownershipNamespace(options.ownershipByUnit, frontier[left]);
      const rightNamespace = ownershipNamespace(options.ownershipByUnit, frontier[right]);
      const relation = namespaceRelation(leftNamespace, rightNamespace);
      if (relation === "different-repository") continue;
      if (relation === "cross-root") {
        const roots = [leftNamespace!.execution_root, rightNamespace!.execution_root].sort() as [string, string];
        integrationRisks.push({
          from: frontier[left], to: frontier[right], repository_id: leftNamespace!.repository_id,
          execution_roots: roots, paths,
        });
        continue;
      }
      conflicts.get(frontier[left])?.add(frontier[right]);
      conflicts.get(frontier[right])?.add(frontier[left]);
    }
  }
  const blockedByActiveOwnership = new Set<string>();
  const activeOwnership = options.activeOwnership || [];
  for (const unitId of frontier) {
    const unitFacts = declared.get(unitId) || [];
    for (const ownership of activeOwnership) {
      if (!isActiveOwnershipBlocking(ownership)) continue;
      const ownershipFacts = normalizeOwnershipFacts(ownership);
      const paths = overlapPaths(unitFacts, ownershipFacts);
      if (!paths.length) continue;
      const candidateNamespace = ownershipNamespace(options.ownershipByUnit, unitId);
      const ownerNamespace = ownership.repository_id && ownership.execution_root
        ? { repository_id: ownership.repository_id, execution_root: ownership.execution_root, ...(ownership.base_tree ? { base_tree: ownership.base_tree } : {}) }
        : undefined;
      const relation = namespaceRelation(candidateNamespace, ownerNamespace);
      if (relation === "different-repository") continue;
      if (relation === "cross-root") {
        const roots = [candidateNamespace!.execution_root, ownerNamespace!.execution_root].sort() as [string, string];
        integrationRisks.push({ from: unitId, to: ownership.key, repository_id: candidateNamespace!.repository_id, execution_roots: roots, paths });
        continue;
      }
      blockedByActiveOwnership.add(unitId);
    }
  }

  return {
    conflicts: new Map([...conflicts.entries()].map(([unitId, linked]) => [unitId, sortByPlanOrder([...linked], stableOrder)])),
    blockedByActiveOwnership,
    integration_conflict_risks: integrationRisks.sort((left, right) => left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to) || left.repository_id.localeCompare(right.repository_id)
      || left.execution_roots.join("\0").localeCompare(right.execution_roots.join("\0"))
      || left.paths.join("\0").localeCompare(right.paths.join("\0"))),
  };
}

export function selectIndependentSet(frontier: readonly string[], conflictGraph: ReadonlyMap<string, readonly string[]>, options: ApplyPlanIndependentSetOptions = {}): string[] {
  const capacity = Math.max(0, Number.isFinite(options.capacity as number) ? Math.floor(options.capacity as number) : 0);
  if (!frontier.length || !capacity) return [];
  const criticalPathByUnit = options.criticalPathByUnit || {};
  const blockedByOption = new Set(options.excludedUnitIds || []);
  const order = [...frontier];
  const candidateUnits = order.filter((unitId) => !blockedByOption.has(unitId));
  const maxCapacity = Math.min(capacity, candidateUnits.length);
  if (maxCapacity === 0) return [];
  const candidateSet = new Set(candidateUnits);
  const adjacencySet = new Map<string, Set<string>>(
    candidateUnits.map((unitId) => [unitId, new Set((conflictGraph.get(unitId) || []).filter((target) => candidateSet.has(target)))]),
  );

  const canSelect = (unitId: string, chosen: ReadonlySet<string>) => {
    for (const existing of chosen) {
      if (adjacencySet.get(unitId)?.has(existing) || adjacencySet.get(existing)?.has(unitId)) return false;
    }
    return true;
  };

  const score = (ids: readonly string[]): number => ids.reduce((total, id) => {
    const value = criticalPathByUnit[id];
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
  const greedy: string[] = [];
  const greedySet = new Set<string>();
  for (const unitId of candidateUnits) {
    if (greedy.length >= maxCapacity) break;
    if (canSelect(unitId, greedySet)) { greedy.push(unitId); greedySet.add(unitId); }
  }
  let best: string[] = greedy;
  const chosenSet = new Set<string>();
  const configuredLimit = Number(options.maxSearchNodes);
  const maxSearchNodes = Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 1_000_000;
  let searchedNodes = 0;
  const backtrack = (startAt: number, chosen: string[]) => {
    searchedNodes += 1;
    if (searchedNodes > maxSearchNodes) throw new ApplyPlanSearchError(maxSearchNodes);
    if (isBetterCandidate(chosen, best, criticalPathByUnit, order)) best = [...chosen];
    const compatible = candidateUnits.slice(startAt).filter((unitId) => canSelect(unitId, chosenSet));
    const needed = Math.min(maxCapacity - chosen.length, compatible.length);
    const maximumCardinality = chosen.length + needed;
    if (maximumCardinality < best.length) return;
    if (maximumCardinality === best.length) {
      const optimisticScore = score(chosen) + compatible
        .map((id) => Number.isFinite(criticalPathByUnit[id]) ? criticalPathByUnit[id]! : 0)
        .sort((left, right) => right - left)
        .slice(0, needed)
        .reduce((total, value) => total + value, 0);
      const bestScore = score(best);
      if (optimisticScore < bestScore) return;
      if (optimisticScore === bestScore) {
        const lexLowerBound = sortByPlanOrder([...chosen, ...compatible.slice(0, needed)], order);
        if (!isLexEarlier(lexLowerBound, best, order)) return;
      }
    }
    if (startAt >= candidateUnits.length || chosen.length === maxCapacity) {
      return;
    }
    const next = candidateUnits[startAt]!;
    if (chosen.length < maxCapacity && canSelect(next, chosenSet)) {
      chosenSet.add(next);
      chosen.push(next);
      backtrack(startAt + 1, chosen);
      chosen.pop();
      chosenSet.delete(next);
    }
    backtrack(startAt + 1, chosen);
  };
  backtrack(0, []);
  return sortByPlanOrder(best, frontier);
}

export function deriveSafeReadyFrontier(plan: ApplyExecutionPlan, options: {
  capacity: number;
  acceptedUnitStates?: readonly ApplyPlanRuntimeState[];
  acceptedGateStates?: readonly ApplyPlanRuntimeState[];
  excludedUnitStates?: readonly ApplyPlanRuntimeState[];
  excludedUnitIds?: readonly string[];
  declaredScopeFacts?: ReadonlyMap<string, readonly ApplyPlanScopeFact[]> | readonly ApplyPlanScopeFact[];
  activeOwnership?: readonly ApplyPlanActiveOwnership[];
  criticalPathByUnit?: Record<string, number>;
}): string[] {
  const frontier = deriveDependencyReadyUndispatchedUnits(plan, {
    acceptedUnitStates: options.acceptedUnitStates,
    acceptedGateStates: options.acceptedGateStates,
    excludedUnitStates: options.excludedUnitStates,
    excludedUnitIds: options.excludedUnitIds,
  });
  const graph = buildFrontierConflictGraph(plan, frontier, { declaredScopeFacts: options.declaredScopeFacts, activeOwnership: options.activeOwnership, stableOrder: frontier });
  const remainingCritical = options.criticalPathByUnit || remainingCriticalPath(plan);
  return selectIndependentSet(frontier, graph.conflicts, {
    capacity: options.capacity,
    criticalPathByUnit: remainingCritical,
    excludedUnitIds: [...graph.blockedByActiveOwnership],
  });
}

function graphCycle(nodes: string[], edges: Map<string, string[]>): string[] | null {
  const colour = new Map<string, number>(); const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    colour.set(node, 1); stack.push(node);
    for (const next of [...(edges.get(node) || [])].sort()) {
      if (colour.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!colour.get(next)) { const found = visit(next); if (found) return found; }
    }
    stack.pop(); colour.set(node, 2); return null;
  };
  for (const node of [...nodes].sort()) if (!colour.get(node)) { const found = visit(node); if (found) return found; }
  return null;
}

function reachable(edges: Map<string, string[]>, from: string, target: string): boolean {
  const seen = new Set<string>(); const todo = [from];
  while (todo.length) { const current = todo.pop()!; if (current === target) return true; if (seen.has(current)) continue; seen.add(current); todo.push(...(edges.get(current) || [])); }
  return false;
}

function criticalPath(plan: ApplyExecutionPlan): Record<string, number> {
  const validUnits = (Array.isArray(plan.units) ? plan.units : [])
    .filter((unit): unit is ApplyPlanUnit => record(unit) && string(unit.id));
  const units = new Map(validUnits.map((unit) => [unit.id, unit]));
  const done = new Set(validUnits.filter((unit) => unit.runtime_state === "succeeded").map((unit) => unit.id));
  const dependents = new Map<string, string[]>();
  for (const unit of validUnits) {
    for (const dependency of Array.isArray(unit.depends_on) ? unit.depends_on.filter(string) : []) {
      const linked = dependents.get(dependency);
      if (linked) linked.push(unit.id);
      else dependents.set(dependency, [unit.id]);
    }
  }
  const memo = new Map<string, number>();
  const distance = (id: string, visiting = new Set<string>()): number => {
    if (done.has(id)) return 0;
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = 1 + Math.max(0, ...(dependents.get(id) || []).map((dependent) => distance(dependent, new Set(visiting))));
    memo.set(id, value); return value;
  };
  return Object.fromEntries([...units.keys()].sort().map((id) => [id, distance(id)]));
}

export function remainingCriticalPath(plan: ApplyExecutionPlan): Record<string, number> { return criticalPath(plan); }

function ownershipForbidden(value: unknown): boolean {
  if (!record(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (["owner", "ownership", "worker", "executor"].includes(key.toLowerCase()) && typeof item === "string" && /openspec(?:[-_ ]worker)?|open.?spec.*worker/i.test(item)) return true;
    if (ownershipForbidden(item)) return true;
    if (Array.isArray(item) && item.some(ownershipForbidden)) return true;
  }
  return false;
}

export function validateApplyExecutionPlan(input: unknown): ApplyPlanValidationResult {
  const diagnostics: ApplyPlanDiagnostic[] = []; const overlap_edges: ApplyPlanOverlapEdge[] = [];
  if (!record(input)) { issue(diagnostics, "INVALID_PLAN", "plan must be a JSON object"); return { valid: false, diagnostics, overlap_edges, remaining_critical_path: {} }; }
  const raw = input;
  unknownKeys(raw, ["schema_version", "identity", "source_snapshot", "selected_tasks", "units", "parent_gates", "task_mappings", "task_completion", "revision_lineage", "runtime_state", "fingerprint"], "plan", diagnostics);
  if (raw.schema_version !== APPLY_EXECUTION_PLAN_SCHEMA_VERSION) issue(diagnostics, "UNKNOWN_SCHEMA", `unsupported schema version ${String(raw.schema_version)}`, "plan.schema_version");
  if (!record(raw.identity)) issue(diagnostics, "REQUIRED_FIELD", "identity is required", "plan.identity");
  else { unknownKeys(raw.identity, ["plan_id", "change_id", "created_at", "owner"], "identity", diagnostics); if (!string(raw.identity.plan_id)) issue(diagnostics, "REQUIRED_FIELD", "plan_id is required", "identity.plan_id"); if (!string(raw.identity.change_id)) issue(diagnostics, "REQUIRED_FIELD", "change_id is required", "identity.change_id"); }
  if (!record(raw.source_snapshot)) issue(diagnostics, "REQUIRED_FIELD", "source_snapshot is required", "plan.source_snapshot");
  else { unknownKeys(raw.source_snapshot, ["repo_root", "revision", "tasks_path", "fingerprint"], "source_snapshot", diagnostics); if (!string(raw.source_snapshot.repo_root) || !string(raw.source_snapshot.revision)) issue(diagnostics, "REQUIRED_FIELD", "repo_root and revision are required", "source_snapshot"); }
  if (raw.revision_lineage !== undefined) {
    if (!record(raw.revision_lineage)) issue(diagnostics, "INVALID_FIELD", "revision_lineage must be an object", "revision_lineage");
    else { unknownKeys(raw.revision_lineage, ["base", "parent", "head", "ancestors"], "revision_lineage", diagnostics); if (!string(raw.revision_lineage.base)) issue(diagnostics, "REQUIRED_FIELD", "revision_lineage.base is required", "revision_lineage.base"); if (raw.revision_lineage.ancestors !== undefined && !strings(raw.revision_lineage.ancestors)) issue(diagnostics, "INVALID_FIELD", "ancestors must be a string array", "revision_lineage.ancestors"); }
  }
  if (raw.runtime_state !== undefined && !RUNTIME_STATES.includes(raw.runtime_state as ApplyPlanRuntimeState)) issue(diagnostics, "INVALID_STATE", "unknown runtime state", "runtime_state");
  if (!strings(raw.selected_tasks)) issue(diagnostics, "REQUIRED_FIELD", "selected_tasks must be a string array", "selected_tasks");
  if (!Array.isArray(raw.units)) issue(diagnostics, "REQUIRED_FIELD", "units must be an array", "units");
  if (ownershipForbidden(raw)) issue(diagnostics, "FORBIDDEN_OWNERSHIP", "OpenSpec worker ownership is forbidden");
  const selected = new Set(strings(raw.selected_tasks) ? raw.selected_tasks : []);
  if (selected.size !== (strings(raw.selected_tasks) ? raw.selected_tasks.length : 0)) issue(diagnostics, "DUPLICATE_REFERENCE", "selected_tasks contains duplicates", "selected_tasks");
  const units = Array.isArray(raw.units) ? raw.units : []; const unitIds = new Set<string>();
  const unitEdges = new Map<string, string[]>();
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]; const p = `units[${index}]`;
    if (!record(unit)) { issue(diagnostics, "INVALID_UNIT", "unit must be an object", p); continue; }
    unknownKeys(unit, ["id", "mode", "task_ids", "description", "prompt", "write_paths", "allowed_operations", "depends_on", "parent_gate_ids", "runtime_state", "remaining_critical_path", "patch", "verification"], p, diagnostics);
    if (!string(unit.id)) issue(diagnostics, "REQUIRED_FIELD", "id is required", `${p}.id`); else if (unitIds.has(unit.id)) issue(diagnostics, "DUPLICATE_REFERENCE", `duplicate unit ${unit.id}`, `${p}.id`); else unitIds.add(unit.id);
    if (unit.mode !== "patch-only" && unit.mode !== "verification-only") issue(diagnostics, "INVALID_MODE", "mode must be patch-only or verification-only", `${p}.mode`);
    if (!strings(unit.task_ids)) issue(diagnostics, "REQUIRED_FIELD", "task_ids must be a string array", `${p}.task_ids`);
    if (unit.mode === "verification-only" && (unit.write_paths !== undefined || unit.allowed_operations !== undefined || unit.patch !== undefined)) issue(diagnostics, "FORBIDDEN_FIELD", "verification-only units cannot declare patch/write fields", p);
    if (unit.mode === "verification-only" && unit.verification !== undefined && !strings(unit.verification)) issue(diagnostics, "INVALID_FIELD", "verification must be a string array", `${p}.verification`);
    if (unit.mode === "patch-only" && unit.verification !== undefined) issue(diagnostics, "FORBIDDEN_FIELD", "patch-only units cannot declare verification", `${p}.verification`);
    if (unit.mode === "patch-only" && (!strings(unit.write_paths) || unit.write_paths.length === 0)) issue(diagnostics, "REQUIRED_FIELD", "patch-only units require write_paths", `${p}.write_paths`);
    if (unit.mode === "patch-only" && (!Array.isArray(unit.allowed_operations) || unit.allowed_operations.length === 0)) issue(diagnostics, "REQUIRED_FIELD", "patch-only units require allowed_operations", `${p}.allowed_operations`);
    if (strings(unit.write_paths) && unit.write_paths.some((item) => item === ".git" || item.startsWith(".git/"))) issue(diagnostics, "FORBIDDEN_PATH", ".git is not an allowed write path", `${p}.write_paths`);
    if (unit.allowed_operations !== undefined && (!Array.isArray(unit.allowed_operations) || unit.allowed_operations.some((op) => !APPLY_PLAN_OPERATIONS.includes(op as SafetyOperation)))) issue(diagnostics, "INVALID_OPERATION", "allowed_operations contains an unsupported operation", `${p}.allowed_operations`);
    if (unit.runtime_state !== undefined && !RUNTIME_STATES.includes(unit.runtime_state as ApplyPlanRuntimeState)) issue(diagnostics, "INVALID_STATE", "unknown runtime state", `${p}.runtime_state`);
    if (strings(unit.task_ids) && new Set(unit.task_ids).size !== unit.task_ids.length) issue(diagnostics, "DUPLICATE_REFERENCE", `unit ${String(unit.id)} repeats a task`, `${p}.task_ids`);
    if (strings(unit.depends_on) && new Set(unit.depends_on).size !== unit.depends_on.length) issue(diagnostics, "DUPLICATE_REFERENCE", `unit ${String(unit.id)} repeats a dependency`, `${p}.depends_on`);
    if (string(unit.id)) unitEdges.set(unit.id, strings(unit.depends_on) ? [...unit.depends_on] : []);
  }
  for (const [id, deps] of unitEdges) for (const dep of deps) if (!unitIds.has(dep)) issue(diagnostics, "UNKNOWN_REFERENCE", `unit ${id} depends on unknown unit ${dep}`, `units.${id}.depends_on`, [dep]);
  const depCycle = graphCycle([...unitIds], unitEdges); if (depCycle) issue(diagnostics, "DEPENDENCY_CYCLE", `dependency cycle: ${depCycle.join(" -> ")}`, "units", depCycle);
  const gates = Array.isArray(raw.parent_gates) ? raw.parent_gates : []; const gateIds = new Set<string>(); const gateEdges = new Map<string, string[]>();
  if (raw.parent_gates !== undefined && !Array.isArray(raw.parent_gates)) issue(diagnostics, "INVALID_FIELD", "parent_gates must be an array", "parent_gates");
  for (let index = 0; index < gates.length; index += 1) { const gate = gates[index]; const p = `parent_gates[${index}]`; if (!record(gate)) { issue(diagnostics, "INVALID_GATE", "gate must be an object", p); continue; } const body = gate as Record<string, unknown>; unknownKeys(body, ["id", "depends_on", "unit_ids", "task_ids", "runtime_state"], p, diagnostics); if (!string(body.id)) issue(diagnostics, "REQUIRED_FIELD", "id is required", `${p}.id`); else if (gateIds.has(body.id)) issue(diagnostics, "DUPLICATE_REFERENCE", `duplicate gate ${body.id}`, `${p}.id`); else gateIds.add(body.id); gateEdges.set(body.id as string, strings(body.depends_on) ? [...body.depends_on] : []); }
  for (const [id, deps] of gateEdges) for (const dep of deps) if (!gateIds.has(dep) && !unitIds.has(dep)) issue(diagnostics, "UNKNOWN_REFERENCE", `gate ${id} depends on unknown gate or unit ${dep}`, `parent_gates.${id}.depends_on`, [dep]);
  const gateCycle = graphCycle([...gateIds], gateEdges); if (gateCycle) issue(diagnostics, "GATE_CYCLE", `gate cycle: ${gateCycle.join(" -> ")}`, "parent_gates", gateCycle);
  for (const unit of units) if (record(unit) && strings(unit.parent_gate_ids)) for (const gateId of unit.parent_gate_ids) if (!gateIds.has(gateId)) issue(diagnostics, "UNKNOWN_REFERENCE", `unit references unknown parent gate ${gateId}`, "units.parent_gate_ids", [gateId]);
  const covered = new Set<string>();
  for (const unit of units) if (record(unit) && strings(unit.task_ids)) for (const task of unit.task_ids) { if (!selected.has(task)) issue(diagnostics, "UNKNOWN_REFERENCE", `unit references unselected task ${task}`, "units.task_ids", [task]); covered.add(task); }
  for (const gate of gates) if (record(gate)) { const body = gate as Record<string, unknown>; if (strings(body.task_ids)) for (const task of body.task_ids) { if (!selected.has(task)) issue(diagnostics, "UNKNOWN_REFERENCE", `gate references unselected task ${task}`, "parent_gates.task_ids", [task]); covered.add(task); } if (strings(body.unit_ids)) for (const id of body.unit_ids) if (!unitIds.has(id)) issue(diagnostics, "UNKNOWN_REFERENCE", `gate references unknown unit ${id}`, "parent_gates.unit_ids", [id]); }
  for (const task of selected) if (!covered.has(task)) issue(diagnostics, "TASK_COVERAGE_INCOMPLETE", `selected task ${task} has no unit or gate mapping`, "selected_tasks", [task]);
  if (raw.task_completion !== undefined) { if (!record(raw.task_completion)) issue(diagnostics, "INVALID_FIELD", "task_completion must be an object", "task_completion"); else for (const [task, completion] of Object.entries(raw.task_completion)) { if (!selected.has(task)) issue(diagnostics, "UNKNOWN_REFERENCE", `completion references unselected task ${task}`, `task_completion.${task}`, [task]); if (!record(completion) || !TASK_STATES.includes(completion.status as ApplyPlanTaskStatus)) issue(diagnostics, "INVALID_STATE", `invalid task completion state for ${task}`, `task_completion.${task}`); } }
  if (raw.task_mappings !== undefined) {
    if (!Array.isArray(raw.task_mappings)) issue(diagnostics, "INVALID_FIELD", "task_mappings must be an array", "task_mappings");
    else {
      const mapped = new Set<string>();
      const unitTasks = new Map<string, Set<string>>();
      const gateTasks = new Map<string, Set<string>>();
      for (const unit of units) {
        if (record(unit) && string(unit.id) && strings(unit.task_ids)) unitTasks.set(unit.id, new Set(unit.task_ids));
      }
      for (const gate of gates) {
        if (record(gate) && string(gate.id) && strings(gate.task_ids)) gateTasks.set(gate.id, new Set(gate.task_ids));
      }
      for (const mapping of raw.task_mappings) {
        if (!record(mapping)) { issue(diagnostics, "INVALID_MAPPING", "mapping requires task_id and at least one unit or gate", "task_mappings"); continue; }
        unknownKeys(mapping, ["task_id", "unit_ids", "gate_ids"], "task_mappings", diagnostics);
        if (!string(mapping.task_id) || !strings(mapping.unit_ids) || (mapping.gate_ids !== undefined && !strings(mapping.gate_ids))) {
          issue(diagnostics, "INVALID_MAPPING", "mapping requires task_id, unit_ids, and valid gate_ids", "task_mappings");
          continue;
        }
        const mappingTaskId = mapping.task_id as string;
        const unitReferences = mapping.unit_ids as string[];
        const gateReferences = (mapping.gate_ids === undefined ? [] : mapping.gate_ids) as string[];
        if (unitReferences.length === 0 && gateReferences.length === 0) {
          issue(diagnostics, "INVALID_MAPPING", `mapping for ${mappingTaskId} requires at least one unit or gate`, "task_mappings", [mappingTaskId]);
        }
        if (mapped.has(mappingTaskId)) issue(diagnostics, "AMBIGUOUS_MAPPING", `task ${mappingTaskId} has multiple mappings`, "task_mappings", [mappingTaskId]);
        mapped.add(mappingTaskId);
        if (!selected.has(mappingTaskId)) issue(diagnostics, "UNKNOWN_REFERENCE", `mapping references unselected task ${mappingTaskId}`, "task_mappings", [mappingTaskId]);
        if (new Set(unitReferences).size !== unitReferences.length) issue(diagnostics, "DUPLICATE_REFERENCE", `mapping for ${mappingTaskId} repeats a unit`, "task_mappings", [mappingTaskId]);
        if (new Set(gateReferences).size !== gateReferences.length) issue(diagnostics, "DUPLICATE_REFERENCE", `mapping for ${mappingTaskId} repeats a gate`, "task_mappings", [mappingTaskId]);
        for (const id of unitReferences) {
          if (!unitIds.has(id)) issue(diagnostics, "UNKNOWN_REFERENCE", `mapping references unknown unit ${id}`, "task_mappings", [id]);
          else if (!unitTasks.get(id)?.has(mappingTaskId)) issue(diagnostics, "MAPPING_TASK_MISMATCH", `mapping for ${mappingTaskId} references unit ${id} without that task`, "task_mappings", [mappingTaskId, id]);
          covered.add(mappingTaskId);
        }
        for (const id of gateReferences) {
          if (!gateIds.has(id)) issue(diagnostics, "UNKNOWN_REFERENCE", `mapping for ${mappingTaskId} references unknown gate ${id}`, "task_mappings", [id]);
          else if (!gateTasks.get(id)?.has(mappingTaskId)) issue(diagnostics, "MAPPING_TASK_MISMATCH", `mapping for ${mappingTaskId} references gate ${id} without that task`, "task_mappings", [mappingTaskId, id]);
          covered.add(mappingTaskId);
        }
      }
      for (const task of selected) {
        if (!mapped.has(task)) issue(diagnostics, "TASK_COVERAGE_INCOMPLETE", `selected task ${task} has no explicit task mapping`, "task_mappings", [task]);
      }
    }
  }
  const unitWriteFacts = new Map<string, ApplyPlanScopeFact[]>();
  const getUnitWriteFacts = (unit: ApplyPlanUnit): ApplyPlanScopeFact[] => {
    const cached = unitWriteFacts.get(unit.id);
    if (cached) return cached;
    const facts = normalizedFactsFromPlanUnit(unit);
    unitWriteFacts.set(unit.id, facts);
    return facts;
  };
  for (let left = 0; left < units.length; left += 1) {
    for (let right = left + 1; right < units.length; right += 1) {
      const a = units[left];
      const b = units[right];
      if (!record(a) || !record(b)) continue;
      const aa = a as unknown as ApplyPlanUnit;
      const bb = b as unknown as ApplyPlanUnit;
      if (!string(aa.id) || !string(bb.id) || !strings(aa.write_paths) || !strings(bb.write_paths)) continue;
      const leftFacts = getUnitWriteFacts(aa);
      const rightFacts = getUnitWriteFacts(bb);
      const paths = [...new Set(
        leftFacts
          .filter((source) => rightFacts.some((target) => scopeConflicts(source, target)))
          .map((source) => source.path),
      )].sort();
      if (!paths.length) continue;
      overlap_edges.push({ from: aa.id, to: bb.id, paths });
    }
  }
  const fakePlan = raw as unknown as ApplyExecutionPlan; const remaining_critical_path = Array.isArray(raw.units) ? criticalPath(fakePlan) : {};
  if (raw.fingerprint !== undefined && (!string(raw.fingerprint) || !HEX_SHA256.test(raw.fingerprint))) issue(diagnostics, "INVALID_FINGERPRINT", "fingerprint must be a SHA-256 hex string", "fingerprint");
  return { valid: diagnostics.length === 0, diagnostics, overlap_edges, remaining_critical_path, ...(diagnostics.length === 0 ? { plan: fakePlan } : {}) };
}

export function assertValidApplyExecutionPlan(input: unknown): ApplyExecutionPlan {
  const result = validateApplyExecutionPlan(input); if (!result.valid) throw new ApplyPlanValidationError(result.diagnostics); return input as ApplyExecutionPlan;
}

export function parseApplyExecutionPlan(text: string): ApplyExecutionPlan {
  let value: unknown; try { value = JSON.parse(text); } catch { throw new ApplyPlanValidationError([{ code: "INVALID_JSON", message: "plan is not valid JSON" }]); }
  return assertValidApplyExecutionPlan(value);
}

export function serializeApplyExecutionPlan(plan: ApplyExecutionPlan): string { return canonicalizeApplyPlan(assertValidApplyExecutionPlan(plan)); }
export const canonicalJson = canonicalizeApplyPlan;
export const fingerprintPlan = fingerprintApplyExecutionPlan;
