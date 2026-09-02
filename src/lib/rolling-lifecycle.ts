import {
  deriveTaskLifecycle,
  stateFor,
  taskLifecycle
} from "./rolling/lifecycle-derive.js";
import {
  coverageByTask,
  lineageStates,
  refsForCoverage,
  supersededVersionsFromContext
} from "./rolling/lifecycle-lineage.js";
import {
  contextDeltas,
  contextManifest,
  contextOf,
  contextSeals,
  contextVersions,
  exactSet,
  issue,
  sortedUnique
} from "./rolling/lifecycle-context.js";
/**
 * Pure task lifecycle and seal evaluation for rolling execution.
 *
 * A task is deliberately open-world.  A unit (or gate) becoming accepted is
 * evidence for the currently known window, not evidence that the director
 * has finished discovering work.  Only an explicit, exact seal can move a
 * task beyond `open`; source reconciliation is a separate fact again.
 */
import {
  RollingProtocolValidationError,
  validateTaskSeal as validateTaskSealShape,
  fingerprintTaskSeal,
  type GateVersion,
  type PlanDelta,
  type RollingDiagnostic,
  type RollingValidationResult,
  type TaskCoverage,
  type TaskManifestEntry,
  type TaskSeal,
  type UnitVersion,
} from "./rolling-plan.js";

export const ROLLING_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export type RollingTaskLifecycleState = "unplanned" | "open" | "blocked" | "sealed" | "reconciled";
/** `planned` is retained as a wire/API spelling for callers of the phase-1 status facade. */
export type RollingTaskStatus = RollingTaskLifecycleState | "planned";
export type RollingTaskLineageState =
  | "undispatched"
  | "reserved"
  | "running"
  | "terminal-unreleased"
  | "accepted"
  | "failed"
  | "blocked"
  | "superseded"
  | string;

/** The lifecycle evaluator accepts a checkpoint-like object, not a run type,
 * so it remains usable by adapters and by callers before storage exists. */
export interface RollingLifecycleContext {
  manifest_entries?: readonly TaskManifestEntry[];
  task_manifest?: readonly TaskManifestEntry[];
  manifest?: readonly TaskManifestEntry[] | { entries?: readonly TaskManifestEntry[] };
  task_entries?: readonly TaskManifestEntry[];
  known_tasks?: readonly TaskManifestEntry[];
  entries?: readonly TaskManifestEntry[];
  accepted_deltas?: readonly PlanDelta[];
  deltas?: readonly PlanDelta[];
  unit_versions?: readonly UnitVersion[];
  gate_versions?: readonly GateVersion[];
  units?: readonly UnitVersion[];
  gates?: readonly GateVersion[];
  seals?: readonly TaskSeal[];
  seal?: TaskSeal;
  supersessions?: readonly unknown[];
  local_failures?: readonly unknown[];
  facts?: readonly unknown[];
  rolling_facts?: readonly unknown[];
  /** Optional direct projections supplied by a scheduler or adapter. */
  unit_status?: unknown;
  unitStatus?: unknown;
  gate_status?: unknown;
  gateStatus?: unknown;
  lineage_status?: unknown;
  lineageStatus?: unknown;
  source_reconciliations?: readonly unknown[];
  reconciliations?: readonly unknown[];
  source_reconciliation?: unknown;
  [key: string]: unknown;
}

export interface RollingTaskBlocker {
  code: string;
  message: string;
  owner?: string;
  refs?: string[];
}

export interface RollingTaskLifecycle {
  schema_version: typeof ROLLING_LIFECYCLE_SCHEMA_VERSION;
  task_key: string;
  /** Effective status.  `blocked` supplements the underlying open/sealed state. */
  state: RollingTaskLifecycleState;
  status: RollingTaskLifecycleState;
  /** The state before a local blocker is projected over it. */
  lifecycle_state: Exclude<RollingTaskLifecycleState, "blocked">;
  coverage: TaskCoverage[];
  explicit_no_op: boolean;
  required_unit_versions: string[];
  required_gate_versions: string[];
  known_unit_versions: string[];
  known_gate_versions: string[];
  superseded_unit_versions: string[];
  superseded_gate_versions: string[];
  accepted_unit_versions: string[];
  accepted_gate_versions: string[];
  unit_status: Record<string, RollingTaskLineageState>;
  gate_status: Record<string, RollingTaskLineageState>;
  blockers: RollingTaskBlocker[];
  ready_to_seal: boolean;
  sealed: boolean;
  reconciled: boolean;
  source_fingerprint?: string;
  seal?: TaskSeal;
}

