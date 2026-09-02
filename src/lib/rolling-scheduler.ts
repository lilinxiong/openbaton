/**
 * Pure scheduling projection for rolling execution.
 *
 * This module intentionally accepts snapshots rather than a run id or a
 * working directory.  Accepted deltas are the only source of plan facts;
 * runtime facts are explicit observations supplied by the parent.  In
 * particular, manifest entries are not inspected: an open-world manifest may
 * contain arbitrarily many tasks which have not been planned yet.
 */
import {
  buildFrontierConflictGraph,
  selectIndependentSet,
  type ApplyPlanActiveOwnership,
  type ApplyPlanIntegrationConflictRisk,
  type ApplyPlanOwnershipNamespace,
  type ApplyPlanUnit,
} from "./apply-plan.js";
import type { SafetyOperation } from "./safety.js";
import type { GateVersion, PlanDelta, UnitVersion } from "./rolling-plan.js";
import {
  AnyRecord,
  Identity,
  addBlocker,
  candidateEligible,
  configuredRoutes,
  executionRootFor,
  gateState,
  identity,
  parseRef,
  prioritizedRoutes,
  record,
  routeId,
  routeList,
  runtimeFacts,
  schedulingOwnershipNamespaces,
  stableUnitIds,
  stateFromFact,
  text,
  unitState,
  versionId
} from "./rolling/scheduler-facts.js";

export type RollingSchedulerState =
  | "undispatched" | "planned" | "ready" | "reserved" | "running"
  | "terminal-unreleased" | "accepted" | "succeeded" | "failed"
  | "blocked" | "stale" | "superseded" | string;

export interface RollingRuntimeFact {
  [key: string]: unknown;
  kind?: string;
  payload?: unknown;
  unit_key?: string;
  unit_id?: string;
  unit_version?: number;
  gate_key?: string;
  gate_id?: string;
  gate_version?: number;
  state?: RollingSchedulerState;
  status?: RollingSchedulerState;
  runtime_state?: RollingSchedulerState;
  accepted?: boolean;
  terminal_unreleased?: boolean;
  stale?: boolean;
}

export interface RollingRouteFact {
  [key: string]: unknown;
  id?: string;
  route_id?: string;
  model_id?: string;
  unit_key?: string;
  unit_id?: string;
  unit_version?: number;
  selectable?: boolean;
  eligible?: boolean;
  automatic_eligible?: boolean;
  disabled?: boolean;
  availability_status?: "available" | "exhausted" | "probe_due" | string;
  current_session_available?: boolean;
  current_session_uncallable?: boolean;
  probe_available?: boolean;
}

export interface RollingSchedulerBlocker {
  code: string;
  message: string;
  refs?: string[];
}

export interface RollingSchedulerInput {
  /** Accepted planning documents. */
  accepted_deltas?: readonly PlanDelta[];
  /** Explicit runtime observations; no persistence is consulted. */
  runtime_facts?: readonly RollingRuntimeFact[];
  /** Explicit route candidates, normally captured from one active CLI. */
  route_facts?: readonly RollingRouteFact[];
  /** Route candidates can be keyed by unit identity. */
  routes_by_unit?: Readonly<Record<string, readonly RollingRouteFact[]>> | ReadonlyMap<string, readonly RollingRouteFact[]>;
  /** Ordered configured route/model ids. */
  configured_routes?: readonly string[];
  /** Current-session availability facts keyed by route id. */
  current_session_availability?: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;
  capacity?: number | null;
  shared_worktree?: boolean;
  active_ownership?: readonly ApplyPlanActiveOwnership[];
  /** Exact immutable execution namespace keyed by unit_key@version. */
  execution_roots_by_unit?: Readonly<Record<string, ApplyPlanOwnershipNamespace>> | ReadonlyMap<string, ApplyPlanOwnershipNamespace>;
  stable_order?: readonly string[];
  /** Optional counter hooks used by conformance tests. */
  instrumentation?: RollingSchedulerInstrumentation;
  /** Deliberately ignored by the scheduler; retained for open-world callers. */
  readonly manifest_entries?: readonly unknown[];
}

export interface RollingSchedulerInstrumentation {
  manifest_reads?: number;
  semantic_reads?: number;
  on_manifest_read?: (taskKey: string) => void;
  on_semantic_read?: (unitKey: string) => void;
}

