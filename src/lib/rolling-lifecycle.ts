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

function record(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function issue(
  diagnostics: RollingDiagnostic[],
  code: string,
  message: string,
  path?: string,
  refs: readonly string[] = [],
): void {
  diagnostics.push({ code, message, ...(path ? { path } : {}), ...(refs.length ? { refs: [...refs] } : {}) });
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function arrayValue(value: unknown, keys: readonly string[]): unknown[] {
  if (!record(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate instanceof Map) return [...candidate.values()];
    if (record(candidate)) {
      if (Array.isArray(candidate.entries)) return candidate.entries;
      const values = Object.values(candidate);
      if (values.length && values.every(record)) return values;
    }
  }
  return [];
}

function allArrayValues(value: unknown, keys: readonly string[]): unknown[] {
  if (!record(value)) return [];
  const result: unknown[] = [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) result.push(...candidate);
    else if (candidate instanceof Map) result.push(...candidate.values());
    else if (record(candidate)) {
      if (Array.isArray(candidate.entries)) result.push(...candidate.entries);
      else {
        const values = Object.values(candidate);
        if (values.length && values.every(record)) result.push(...values);
      }
    }
  }
  return result;
}

function contextOf(value: RollingLifecycleContext | unknown): AnyRecord {
  if (!record(value)) return {};
  const nested = record(value.fixed_facts)
    ? value.fixed_facts
    : record(value.fixed)
      ? value.fixed
      : record(value.checkpoint)
        ? value.checkpoint
        : {};
  return { ...nested, ...value };
}

function contextFacts(source: AnyRecord): unknown[] {
  return [
    ...allArrayValues(source, ["facts", "rolling_facts", "rollingFacts", "execution_facts", "executionFacts"]),
  ];
}

function contextDeltas(source: AnyRecord): PlanDelta[] {
  const direct = allArrayValues(source, ["accepted_deltas", "deltas"]);
  const fromFacts = contextFacts(source)
    .filter((item) => record(item) && (item.kind === "delta" || item.fact_kind === "delta"))
    .map((item) => {
      const fact = item as AnyRecord;
      return record(fact.payload) ? fact.payload : fact;
    })
    .filter(record);
  const result: PlanDelta[] = [];
  for (const item of [...direct, ...fromFacts]) if (record(item)) result.push(item as unknown as PlanDelta);
  return result;
}

function contextManifest(source: AnyRecord, deltas: readonly PlanDelta[]): Map<string, TaskManifestEntry> {
  const entries = [
    ...allArrayValues(source, ["manifest_entries", "task_manifest", "task_entries", "known_tasks", "manifest", "entries"]),
    ...deltas.flatMap((delta) => [
      ...(Array.isArray(delta.manifest_additions) ? delta.manifest_additions : []),
      ...(Array.isArray(delta.manifest_refreshes) ? delta.manifest_refreshes : []),
    ]),
  ];
  const result = new Map<string, TaskManifestEntry>();
  for (const value of entries) if (record(value) && text(value.task_key)) result.set(value.task_key, value as unknown as TaskManifestEntry);
  return result;
}

function contextVersions(source: AnyRecord, deltas: readonly PlanDelta[]): { units: Map<string, UnitVersion>; gates: Map<string, GateVersion> } {
  const units = new Map<string, UnitVersion>();
  const gates = new Map<string, GateVersion>();
  const addUnit = (value: unknown): void => {
    if (!record(value) || !text(value.unit_key) || !integer(value.version) || value.version < 1) return;
    units.set(`${value.unit_key}@${value.version}`, value as unknown as UnitVersion);
  };
  const addGate = (value: unknown): void => {
    if (!record(value) || !text(value.gate_key) || !integer(value.version) || value.version < 1) return;
    gates.set(`${value.gate_key}@${value.version}`, value as unknown as GateVersion);
  };
  for (const value of allArrayValues(source, ["unit_versions", "known_units", "units", "unitVersions"])) addUnit(value);
  for (const value of allArrayValues(source, ["gate_versions", "known_gates", "gates", "gateVersions"])) addGate(value);
  for (const delta of deltas) {
    for (const value of Array.isArray(delta.unit_versions) ? delta.unit_versions : []) addUnit(value);
    for (const value of Array.isArray(delta.gate_versions) ? delta.gate_versions : []) addGate(value);
  }
  return { units, gates };
}

function contextSeals(source: AnyRecord, deltas: readonly PlanDelta[]): TaskSeal[] {
  const result: TaskSeal[] = [];
  for (const value of allArrayValues(source, ["seals"])) if (record(value) && text(value.task_key)) result.push(value as unknown as TaskSeal);
  if (record(source.seal) && text(source.seal.task_key)) result.push(source.seal as unknown as TaskSeal);
  for (const delta of deltas) for (const value of Array.isArray(delta.seals) ? delta.seals : []) if (record(value) && text(value.task_key)) result.push(value as unknown as TaskSeal);
  for (const value of contextFacts(source)) {
    if (!record(value) || (value.kind !== "seal" && value.fact_kind !== "seal")) continue;
    const payload = record(value.payload) ? value.payload : value;
    if (text(payload.task_key)) result.push(payload as unknown as TaskSeal);
  }
  return result;
}

function parseRef(value: unknown, fallbackKind?: FactKind): { kind: FactKind; key: string; version?: number; id: string } | null {
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

function normalizedState(value: unknown): RollingTaskLineageState | null {
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

function stateRank(state: RollingTaskLineageState): number {
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

function setState(states: Map<string, RollingTaskLineageState>, identity: ReturnType<typeof parseRef>, state: RollingTaskLineageState | null): void {
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

function collectStatusEntry(states: Map<string, RollingTaskLineageState>, value: unknown, fallbackKind?: FactKind, fallbackKey?: string): void {
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

function collectStatusContainer(states: Map<string, RollingTaskLineageState>, value: unknown, fallbackKind?: FactKind): void {
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

function collectFactStatuses(states: Map<string, RollingTaskLineageState>, fact: unknown): void {
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

function lineageStates(source: AnyRecord, deltas: readonly PlanDelta[]): Map<string, RollingTaskLineageState> {
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

function supersededVersions(deltas: readonly PlanDelta[]): { units: Set<string>; gates: Set<string> } {
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

function supersededVersionsFromContext(source: AnyRecord, deltas: readonly PlanDelta[]): { units: Set<string>; gates: Set<string> } {
  const result = supersededVersions(deltas);
  for (const item of allArrayValues(source, ["supersessions"])) {
    if (!record(item)) continue;
    const kind = item.owner === "unit_version" ? "unit" : item.owner === "gate_version" ? "gate" : null;
    const ref = kind ? parseRef(item.previous, kind) : null;
    if (ref?.version !== undefined) (kind === "unit" ? result.units : result.gates).add(ref.id);
  }
  return result;
}

function coverageByTask(deltas: readonly PlanDelta[]): Map<string, TaskCoverage[]> {
  const result = new Map<string, TaskCoverage[]>();
  for (const delta of deltas) for (const item of Array.isArray(delta.task_coverage) ? delta.task_coverage : []) {
    if (!record(item) || !text(item.task_key)) continue;
    const value = item as unknown as TaskCoverage;
    const current = result.get(value.task_key) || [];
    const signature = JSON.stringify(value);
    if (!current.some((entry) => JSON.stringify(entry) === signature)) current.push(clone(value));
    result.set(value.task_key, current);
  }
  return result;
}

function refsForCoverage(coverage: readonly TaskCoverage[], superseded: { units: Set<string>; gates: Set<string> }): { units: Set<string>; gates: Set<string>; noOp: boolean } {
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

function stateFor(states: Map<string, RollingTaskLineageState>, kind: FactKind, id: string): RollingTaskLineageState | undefined {
  return states.get(`${kind}:${id}`) || states.get(`${kind}:${id.split("@")[0]}`);
}

function reconciliationFor(source: AnyRecord, taskKey: string, seals: readonly TaskSeal[], entry: TaskManifestEntry | undefined): boolean {
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

function taskKeys(source: AnyRecord, manifest: Map<string, TaskManifestEntry>, coverage: Map<string, TaskCoverage[]>, seals: readonly TaskSeal[]): string[] {
  const keys = new Set<string>(manifest.keys());
  for (const key of coverage.keys()) keys.add(key);
  for (const seal of seals) if (text(seal.task_key)) keys.add(seal.task_key);
  for (const delta of contextDeltas(source)) {
    for (const unit of Array.isArray(delta.unit_versions) ? delta.unit_versions : []) for (const key of unit.task_keys || []) keys.add(key);
    for (const gate of Array.isArray(delta.gate_versions) ? delta.gate_versions : []) for (const key of gate.task_keys || []) keys.add(key);
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function taskLifecycle(taskKey: string, source: AnyRecord, manifest: Map<string, TaskManifestEntry>, versions: { units: Map<string, UnitVersion>; gates: Map<string, GateVersion> }, deltas: readonly PlanDelta[], seals: readonly TaskSeal[], states: Map<string, RollingTaskLineageState>): RollingTaskLifecycle {
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
    ...(seal ? { seal: clone(seal) } : {}),
  };
}

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


function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every((item) => expected.includes(item));
}

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
  const normalized = clone(seal);
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

