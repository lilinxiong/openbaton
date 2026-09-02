/**
 * Fact indexing, lineage-state collection and version resolution for rolling
 * plan-delta validation. Split from rolling-delta.ts (leaf module).
 */
import type {
  GateVersion,
  PlanDelta,
  RollingDiagnostic,
  TaskManifestEntry,
  UnitVersion,
} from "./rolling-plan.js";
import { isNonBlankString } from "./validate-utils.js";
import { isRecord } from "./validate-utils.js";
import type { SafetyOperation } from "./safety.js";
import type { GateType } from "./rolling-plan.js";

export const ROLLING_DELTA_OPERATIONS: readonly SafetyOperation[] = [
  "write",
  "create",
  "delete",
  "rename",
  "chmod",
];

export const ROLLING_DELTA_GATE_TYPES: readonly GateType[] = [
  "safety-precondition",
  "integration-acceptance",
  "evidence",
];

export type AnyRecord = Record<string, unknown>;
export type FactKind = "unit" | "gate";
export type SourceKind = "fixed" | "delta";

/**
 * Runtime lineage states are intentionally kept source-neutral here.  The
 * rolling kernel may receive them from a checkpoint, a ticket projection, or
 * a caller supplied status map.  Unknown strings are retained and treated as
 * immutable below; only the two explicitly replaceable states are mutable.
 */
export type LineageState = string;

export interface VersionFact<T> {
  id: string;
  key: string;
  version: number;
  value: T;
  source: SourceKind;
}

export interface NodeFact {
  id: string;
  kind: FactKind;
  key: string;
  version: number;
  source: SourceKind;
  value: UnitVersion | GateVersion;
}

export interface FactIndex {
  tasks: Map<string, TaskManifestEntry>;
  units: Map<string, VersionFact<UnitVersion>>;
  gates: Map<string, VersionFact<GateVersion>>;
  nodes: Map<string, NodeFact>;
  localUnits: Map<string, VersionFact<UnitVersion>>;
  localGates: Map<string, VersionFact<GateVersion>>;
  lineageStates: Map<string, LineageState>;
}

const VERSION_REF = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)@([1-9][0-9]*)$/;

export function own(value: AnyRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function text(value: unknown): value is string { return isNonBlankString(value); }

export function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function issue(
  diagnostics: RollingDiagnostic[],
  code: string,
  message: string,
  pathName: string,
  refs: readonly string[] = [],
): void {
  diagnostics.push({
    code,
    message,
    path: pathName,
    ...(refs.length ? { refs: [...refs] } : {}),
  });
}

export function sortDiagnostics(diagnostics: readonly RollingDiagnostic[]): RollingDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const pathCompare = (left.path || "").localeCompare(right.path || "");
    if (pathCompare !== 0) return pathCompare;
    const codeCompare = left.code.localeCompare(right.code);
    if (codeCompare !== 0) return codeCompare;
    const refsCompare = (left.refs || []).join("\u0000").localeCompare((right.refs || []).join("\u0000"));
    if (refsCompare !== 0) return refsCompare;
    return left.message.localeCompare(right.message);
  });
}

export function stableVersionId(key: unknown, version: unknown): string | null {
  return text(key) && integer(version) && version > 0 ? `${key}@${version}` : null;
}

export function versionPath(kind: FactKind, id: string): string {
  return kind === "unit" ? `delta.unit_versions[${id}]` : `delta.gate_versions[${id}]`;
}

export function taskPath(taskKey: string): string {
  return `delta.task_coverage[${taskKey}]`;
}

export function parseVersionRef(value: unknown): { key: string; version: number; id: string } | null {
  if (typeof value !== "string") return null;
  const match = value.match(VERSION_REF);
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { key: match[1]!, version, id: value };
}


export function arrayAt(value: unknown, keys: readonly string[]): unknown[] {
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate instanceof Map) return [...candidate.values()];
    if (isRecord(candidate)) {
      if (Array.isArray(candidate.entries)) return candidate.entries;
      // A fixed-facts snapshot may use keyed maps (`unit_key@version` ->
      // UnitVersion) instead of arrays.  Preserve insertion order here; all
      // semantic diagnostics are sorted by stable identities later.
      const values = Object.values(candidate);
      if (values.length > 0 && values.every(isRecord)) return values;
    }
  }
  return [];
}

