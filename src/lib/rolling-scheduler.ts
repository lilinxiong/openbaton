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

type AnyRecord = Record<string, unknown>;
type Kind = "unit" | "gate";
type Identity = { kind: Kind; key: string; version?: number; id: string };

const ACCEPTED = new Set(["accepted", "succeeded", "success", "done", "reconciled"]);
const TERMINAL = new Set(["reserved", "running", "terminal", "terminal-unreleased", "terminal-awaiting-release"]);
const EXCLUDED = new Set(["failed", "blocked", "cancelled", "stale", "superseded"]);
const VERSION_REF = /^([^@]+)@([1-9][0-9]*)$/;

function record(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function state(value: unknown): string | null {
  if (typeof value === "string") return value.trim().toLowerCase().replaceAll("_", "-") || null;
  if (!record(value)) return null;
  if (value.accepted === true) return "accepted";
  if (value.terminal_unreleased === true || value.terminalUnreleased === true) return "terminal-unreleased";
  if (value.stale === true) return "stale";
  if (value.local_input_stale === true || value.localInputStale === true || value.input_stale === true || value.inputStale === true) return "stale";
  for (const key of ["state", "status", "runtime_state", "runtimeState", "lineage_state", "lineageState"]) {
    if (typeof value[key] === "string") return String(value[key]).trim().toLowerCase().replaceAll("_", "-") || null;
  }
  return null;
}
function normalizeState(value: unknown): string | null {
  const valueState = state(value);
  if (!valueState) return null;
  if (ACCEPTED.has(valueState)) return "accepted";
  if (TERMINAL.has(valueState)) return valueState === "terminal" || valueState === "terminal-awaiting-release" ? "terminal-unreleased" : valueState;
  if (EXCLUDED.has(valueState)) return valueState;
  if (["planned", "ready", "queued", "open", "undispatched"].includes(valueState)) return "undispatched";
  return valueState;
}
function stateFromFact(value: unknown): string | null {
  const direct = normalizeState(value);
  if (direct) return direct;
  if (!record(value)) return null;
  if (String(value.code || value.error_code || "").toUpperCase().includes("STALE")) return "stale";
  const kind = String(value.kind || value.fact_kind || "").toLowerCase();
  if (/(?:accepted|succeed|success|done|reconciled)/u.test(kind)) return "accepted";
  if (/(?:terminal|complete)/u.test(kind)) return "terminal-unreleased";
  if (/(?:running|active)/u.test(kind)) return "running";
  if (/(?:reserve|dispatch|material)/u.test(kind)) return "reserved";
  if (/(?:stale)/u.test(kind)) return "stale";
  if (/(?:fail|error|reject|block)/u.test(kind)) return kind.includes("block") ? "blocked" : "failed";
  return null;
}
function identity(value: unknown, fallback?: Kind, fallbackKey?: string): Identity | null {
  if (typeof value === "string") {
    const parsed = value.match(VERSION_REF);
    const raw = parsed?.[1] || value;
    const kind = fallback || (value.startsWith("unit:") ? "unit" : value.startsWith("gate:") ? "gate" : undefined);
    if (!kind || !text(raw)) return null;
    return { kind, key: raw.replace(/^(?:unit|gate):/, ""), ...(parsed ? { version: Number(parsed[2]) } : {}), id: parsed ? `${raw}@${parsed[2]}` : raw.replace(/^(?:unit|gate):/, "") };
  }
  if (!record(value)) return null;
  const payload = record(value.payload) ? value.payload : value;
  const owner = String(payload.owner || value.owner || "");
  const kind: Kind | undefined = owner === "gate_version" || text(payload.gate_key) || text(payload.gate_id) || text(value.gate_key) || text(value.gate_id)
    ? "gate"
    : owner === "unit_version" || text(payload.unit_key) || text(payload.unit_id) || text(value.unit_key) || text(value.unit_id)
      ? "unit" : fallback;
  if (!kind) return fallbackKey ? identity(fallbackKey, fallback) : null;
  const raw = kind === "unit"
    ? payload.unit_key ?? payload.unit_id ?? payload.unit_version_id ?? payload.key ?? payload.id ?? payload.owner_key ?? value.unit_key ?? value.unit_id ?? value.key ?? value.id ?? fallbackKey
    : payload.gate_key ?? payload.gate_id ?? payload.gate_version_id ?? payload.key ?? payload.id ?? payload.owner_key ?? value.gate_key ?? value.gate_id ?? value.key ?? value.id ?? fallbackKey;
  if (!text(raw)) return null;
  const parsed = String(raw).match(VERSION_REF);
  const rawVersion = kind === "unit"
    ? payload.unit_version ?? payload.version ?? payload.owner_version ?? value.unit_version ?? value.version
    : payload.gate_version ?? payload.version ?? payload.owner_version ?? value.gate_version ?? value.version;
  const version = integer(rawVersion) ? rawVersion : parsed ? Number(parsed[2]) : undefined;
  const key = parsed?.[1] || String(raw);
  return { kind, key, ...(version === undefined ? {} : { version }), id: version === undefined ? key : `${key}@${version}` };
}
function runtimeFacts(input: RollingSchedulerInput): unknown[] {
  return input.runtime_facts ? [...input.runtime_facts] : [];
}
function executionRootFor(input: RollingSchedulerInput, id: string, key: string): ApplyPlanOwnershipNamespace | undefined {
  const values = input.execution_roots_by_unit;
  return values instanceof Map ? values.get(id) ?? values.get(key) : values?.[id] ?? values?.[key];
}

/**
 * Planned isolated units already own distinct future roots even before the
 * selected frontier has passed repository setup.  Model that fact only for
 * conflict selection; exact base/root identity is still required by the
 * dispatch boundary and is never inferred here.
 */
function schedulingOwnershipNamespaces(
  input: RollingSchedulerInput,
  units: ReadonlyMap<string, UnitVersion>,
): ReadonlyMap<string, ApplyPlanOwnershipNamespace> {
  const result = new Map<string, ApplyPlanOwnershipNamespace>();
  for (const [id, unit] of units) {
    const exact = executionRootFor(input, id, unit.unit_key);
    if (exact) result.set(id, exact);
    else if (unit.execution_mode === "patch-only" && unit.worktree_mode === "isolated-worktree") {
      result.set(id, {
        repository_id: "baton-pending-isolated-repository",
        execution_root: `baton-pending-isolated-root:${id}`,
      });
    }
  }
  return result;
}
function versionId(key: string, version: number): string { return `${key}@${version}`; }
function parseRef(value: string): { key: string; version?: number } { const parsed = value.match(VERSION_REF); return parsed ? { key: parsed[1]!, version: Number(parsed[2]) } : { key: value }; }
function addBlocker(map: Map<string, RollingSchedulerBlocker[]>, id: string, code: string, message: string, refs: string[] = []): void {
  const values = map.get(id) || [];
  const signature = `${code}\0${message}\0${refs.join(",")}`;
  if (!values.some((item) => `${item.code}\0${item.message}\0${(item.refs || []).join(",")}` === signature)) values.push({ code, message, ...(refs.length ? { refs } : {}) });
  map.set(id, values);
}
function routeId(value: unknown): string | null {
  if (!record(value)) return text(value) ? value : null;
  return text(value.route_id) ? value.route_id : text(value.model_id) ? value.model_id : text(value.id) ? value.id : null;
}
function routeMatchesUnit(route: RollingRouteFact, id: string): boolean {
  const linked = route.unit_id ?? route.unit_key ?? route.unit_version_id;
  if (linked === undefined) return true;
  return identity(route, "unit")?.id === id || identity(route, "unit")?.key === id;
}
function routeList(input: RollingSchedulerInput, unit: UnitVersion, id: string): RollingRouteFact[] {
  const keyed = input.routes_by_unit;
  if (keyed instanceof Map) {
    const values = keyed.get(id) || keyed.get(unit.unit_key) || [];
    if (values.length) return [...values];
  } else if (keyed) {
    const values = keyed[id] || keyed[unit.unit_key] || [];
    if (values.length) return [...values];
  }
  return (input.route_facts || []).filter((item) => routeMatchesUnit(item, id));
}
function configuredRoutes(input: RollingSchedulerInput): string[] {
  return [...new Set((input.configured_routes || []).map(String).map((v) => v.trim()).filter(Boolean))];
}
function routeBase(id: string): string {
  const at = id.lastIndexOf("@");
  return at > 0 ? id.slice(0, at) : id;
}
function routeMatchesConfigured(id: string, configured: string): boolean {
  return id === configured || routeBase(id) === routeBase(configured);
}
function prioritizedRoutes(candidates: readonly RollingRouteFact[], configured: readonly string[]): RollingRouteFact[] {
  const withIds = candidates
    .map((candidate) => ({ candidate, id: routeId(candidate) }))
    .filter((item): item is { candidate: RollingRouteFact; id: string } => Boolean(item.id));
  if (!configured.length) return withIds.sort((left, right) => left.id.localeCompare(right.id)).map((item) => item.candidate);
  const ordered: RollingRouteFact[] = [];
  const seen = new Set<RollingRouteFact>();
  for (const configuredId of configured) {
    const matches = withIds
      .filter((item) => routeMatchesConfigured(item.id, configuredId))
      .sort((left, right) => Number(right.id === configuredId) - Number(left.id === configuredId) || left.id.localeCompare(right.id));
    for (const item of matches) {
      if (seen.has(item.candidate)) continue;
      seen.add(item.candidate);
      ordered.push(item.candidate);
    }
  }
  return ordered;
}
function availabilityFor(input: RollingSchedulerInput, id: string): AnyRecord | null {
  const source = input.current_session_availability;
  const base = id.includes("@") ? id.slice(0, id.lastIndexOf("@")) : id;
  const value = source instanceof Map ? source.get(id) ?? source.get(base) : source?.[id] ?? source?.[base];
  return record(value) ? value : typeof value === "string" ? { status: value } : null;
}
function candidateEligible(route: RollingRouteFact, input: RollingSchedulerInput, unit: UnitVersion): { ok: boolean; code?: string; message?: string } {
  const id = routeId(route);
  if (!id) return { ok: false, code: "ROUTE_ABSENT_FROM_ACTIVE_CATALOG", message: "route has no stable route id" };
  const availability = availabilityFor(input, id);
  const diagnostic = String(route.diagnostic_code || route.selection_code || "");
  if (route.disabled === true || route.selectable === false || route.eligible === false || route.automatic_eligible === false) return { ok: false, code: diagnostic || "CURRENT_SESSION_UNCALLABLE", message: String(route.selection_reason || `route ${id} is not callable in the current Baton session`) };
  const status = String(route.availability_status || route.availability || availability?.status || "available").toLowerCase();
  const probeAvailable = route.probe_available === true || availability?.probe_available === true;
  if ((status === "exhausted" || status === "probe_due") && !probeAvailable) return { ok: false, code: diagnostic || "CURRENT_SESSION_QUOTA_EXHAUSTED", message: String(route.availability_reason || availability?.reason || `route ${id} is unavailable in the current Baton session`) };
  if (route.current_session_available === false || route.current_session_uncallable === true || availability?.current_session_available === false || availability?.current_session_uncallable === true) return { ok: false, code: diagnostic || "CURRENT_SESSION_UNCALLABLE", message: String(route.selection_reason || availability?.reason || `route ${id} is not callable in the current Baton session`) };
  const raw = unit as unknown as AnyRecord;
  const requirements = raw.required_execution_capabilities ?? raw.requiredExecutionCapabilities ?? raw.execution_capabilities_required ?? raw.required_capabilities;
  const required = Array.isArray(requirements) ? requirements.map(String).map((v) => v.toLowerCase().replaceAll(/[_ ]+/g, "-")).filter(Boolean) : [];
  if (raw.execution_mode === "patch-only" && raw.requires_native_execution === true) required.push("native-execution");
  const advertised = route.execution_capabilities ?? route.executionCapabilities ?? route.capabilities;
  if (required.length && (Array.isArray(advertised) || record(advertised))) {
    const names = Array.isArray(advertised)
      ? advertised.map(String).map((v) => v.toLowerCase().replaceAll(/[_ ]+/g, "-"))
      : Object.entries(advertised).filter(([, value]) => value === true || (record(value) && value.supported === true)).map(([name]) => name.toLowerCase().replaceAll(/[_ ]+/g, "-"));
    const missing = required.find((name) => !names.includes(name));
    if (missing) return { ok: false, code: "REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED", message: `route ${id} does not advertise ${missing}` };
  }
  return { ok: true };
}

function unitState(states: Map<string, string>, id: string, key: string): string | null { return states.get(`unit:${id}`) || states.get(`unit:${key}`) || null; }
function gateState(states: Map<string, string>, id: string, key: string): string | null { return states.get(`gate:${id}`) || states.get(`gate:${key}`) || null; }
function stableUnitIds(ids: readonly string[], stableOrder: readonly string[]): string[] {
  const fallback = [...ids].sort((left, right) => left.localeCompare(right));
  const remaining = new Set(fallback);
  const ordered: string[] = [];
  for (const value of stableOrder) {
    if (!text(value)) continue;
    const parsed = parseRef(value.replace(/^unit:/, ""));
    for (const id of fallback) {
      if (!remaining.has(id)) continue;
      const candidate = parseRef(id);
      if (candidate.key !== parsed.key || (parsed.version !== undefined && candidate.version !== parsed.version)) continue;
      remaining.delete(id);
      ordered.push(id);
    }
  }
  return [...ordered, ...fallback.filter((id) => remaining.has(id))];
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