export interface RollingLifecycleReport {
  schema_version: typeof ROLLING_LIFECYCLE_SCHEMA_VERSION;
  status: RollingTaskLifecycleState;
  tasks: RollingTaskLifecycle[];
  task_lifecycle: Record<string, RollingTaskLifecycle>;
  /** Rich state map.  `task_status` is intentionally the compatibility map. */
  lifecycle_status: Record<string, RollingTaskLifecycleState>;
  task_status: Record<string, RollingTaskStatus>;
  /** Explicit alias for clients that want the modern spelling. */
  task_states: Record<string, RollingTaskLifecycleState>;
}

export interface TaskSealValidationResult extends RollingValidationResult<TaskSeal> {
  normalized?: TaskSeal;
}

export class RollingTaskSealValidationError extends RollingProtocolValidationError {
  constructor(diagnostics: RollingDiagnostic[]) {
    super(diagnostics);
    this.name = "RollingTaskSealValidationError";
  }
}

export { RollingTaskSealValidationError as TaskSealValidationError };

type AnyRecord = Record<string, unknown>;
type FactKind = "unit" | "gate";
type Version = UnitVersion | GateVersion;

const VERSION_REF = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)@([1-9][0-9]*)$/u;
const HASH = /^[0-9a-f]{64}$/u;



function manifestForContext(source: AnyRecord, taskKey: string): TaskManifestEntry | undefined {
  const deltas = contextDeltas(source);
  return contextManifest(source, deltas).get(taskKey);
}

function supersessionSetsForContext(source: AnyRecord): { units: Set<string>; gates: Set<string> } {
  return supersededVersionsFromContext(source, contextDeltas(source));
}