export function arraysAt(value: unknown, keys: readonly string[]): unknown[] {
  if (!isRecord(value)) return [];
  const out: unknown[] = [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) out.push(...candidate);
    else if (candidate instanceof Map) out.push(...candidate.values());
    else if (isRecord(candidate)) {
      if (Array.isArray(candidate.entries)) out.push(...candidate.entries);
      else {
        const values = Object.values(candidate);
        if (values.length > 0 && values.every(isRecord)) out.push(...values);
      }
    }
  }
  return out;
}

export function normalizedLineageState(value: unknown): LineageState | null {
  let raw: string | undefined;
  if (typeof value === "string") raw = value;
  else if (isRecord(value)) {
    for (const key of ["status", "state", "lifecycle", "runtime_state", "runtimeState", "lineage_state", "lineageState"]) {
      if (typeof value[key] === "string") { raw = value[key] as string; break; }
    }
    if (!raw && value.terminal_unreleased === true) raw = "terminal-unreleased";
    if (!raw && value.terminalUnreleased === true) raw = "terminal-unreleased";
    if (!raw && value.accepted === true) raw = "accepted";
    if (!raw && value.failed === true) raw = "failed";
  }
  if (!raw || !raw.trim()) return null;
  const state = raw.trim().toLowerCase().replaceAll("_", "-");
  if (["planned", "ready", "queued", "open", "unplanned", "undispatched", "stale"].includes(state)) return "undispatched";
  if (["dispatching", "materialized", "reserved"].includes(state)) return "reserved";
  if (["completed", "terminal", "terminal-unreleased", "terminal-awaiting-release"].includes(state)) return "terminal-unreleased";
  if (["succeeded", "success", "accepted", "reconciled", "done"].includes(state)) return "accepted";
  if (["errored", "timed-out", "failure", "failed", "cancelled", "canceled", "closed", "interrupted"].includes(state)) return "failed";
  return state;
}

