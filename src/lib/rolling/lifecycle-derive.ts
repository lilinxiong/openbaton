import {
  FactKind,
  lineageStates,
  normalizedState,
  parseRef,
  supersededVersionsFromContext
} from "./lifecycle-lineage.js";
import {
  ROLLING_LIFECYCLE_SCHEMA_VERSION,
  RollingLifecycleContext,
  RollingLifecycleReport,
  RollingTaskBlocker,
  RollingTaskLifecycle,
  RollingTaskLifecycleState,
  RollingTaskLineageState,
  RollingTaskStatus
} from "../rolling-lifecycle.js";
import {
  AnyRecord,
  allArrayValues,
  contextDeltas,
  contextFacts,
  contextManifest,
  contextOf,
  contextSeals,
  contextVersions,
  exactSet,
  record,
  sortedUnique,
  text
} from "./lifecycle-context.js";
/**
 * Task lifecycle derivation (coverage, reconciliation, public derive API).
 * Split from rolling-lifecycle.ts.
 */
import type {
  GateVersion,
  PlanDelta,
  TaskCoverage,
  TaskManifestEntry,
  TaskSeal,
  UnitVersion,
} from "../rolling-plan.js";

export function coverageByTask(deltas: readonly PlanDelta[]): Map<string, TaskCoverage[]> {
  const result = new Map<string, TaskCoverage[]>();
  for (const delta of deltas) for (const item of Array.isArray(delta.task_coverage) ? delta.task_coverage : []) {
    if (!record(item) || !text(item.task_key)) continue;
    const value = item as unknown as TaskCoverage;
    const current = result.get(value.task_key) || [];
    const signature = JSON.stringify(value);
    if (!current.some((entry) => JSON.stringify(entry) === signature)) current.push(structuredClone(value));
    result.set(value.task_key, current);
  }
  return result;
}

export function refsForCoverage(coverage: readonly TaskCoverage[], superseded: { units: Set<string>; gates: Set<string> }): { units: Set<string>; gates: Set<string>; noOp: boolean } {
  const units = new Set<string>();
  const gates = new Set<string>();
  let noOp = false;
  for (const item of coverage) {
    if (item.kind === "no-op") { noOp = true; continue; }
    for (const ref of Array.isArray(item.unit_versions) ? item.unit_versions : []) if (!superseded.units.has(ref)) units.add(ref);
    for (const ref of Array.isArray(item.gate_versions) ? item.gate_versions : []) if (!superseded.gates.has(ref)) gates.add(ref);
  }
  return { units, gates, noOp };
}

export function stateFor(states: Map<string, RollingTaskLineageState>, kind: FactKind, id: string): RollingTaskLineageState | undefined {
  return states.get(`${kind}:${id}`) || states.get(`${kind}:${id.split("@")[0]}`);
}

export function reconciliationFor(source: AnyRecord, taskKey: string, seals: readonly TaskSeal[], entry: TaskManifestEntry | undefined): boolean {
  const values = [
    ...allArrayValues(source, ["source_reconciliations", "reconciliations"]),
    ...(source.source_reconciliation === undefined ? [] : [source.source_reconciliation]),
    ...contextFacts(source).filter((fact) => record(fact) && ["reconciliation", "source-reconciliation", "reconcile"].includes(String(fact.kind || fact.fact_kind))),
  ];
  for (const value of values) {
    const payload = record(value) && record(value.payload) ? value.payload : value;
    if (!record(payload)) continue;
    if (payload.task_key !== taskKey && payload.task_id !== taskKey) continue;
    if (payload.reconciled === true || payload.complete === true || payload.source_state === "complete" || payload.status === "complete" || payload.status === "reconciled") return true;
  }
  // A source entry marked complete is useful as an adapter projection only
  // after an explicit seal.  It does not by itself plan or accept work.
  return Boolean(seals.length && entry?.source_state === "complete");
}