function validateSealSemantics(seal: TaskSeal, source: AnyRecord, diagnostics: RollingDiagnostic[]): TaskSeal | undefined {
  const entry = manifestForContext(source, seal.task_key);
  if (!entry) {
    issue(diagnostics, "SEAL_UNKNOWN_TASK", `seal references unknown task ${seal.task_key}`, "seal.task_key", [seal.task_key]);
    return undefined;
  }
  if (!HASH.test(entry.source_fingerprint) || seal.source_fingerprint !== entry.source_fingerprint) {
    issue(diagnostics, "SEAL_SOURCE_FINGERPRINT_STALE", `seal source fingerprint does not match current task source for ${seal.task_key}`, "seal.source_fingerprint", [seal.task_key, entry.source_fingerprint]);
  }
  const deltas = contextDeltas(source);
  const versions = contextVersions(source, deltas);
  const superseded = supersessionSetsForContext(source);
  const coverage = coverageByTask(deltas).get(seal.task_key) || [];
  const refs = refsForCoverage(coverage, superseded);
  const expectedUnits = sortedUnique(refs.units);
  const expectedGates = sortedUnique(refs.gates);
  const normalized = structuredClone(seal);
  normalized.required_unit_versions = [...seal.required_unit_versions].sort((left, right) => left.localeCompare(right));
  normalized.required_gate_versions = [...seal.required_gate_versions].sort((left, right) => left.localeCompare(right));
  if (!coverage.length) {
    issue(diagnostics, "SEAL_COVERAGE_INCOMPLETE", `task ${seal.task_key} has no accepted coverage`, "seal", [seal.task_key]);
  }
  if (refs.noOp && (expectedUnits.length > 0 || expectedGates.length > 0)) {
    issue(diagnostics, "SEAL_NOOP_CONFLICT", `no-op coverage for ${seal.task_key} cannot be combined with required versions`, "seal", [seal.task_key]);
  }
  if (!refs.noOp && coverage.length && expectedUnits.length === 0 && expectedGates.length === 0) {
    issue(diagnostics, "SEAL_NOOP_COVERAGE_REQUIRED", `empty seal for ${seal.task_key} requires explicit no-op coverage`, "seal", [seal.task_key]);
  }
  if (!exactSet(seal.required_unit_versions, expectedUnits)) {
    issue(diagnostics, "SEAL_REQUIRED_UNITS_MISMATCH", `seal required unit versions must exactly match known non-superseded coverage`, "seal.required_unit_versions", [seal.task_key, ...expectedUnits]);
  }
  if (!exactSet(seal.required_gate_versions, expectedGates)) {
    issue(diagnostics, "SEAL_REQUIRED_GATES_MISMATCH", `seal required gate versions must exactly match known non-superseded coverage`, "seal.required_gate_versions", [seal.task_key, ...expectedGates]);
  }
  for (const id of seal.required_unit_versions) {
    if (superseded.units.has(id)) issue(diagnostics, "SEAL_SUPERSEDED_VERSION", `seal references superseded unit version ${id}`, "seal.required_unit_versions", [id]);
    if (!versions.units.has(id)) issue(diagnostics, "SEAL_UNKNOWN_UNIT_VERSION", `seal references unknown unit version ${id}`, "seal.required_unit_versions", [id]);
  }
  for (const id of seal.required_gate_versions) {
    if (superseded.gates.has(id)) issue(diagnostics, "SEAL_SUPERSEDED_VERSION", `seal references superseded gate version ${id}`, "seal.required_gate_versions", [id]);
    if (!versions.gates.has(id)) issue(diagnostics, "SEAL_UNKNOWN_GATE_VERSION", `seal references unknown gate version ${id}`, "seal.required_gate_versions", [id]);
  }
  const states = lineageStates(source, deltas);
  for (const id of expectedUnits) if (stateFor(states, "unit", id) !== "accepted") issue(diagnostics, "SEAL_UNIT_NOT_ACCEPTED", `required unit version ${id} is not accepted`, "seal.required_unit_versions", [id]);
  for (const id of expectedGates) if (stateFor(states, "gate", id) !== "accepted") issue(diagnostics, "SEAL_GATE_NOT_ACCEPTED", `required gate version ${id} is not accepted`, "seal.required_gate_versions", [id]);
  const lifecycle = taskLifecycle(seal.task_key, source, contextManifest(source, deltas), versions, deltas, contextSeals(source, deltas), states);
  for (const blocker of lifecycle.blockers) issue(diagnostics, "SEAL_BLOCKED", blocker.message, "seal", blocker.refs || [seal.task_key]);
  if (diagnostics.length) return undefined;
  // A seal's accepted document is canonical and carries the exact version
  // lists used by validation.  This makes reordered transport arrays
  // idempotent and keeps future comparisons set-exact.
  normalized.fingerprint = fingerprintTaskSeal(normalized);
  return normalized;
}

/** Validate one seal against the current manifest, accepted deltas, lineage,
 * supersessions, and local failures.  This function never mutates context. */
export function validateTaskSealAgainstFacts(input: unknown, context: RollingLifecycleContext = {}): TaskSealValidationResult {
  const shaped = validateTaskSealShape(input);
  const diagnostics: RollingDiagnostic[] = [...shaped.diagnostics];
  if (!shaped.valid || !shaped.value) return { valid: false, diagnostics };
  const normalized = validateSealSemantics(shaped.value, contextOf(context), diagnostics);
  if (!normalized || diagnostics.length) return { valid: false, diagnostics };
  return { valid: true, diagnostics: [], value: normalized, normalized };
}

export const validateTaskSeal = validateTaskSealAgainstFacts;

export function assertTaskSealAgainstFacts(input: unknown, context: RollingLifecycleContext = {}): TaskSeal {
  const result = validateTaskSealAgainstFacts(input, context);
  if (!result.valid) throw new RollingTaskSealValidationError(result.diagnostics);
  return result.value as TaskSeal;
}

export const assertTaskSeal = assertTaskSealAgainstFacts;

/** Convenience predicate used by scheduler/status callers. */
export function taskReadyToSeal(taskKey: string, context: RollingLifecycleContext = {}): boolean {
  return deriveTaskLifecycle(taskKey, context).ready_to_seal;
}


export * from "./rolling/lifecycle-derive.js";
