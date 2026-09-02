/**
 * Semantic validation for one rolling PlanDelta.
 *
 * `rolling-plan.ts` validates the wire shape of a document.  This module is
 * the second, deliberately source-neutral boundary: it validates one delta
 * against facts that have already been accepted by the run.  It never reads a
 * source, repository, run log, or scheduler state.  A caller may therefore
 * validate a delta before taking the compare-and-append lock.
 */
import path from "node:path";
import {
  ROLLING_WORKTREE_STATE_SCHEMA_VERSION,
  RollingProtocolValidationError,
  validatePlanDelta as validatePlanDeltaShape,
  type GateType,
  type GateVersion,
  type PlanDelta,
  type RollingDiagnostic,
  type RollingValidationResult,
  type TaskCoverage,
  type TaskManifestEntry,
  type UnitExecutionMode,
  type UnitVersion,
  type WorktreeExecutionMode,
} from "./rolling-plan.js";
import type { SafetyOperation } from "./safety.js";
import { isNonBlankString, isRecord } from "./validate-utils.js";
import {
  ROLLING_DELTA_GATE_TYPES,
  ROLLING_DELTA_OPERATIONS,
  makeIndex,
  sortDiagnostics,
  stableVersionId,
} from "./rolling/delta-index.js";
import {
  addKnownDependencies,
  addStructuralDiagnostics,
  checkAcyclic,
  checkCoverage,
  checkDependencies,
  checkGateContract,
  checkSupersessions,
  checkTaskRefs,
  checkUnitContract,
  normalizeDelta,
} from "./rolling/delta-checks.js";

export { ROLLING_DELTA_GATE_TYPES, ROLLING_DELTA_OPERATIONS };

export const ROLLING_DELTA_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;


type FixedFactCollection<T> = readonly T[] | ReadonlyMap<string, T> | Readonly<Record<string, T>>;

/**
 * Fixed facts are intentionally explicit.  The validator does not discover
 * facts from a run, a task source, or the filesystem.  The aliases are kept
 * for callers that use the corresponding checkpoint field names; the
 * snake_case fields are the canonical form.
 */
export interface PlanDeltaFixedFacts {
  [key: string]: unknown;
  manifest_entries?: FixedFactCollection<TaskManifestEntry>;
  task_manifest?: FixedFactCollection<TaskManifestEntry>;
  task_entries?: FixedFactCollection<TaskManifestEntry>;
  tasks?: FixedFactCollection<TaskManifestEntry>;
  known_tasks?: FixedFactCollection<TaskManifestEntry>;
  unit_versions?: FixedFactCollection<UnitVersion>;
  gate_versions?: FixedFactCollection<GateVersion>;
  known_units?: FixedFactCollection<UnitVersion>;
  known_gates?: FixedFactCollection<GateVersion>;

  /** Checkpoint-friendly aliases. */
  manifest?: FixedFactCollection<TaskManifestEntry> | { entries?: readonly TaskManifestEntry[] };
  units?: FixedFactCollection<UnitVersion>;
  gates?: FixedFactCollection<GateVersion>;

  /** Explicit aliases for code that keeps fixed and proposed facts separate. */
  fixed_manifest_entries?: FixedFactCollection<TaskManifestEntry>;
  fixed_task_entries?: FixedFactCollection<TaskManifestEntry>;
  fixed_tasks?: FixedFactCollection<TaskManifestEntry>;
  fixed_unit_versions?: FixedFactCollection<UnitVersion>;
  fixed_gate_versions?: FixedFactCollection<GateVersion>;

  /** Camel-case views are accepted at the API edge and never persisted. */
  manifestEntries?: FixedFactCollection<TaskManifestEntry>;
  taskEntries?: FixedFactCollection<TaskManifestEntry>;
  unitVersions?: FixedFactCollection<UnitVersion>;
  gateVersions?: FixedFactCollection<GateVersion>;

  /** Previously accepted deltas may be supplied instead of flattened facts. */
  accepted_deltas?: readonly PlanDelta[];
  deltas?: readonly PlanDelta[];

  /** Rolling checkpoint identity used to gate immutable worktree mode. */
  rolling_run_schema_version?: number;
  run_schema_version?: number;
  run_execution_mode?: WorktreeExecutionMode;
  worktree_mode?: WorktreeExecutionMode;
  identity?: { execution_mode?: WorktreeExecutionMode; [key: string]: unknown };
}

