/**
 * Lineage state machinery for rolling task lifecycle derivation. Split from
 * rolling-lifecycle.ts.
 */
import type {
  GateVersion,
  PlanDelta,
  UnitVersion,
} from "./rolling-plan.js";
import type { RollingTaskLineageState } from "./rolling-lifecycle.js";
import { TaskCoverage } from "./rolling-plan.js";
import {
  allArrayValues,
  contextFacts,
  integer,
  record,
  text
} from "./rolling-lifecycle-context.js";

type AnyRecord = Record<string, unknown>;
export type FactKind = "unit" | "gate";
type Version = UnitVersion | GateVersion;

const VERSION_REF = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)@([1-9][0-9]*)$/u;
const HASH = /^[0-9a-f]{64}$/u;

export function parseRef(value: unknown, fallbackKind?: FactKind): { kind: FactKind; key: string; version?: number; id: string } | null {
  if (typeof value === "string") {
    const prefixed = value.match(/^(unit|gate):(.+)$/u);
    const raw = prefixed ? prefixed[2]! : value;
    const parsed = raw.match(VERSION_REF);
    const kind = prefixed ? prefixed[1] as FactKind : fallbackKind;
    if (!kind || !text(raw)) return null;
    if (parsed) return { kind, key: parsed[1]!, version: Number(parsed[2]), id: raw };
    return { kind, key: raw, id: raw };
  }
  if (!record(value)) return null;
  const owner = typeof value.owner === "string" ? value.owner : "";
  const ownerRecord = record(value.owner) ? value.owner : undefined;
  const ownerKind: FactKind | undefined = owner === "unit" || owner === "unit_version" || ownerRecord?.kind === "unit" || ownerRecord?.kind === "unit_version"
    ? "unit"
    : owner === "gate" || owner === "gate_version" || ownerRecord?.kind === "gate" || ownerRecord?.kind === "gate_version"
      ? "gate"
      : undefined;
  const kind = ownerKind || fallbackKind
    || (text(value.unit_key) || text(value.unit_id) || value.unit_version !== undefined ? "unit" : undefined)
    || (text(value.gate_key) || text(value.gate_id) || value.gate_version !== undefined ? "gate" : undefined);
  if (!kind) return null;
  const raw = kind === "unit"
    ? value.unit_key ?? value.unit_id ?? value.unit ?? value.key ?? value.id ?? value.owner_key ?? ownerRecord?.key ?? ownerRecord?.id
    : value.gate_key ?? value.gate_id ?? value.gate ?? value.key ?? value.id ?? value.owner_key ?? ownerRecord?.key ?? ownerRecord?.id;
  if (!text(raw)) return null;
  const parsed = String(raw).match(VERSION_REF);
  const versionValue = kind === "unit"
    ? value.unit_version ?? value.version ?? value.owner_version ?? ownerRecord?.version ?? ownerRecord?.unit_version
    : value.gate_version ?? value.version ?? value.owner_version ?? ownerRecord?.version ?? ownerRecord?.gate_version;
  const version = integer(versionValue) && versionValue > 0 ? versionValue : parsed ? Number(parsed[2]) : undefined;
  const key = parsed ? parsed[1]! : String(raw);
  return { kind, key, ...(version === undefined ? {} : { version }), id: version === undefined ? key : `${key}@${version}` };
}

export function normalizedState(value: unknown): RollingTaskLineageState | null {
  let raw: string | undefined;
  if (typeof value === "string") raw = value;
  else if (record(value)) {
    for (const key of ["status", "state", "lifecycle", "runtime_state", "runtimeState", "lineage_state", "lineageState"]) {
      if (typeof value[key] === "string") { raw = value[key] as string; break; }
    }
    if (!raw && value.accepted === true) raw = "accepted";
    if (!raw && value.failed === true) raw = "failed";
    if (!raw && value.blocked === true) raw = "blocked";
  }
  if (!raw || !raw.trim()) return null;
  const state = raw.trim().toLowerCase().replaceAll("_", "-");
  if (["accepted", "succeeded", "success", "reconciled", "done"].includes(state)) return "accepted";
  if (["failed", "failure", "errored", "error", "rejected", "cancelled", "blocked"].includes(state)) return state === "blocked" ? "blocked" : "failed";
  if (["terminal", "completed", "terminal-unreleased", "terminal-awaiting-release"].includes(state)) return "terminal-unreleased";
  if (["reserved", "dispatching", "materialized"].includes(state)) return "reserved";
  if (["running", "active"].includes(state)) return "running";
  if (["queued", "planned", "open", "undispatched", "stale"].includes(state)) return "undispatched";
  return state;
}