export function taskKeys(source: AnyRecord, manifest: Map<string, TaskManifestEntry>, coverage: Map<string, TaskCoverage[]>, seals: readonly TaskSeal[]): string[] {
  const keys = new Set<string>(manifest.keys());
  for (const key of coverage.keys()) keys.add(key);
  for (const seal of seals) if (text(seal.task_key)) keys.add(seal.task_key);
  for (const delta of contextDeltas(source)) {
    for (const unit of Array.isArray(delta.unit_versions) ? delta.unit_versions : []) for (const key of unit.task_keys || []) keys.add(key);
    for (const gate of Array.isArray(delta.gate_versions) ? delta.gate_versions : []) for (const key of gate.task_keys || []) keys.add(key);
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

export function taskLifecycle(taskKey: string, source: AnyRecord, manifest: Map<string, TaskManifestEntry>, versions: { units: Map<string, UnitVersion>; gates: Map<string, GateVersion> }, deltas: readonly PlanDelta[], seals: readonly TaskSeal[], states: Map<string, RollingTaskLineageState>): RollingTaskLifecycle {
  const entry = manifest.get(taskKey);
  const coverage = coverageByTask(deltas).get(taskKey) || [];
  const superseded = supersededVersionsFromContext(source, deltas);
  const refs = refsForCoverage(coverage, superseded);
  const knownUnitVersions = sortedUnique([...versions.units.entries()].filter(([, value]) => value.task_keys?.includes(taskKey)).map(([id]) => id));
  const knownGateVersions = sortedUnique([...versions.gates.entries()].filter(([, value]) => value.task_keys?.includes(taskKey)).map(([id]) => id));
  const requiredUnits = sortedUnique(refs.units);
  const requiredGates = sortedUnique(refs.gates);
  const acceptedUnits = requiredUnits.filter((id) => stateFor(states, "unit", id) === "accepted");
  const acceptedGates = requiredGates.filter((id) => stateFor(states, "gate", id) === "accepted");
  const blockers: RollingTaskBlocker[] = [];
  const addBlocker = (code: string, message: string, owner?: string, refsValue: readonly string[] = []): void => {
    const signature = `${code}:${owner || ""}:${refsValue.join(",")}`;
    if (blockers.some((item) => `${item.code}:${item.owner || ""}:${(item.refs || []).join(",")}` === signature)) return;
    blockers.push({ code, message, ...(owner ? { owner } : {}), ...(refsValue.length ? { refs: [...refsValue] } : {}) });
  };
  for (const id of requiredUnits) {
    const state = stateFor(states, "unit", id);
    if (state === "failed" || state === "blocked") addBlocker("UNIT_BLOCKED", `unit ${id} is ${state}`, id, [id]);
  }
  for (const id of requiredGates) {
    const state = stateFor(states, "gate", id);
    if (state === "failed" || state === "blocked") addBlocker("GATE_BLOCKED", `gate ${id} is ${state}`, id, [id]);
  }
  for (const delta of deltas) {
    const claimsTask = (Array.isArray(delta.task_coverage) && delta.task_coverage.some((item) => record(item) && item.task_key === taskKey))
      || (Array.isArray(delta.unit_versions) && delta.unit_versions.some((item) => record(item) && item.task_keys?.includes(taskKey)))
      || (Array.isArray(delta.gate_versions) && delta.gate_versions.some((item) => record(item) && item.task_keys?.includes(taskKey)));
    if (!claimsTask) continue;
    for (const failure of Array.isArray(delta.local_failures) ? delta.local_failures : []) if (record(failure)) {
      const owner = String(failure.owner || "");
      const ownerKey = String(failure.owner_key || "");
      const ownerKind = owner === "unit_version" ? "unit" : owner === "gate_version" ? "gate" : undefined;
      const ownerId = ownerKind
        ? parseRef({ owner_key: ownerKey, owner_version: failure.owner_version }, ownerKind)?.id || ownerKey
        : ownerKey;
      const belongs = owner === "manifest_entry" || owner === "seal" || owner === "reconciliation"
        ? ownerKey === taskKey
        : owner === "delta" ? delta.delta_id === ownerKey
        : owner === "unit_version" ? requiredUnits.includes(ownerId)
        : owner === "gate_version" ? requiredGates.includes(ownerId)
        : false;
      if (belongs) addBlocker("LOCAL_FAILURE", `${owner || "local"} failure: ${String(failure.message || failure.code || "blocked")}`, ownerId || owner, [taskKey]);
    }
  }
  // Fact logs may carry a local failure as a first-class fact rather than
  // embedding it in the delta.  Project only failures belonging to this task;
  // a failure in an unrelated task must not turn this task blocked.
  for (const fact of contextFacts(source)) {
    if (!record(fact)) continue;
    const payload = record(fact.payload) ? fact.payload : fact;
    const kindText = String(fact.kind || fact.fact_kind || "").toLowerCase();
    const owner = String(payload.owner || "");
    const ownerKey = String(payload.owner_key || "");
    const failureLike = owner === "manifest_entry" || owner === "delta" || owner === "unit_version" || owner === "gate_version" || owner === "seal" || owner === "reconciliation"
      || /(?:fail|error|reject|block)/u.test(kindText)
      || normalizedState(payload) === "failed" || normalizedState(payload) === "blocked";
    if (!failureLike) continue;
    const ownerKind = owner === "unit_version" ? "unit" : owner === "gate_version" ? "gate" : undefined;
    const ownerId = ownerKind
      ? parseRef({ owner_key: ownerKey, owner_version: payload.owner_version }, ownerKind)?.id || ownerKey
      : ownerKey;
    const identity = parseRef(payload, ownerKind);
    const belongs = owner === "manifest_entry" || owner === "seal" || owner === "reconciliation"
      ? ownerKey === taskKey
      : owner === "delta"
        ? deltas.some((delta) => delta.delta_id === ownerKey && ((delta.task_coverage || []).some((item) => item.task_key === taskKey)))
        : owner === "unit_version"
          ? requiredUnits.includes(ownerId)
          : owner === "gate_version"
            ? requiredGates.includes(ownerId)
            : identity?.kind === "unit"
              ? requiredUnits.includes(identity.id)
              : identity?.kind === "gate"
                ? requiredGates.includes(identity.id)
                : Array.isArray(payload.task_keys) && payload.task_keys.includes(taskKey) || payload.task_key === taskKey || payload.task_id === taskKey;
    if (belongs) addBlocker("LOCAL_FAILURE", String(payload.message || payload.code || `local failure for ${taskKey}`), ownerId || taskKey, [taskKey]);
  }
  if (entry?.source_state === "unavailable") addBlocker("SOURCE_UNAVAILABLE", `task source is unavailable for ${taskKey}`, taskKey, [taskKey]);
  const seal = [...seals].reverse().find((value) => value.task_key === taskKey);
  const sourceFingerprint = entry?.source_fingerprint;
  const sealSourceMatches = Boolean(seal && sourceFingerprint && seal.source_fingerprint === sourceFingerprint);
  const requirementsAccepted = requiredUnits.every((id) => acceptedUnits.includes(id)) && requiredGates.every((id) => acceptedGates.includes(id));
  const sealRequirementsExact = Boolean(seal
    && exactSet(seal.required_unit_versions || [], requiredUnits)
    && exactSet(seal.required_gate_versions || [], requiredGates)
    && coverage.length
    && (refs.noOp ? requiredUnits.length === 0 && requiredGates.length === 0 : requiredUnits.length > 0 || requiredGates.length > 0));
  const sealed = Boolean(seal && sealSourceMatches && sealRequirementsExact && requirementsAccepted && !blockers.length);
  const readyToSeal = Boolean(coverage.length && !blockers.length && requirementsAccepted && (refs.noOp ? requiredUnits.length === 0 && requiredGates.length === 0 : true));
  const reconciled = Boolean(sealed && requirementsAccepted && reconciliationFor(source, taskKey, seal ? [seal] : [], entry));
  const lifecycleState: Exclude<RollingTaskLifecycleState, "blocked"> = !coverage.length
    ? "unplanned"
    : reconciled
      ? "reconciled"
      : sealed
        ? "sealed"
        : "open";
  const state: RollingTaskLifecycleState = blockers.length ? "blocked" : lifecycleState;
  const unitStatus: Record<string, RollingTaskLineageState> = {};
  const gateStatus: Record<string, RollingTaskLineageState> = {};
  for (const id of knownUnitVersions) unitStatus[id] = stateFor(states, "unit", id) || "undispatched";
  for (const id of knownGateVersions) gateStatus[id] = stateFor(states, "gate", id) || "undispatched";
  return {
    schema_version: ROLLING_LIFECYCLE_SCHEMA_VERSION,
    task_key: taskKey,
    state,
    status: state,
    lifecycle_state: lifecycleState,
    coverage,
    explicit_no_op: refs.noOp,
    required_unit_versions: requiredUnits,
    required_gate_versions: requiredGates,
    known_unit_versions: knownUnitVersions,
    known_gate_versions: knownGateVersions,
    superseded_unit_versions: sortedUnique([...superseded.units].filter((id) => knownUnitVersions.includes(id))),
    superseded_gate_versions: sortedUnique([...superseded.gates].filter((id) => knownGateVersions.includes(id))),
    accepted_unit_versions: acceptedUnits,
    accepted_gate_versions: acceptedGates,
    unit_status: unitStatus,
    gate_status: gateStatus,
    blockers,
    ready_to_seal: readyToSeal,
    sealed,
    reconciled,
    ...(sourceFingerprint ? { source_fingerprint: sourceFingerprint } : {}),
    ...(seal ? { seal: structuredClone(seal) } : {}),
  };
}

/** Derive one task.  The argument order accepts both common call styles. */

/** Derive one task.  The argument order accepts both common call styles. */
export function deriveTaskLifecycle(taskKey: string, context?: RollingLifecycleContext): RollingTaskLifecycle;
export function deriveTaskLifecycle(context: RollingLifecycleContext, taskKey: string): RollingTaskLifecycle;
export function deriveTaskLifecycle(first: string | RollingLifecycleContext, second: string | RollingLifecycleContext = {}): RollingTaskLifecycle {
  let taskKey: string;
  let source: AnyRecord;
  if (typeof first === "string") {
    taskKey = first;
    source = contextOf(second);
  } else {
    if (typeof second !== "string") throw new TypeError("deriveTaskLifecycle requires a task key");
    taskKey = second;
    source = contextOf(first);
  }
  const deltas = contextDeltas(source);
  const manifest = contextManifest(source, deltas);
  const versions = contextVersions(source, deltas);
  const seals = contextSeals(source, deltas);
  const states = lineageStates(source, deltas);
  return taskLifecycle(taskKey, source, manifest, versions, deltas, seals, states);
}

/** Derive all tasks in deterministic manifest/key order. */
export function deriveRollingTaskLifecycles(context: RollingLifecycleContext = {}): RollingTaskLifecycle[] {
  const source = contextOf(context);
  const deltas = contextDeltas(source);
  const manifest = contextManifest(source, deltas);
  const coverage = coverageByTask(deltas);
  const seals = contextSeals(source, deltas);
  const versions = contextVersions(source, deltas);
  const states = lineageStates(source, deltas);
  return taskKeys(source, manifest, coverage, seals).map((taskKey) => taskLifecycle(taskKey, source, manifest, versions, deltas, seals, states));
}


/** Build the run-level status projection while retaining the phase-1 aliases. */
export function deriveRollingLifecycle(context: RollingLifecycleContext = {}): RollingLifecycleReport {
  const tasks = deriveRollingTaskLifecycles(context);
  const task_lifecycle: Record<string, RollingTaskLifecycle> = {};
  const lifecycle_status: Record<string, RollingTaskLifecycleState> = {};
  const task_status: Record<string, RollingTaskStatus> = {};
  const task_states: Record<string, RollingTaskLifecycleState> = {};
  for (const task of tasks) {
    task_lifecycle[task.task_key] = task;
    lifecycle_status[task.task_key] = task.state;
    task_states[task.task_key] = task.state;
    // Keep `planned` as the legacy map spelling for an open task.  New code
    // should consume lifecycle_status/task_states, which retain `open`.
    task_status[task.task_key] = task.state === "open" ? "planned" : task.state;
  }
  let status: RollingTaskLifecycleState = "unplanned";
  if (tasks.length) {
    if (tasks.some((task) => task.state === "blocked")) status = "blocked";
    else if (tasks.every((task) => task.state === "reconciled")) status = "reconciled";
    else if (tasks.every((task) => task.state === "sealed" || task.state === "reconciled")) status = "sealed";
    else if (tasks.some((task) => task.state === "open")) status = "open";
  }
  return { schema_version: ROLLING_LIFECYCLE_SCHEMA_VERSION, status, tasks, task_lifecycle, lifecycle_status, task_status, task_states };
}