export function statusIdentity(value: unknown, fallbackKind?: FactKind): { kind: FactKind; key: string; version?: number } | null {
  if (typeof value === "string") {
    const parsed = parseVersionRef(value);
    if (parsed && fallbackKind) return { kind: fallbackKind, key: parsed.key, version: parsed.version };
    if (fallbackKind && text(value)) return { kind: fallbackKind, key: value };
    const separator = value.indexOf(":");
    const prefixedKind = separator > 0 && (value.slice(0, separator) === "unit" || value.slice(0, separator) === "gate")
      ? value.slice(0, separator) as FactKind
      : undefined;
    if (prefixedKind) {
      const prefixed = parseVersionRef(value.slice(separator + 1));
      return prefixed
        ? { kind: prefixedKind, key: prefixed.key, version: prefixed.version }
        : { kind: prefixedKind, key: value.slice(separator + 1) };
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const owner = typeof value.owner === "string" ? value.owner : undefined;
  const ownerRecord = isRecord(value.owner) ? value.owner : undefined;
  const ownerKind: FactKind | undefined = owner === "unit_version" || owner === "unit"
    || ownerRecord?.kind === "unit_version" || ownerRecord?.kind === "unit" ? "unit"
    : owner === "gate_version" || owner === "gate"
      || ownerRecord?.kind === "gate_version" || ownerRecord?.kind === "gate" ? "gate"
      : undefined;
  const kind: FactKind | undefined = ownerKind || fallbackKind
    || (text(value.unit_key) || text(value.unit_id) || text(value.unit_version) ? "unit" : undefined)
    || (text(value.gate_key) || text(value.gate_id) || text(value.gate_version) ? "gate" : undefined);
  if (!kind) return null;
  const keyRaw = kind === "unit"
    ? value.unit_key ?? value.unit_id ?? value.unit ?? value.key ?? value.id ?? value.owner_key ?? ownerRecord?.key ?? ownerRecord?.id
    : value.gate_key ?? value.gate_id ?? value.gate ?? value.key ?? value.id ?? value.owner_key ?? ownerRecord?.key ?? ownerRecord?.id;
  if (!text(keyRaw)) return null;
  const parsed = parseVersionRef(keyRaw);
  const versionRaw = kind === "unit"
    ? value.unit_version ?? value.version ?? value.owner_version ?? ownerRecord?.version ?? ownerRecord?.unit_version
    : value.gate_version ?? value.version ?? value.owner_version ?? ownerRecord?.version ?? ownerRecord?.gate_version;
  const version = integer(versionRaw) && versionRaw > 0 ? versionRaw : parsed?.version;
  return { kind, key: parsed?.key || keyRaw, ...(version === undefined ? {} : { version }) };
}

export function putLineageState(states: Map<string, LineageState>, identity: { kind: FactKind; key: string; version?: number } | null, state: unknown): void {
  const normalized = normalizedLineageState(state);
  if (!identity || !normalized) return;
  const parsed = parseVersionRef(identity.key);
  const key = parsed?.key || identity.key;
  const version = identity.version ?? parsed?.version;
  const id = version === undefined ? key : `${key}@${version}`;
  states.set(`${identity.kind}:${id}`, normalized);
  // A ticket projection without a version applies to the whole key.  A
  // versioned status must stay exact; otherwise the state of `u@2` could
  // accidentally make an undispatched `u@1` immutable.
  if (version === undefined) states.set(`${identity.kind}:${key}`, normalized);
}

export function collectLineageStatusEntry(states: Map<string, LineageState>, value: unknown, fallbackKind?: FactKind, fallbackKey?: string): void {
  const explicit = typeof value === "string" ? null : statusIdentity(value, fallbackKind);
  const identity = explicit || (fallbackKey && fallbackKind ? statusIdentity(fallbackKey, fallbackKind) : statusIdentity(value, fallbackKind));
  const state = normalizedLineageState(value);
  if (identity && state) putLineageState(states, identity, state);
}

export function collectLineageStatusContainer(states: Map<string, LineageState>, value: unknown, fallbackKind?: FactKind): void {
  if (value instanceof Map) {
    for (const [key, item] of value.entries()) collectLineageStatusEntry(states, item, fallbackKind, String(key));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLineageStatusEntry(states, item, fallbackKind);
    return;
  }
  if (!isRecord(value)) return;
  if (normalizedLineageState(value) && statusIdentity(value, fallbackKind)) {
    collectLineageStatusEntry(states, value, fallbackKind);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (fallbackKind) collectLineageStatusEntry(states, item, fallbackKind, key);
    else collectLineageStatusEntry(states, item, undefined, key);
  }
}

export function collectLineageFact(states: Map<string, LineageState>, value: unknown): void {
  if (!isRecord(value)) return;
  const payload = isRecord(value.payload) ? value.payload : value;
  const outerKind = typeof value.kind === "string" ? value.kind.toLowerCase() : "";
  const payloadKind = typeof payload.kind === "string" ? payload.kind.toLowerCase() : "";
  const kindText = `${outerKind} ${payloadKind}`.trim();
  const fallbackKind: FactKind | undefined = kindText.includes("gate") ? "gate" : kindText.includes("unit") || kindText.includes("ticket") || kindText.includes("attempt") || kindText.includes("result") ? "unit" : undefined;
  // A safety pass is a prerequisite, not parent acceptance of the unit.  It
  // must not overwrite a terminal failure merely because its payload also
  // uses an `accepted: true` field.
  const state = (kindText.includes("safety-verdict") && payload.accepted === true ? null : normalizedLineageState(payload)) || normalizedLineageState(value)
    || (/(?:fail|error|reject)/u.test(kindText) ? "failed"
      : /(?:accept|success|succeed)/u.test(kindText) ? "accepted"
      : /terminal/u.test(kindText) ? "terminal-unreleased"
      : /running/u.test(kindText) ? "running"
      : /(?:reserve|dispatch|material)/u.test(kindText) ? "reserved"
      : null);
  const identity = statusIdentity(payload, fallbackKind) || statusIdentity(value, fallbackKind);
  if (identity && state) putLineageState(states, identity, state);
  for (const id of Array.isArray(payload.unit_ids) ? payload.unit_ids : []) putLineageState(states, statusIdentity(id, "unit"), state);
  for (const id of Array.isArray(payload.gate_ids) ? payload.gate_ids : []) putLineageState(states, statusIdentity(id, "gate"), state);
  const supersessions = Array.isArray(payload.supersessions) ? payload.supersessions : [];
  for (const item of supersessions) {
    if (!isRecord(item)) continue;
    const owner = item.owner === "gate_version" ? "gate" : item.owner === "unit_version" ? "unit" : undefined;
    if (owner && text(item.previous)) putLineageState(states, statusIdentity(item.previous, owner), "superseded");
  }
}

export function lineageStatesFromContext(source: AnyRecord): Map<string, LineageState> {
  const states = new Map<string, LineageState>();
  for (const key of ["unit_status", "unitStatus", "unit_state", "unitState", "unit_states", "unitStates", "unit_lifecycle", "unitLifecycle", "unit_lineage", "unitLineage", "unit_versions_status", "unitVersionsStatus", "active_units", "activeUnits", "unit_facts", "unitFacts"]) {
    collectLineageStatusContainer(states, source[key], "unit");
  }
  for (const key of ["gate_status", "gateStatus", "gate_state", "gateState", "gate_states", "gateStates", "gate_lifecycle", "gateLifecycle", "gate_lineage", "gateLineage", "gate_versions_status", "gateVersionsStatus", "active_gates", "activeGates", "gate_facts", "gateFacts"]) {
    collectLineageStatusContainer(states, source[key], "gate");
  }
  for (const key of ["lineage_status", "lineageStatus", "lineage_states", "lineageStates", "statuses", "lifecycle_status", "lifecycleStatus"]) {
    collectLineageStatusContainer(states, source[key]);
  }
  for (const key of ["facts", "rolling_facts", "rollingFacts", "ticket_facts", "ticketFacts", "execution_facts", "executionFacts"]) {
    const values = source[key];
    if (Array.isArray(values)) for (const item of values) collectLineageFact(states, item);
  }
  for (const value of arrayAt(source, ["unit_versions", "unitVersions", "known_units", "units"])) collectLineageStatusEntry(states, value, "unit");
  for (const value of arrayAt(source, ["gate_versions", "gateVersions", "known_gates", "gates"])) collectLineageStatusEntry(states, value, "gate");
  for (const delta of arrayAt(source, ["accepted_deltas", "deltas"])) {
    if (!isRecord(delta)) continue;
    for (const attempt of Array.isArray(delta.retry_attempts) ? delta.retry_attempts : []) {
      if (!isRecord(attempt)) continue;
      const unitKey = typeof attempt.unit_key === "string" ? attempt.unit_key : undefined;
      if (unitKey) putLineageState(states, { kind: "unit", key: unitKey, ...(integer(attempt.unit_version) && attempt.unit_version > 0 ? { version: attempt.unit_version } : {}) }, attempt.state);
    }
    for (const failure of Array.isArray(delta.local_failures) ? delta.local_failures : []) {
      if (!isRecord(failure)) continue;
      const owner = failure.owner === "gate_version" ? "gate" : failure.owner === "unit_version" ? "unit" : undefined;
      const ownerKey = typeof failure.owner_key === "string" ? failure.owner_key : undefined;
      if (owner && ownerKey) putLineageState(states, { kind: owner, key: ownerKey, ...(integer(failure.owner_version) && failure.owner_version > 0 ? { version: failure.owner_version } : {}) }, "failed");
    }
    for (const item of Array.isArray(delta.supersessions) ? delta.supersessions : []) {
      if (!isRecord(item)) continue;
      const owner = item.owner === "gate_version" ? "gate" : item.owner === "unit_version" ? "unit" : undefined;
      if (owner && text(item.previous)) putLineageState(states, statusIdentity(item.previous, owner), "superseded");
    }
  }
  return states;
}

export function contextSource(context: unknown): AnyRecord {
  if (!isRecord(context)) return {};
  const nested = isRecord(context.fixed_facts)
    ? context.fixed_facts
    : isRecord(context.fixed)
      ? context.fixed
    : isRecord(context.checkpoint)
      ? context.checkpoint
      : {};
  // Keep direct fields authoritative while accepting a nested fixed-facts
  // object.  The two are merged only for read-only indexing.
  return { ...nested, ...context };
}

export function appendDeltaFacts(source: AnyRecord, field: "manifest" | "unit" | "gate"): unknown[] {
  const deltas = [
    ...arrayAt(source, ["accepted_deltas", "deltas"]),
  ].filter(isRecord);
  const out: unknown[] = [];
  for (const delta of deltas) {
    const keys = field === "manifest"
      ? ["manifest_additions", "manifest_refreshes"]
      : field === "unit"
        ? ["unit_versions"]
        : ["gate_versions"];
    out.push(...arraysAt(delta, keys));
  }
  return out;
}

export function makeIndex(context: unknown, delta: PlanDelta, diagnostics: RollingDiagnostic[]): FactIndex {
  const source = contextSource(context);
  const tasks = new Map<string, TaskManifestEntry>();
  const units = new Map<string, VersionFact<UnitVersion>>();
  const gates = new Map<string, VersionFact<GateVersion>>();
  const localUnits = new Map<string, VersionFact<UnitVersion>>();
  const localGates = new Map<string, VersionFact<GateVersion>>();

  const fixedManifest = [
    ...arrayAt(source, ["manifest_entries", "task_manifest", "task_entries", "tasks", "known_tasks", "fixed_manifest_entries", "fixed_task_entries", "fixed_tasks", "manifestEntries", "taskEntries", "manifest", "entries"]),
    ...appendDeltaFacts(source, "manifest"),
  ];
  for (const value of fixedManifest) {
    if (!isRecord(value) || !text(value.task_key)) continue;
    // Fixed facts are accepted state.  If a duplicate is supplied, retain the
    // first deterministic value rather than attributing the external error to
    // this proposed delta.
    if (!tasks.has(value.task_key)) tasks.set(value.task_key, value as unknown as TaskManifestEntry);
  }

  const fixedUnits = [
    ...arrayAt(source, ["unit_versions", "unitVersions", "known_units", "fixed_unit_versions", "units"]),
    ...appendDeltaFacts(source, "unit"),
  ];
  for (const value of fixedUnits) {
    if (!isRecord(value)) continue;
    const id = stableVersionId(value.unit_key, value.version);
    if (!id || units.has(id)) continue;
    const fact: VersionFact<UnitVersion> = {
      id,
      key: value.unit_key as string,
      version: value.version as number,
      value: value as unknown as UnitVersion,
      source: "fixed",
    };
    units.set(id, fact);
  }

  const fixedGates = [
    ...arrayAt(source, ["gate_versions", "gateVersions", "known_gates", "fixed_gate_versions", "gates"]),
    ...appendDeltaFacts(source, "gate"),
  ];
  for (const value of fixedGates) {
    if (!isRecord(value)) continue;
    const id = stableVersionId(value.gate_key, value.version);
    if (!id || gates.has(id)) continue;
    const fact: VersionFact<GateVersion> = {
      id,
      key: value.gate_key as string,
      version: value.version as number,
      value: value as unknown as GateVersion,
      source: "fixed",
    };
    gates.set(id, fact);
  }

  const localManifest = [
    ...arraysAt(delta, ["manifest_additions", "manifest_refreshes"]),
  ];
  const fixedTaskKeys = new Set(tasks.keys());
  const additionKeys = new Set(
    arraysAt(delta, ["manifest_additions"])
      .filter(isRecord)
      .filter((value) => text(value.task_key))
      .map((value) => value.task_key as string),
  );
  const seenLocalTaskKeys = new Set<string>();
  for (const value of localManifest) {
    if (!isRecord(value) || !text(value.task_key)) continue;
    const addition = additionKeys.has(value.task_key);
    if (seenLocalTaskKeys.has(value.task_key) || (addition && fixedTaskKeys.has(value.task_key))) {
      issue(diagnostics, "DUPLICATE_TASK", `manifest task ${value.task_key} is declared more than once`, `delta.manifest[${value.task_key}]`, [value.task_key]);
    } else if (!addition && !fixedTaskKeys.has(value.task_key)) {
      issue(diagnostics, "UNKNOWN_TASK_REFERENCE", `manifest refresh references unknown task ${value.task_key}`, `delta.manifest_refreshes[${value.task_key}]`, [value.task_key]);
    }
    seenLocalTaskKeys.add(value.task_key);
    tasks.set(value.task_key, value as unknown as TaskManifestEntry);
  }

  const localUnitValues = arrayAt(delta, ["unit_versions"]);
  for (const value of localUnitValues) {
    if (!isRecord(value)) continue;
    const id = stableVersionId(value.unit_key, value.version);
    if (!id) continue;
    if (units.has(id)) {
      issue(diagnostics, "DUPLICATE_VERSION", `duplicate unit version ${id}`, versionPath("unit", id), [id]);
      continue;
    }
    const fact: VersionFact<UnitVersion> = {
      id,
      key: value.unit_key as string,
      version: value.version as number,
      value: value as unknown as UnitVersion,
      source: "delta",
    };
    units.set(id, fact);
    localUnits.set(id, fact);
  }

  const localGateValues = arrayAt(delta, ["gate_versions"]);
  for (const value of localGateValues) {
    if (!isRecord(value)) continue;
    const id = stableVersionId(value.gate_key, value.version);
    if (!id) continue;
    if (gates.has(id)) {
      issue(diagnostics, "DUPLICATE_VERSION", `duplicate gate version ${id}`, versionPath("gate", id), [id]);
      continue;
    }
    const fact: VersionFact<GateVersion> = {
      id,
      key: value.gate_key as string,
      version: value.version as number,
      value: value as unknown as GateVersion,
      source: "delta",
    };
    gates.set(id, fact);
    localGates.set(id, fact);
  }

  const nodes = new Map<string, NodeFact>();
  for (const fact of units.values()) nodes.set(`unit:${fact.id}`, { ...fact, kind: "unit" });
  for (const fact of gates.values()) nodes.set(`gate:${fact.id}`, { ...fact, kind: "gate" });
  return { tasks, units, gates, nodes, localUnits, localGates, lineageStates: lineageStatesFromContext(source) };
}


export function ownerPath(kind: FactKind, id: string): string {
  return versionPath(kind, id);
}

export function latestByKey<T extends UnitVersion | GateVersion>(facts: Map<string, VersionFact<T>>, key: string): VersionFact<T> | null {
  let best: VersionFact<T> | null = null;
  for (const fact of facts.values()) {
    if (fact.key !== key) continue;
    if (!best || fact.version > best.version || (fact.version === best.version && fact.id < best.id)) best = fact;
  }
  return best;
}

export function resolveVersion(
  ref: unknown,
  facts: Map<string, VersionFact<UnitVersion>> | Map<string, VersionFact<GateVersion>>,
): VersionFact<UnitVersion> | VersionFact<GateVersion> | null {
  if (typeof ref !== "string") return null;
  // A version-qualified reference is already an immutable identity.  Never
  // silently fall back to another version when that exact identity is absent.
  if (parseVersionRef(ref)) return facts.get(ref) || null;
  const exact = facts.get(ref);
  if (exact) return exact;
  if (facts.size === 0) return null;
  let best: VersionFact<UnitVersion> | VersionFact<GateVersion> | null = null;
  for (const fact of facts.values()) {
    if (fact.key !== ref) continue;
    if (!best || fact.version > best.version || (fact.version === best.version && fact.id < best.id)) best = fact;
  }
  return best;
}

export function resolveExactVersion(
  ref: unknown,
  facts: Map<string, VersionFact<UnitVersion>> | Map<string, VersionFact<GateVersion>>,
): VersionFact<UnitVersion> | VersionFact<GateVersion> | null {
  const parsed = parseVersionRef(ref);
  return parsed ? facts.get(parsed.id) || null : null;
}

export function lineageState(index: FactIndex, kind: FactKind, id: string, key: string): LineageState | null {
  return index.lineageStates.get(`${kind}:${id}`)
    || index.lineageStates.get(`${kind}:${key}`)
    || null;
}

export function supersessionReplaceable(state: LineageState | null): boolean {
  // Missing state is the historical/undispatched default.  A stale version is
  // likewise replaceable because it has not been dispatched; all materialized
  // and terminal states remain immutable unless explicitly failed.
  return state === null || state === "undispatched" || state === "failed";
}

export function resolveDependency(
  ref: unknown,
  preferred: FactKind,
  index: FactIndex,
): NodeFact | null {
  if (typeof ref !== "string") return null;
  const preferredFacts = preferred === "unit" ? index.units : index.gates;
  const otherFacts = preferred === "unit" ? index.gates : index.units;
  const preferredMatch = resolveVersion(ref, preferredFacts);
  if (preferredMatch) {
    return index.nodes.get(`${preferred}:${preferredMatch.id}`) || null;
  }
  const otherKind: FactKind = preferred === "unit" ? "gate" : "unit";
  const otherMatch = resolveVersion(ref, otherFacts);
  return otherMatch ? index.nodes.get(`${otherKind}:${otherMatch.id}`) || null : null;
}