export function stateRank(state: RollingTaskLineageState): number {
  return {
    undispatched: 0,
    reserved: 1,
    running: 2,
    "terminal-unreleased": 3,
    failed: 4,
    blocked: 4,
    accepted: 5,
    superseded: 6,
  }[state] ?? 2;
}

export function setState(states: Map<string, RollingTaskLineageState>, identity: ReturnType<typeof parseRef>, state: RollingTaskLineageState | null): void {
  if (!identity || !state) return;
  const id = `${identity.kind}:${identity.id}`;
  const prior = states.get(id);
  // Accepted state is parent-owned and monotonic.  A later transport status
  // must not downgrade it while a reconnect is rebuilding the projection.
  if (!prior || prior !== "accepted" && stateRank(state) >= stateRank(prior)) states.set(id, state);
  if (identity.version === undefined) {
    const key = `${identity.kind}:${identity.key}`;
    const priorKey = states.get(key);
    if (!priorKey || priorKey !== "accepted" && stateRank(state) >= stateRank(priorKey)) states.set(key, state);
  }
}

export function collectStatusEntry(states: Map<string, RollingTaskLineageState>, value: unknown, fallbackKind?: FactKind, fallbackKey?: string): void {
  const state = normalizedState(value);
  if (!state) return;
  // In a keyed `{ "unit@1": "accepted" }` map the value is the state and
  // the key is the identity.  Do not mistake the literal state string for a
  // unit named `accepted`.
  const stateString = typeof value === "string" && !VERSION_REF.test(value) && !/^(?:unit|gate):/u.test(value);
  const identity = stateString
    ? (fallbackKey ? parseRef(fallbackKey, fallbackKind) : null)
    : parseRef(value, fallbackKind) || (fallbackKey ? parseRef(fallbackKey, fallbackKind) : null);
  setState(states, identity, state);
}

export function collectStatusContainer(states: Map<string, RollingTaskLineageState>, value: unknown, fallbackKind?: FactKind): void {
  if (value instanceof Map) {
    for (const [key, item] of value.entries()) collectStatusEntry(states, item, fallbackKind, String(key));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStatusEntry(states, item, fallbackKind);
    return;
  }
  if (!record(value)) return;
  if (normalizedState(value) && parseRef(value, fallbackKind)) {
    collectStatusEntry(states, value, fallbackKind);
    return;
  }
  for (const [key, item] of Object.entries(value)) collectStatusEntry(states, item, fallbackKind, key);
}

export function collectFactStatuses(states: Map<string, RollingTaskLineageState>, fact: unknown): void {
  if (!record(fact)) return;
  const payload = record(fact.payload) ? fact.payload : fact;
  const kindText = typeof fact.kind === "string" ? fact.kind.toLowerCase() : "";
  const fallbackKind: FactKind | undefined = kindText.includes("gate") ? "gate" : kindText.includes("unit") || kindText.includes("ticket") || kindText.includes("attempt") || kindText.includes("result") ? "unit" : undefined;
  const state = normalizedState(payload) || normalizedState(fact)
    || (/(?:fail|error|reject)/u.test(kindText) ? "failed"
      : /(?:accept|success|succeed)/u.test(kindText) ? "accepted"
      : /terminal/u.test(kindText) ? "terminal-unreleased"
      : /running/u.test(kindText) ? "running"
      : /(?:reserve|dispatch|material)/u.test(kindText) ? "reserved"
      : null);
  const identity = parseRef(payload, fallbackKind) || parseRef(fact, fallbackKind);
  setState(states, identity, state);
  if (record(payload)) {
    for (const id of Array.isArray(payload.unit_ids) ? payload.unit_ids : []) setState(states, parseRef(id, "unit"), state);
    for (const id of Array.isArray(payload.gate_ids) ? payload.gate_ids : []) setState(states, parseRef(id, "gate"), state);
  }
}