/** A nested form is useful when passing a run snapshot plus other context. */
export interface PlanDeltaValidationContext extends PlanDeltaFixedFacts {
  [key: string]: unknown;
  fixed_facts?: PlanDeltaFixedFacts;
  fixed?: PlanDeltaFixedFacts;
  checkpoint?: PlanDeltaFixedFacts;
}

/** Public aliases used by source-neutral callers. */
export type RollingPlanFixedFacts = PlanDeltaFixedFacts;
export type RollingDeltaFixedFacts = PlanDeltaFixedFacts;
export type RollingPlanDeltaFixedFacts = PlanDeltaFixedFacts;
export type FixedRollingFacts = PlanDeltaFixedFacts;

export interface PlanDeltaValidationResult extends RollingValidationResult<PlanDelta> {
  /** The accepted document with write scopes and operation lists canonicalized. */
  normalized?: PlanDelta;
}

export type PlanDeltaDiagnostic = RollingDiagnostic;
export type RollingDeltaDiagnostic = RollingDiagnostic;

export class RollingDeltaValidationError extends RollingProtocolValidationError {
  constructor(diagnostics: RollingDiagnostic[]) {
    super(diagnostics);
    this.name = "RollingDeltaValidationError";
  }
}

export { RollingDeltaValidationError as PlanDeltaValidationError };


/**
 * Validate a single open-world PlanDelta against only the supplied fixed
 * facts.  No coverage is inferred or required for untouched manifest tasks.
 */
export function validatePlanDeltaAgainstFacts(input: unknown, context: PlanDeltaValidationContext = {}): PlanDeltaValidationResult {
  const diagnostics: RollingDiagnostic[] = [];
  const shapeValid = addStructuralDiagnostics(input, diagnostics);
  if (!isRecord(input)) return { valid: false, diagnostics: sortDiagnostics(diagnostics) };
  const delta = input as unknown as PlanDelta;
  const index = makeIndex(context, delta, diagnostics);
  const normalized = structuredClone(delta);
  const normalizedUnits = new Map<string, UnitVersion>();
  for (const value of Array.isArray(normalized.unit_versions) ? normalized.unit_versions : []) {
    const id = stableVersionId(value.unit_key, value.version);
    if (id) normalizedUnits.set(id, value);
  }

  for (const fact of [...index.localUnits.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const node = index.nodes.get(`unit:${fact.id}`);
    if (!node) continue;
    checkTaskRefs(node, index, diagnostics);
    checkUnitContract(fact, normalizedUnits.get(fact.id) || structuredClone(fact.value), index, context, diagnostics);
  }
  for (const fact of [...index.localGates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const node = index.nodes.get(`gate:${fact.id}`);
    if (!node) continue;
    checkTaskRefs(node, index, diagnostics);
    checkGateContract(fact, diagnostics);
  }

  const edges = new Map<string, Set<string>>();
  for (const node of [...index.nodes.values()].filter((fact) => fact.source === "fixed").sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
    addKnownDependencies(node, index, edges);
  }
  for (const fact of [...index.localUnits.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const node = index.nodes.get(`unit:${fact.id}`);
    if (node) checkDependencies(node, index, edges, diagnostics);
  }
  for (const fact of [...index.localGates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const node = index.nodes.get(`gate:${fact.id}`);
    if (node) checkDependencies(node, index, edges, diagnostics);
  }
  checkAcyclic(index, edges, diagnostics);
  checkCoverage(delta, index, diagnostics);
  checkSupersessions(delta, index, diagnostics);

  if (!shapeValid || diagnostics.length > 0) return { valid: false, diagnostics: sortDiagnostics(diagnostics) };
  const canonical = normalizeDelta(normalized, index);
  return { valid: true, diagnostics: [], value: canonical, normalized: canonical };
}

/** Common short name for callers that already know they are validating a delta. */
export const validatePlanDelta = validatePlanDeltaAgainstFacts;

export function assertPlanDeltaAgainstFacts(input: unknown, context: PlanDeltaValidationContext = {}): PlanDelta {
  const result = validatePlanDeltaAgainstFacts(input, context);
  if (!result.valid) throw new RollingDeltaValidationError(result.diagnostics);
  return result.value as PlanDelta;
}

export const assertPlanDelta = assertPlanDeltaAgainstFacts;
