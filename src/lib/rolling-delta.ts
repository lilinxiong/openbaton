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

export const ROLLING_DELTA_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

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

type AnyRecord = Record<string, unknown>;
type FactKind = "unit" | "gate";
type SourceKind = "fixed" | "delta";

/**
 * Runtime lineage states are intentionally kept source-neutral here.  The
 * rolling kernel may receive them from a checkpoint, a ticket projection, or
 * a caller supplied status map.  Unknown strings are retained and treated as
 * immutable below; only the two explicitly replaceable states are mutable.
 */
type LineageState = string;

interface VersionFact<T> {
  id: string;
  key: string;
  version: number;
  value: T;
  source: SourceKind;
}

interface NodeFact {
  id: string;
  kind: FactKind;
  key: string;
  version: number;
  source: SourceKind;
  value: UnitVersion | GateVersion;
}

interface FactIndex {
  tasks: Map<string, TaskManifestEntry>;
  units: Map<string, VersionFact<UnitVersion>>;
  gates: Map<string, VersionFact<GateVersion>>;
  nodes: Map<string, NodeFact>;
  localUnits: Map<string, VersionFact<UnitVersion>>;
  localGates: Map<string, VersionFact<GateVersion>>;
  lineageStates: Map<string, LineageState>;
}

const VERSION_REF = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)@([1-9][0-9]*)$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATION_ORDER = new Map(ROLLING_DELTA_OPERATIONS.map((value, index) => [value, index]));

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function own(value: AnyRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function issue(
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

function sortDiagnostics(diagnostics: readonly RollingDiagnostic[]): RollingDiagnostic[] {
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

function stableVersionId(key: unknown, version: unknown): string | null {
  return text(key) && integer(version) && version > 0 ? `${key}@${version}` : null;
}

function versionPath(kind: FactKind, id: string): string {
  return kind === "unit" ? `delta.unit_versions[${id}]` : `delta.gate_versions[${id}]`;
}

function taskPath(taskKey: string): string {
  return `delta.task_coverage[${taskKey}]`;
}

function parseVersionRef(value: unknown): { key: string; version: number; id: string } | null {
  if (typeof value !== "string") return null;
  const match = value.match(VERSION_REF);
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { key: match[1]!, version, id: value };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function arrayAt(value: unknown, keys: readonly string[]): unknown[] {
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

function arraysAt(value: unknown, keys: readonly string[]): unknown[] {
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

function normalizedLineageState(value: unknown): LineageState | null {
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
  if (["errored", "timed-out", "failure", "failed"].includes(state)) return "failed";
  return state;
}

function statusIdentity(value: unknown, fallbackKind?: FactKind): { kind: FactKind; key: string; version?: number } | null {
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

function putLineageState(states: Map<string, LineageState>, identity: { kind: FactKind; key: string; version?: number } | null, state: unknown): void {
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

function collectLineageStatusEntry(states: Map<string, LineageState>, value: unknown, fallbackKind?: FactKind, fallbackKey?: string): void {
  const explicit = typeof value === "string" ? null : statusIdentity(value, fallbackKind);
  const identity = explicit || (fallbackKey && fallbackKind ? statusIdentity(fallbackKey, fallbackKind) : statusIdentity(value, fallbackKind));
  const state = normalizedLineageState(value);
  if (identity && state) putLineageState(states, identity, state);
}

function collectLineageStatusContainer(states: Map<string, LineageState>, value: unknown, fallbackKind?: FactKind): void {
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

function collectLineageFact(states: Map<string, LineageState>, value: unknown): void {
  if (!isRecord(value)) return;
  const payload = isRecord(value.payload) ? value.payload : value;
  const kindText = typeof value.kind === "string" ? value.kind.toLowerCase() : "";
  const fallbackKind: FactKind | undefined = kindText.includes("gate") ? "gate" : kindText.includes("unit") || kindText.includes("ticket") || kindText.includes("attempt") || kindText.includes("result") ? "unit" : undefined;
  const state = normalizedLineageState(payload) || normalizedLineageState(value)
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

function lineageStatesFromContext(source: AnyRecord): Map<string, LineageState> {
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

function contextSource(context: unknown): AnyRecord {
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

function appendDeltaFacts(source: AnyRecord, field: "manifest" | "unit" | "gate"): unknown[] {
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

function makeIndex(context: unknown, delta: PlanDelta, diagnostics: RollingDiagnostic[]): FactIndex {
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

function ownerPath(kind: FactKind, id: string): string {
  return versionPath(kind, id);
}

function latestByKey<T extends UnitVersion | GateVersion>(facts: Map<string, VersionFact<T>>, key: string): VersionFact<T> | null {
  let best: VersionFact<T> | null = null;
  for (const fact of facts.values()) {
    if (fact.key !== key) continue;
    if (!best || fact.version > best.version || (fact.version === best.version && fact.id < best.id)) best = fact;
  }
  return best;
}

function resolveVersion(
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

function resolveExactVersion(
  ref: unknown,
  facts: Map<string, VersionFact<UnitVersion>> | Map<string, VersionFact<GateVersion>>,
): VersionFact<UnitVersion> | VersionFact<GateVersion> | null {
  const parsed = parseVersionRef(ref);
  return parsed ? facts.get(parsed.id) || null : null;
}

function lineageState(index: FactIndex, kind: FactKind, id: string, key: string): LineageState | null {
  return index.lineageStates.get(`${kind}:${id}`)
    || index.lineageStates.get(`${kind}:${key}`)
    || null;
}

function supersessionReplaceable(state: LineageState | null): boolean {
  // Missing state is the historical/undispatched default.  A stale version is
  // likewise replaceable because it has not been dispatched; all materialized
  // and terminal states remain immutable unless explicitly failed.
  return state === null || state === "undispatched" || state === "failed";
}

function resolveDependency(
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

function normalizeScopePath(raw: string): string | null {
  const value = raw.trim().replaceAll("\\", "/");
  if (!value) return null;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return null;
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "." : normalized;
}

function scopeIsForbidden(value: string): boolean {
  const first = value.split("/")[0];
  return first === ".git" || value === ".git" || value.startsWith(".git/");
}

function normalizeWritePath(raw: unknown, operations: readonly SafetyOperation[]): { value?: string; error?: string } {
  if (typeof raw !== "string") return { error: "write path must be a string" };
  const value = raw.trim();
  if (operations.includes("rename") && value.includes("->")) {
    const pieces = value.split("->").map((piece) => piece.trim());
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return { error: "rename scope must contain one source and one target" };
    const source = normalizeScopePath(pieces[0]!);
    const target = normalizeScopePath(pieces[1]!);
    if (!source || !target) return { error: "rename scope contains an unsafe path" };
    if (scopeIsForbidden(source) || scopeIsForbidden(target)) return { error: ".git is not an allowed write path" };
    return { value: `${source} -> ${target}` };
  }
  const normalized = normalizeScopePath(value);
  if (!normalized) return { error: "write path must be a relative path within the workspace" };
  if (scopeIsForbidden(normalized)) return { error: ".git is not an allowed write path" };
  return { value: normalized };
}

function normalizeOperations(raw: unknown): { values: SafetyOperation[]; valid: boolean } {
  if (!Array.isArray(raw)) return { values: [], valid: false };
  const values: SafetyOperation[] = [];
  let valid = true;
  for (const item of raw) {
    if (typeof item !== "string" || !OPERATION_ORDER.has(item as SafetyOperation)) {
      valid = false;
      continue;
    }
    const operation = item as SafetyOperation;
    if (!values.includes(operation)) values.push(operation);
    else valid = false;
  }
  values.sort((left, right) => OPERATION_ORDER.get(left)! - OPERATION_ORDER.get(right)!);
  return { values, valid };
}

function checkFingerprintMap(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).length > 0
    && Object.values(value).every((item) => typeof item === "string" && HASH.test(item));
}

interface WorktreeRunContext {
  schema_version?: number;
  mode?: WorktreeExecutionMode;
  raw_mode?: unknown;
}

function worktreeRunContext(context: unknown): WorktreeRunContext {
  const source = contextSource(context);
  const identity = isRecord(source.identity) ? source.identity : {};
  const schema = source.rolling_run_schema_version ?? source.run_schema_version ?? source.schema_version;
  const rawMode = source.run_execution_mode ?? source.worktree_mode ?? identity.execution_mode;
  return {
    ...(integer(schema) ? { schema_version: schema } : {}),
    ...(rawMode === "isolated-worktree" || rawMode === "shared-worktree" ? { mode: rawMode } : {}),
    ...(rawMode !== undefined ? { raw_mode: rawMode } : {}),
  };
}

function effectiveWorktreeMode(unit: UnitVersion, run: WorktreeRunContext): WorktreeExecutionMode | undefined {
  if (unit.worktree_mode === "isolated-worktree" || unit.worktree_mode === "shared-worktree") return unit.worktree_mode;
  if (run.mode === "shared-worktree" || run.schema_version !== ROLLING_WORKTREE_STATE_SCHEMA_VERSION) return "shared-worktree";
  return undefined;
}

function checkWorktreeModeContract(
  fact: VersionFact<UnitVersion>,
  index: FactIndex,
  context: unknown,
  diagnostics: RollingDiagnostic[],
): void {
  const unit = fact.value;
  const pathName = ownerPath("unit", fact.id);
  const run = worktreeRunContext(context);
  const explicit = unit.worktree_mode;

  if (run.raw_mode !== undefined && !run.mode) {
    issue(diagnostics, "INVALID_WORKTREE_MODE", "rolling run has an unsupported worktree execution mode", `${pathName}.worktree_mode`, [fact.id, String(run.raw_mode)]);
    return;
  }
  if (unit.execution_mode === "verification-only") {
    if (explicit !== undefined) issue(diagnostics, "FORBIDDEN_FIELD", "verification-only units do not own a worktree mode", `${pathName}.worktree_mode`, [fact.id]);
    return;
  }
  if (explicit === "isolated-worktree" && run.schema_version !== ROLLING_WORKTREE_STATE_SCHEMA_VERSION) {
    issue(diagnostics, "ROLLING_V2_REQUIRED", "isolated worktree execution requires rolling-run v2 state", `${pathName}.worktree_mode`, [fact.id]);
  }
  if (run.schema_version === ROLLING_WORKTREE_STATE_SCHEMA_VERSION && !run.mode) {
    issue(diagnostics, "WORKTREE_MODE_REQUIRED", "rolling-run v2 state must persist an explicit worktree execution mode", `${pathName}.worktree_mode`, [fact.id]);
  }
  if (run.mode === "isolated-worktree" && explicit === undefined) {
    issue(diagnostics, "WORKTREE_MODE_REQUIRED", "isolated writing units must persist isolated-worktree mode before dispatch", `${pathName}.worktree_mode`, [fact.id]);
  }
  if (run.mode && explicit && run.mode !== explicit) {
    issue(diagnostics, "WORKTREE_MODE_IMMUTABLE", "unit worktree mode cannot differ from the active rolling run", `${pathName}.worktree_mode`, [fact.id, run.mode, explicit]);
  }

  const current = effectiveWorktreeMode(unit, run);
  const predecessors = [...index.units.values()]
    .filter((candidate) => candidate.id !== fact.id && candidate.key === fact.key && candidate.version < fact.version)
    .sort((left, right) => right.version - left.version || left.id.localeCompare(right.id));
  const previous = predecessors[0];
  if (previous) {
    const priorMode = effectiveWorktreeMode(previous.value, run);
    if (current && priorMode && current !== priorMode) {
      issue(diagnostics, "WORKTREE_MODE_IMMUTABLE", `unit ${fact.key} cannot change worktree mode across versions`, `${pathName}.worktree_mode`, [previous.id, fact.id]);
    }
  }
}

function checkRepositoryParts(
  fact: VersionFact<UnitVersion>,
  normalized: UnitVersion,
  index: FactIndex,
  diagnostics: RollingDiagnostic[],
): void {
  const unit = fact.value;
  if (!Array.isArray(unit.repository_parts)) return;
  const pathName = ownerPath("unit", fact.id);
  if (unit.execution_mode !== "patch-only") {
    issue(diagnostics, "FORBIDDEN_FIELD", "only writing units may declare repository-local parts", `${pathName}.repository_parts`, [fact.id]);
    return;
  }
  const operations = normalizeOperations(unit.allowed_operations).values;
  const unitPaths = new Set(Array.isArray(normalized.write_paths) ? normalized.write_paths : []);
  const claimed = new Set<string>();
  const parts = new Map<string, { order: number; value: AnyRecord }>();
  const normalizedParts: AnyRecord[] = [];
  for (const [partIndex, rawPart] of unit.repository_parts.entries()) {
    if (!isRecord(rawPart)) continue;
    const partPath = `${pathName}.repository_parts.${partIndex}`;
    if (text(rawPart.part_key) && integer(rawPart.integration_order)) parts.set(rawPart.part_key, { order: rawPart.integration_order, value: rawPart });
    const copy = clone(rawPart);
    const normalizedPaths: string[] = [];
    for (const rawPath of Array.isArray(rawPart.write_paths) ? rawPart.write_paths : []) {
      const result = normalizeWritePath(rawPath, operations);
      if (!result.value) {
        issue(diagnostics, result.error?.includes(".git") ? "FORBIDDEN_PATH" : "INVALID_SCOPE", result.error || "repository part path is invalid", `${partPath}.write_paths`, [fact.id, String(rawPath)]);
        continue;
      }
      normalizedPaths.push(result.value);
      if (!unitPaths.has(result.value)) issue(diagnostics, "REPOSITORY_PART_SCOPE_MISMATCH", `repository part path ${result.value} is outside the unit scope`, `${partPath}.write_paths`, [fact.id, result.value]);
      if (claimed.has(result.value)) issue(diagnostics, "DUPLICATE_REPOSITORY_PART_SCOPE", `write path ${result.value} is claimed by more than one repository part`, `${partPath}.write_paths`, [fact.id, result.value]);
      claimed.add(result.value);
    }
    copy.write_paths = normalizedPaths;
    normalizedParts.push(copy);
  }
  for (const unitPath of unitPaths) if (!claimed.has(unitPath)) {
    issue(diagnostics, "REPOSITORY_PART_SCOPE_MISMATCH", `unit write path ${unitPath} is not assigned to a repository-local part`, `${pathName}.repository_parts`, [fact.id, unitPath]);
  }
  for (const [partKey, part] of parts) {
    for (const dependency of Array.isArray(part.value.depends_on) ? part.value.depends_on : []) {
      const predecessor = parts.get(String(dependency));
      if (predecessor && predecessor.order >= part.order) {
        issue(diagnostics, "INVALID_INTEGRATION_ORDER", `repository part ${partKey} must follow dependency ${String(dependency)}`, `${pathName}.repository_parts`, [String(dependency), partKey]);
      }
    }
  }
  const integrationGates = new Set<string>([
    ...(Array.isArray(unit.integration_gate_keys) ? unit.integration_gate_keys : []),
    ...unit.repository_parts.flatMap((part) => isRecord(part) && Array.isArray(part.integration_gate_keys) ? part.integration_gate_keys.filter(text) : []),
  ]);
  for (const gateKey of integrationGates) {
    const gate = resolveVersion(gateKey, index.gates);
    if (!gate) issue(diagnostics, "UNKNOWN_DEPENDENCY", `unit ${fact.id} requires unknown integration gate ${gateKey}`, `${pathName}.integration_gate_keys`, [fact.id, gateKey]);
    else if ((gate.value as GateVersion).type !== "integration-acceptance") issue(diagnostics, "INVALID_INTEGRATION_GATE", `gate ${gate.id} is not an integration-acceptance gate`, `${pathName}.integration_gate_keys`, [fact.id, gate.id]);
  }
  normalized.repository_parts = normalizedParts as unknown as UnitVersion["repository_parts"];
}

function checkUnitContract(
  fact: VersionFact<UnitVersion>,
  normalized: UnitVersion,
  index: FactIndex,
  context: unknown,
  diagnostics: RollingDiagnostic[],
): void {
  const pathName = ownerPath("unit", fact.id);
  const unit = fact.value as unknown as AnyRecord;
  const mode = unit.execution_mode as UnitExecutionMode;
  if (!Array.isArray(unit.task_keys) || unit.task_keys.length === 0) {
    issue(diagnostics, "INCOMPLETE_EXECUTION_CONTRACT", "a unit must claim at least one task", `${pathName}.task_keys`, [fact.id]);
  }
  if (!["prompt", "recipe", "description"].some((key) => text(unit[key]))) {
    issue(diagnostics, "INCOMPLETE_EXECUTION_CONTRACT", "unit requires a non-empty prompt, recipe, or description", `${pathName}.prompt`, [fact.id]);
  }
  for (const key of ["completion_criteria", "permitted_validation"] as const) {
    if (!Array.isArray(unit[key]) || unit[key].length === 0 || !unit[key].every(text)) {
      issue(diagnostics, "INCOMPLETE_EXECUTION_CONTRACT", `${key} must be a non-empty string array`, `${pathName}.${key}`, [fact.id]);
    }
  }
  if (!checkFingerprintMap(unit.input_fingerprints)) {
    issue(diagnostics, "MISSING_BASELINE", "unit requires at least one relevant input fingerprint", `${pathName}.input_fingerprints`, [fact.id]);
  }

  const operationResult = normalizeOperations(unit.allowed_operations);
  if (mode === "patch-only") {
    if (!Array.isArray(unit.write_paths) || unit.write_paths.length === 0) {
      issue(diagnostics, "REQUIRED_SCOPE", "patch-only units require a non-empty write scope", `${pathName}.write_paths`, [fact.id]);
    }
    if (!Array.isArray(unit.allowed_operations) || unit.allowed_operations.length === 0) {
      issue(diagnostics, "REQUIRED_OPERATION", "patch-only units require at least one allowed operation", `${pathName}.allowed_operations`, [fact.id]);
    }
    if (!operationResult.valid) {
      issue(diagnostics, "INVALID_OPERATION", "allowed_operations contains an unsupported or duplicate operation", `${pathName}.allowed_operations`, [fact.id]);
    }
    if (Array.isArray(unit.write_paths)) {
      const normalizedPaths: string[] = [];
      for (const raw of unit.write_paths) {
        const scope = normalizeWritePath(raw, operationResult.values);
        if (!scope.value) {
          issue(diagnostics, scope.error?.includes(".git") ? "FORBIDDEN_PATH" : "INVALID_SCOPE", scope.error || "write path is invalid", `${pathName}.write_paths`, [fact.id, String(raw)]);
          continue;
        }
        if (normalizedPaths.includes(scope.value)) {
          issue(diagnostics, "DUPLICATE_SCOPE", `duplicate normalized write path ${scope.value}`, `${pathName}.write_paths`, [fact.id, scope.value]);
        } else normalizedPaths.push(scope.value);
      }
      normalized.write_paths = normalizedPaths;
    }
    normalized.allowed_operations = operationResult.values;
  } else if (mode === "verification-only") {
    if (own(unit, "write_paths") || own(unit, "allowed_operations")) {
      issue(diagnostics, "FORBIDDEN_FIELD", "verification-only units cannot declare write scope or operations", pathName, [fact.id]);
    }
    // Keep verification contracts canonical and explicit.  These properties
    // are absent from a valid verification-only unit rather than empty arrays.
    delete (normalized as unknown as AnyRecord).write_paths;
    delete (normalized as unknown as AnyRecord).allowed_operations;
  }
  checkWorktreeModeContract(fact, index, context, diagnostics);
  checkRepositoryParts(fact, normalized, index, diagnostics);
}

function checkGateContract(
  fact: VersionFact<GateVersion>,
  diagnostics: RollingDiagnostic[],
): void {
  const gate = fact.value as unknown as AnyRecord;
  const pathName = ownerPath("gate", fact.id);
  if (!ROLLING_DELTA_GATE_TYPES.includes(gate.type as GateType)) {
    issue(diagnostics, "UNKNOWN_GATE_TYPE", "gate type is unsupported", `${pathName}.type`, [fact.id]);
  }
  if (!Array.isArray(gate.task_keys) || gate.task_keys.length === 0) {
    issue(diagnostics, "INCOMPLETE_GATE_CONTRACT", "a gate must claim at least one task", `${pathName}.task_keys`, [fact.id]);
  }
  if (gate.acceptance_contract === undefined || gate.acceptance_contract === null) {
    issue(diagnostics, "INCOMPLETE_GATE_CONTRACT", "gate requires an acceptance contract", `${pathName}.acceptance_contract`, [fact.id]);
  }
}

function stableStructuralPath(input: unknown, diagnostic: RollingDiagnostic): RollingDiagnostic {
  const pathName = diagnostic.path;
  if (!pathName || !isRecord(input)) return diagnostic;
  const delta = input;
  const match = pathName.match(/^delta\.(unit_versions|gate_versions|task_coverage|manifest_additions|manifest_refreshes|supersessions|seals)\.(\d+)(?:\.(.*))?$/);
  if (!match) return diagnostic;
  const list = Array.isArray(delta[match[1]!]) ? delta[match[1]!] as unknown[] : [];
  const item = list[Number(match[2])];
  let stable: string | null = null;
  if (match[1] === "unit_versions" && isRecord(item)) stable = stableVersionId(item.unit_key, item.version);
  if (match[1] === "gate_versions" && isRecord(item)) stable = stableVersionId(item.gate_key, item.version);
  if ((match[1] === "task_coverage" || match[1] === "manifest_additions" || match[1] === "manifest_refreshes" || match[1] === "seals") && isRecord(item) && text(item.task_key)) stable = item.task_key;
  if (match[1] === "supersessions" && isRecord(item) && text(item.owner) && text(item.previous) && text(item.successor)) stable = `${item.owner}:${item.previous}->${item.successor}`;
  if (!stable) return diagnostic;
  return { ...diagnostic, path: `delta.${match[1]}[${stable}]${match[3] ? `.${match[3]}` : ""}` };
}

function addStructuralDiagnostics(input: unknown, diagnostics: RollingDiagnostic[]): boolean {
  const result = validatePlanDeltaShape(input);
  for (const diagnostic of result.diagnostics) diagnostics.push(stableStructuralPath(input, diagnostic));
  return result.valid;
}

function checkTaskRefs(
  fact: NodeFact,
  index: FactIndex,
  diagnostics: RollingDiagnostic[],
): void {
  const values = Array.isArray(fact.value.task_keys) ? fact.value.task_keys : [];
  const pathName = `${ownerPath(fact.kind, fact.id)}.task_keys`;
  for (const taskKey of values) {
    if (!index.tasks.has(taskKey)) {
      issue(diagnostics, "UNKNOWN_TASK_REFERENCE", `unknown task ${taskKey}`, pathName, [fact.id, taskKey]);
    }
  }
}

function checkDependencies(
  fact: NodeFact,
  index: FactIndex,
  edges: Map<string, Set<string>>,
  diagnostics: RollingDiagnostic[],
): void {
  const pathName = `${ownerPath(fact.kind, fact.id)}.depends_on`;
  const dependencies = Array.isArray(fact.value.depends_on) ? fact.value.depends_on : [];
  const from = `${fact.kind}:${fact.id}`;
  if (!edges.has(from)) edges.set(from, new Set());
  for (const dependency of dependencies) {
    const target = resolveDependency(dependency, fact.kind, index);
    if (!target) {
      issue(diagnostics, "UNKNOWN_DEPENDENCY", `${fact.kind} ${fact.id} depends on unknown unit or gate ${String(dependency)}`, pathName, [fact.id, String(dependency)]);
      continue;
    }
    edges.get(from)!.add(`${target.kind}:${target.id}`);
  }
  if (fact.kind === "unit") {
    const unit = fact.value as UnitVersion;
    const requiredGates = new Set([
      ...(Array.isArray(unit.required_gate_keys) ? unit.required_gate_keys : []),
      ...(Array.isArray(unit.integration_gate_keys) ? unit.integration_gate_keys : []),
      ...(Array.isArray(unit.repository_parts)
        ? unit.repository_parts.flatMap((part) => Array.isArray(part.integration_gate_keys) ? part.integration_gate_keys : [])
        : []),
    ]);
    if (requiredGates.size > 0) {
      for (const gateKey of requiredGates) {
        const target = resolveVersion(gateKey, index.gates);
        if (!target) {
          issue(diagnostics, "UNKNOWN_DEPENDENCY", `unit ${fact.id} requires unknown gate ${gateKey}`, `${ownerPath(fact.kind, fact.id)}.required_gate_keys`, [fact.id, gateKey]);
        } else edges.get(from)!.add(`gate:${target.id}`);
      }
    }
  }
}

/** Add edges for an accepted fact without attributing malformed fixed state
 * to the proposed delta.  Fixed facts are expected to have passed this
 * validator already, but their edges are still needed to detect a cycle that
 * enters a fixed node and returns through a local node. */
function addKnownDependencies(
  fact: NodeFact,
  index: FactIndex,
  edges: Map<string, Set<string>>,
): void {
  const from = `${fact.kind}:${fact.id}`;
  if (!edges.has(from)) edges.set(from, new Set());
  const dependencies = Array.isArray(fact.value.depends_on) ? fact.value.depends_on : [];
  for (const dependency of dependencies) {
    const target = resolveDependency(dependency, fact.kind, index);
    if (target) edges.get(from)!.add(`${target.kind}:${target.id}`);
  }
  if (fact.kind !== "unit") return;
  const unit = fact.value as UnitVersion;
  const requiredGates = [
    ...(Array.isArray(unit.required_gate_keys) ? unit.required_gate_keys : []),
    ...(Array.isArray(unit.integration_gate_keys) ? unit.integration_gate_keys : []),
    ...(Array.isArray(unit.repository_parts)
      ? unit.repository_parts.flatMap((part) => Array.isArray(part.integration_gate_keys) ? part.integration_gate_keys : [])
      : []),
  ];
  for (const gateKey of requiredGates) {
    const target = resolveVersion(gateKey, index.gates);
    if (target) edges.get(from)!.add(`gate:${target.id}`);
  }
}

function checkAcyclic(
  index: FactIndex,
  edges: Map<string, Set<string>>,
  diagnostics: RollingDiagnostic[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const local = new Set<string>([
    ...[...index.localUnits.keys()].map((id) => `unit:${id}`),
    ...[...index.localGates.keys()].map((id) => `gate:${id}`),
  ]);

  const visit = (node: string): void => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = (start >= 0 ? stack.slice(start) : [node]).concat(node);
      const cycleSet = [...new Set(cycle)].sort();
      if (!cycleSet.some((item) => local.has(item))) return;
      const signature = cycleSet.join("|");
      if (reported.has(signature)) return;
      reported.add(signature);
      const firstLocal = cycleSet.find((item) => local.has(item))!;
      const separator = firstLocal.indexOf(":");
      const kind = firstLocal.slice(0, separator) as FactKind;
      const id = firstLocal.slice(separator + 1);
      issue(diagnostics, "DEPENDENCY_CYCLE", `dependency cycle: ${cycleSet.join(" -> ")}`, `${ownerPath(kind, id)}.depends_on`, cycleSet);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const target of [...(edges.get(node) || [])].sort()) {
      if (index.nodes.has(target)) visit(target);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of [...index.nodes.keys()].sort()) visit(node);
}

function coverageRefs(coverage: TaskCoverage): { units: string[]; gates: string[] } {
  return {
    units: Array.isArray(coverage.unit_versions) ? coverage.unit_versions : [],
    gates: Array.isArray(coverage.gate_versions) ? coverage.gate_versions : [],
  };
}

function checkCoverage(delta: PlanDelta, index: FactIndex, diagnostics: RollingDiagnostic[]): void {
  const coverage = Array.isArray(delta.task_coverage) ? delta.task_coverage : [];
  const covered = new Set<string>();
  const coveredUnits = new Set<string>();
  const coveredGates = new Set<string>();
  for (const item of coverage) {
    if (!isRecord(item) || !text(item.task_key)) continue;
    const value = item as unknown as TaskCoverage;
    const pathName = taskPath(value.task_key);
    covered.add(value.task_key);
    if (!index.tasks.has(value.task_key)) {
      issue(diagnostics, "UNKNOWN_TASK_REFERENCE", `coverage references unknown task ${value.task_key}`, pathName, [value.task_key]);
    }
    const refs = coverageRefs(value);
    if (value.kind === "unit" && refs.units.length === 0) issue(diagnostics, "INCOMPLETE_COVERAGE", "unit coverage requires at least one unit version", `${pathName}.unit_versions`, [value.task_key]);
    if (value.kind === "gate" && refs.gates.length === 0) issue(diagnostics, "INCOMPLETE_COVERAGE", "gate coverage requires at least one gate version", `${pathName}.gate_versions`, [value.task_key]);
    if (value.kind === "no-op" && (refs.units.length > 0 || refs.gates.length > 0)) issue(diagnostics, "INVALID_COVERAGE", "no-op coverage cannot reference unit or gate versions", pathName, [value.task_key]);

    for (const ref of refs.units) {
      const fact = resolveVersion(ref, index.units);
      if (!fact || !parseVersionRef(ref)) {
        issue(diagnostics, "UNKNOWN_COVERAGE_REFERENCE", `coverage references unknown unit version ${ref}`, `${pathName}.unit_versions`, [value.task_key, ref]);
      } else if (!Array.isArray(fact.value.task_keys) || !fact.value.task_keys.includes(value.task_key)) {
        issue(diagnostics, "COVERAGE_TASK_MISMATCH", `unit version ${ref} does not claim task ${value.task_key}`, `${pathName}.unit_versions`, [value.task_key, ref]);
      } else coveredUnits.add(fact.id);
    }
    for (const ref of refs.gates) {
      const fact = resolveVersion(ref, index.gates);
      if (!fact || !parseVersionRef(ref)) {
        issue(diagnostics, "UNKNOWN_COVERAGE_REFERENCE", `coverage references unknown gate version ${ref}`, `${pathName}.gate_versions`, [value.task_key, ref]);
      } else if (!Array.isArray(fact.value.task_keys) || !fact.value.task_keys.includes(value.task_key)) {
        issue(diagnostics, "COVERAGE_TASK_MISMATCH", `gate version ${ref} does not claim task ${value.task_key}`, `${pathName}.gate_versions`, [value.task_key, ref]);
      } else coveredGates.add(fact.id);
    }
  }

  // Only tasks claimed by a newly introduced unit or gate need coverage in
  // this delta.  Fixed manifest entries and manifest-only additions remain
  // open-world and intentionally do not trigger a whole-manifest requirement.
  const claimedByLocal = new Set<string>();
  for (const fact of [...index.localUnits.values(), ...index.localGates.values()]) {
    for (const taskKey of fact.value.task_keys) claimedByLocal.add(taskKey);
  }
  for (const taskKey of [...claimedByLocal].sort()) {
    if (!covered.has(taskKey)) issue(diagnostics, "MISSING_COVERAGE", `delta claims task ${taskKey} without task coverage`, taskPath(taskKey), [taskKey]);
  }
  for (const fact of [...index.localUnits.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!coveredUnits.has(fact.id)) issue(diagnostics, "MISSING_COVERAGE", `unit version ${fact.id} is not present in task coverage`, `${ownerPath("unit", fact.id)}.task_keys`, [fact.id]);
  }
  for (const fact of [...index.localGates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!coveredGates.has(fact.id)) issue(diagnostics, "MISSING_COVERAGE", `gate version ${fact.id} is not present in task coverage`, `${ownerPath("gate", fact.id)}.task_keys`, [fact.id]);
  }
}

function checkSupersessions(delta: PlanDelta, index: FactIndex, diagnostics: RollingDiagnostic[]): void {
  const supersessions = Array.isArray(delta.supersessions) ? delta.supersessions : [];
  const seenPrevious = new Set<string>();
  for (const value of supersessions) {
    if (!isRecord(value) || !text(value.owner) || !text(value.previous) || !text(value.successor)) continue;
    const owner = value.owner as string;
    const expectedKind: FactKind | null = owner === "unit_version" ? "unit" : owner === "gate_version" ? "gate" : null;
    const pathName = `delta.supersessions[${owner}:${value.previous}->${value.successor}]`;
    if (!expectedKind) continue;
    const facts = expectedKind === "unit" ? index.units : index.gates;
    // Supersession is a lineage operation, so both sides must identify an
    // exact immutable version.  Dependencies and coverage intentionally allow
    // key-only shorthand, but silently resolving `unit@9` to the latest known
    // version would let a caller replace the wrong owner.
    const previous = resolveExactVersion(value.previous, facts);
    const successor = resolveExactVersion(value.successor, facts);
    if (!previous || !parseVersionRef(value.previous)) issue(diagnostics, "UNKNOWN_SUPERSESSION_REFERENCE", `supersession references unknown previous ${value.previous}`, `${pathName}.previous`, [String(value.previous)]);
    if (!successor || !parseVersionRef(value.successor)) issue(diagnostics, "UNKNOWN_SUPERSESSION_REFERENCE", `supersession references unknown successor ${value.successor}`, `${pathName}.successor`, [String(value.successor)]);
    if (!successor || successor.source !== "delta") issue(diagnostics, "SUPERSESSION_SUCCESSOR_NOT_LOCAL", "a supersession successor must be introduced by this delta", `${pathName}.successor`, [String(value.successor)]);
    if (previous && successor) {
      if (previous.key !== successor.key || successor.version <= previous.version) {
        issue(diagnostics, "INVALID_SUPERSESSION", "supersession successor must be a higher version of the same key", pathName, [previous.id, successor.id]);
      }
      const state = lineageState(index, expectedKind, previous.id, previous.key);
      if (!supersessionReplaceable(state)) {
        issue(diagnostics, "SUPERSESSION_FORBIDDEN", `cannot supersede ${previous.id}: lineage is ${state}`, `${pathName}.previous`, [previous.id, state]);
      }
    }
    if (seenPrevious.has(`${expectedKind}:${value.previous}`)) issue(diagnostics, "DUPLICATE_SUPERSESSION", `version ${value.previous} is superseded more than once`, `${pathName}.previous`, [String(value.previous)]);
    seenPrevious.add(`${expectedKind}:${value.previous}`);
  }
}

function normalizeDelta(delta: PlanDelta, index: FactIndex): PlanDelta {
  const output = clone(delta);
  const units = Array.isArray(output.unit_versions) ? output.unit_versions : [];
  for (const unit of units) {
    if (!isRecord(unit)) continue;
    const id = stableVersionId(unit.unit_key, unit.version);
    if (!id) continue;
    const fact = index.localUnits.get(id);
    if (!fact) continue;
    const operations = normalizeOperations(unit.allowed_operations).values;
    if (Array.isArray(unit.write_paths)) {
      const paths = unit.write_paths.map((item) => normalizeWritePath(item, operations).value).filter((item): item is string => Boolean(item));
      unit.write_paths = paths;
    }
    if (Array.isArray(unit.allowed_operations)) unit.allowed_operations = operations;
  }
  return output;
}

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
  const normalized = clone(delta);
  const normalizedUnits = new Map<string, UnitVersion>();
  for (const value of Array.isArray(normalized.unit_versions) ? normalized.unit_versions : []) {
    const id = stableVersionId(value.unit_key, value.version);
    if (id) normalizedUnits.set(id, value);
  }

  for (const fact of [...index.localUnits.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const node = index.nodes.get(`unit:${fact.id}`);
    if (!node) continue;
    checkTaskRefs(node, index, diagnostics);
    checkUnitContract(fact, normalizedUnits.get(fact.id) || clone(fact.value), index, context, diagnostics);
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
export const validateRollingPlanDelta = validatePlanDeltaAgainstFacts;
export const validateDeltaAgainstFacts = validatePlanDeltaAgainstFacts;
export const validateRollingDelta = validatePlanDeltaAgainstFacts;
export const validatePlanDelta = validatePlanDeltaAgainstFacts;
export const validatePlanDeltaSemantics = validatePlanDeltaAgainstFacts;
export const validateSemanticPlanDelta = validatePlanDeltaAgainstFacts;
export const validatePlanDeltaWithFacts = validatePlanDeltaAgainstFacts;

export function assertPlanDeltaAgainstFacts(input: unknown, context: PlanDeltaValidationContext = {}): PlanDelta {
  const result = validatePlanDeltaAgainstFacts(input, context);
  if (!result.valid) throw new RollingDeltaValidationError(result.diagnostics);
  return result.value as PlanDelta;
}

export const assertRollingPlanDelta = assertPlanDeltaAgainstFacts;
export const assertDeltaAgainstFacts = assertPlanDeltaAgainstFacts;
export const assertRollingDelta = assertPlanDeltaAgainstFacts;
export const assertPlanDelta = assertPlanDeltaAgainstFacts;
export const assertPlanDeltaSemantics = assertPlanDeltaAgainstFacts;
export const assertSemanticPlanDelta = assertPlanDeltaAgainstFacts;
export const assertPlanDeltaWithFacts = assertPlanDeltaAgainstFacts;