export function lineageStates(source: AnyRecord, deltas: readonly PlanDelta[]): Map<string, RollingTaskLineageState> {
  const states = new Map<string, RollingTaskLineageState>();
  for (const key of ["unit_status", "unitStatus", "unit_state", "unitState", "unit_states", "unitStates", "unit_lifecycle", "unitLifecycle", "unit_lineage", "unitLineage", "unit_versions_status", "unitVersionsStatus", "active_units", "activeUnits"]) collectStatusContainer(states, source[key], "unit");
  for (const key of ["gate_status", "gateStatus", "gate_state", "gateState", "gate_states", "gateStates", "gate_lifecycle", "gateLifecycle", "gate_lineage", "gateLineage", "gate_versions_status", "gateVersionsStatus", "active_gates", "activeGates"]) collectStatusContainer(states, source[key], "gate");
  for (const key of ["lineage_status", "lineageStatus", "lineage_states", "lineageStates", "statuses", "lifecycle_status", "lifecycleStatus"]) collectStatusContainer(states, source[key]);
  for (const fact of contextFacts(source)) collectFactStatuses(states, fact);
  for (const value of allArrayValues(source, ["local_failures"])) {
    if (!record(value)) continue;
    const kind = value.owner === "gate_version" ? "gate" : value.owner === "unit_version" ? "unit" : undefined;
    if (kind) setState(states, parseRef({ owner_key: value.owner_key, owner_version: value.owner_version }, kind), "failed");
  }
  for (const delta of deltas) {
    for (const attempt of Array.isArray(delta.retry_attempts) ? delta.retry_attempts : []) collectStatusEntry(states, attempt, "unit");
    for (const failure of Array.isArray(delta.local_failures) ? delta.local_failures : []) {
      if (!record(failure)) continue;
      const kind = failure.owner === "gate_version" ? "gate" : failure.owner === "unit_version" ? "unit" : undefined;
      setState(states, kind ? parseRef({ owner_key: failure.owner_key, owner_version: failure.owner_version }, kind) : null, "failed");
    }
    for (const supersession of Array.isArray(delta.supersessions) ? delta.supersessions : []) {
      if (!record(supersession)) continue;
      const kind = supersession.owner === "gate_version" ? "gate" : supersession.owner === "unit_version" ? "unit" : undefined;
      setState(states, kind ? parseRef(supersession.previous, kind) : null, "superseded");
    }
  }
  return states;
}

export function supersededVersions(deltas: readonly PlanDelta[]): { units: Set<string>; gates: Set<string> } {
  const units = new Set<string>();
  const gates = new Set<string>();
  for (const delta of deltas) for (const item of Array.isArray(delta.supersessions) ? delta.supersessions : []) {
    if (!record(item)) continue;
    const kind = item.owner === "unit_version" ? "unit" : item.owner === "gate_version" ? "gate" : null;
    const ref = kind ? parseRef(item.previous, kind) : null;
    if (ref?.version !== undefined) (kind === "unit" ? units : gates).add(ref.id);
  }
  return { units, gates };
}

export function supersededVersionsFromContext(source: AnyRecord, deltas: readonly PlanDelta[]): { units: Set<string>; gates: Set<string> } {
  const result = supersededVersions(deltas);
  for (const item of allArrayValues(source, ["supersessions"])) {
    if (!record(item)) continue;
    const kind = item.owner === "unit_version" ? "unit" : item.owner === "gate_version" ? "gate" : null;
    const ref = kind ? parseRef(item.previous, kind) : null;
    if (ref?.version !== undefined) (kind === "unit" ? result.units : result.gates).add(ref.id);
  }
  return result;
}

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