export interface RollingSchedulerResult {
  /** All known units that passed dependency and safety-precondition gates. */
  frontier: string[];
  /** Selected route id by unit-version identity. */
  selected_routes: Record<string, string>;
  route_by_unit: Record<string, string | null>;
  eligible: string[];
  /** Non-blocking overlaps across isolated roots which the parent integration queue must serialize. */
  integration_conflict_risks: ApplyPlanIntegrationConflictRisk[];
  /** Accepted integration result tree inherited by each integration-dependent unit. */
  inherited_base_trees: Record<string, string>;
  blockers: Record<string, RollingSchedulerBlocker[]>;
  /** Known non-superseded unit identities considered by this projection. */
  known_unit_versions: string[];
  instrumentation: { manifest_reads: number; semantic_reads: number };
}

/** Compute one deterministic maximum safe known frontier. */
export function deriveRollingSafeFrontier(input: RollingSchedulerInput = {}): RollingSchedulerResult {
  const deltas = [...(input.accepted_deltas || [])];
  const units = new Map<string, UnitVersion>();
  const gates = new Map<string, GateVersion>();
  const supersededUnits = new Set<string>();
  const supersededGates = new Set<string>();
  for (const delta of deltas) {
    for (const unit of delta.unit_versions || []) units.set(versionId(unit.unit_key, unit.version), unit);
    for (const gate of delta.gate_versions || []) gates.set(versionId(gate.gate_key, gate.version), gate);
    for (const item of delta.supersessions || []) {
      const parsed = parseRef(item.previous);
      if (item.owner === "unit_version" && parsed.version) supersededUnits.add(item.previous);
      if (item.owner === "gate_version" && parsed.version) supersededGates.add(item.previous);
    }
  }
  const states = new Map<string, string>();
  const statePriority = (value: string): number => ({ "terminal-unreleased": 4, terminal: 4, running: 3, reserved: 2, accepted: 1, stale: 0, failed: 0 }[value] ?? -1);
  const updateState = (key: string, value: string): void => {
    const prior = states.get(key);
    if (!prior || statePriority(value) >= statePriority(prior)) states.set(key, value);
  };
  const acceptedUnits = new Set<string>();
  const integrationResultBases = new Map<string, string>();
  type AttemptObservation = { unitId: string; ownerKey: string; reserved: boolean; running: boolean; terminal: boolean; failed: boolean; released: boolean };
  const attempts = new Map<string, AttemptObservation>();
  const attemptKinds = new Set(["reservation", "native-attempt", "terminal-result", "release", "retry"]);
  const unitIdentity = (value: unknown): Identity | null => identity(value, "unit");
  const unitIdentityFromAttemptOwner = (ownerKey: string): Identity | null => {
    const match = ownerKey.match(/^(.+):attempt-[1-9][0-9]*$/);
    if (!match) return null;
    const parsed = parseRef(match[1]!);
    return { kind: "unit", key: parsed.key, ...(parsed.version === undefined ? {} : { version: parsed.version }), id: match[1]! };
  };
  const acceptedUnit = (item: Identity): void => {
    if (item.kind !== "unit") return;
    acceptedUnits.add(`unit:${item.id}`);
    if (item.version === undefined) acceptedUnits.add(`unit:${item.key}`);
  };
  for (const fact of runtimeFacts(input)) {
    const payload = record(fact) && record(fact.payload) ? fact.payload : fact;
    const source = record(payload) ? payload : record(fact) ? fact : null;
    const factKind = String(source?.kind || (record(fact) ? fact.kind : "")).toLowerCase();
    const item = identity(fact) || identity(payload);
    const observedState = stateFromFact(payload) || stateFromFact(fact);
    // A safety verdict authorizes the write scope; only parent acceptance
    // accepts the unit.  In particular, do not let an accepted verdict from a
    // superseded version leak through the stable unit key to its successor.
    const itemState = factKind === "safety-verdict" && observedState === "accepted" ? null : observedState;
    const explicitAccepted = record(payload) && payload.accepted === true && factKind !== "safety-verdict";
    const explicitTerminal = record(payload) && (payload.terminal_unreleased === true || payload.terminalUnreleased === true);
    const attemptOwned = attemptKinds.has(factKind) || (record(payload) && payload.owner_type === "attempt");
    if (item?.kind === "unit" && (explicitAccepted || (!attemptOwned && itemState === "accepted"))) acceptedUnit(item);
    if (item?.kind === "gate" && itemState === "accepted" && record(source)) {
      const resultBase = source.result_base_tree ?? source.result_tree ?? source.after_tree;
      if (text(resultBase) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(String(resultBase))) {
        integrationResultBases.set(item.id, resultBase);
        integrationResultBases.set(item.key, resultBase);
      }
    }
    if (attemptOwned) {
      const explicitOwnerKey = record(payload) && text(payload.owner_key)
        ? String(payload.owner_key)
        : record(fact) && text(fact.owner_key) ? String(fact.owner_key) : undefined;
      const unit = unitIdentity(fact) || unitIdentity(payload) || (explicitOwnerKey ? unitIdentityFromAttemptOwner(explicitOwnerKey) : null);
      const ownerKey = explicitOwnerKey || unit?.id;
      if (unit && ownerKey) {
        const observation = attempts.get(ownerKey) || { unitId: unit.id, ownerKey, reserved: false, running: false, terminal: false, failed: false, released: false };
        const stateValue = String(source?.state || "").toLowerCase().replaceAll("_", "-");
        const terminalStatus = String(source?.status || "").toLowerCase();
        if (factKind === "reservation") observation.reserved ||= stateValue === "reserved";
        if (factKind === "native-attempt") {
          observation.reserved ||= stateValue === "reserved";
          observation.running ||= stateValue === "running";
          observation.failed ||= ["failed", "cancelled"].includes(stateValue);
        }
        if (factKind === "terminal-result") {
          observation.terminal = true;
          observation.failed ||= !["completed", "succeeded"].includes(terminalStatus);
        }
        if (factKind === "release" && source?.released === true) observation.released = true;
        attempts.set(ownerKey, observation);
      }
    }
    if (item && itemState) {
      const key = `${item.kind}:${item.id}`;
      if (!attemptOwned) {
        updateState(key, itemState);
      }
      if (item.version === undefined && !attemptOwned) updateState(`${item.kind}:${item.key}`, itemState);
    }
    if (item?.kind === "unit" && explicitTerminal) updateState(`unit:${item.id}`, "terminal-unreleased");
    if (record(payload) && Array.isArray(payload.accepted_unit_versions)) for (const ref of payload.accepted_unit_versions) if (text(ref)) updateState(`unit:${ref}`, "accepted");
    if (record(payload) && Array.isArray(payload.accepted_gate_versions)) for (const ref of payload.accepted_gate_versions) if (text(ref)) updateState(`gate:${ref}`, "accepted");
  }
  for (const ref of [...states.keys()].filter((key) => key.startsWith("unit:") && states.get(key) === "accepted")) acceptedUnits.add(ref);
  const attemptStatus = new Map<string, string>();
  const attemptOwnership = new Map<string, AttemptObservation[]>();
  for (const observation of attempts.values()) {
    const list = attemptOwnership.get(observation.unitId) || [];
    list.push(observation);
    attemptOwnership.set(observation.unitId, list);
    const status = observation.released
      ? observation.failed ? "failed" : null
      : observation.terminal ? "terminal-unreleased" : observation.running ? "running" : observation.reserved ? "reserved" : observation.failed ? "failed" : null;
    if (!status) continue;
    const prior = attemptStatus.get(observation.unitId);
    const rank = (value: string): number => ({ "terminal-unreleased": 4, running: 3, reserved: 2, accepted: 1, stale: 0, failed: 0 }[value] ?? -1);
    if (!prior || rank(status) > rank(prior)) attemptStatus.set(observation.unitId, status);
  }
  for (const [id, status] of attemptStatus) states.set(`unit:${id}`, status);
  for (const id of acceptedUnits) {
    if (!id.startsWith("unit:")) continue;
    const unitId = id.slice("unit:".length);
    if (!attemptStatus.has(unitId) && !states.has(id)) states.set(id, "accepted");
  }
  for (const id of supersededUnits) states.set(`unit:${id}`, "superseded");
  for (const id of supersededGates) states.set(`gate:${id}`, "superseded");

  const knownIds = stableUnitIds(
    [...units.keys()].filter((id) => !supersededUnits.has(id) && states.get(`unit:${id}`) !== "superseded"),
    input.stable_order || [],
  );
  const known = knownIds.map((id) => [id, units.get(id)!] as [string, UnitVersion]);
  const blockers = new Map<string, RollingSchedulerBlocker[]>();
  const dependencyReady: string[] = [];
  const inheritedBaseTrees: Record<string, string> = {};
  const activeByKey = new Map<string, UnitVersion>();
  const activeGateByKey = new Map<string, GateVersion>();
  for (const [, unit] of known) {
    const prior = activeByKey.get(unit.unit_key);
    if (!prior || unit.version > prior.version) activeByKey.set(unit.unit_key, unit);
  }
  for (const [id, gate] of gates) if (!supersededGates.has(id)) {
    const prior = activeGateByKey.get(gate.gate_key);
    if (!prior || gate.version > prior.version) activeGateByKey.set(gate.gate_key, gate);
  }
  const resolveUnit = (ref: string): [string, UnitVersion] | null => {
    const parsed = parseRef(ref);
    if (parsed.version) { const exact = units.get(ref); return exact && !supersededUnits.has(ref) ? [ref, exact] : null; }
    const value = activeByKey.get(parsed.key); return value ? [versionId(value.unit_key, value.version), value] : null;
  };
  const resolveGate = (ref: string): [string, GateVersion] | null => {
    const parsed = parseRef(ref);
    if (parsed.version) { const exactId = versionId(parsed.key, parsed.version); const exact = gates.get(exactId); return exact && !supersededGates.has(exactId) ? [exactId, exact] : null; }
    const value = activeGateByKey.get(parsed.key); return value ? [versionId(value.gate_key, value.version), value] : null;
  };
  const unitAccepted = (id: string, key: string): boolean => acceptedUnits.has(`unit:${id}`) || acceptedUnits.has(`unit:${key}`) || unitState(states, id, key) === "accepted";
  const gateAccepted = (id: string, value: GateVersion, visiting = new Set<string>()): boolean => {
    if (visiting.has(id)) return false;
    if (gateState(states, id, value.gate_key) !== "accepted") return false;
    const next = new Set(visiting).add(id);
    return (value.depends_on || []).every((ref) => {
      const targetUnit = resolveUnit(ref);
      if (targetUnit) return unitAccepted(targetUnit[0], targetUnit[1].unit_key);
      const targetGate = resolveGate(ref);
      return Boolean(targetGate && gateAccepted(targetGate[0], targetGate[1], next));
    });
  };
  for (const [id, unit] of known) {
    const direct = unitState(states, id, unit.unit_key);
    const accepted = unitAccepted(id, unit.unit_key);
    if (direct === "terminal-unreleased" || direct === "running" || direct === "reserved" || accepted) {
      const effective = direct === "terminal-unreleased" || direct === "running" || direct === "reserved" ? direct : "accepted";
      addBlocker(blockers, id, effective === "terminal-unreleased" ? "TERMINAL_UNRELEASED" : "UNIT_NOT_DISPATCHABLE", `unit ${id} is ${effective}`, [id]);
      continue;
    }
    if (direct === "stale") { addBlocker(blockers, id, "LOCAL_INPUT_STALE", `unit ${id} has stale local inputs`, [id]); continue; }
    if (direct === "failed" || direct === "blocked" || direct === "superseded") { addBlocker(blockers, id, "UNIT_BLOCKED", `unit ${id} is ${direct}`, [id]); continue; }
    let ready = true;
    for (const ref of unit.depends_on || []) {
      const targetUnit = resolveUnit(ref);
      const targetGate = targetUnit ? null : resolveGate(ref);
      if (!targetUnit && !targetGate) { addBlocker(blockers, id, "UNKNOWN_DEPENDENCY", `unit ${id} depends on unknown ${ref}`, [id, ref]); ready = false; continue; }
      const targetId = targetUnit?.[0] || targetGate?.[0] || ref;
      const targetKey = targetUnit?.[1].unit_key || targetGate?.[1].gate_key || ref;
      const dependencyAccepted = targetUnit ? unitAccepted(targetId, targetKey) : gateAccepted(targetId, targetGate![1]);
      if (!dependencyAccepted) { addBlocker(blockers, id, "DEPENDENCY_NOT_ACCEPTED", `dependency ${targetId} is not accepted`, [id, targetId]); ready = false; }
    }
    for (const ref of unit.required_gate_keys || []) {
      const gate = resolveGate(ref);
      if (!gate) { addBlocker(blockers, id, "UNKNOWN_SAFETY_GATE", `unit ${id} requires unknown safety gate ${ref}`, [id, ref]); ready = false; continue; }
      const [gateId, gateValue] = gate;
      if (gateValue.type !== "safety-precondition") continue;
      if (!gateAccepted(gateId, gateValue)) { addBlocker(blockers, id, "SAFETY_PRECONDITION_NOT_ACCEPTED", `safety-precondition ${gateId} is not accepted`, [id, gateId]); ready = false; }
    }
    for (const ref of unit.integration_gate_keys || []) {
      const gate = resolveGate(ref);
      if (!gate || gate[1].type !== "integration-acceptance") {
        addBlocker(blockers, id, "UNKNOWN_INTEGRATION_GATE", `unit ${id} requires unknown integration gate ${ref}`, [id, ref]); ready = false; continue;
      }
      const [gateId, gateValue] = gate;
      if (!gateAccepted(gateId, gateValue)) {
        addBlocker(blockers, id, "INTEGRATION_NOT_ACCEPTED", `integration ${gateId} is not accepted`, [id, gateId]); ready = false; continue;
      }
      const resultBase = integrationResultBases.get(gateId) ?? integrationResultBases.get(gateValue.gate_key);
      if (!resultBase) {
        addBlocker(blockers, id, "INTEGRATION_RESULT_BASE_MISSING", `accepted integration ${gateId} has no result base`, [id, gateId]); ready = false; continue;
      }
      const executionRoot = executionRootFor(input, id, unit.unit_key);
      if (unit.worktree_mode === "isolated-worktree" && executionRoot && executionRoot.base_tree !== resultBase) {
        addBlocker(blockers, id, "INTEGRATION_RESULT_BASE_MISMATCH", `unit ${id} must inherit integration ${gateId} result base ${resultBase}`, [id, gateId]); ready = false; continue;
      }
      const inherited = inheritedBaseTrees[id];
      if (inherited !== undefined && inherited !== resultBase) {
        addBlocker(blockers, id, "INTEGRATION_RESULT_BASE_CONFLICT", `unit ${id} inherits conflicting integration result bases`, [id, gateId]); ready = false; continue;
      }
      inheritedBaseTrees[id] = resultBase;
    }
    if (ready) dependencyReady.push(id);
  }

  const routeByUnit: Record<string, string | null> = {};
  const configured = configuredRoutes(input);
  for (const id of [...dependencyReady]) {
    const unit = units.get(id)!;
    const raw = unit as unknown as AnyRecord;
    if (raw.director_local === true || raw.directorLocal === true) { routeByUnit[id] = null; continue; }
    const allCandidates = routeList(input, unit, id);
    const candidates = prioritizedRoutes(allCandidates, configured);
    if (!candidates.length && allCandidates.length && configured.length) {
      addBlocker(blockers, id, "ROUTE_ABSENT_FROM_ACTIVE_CATALOG", `unit ${id} has no configured route in the active catalog`, [id]);
      continue;
    }
    if (!candidates.length && configured.length) {
      addBlocker(blockers, id, "NO_QUALIFIED_CANDIDATE", `unit ${id} has no configured route candidate`, [id]);
      continue;
    }
    if (!candidates.length) { routeByUnit[id] = null; continue; }
    const evaluated = candidates.map((candidate) => ({ candidate, result: candidateEligible(candidate, input, unit) }));
    const eligible = evaluated.find((item) => item.result.ok);
    if (!eligible) {
      const first = evaluated.map((item) => item.result).find((item) => item.code) || { code: "NO_QUALIFIED_CANDIDATE", message: `unit ${id} has no eligible route` };
      addBlocker(blockers, id, first.code || "NO_QUALIFIED_CANDIDATE", first.message || `unit ${id} has no eligible route`, [id]);
      continue;
    }
    const chosen = eligible.candidate;
    routeByUnit[id] = routeId(chosen);
  }

  const routable = dependencyReady.filter((id) => !blockers.has(id));
  const pseudoUnits: ApplyPlanUnit[] = routable.map((id) => {
    const unit = units.get(id)!;
    return { id, mode: unit.execution_mode, task_ids: unit.task_keys, write_paths: unit.write_paths, allowed_operations: unit.allowed_operations as SafetyOperation[] | undefined, depends_on: (unit.depends_on || []).map((ref) => resolveUnit(ref)?.[0] || ref) };
  });
  const activeOwnership: ApplyPlanActiveOwnership[] = [...(input.active_ownership || [])];
  for (const [id, unit] of known) {
    const status = unitState(states, id, unit.unit_key);
    if (status === "reserved" || status === "running" || status === "terminal-unreleased") {
      const owners = attemptOwnership.get(id)?.filter((attempt) => !attempt.released) || [];
      const keys = owners.length ? owners.map((attempt) => attempt.ownerKey) : [id];
      for (const key of keys) {
        const ownership: ApplyPlanActiveOwnership = { key, terminal: status === "terminal-unreleased", facts: (unit.write_paths || []).map((path) => ({ unit_id: key, path, kind: "path" })) };
        const namespace = executionRootFor(input, id, unit.unit_key);
        if (namespace) Object.assign(ownership, namespace);
        if (status === "terminal-unreleased") ownership.terminal_unreleased = true;
        activeOwnership.push(ownership);
      }
    }
  }
  let selected = [...routable];
  let integrationConflictRisks: ApplyPlanIntegrationConflictRisk[] = [];
  if (input.shared_worktree !== false) {
    const plan = { units: pseudoUnits } as unknown as Parameters<typeof buildFrontierConflictGraph>[0];
    const graph = buildFrontierConflictGraph(plan, routable, {
      activeOwnership, stableOrder: routable, ownershipByUnit: schedulingOwnershipNamespaces(input, units),
    });
    integrationConflictRisks = graph.integration_conflict_risks;
    for (const id of graph.blockedByActiveOwnership) addBlocker(blockers, id, "WRITE_SCOPE_CONFLICT", `unit ${id} conflicts with terminal-unreleased ownership`, [id]);
    const available = routable.filter((id) => !graph.blockedByActiveOwnership.has(id));
    const selectedSet = selectIndependentSet(available, graph.conflicts, { capacity: input.capacity == null ? available.length : input.capacity });
    selected = selectedSet;
    for (const id of available) if (!selectedSet.includes(id)) {
      const conflict = (graph.conflicts.get(id) || []).find((other) => selectedSet.includes(other));
      addBlocker(blockers, id, conflict ? "WRITE_SCOPE_CONFLICT" : "CAPACITY_EXHAUSTED", conflict ? `unit ${id} overlaps selected unit ${conflict}` : "shared-worktree capacity is full", conflict ? [id, conflict] : [id]);
    }
  } else {
    const limit = input.capacity == null ? selected.length : Math.max(0, Math.floor(input.capacity));
    const before = selected; selected = before.slice(0, limit);
    for (const id of before.slice(limit)) addBlocker(blockers, id, "CAPACITY_EXHAUSTED", "scheduler capacity is full", [id]);
  }
  const stableBlockers: Record<string, RollingSchedulerBlocker[]> = {};
  for (const id of knownIds) if (blockers.has(id)) stableBlockers[id] = [...blockers.get(id)!].sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  const selectedRoutes = Object.fromEntries(selected.filter((id) => routeByUnit[id]).map((id) => [id, routeByUnit[id]!])) as Record<string, string>;
  return { frontier: [...selected], selected_routes: selectedRoutes, route_by_unit: Object.fromEntries(knownIds.map((id) => [id, routeByUnit[id] ?? null])), eligible: [...routable], integration_conflict_risks: integrationConflictRisks, inherited_base_trees: Object.fromEntries(Object.entries(inheritedBaseTrees).sort(([left], [right]) => left.localeCompare(right))), blockers: stableBlockers, known_unit_versions: knownIds, instrumentation: { manifest_reads: 0, semantic_reads: 0 } };
}
