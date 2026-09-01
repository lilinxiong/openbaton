/** Version-local execution facts and acceptance projections for rolling runs. */
import crypto from "node:crypto";
import {
  canonicalizeRolling,
  fingerprintGateVersion,
  fingerprintUnitVersion,
  type GateType,
  type GateVersion,
  type UnitVersion,
} from "./rolling-plan.js";

export const ROLLING_ACCEPTANCE_SCHEMA_VERSION = 1 as const;

type OwnerType = "unit_version" | "attempt" | "gate_version";
type FactKind = "reservation" | "native-attempt" | "terminal-result" | "safety-verdict" | "parent-acceptance" | "retry" | "release" | "gate-acceptance" | "plan-insufficient";
type UnitState = "queued" | "reserved" | "running" | "terminal-unreleased" | "failed" | "accepted" | "released";
type GateState = "pending" | "ready" | "failed" | "accepted";
type Hash = string;

interface FactBase {
  schema_version: typeof ROLLING_ACCEPTANCE_SCHEMA_VERSION;
  fact_id: string;
  kind: FactKind;
  owner_type: OwnerType;
  owner_key: string;
  recorded_at: string;
  fingerprint: Hash;
}
interface UnitFactBase extends FactBase {
  owner_type: "unit_version" | "attempt";
  unit_key: string;
  unit_version: number;
  unit_fingerprint: Hash;
  attempt?: number;
}
interface GateFactBase extends FactBase {
  owner_type: "gate_version";
  gate_key: string;
  gate_version: number;
  gate_fingerprint: Hash;
}
interface ReservationFact extends UnitFactBase { kind: "reservation"; reservation_id: string; state: "queued" | "reserved" | "released" | "cancelled"; }
interface NativeAttemptFact extends UnitFactBase { kind: "native-attempt"; state: "queued" | "reserved" | "running" | "completed" | "failed" | "cancelled"; }
interface TerminalResultFact extends UnitFactBase { kind: "terminal-result"; status: "completed" | "succeeded" | "failed" | "errored" | "timed-out" | "cancelled"; result?: unknown; result_id?: string; result_fingerprint?: Hash; }
interface SafetyVerdictFact extends UnitFactBase { kind: "safety-verdict"; accepted: boolean; violations?: readonly unknown[]; }
interface ParentAcceptanceFact extends UnitFactBase { kind: "parent-acceptance"; accepted: boolean; evidence?: string; }
interface RetryFact extends UnitFactBase { kind: "retry"; retry_kind: "route" | "native"; retry_of: string; reason?: string; }
interface ReleaseFact extends UnitFactBase { kind: "release"; released: boolean; released_at?: string; }
interface GateAcceptanceFact extends GateFactBase { kind: "gate-acceptance"; accepted: boolean; evidence?: string; result_tree?: Hash; }
interface PlanInsufficientFact extends UnitFactBase { kind: "plan-insufficient"; file: string; symbol: string; missing_decision: string; }

/** Canonical, discriminated facts accepted by the rolling evaluator. */
export type RollingExecutionFact = ReservationFact | NativeAttemptFact | TerminalResultFact | SafetyVerdictFact | ParentAcceptanceFact | RetryFact | ReleaseFact | GateAcceptanceFact | PlanInsufficientFact;

export interface RollingExecutionContext {
  units?: readonly UnitVersion[] | Readonly<Record<string, UnitVersion>>;
  gates?: readonly GateVersion[] | Readonly<Record<string, GateVersion>>;
  facts?: readonly unknown[];
}
interface Blocker { code: string; message: string; owner_type: OwnerType; owner_key: string; refs?: string[]; }

export interface RollingUnitVersionState {
  unit_key: string; version: number; unit_ref: string; unit_fingerprint: Hash; state: UnitState;
  queued: boolean; reserved: boolean; running: boolean; terminal_unreleased: boolean; failed: boolean; accepted: boolean; released: boolean;
  requires_successor_version: boolean; attempts: string[]; blockers: Blocker[]; fact_ids: string[];
}
export interface RollingGateVersionState {
  gate_key: string; version: number; gate_ref: string; gate_fingerprint: Hash; type: GateType; state: GateState;
  pending: boolean; ready: boolean; failed: boolean; accepted: boolean; depends_on: string[];
  dependency_states: Record<string, string>; blockers: Blocker[]; acceptance_fact_ids: string[];
}

export class RollingAcceptanceError extends Error {
  readonly code = "ROLLING_ACCEPTANCE_INVALID";
  readonly diagnostics: readonly string[];
  constructor(message: string, diagnostics: readonly string[] = []) { super(message); this.name = "RollingAcceptanceError"; this.diagnostics = diagnostics; }
}

const HASH_RE = /^[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;
const REF_RE = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)@([1-9][0-9]*)$/u;
const TERMINAL_SUCCESS = new Set(["completed", "succeeded"]);
const GATE_TYPES = new Set<GateType>(["safety-precondition", "integration-acceptance", "evidence"]);
const KINDS: readonly FactKind[] = ["reservation", "native-attempt", "terminal-result", "safety-verdict", "parent-acceptance", "retry", "release", "gate-acceptance", "plan-insufficient"];

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function hash(value: unknown): string { return crypto.createHash("sha256").update(canonicalizeRolling(value)).digest("hex"); }
function ref(key: string, version: number): string { return `${key}@${version}`; }
function parseRef(value: string): { key: string; version: number } | undefined { const match = value.match(REF_RE); return match ? { key: match[1]!, version: Number(match[2]) } : undefined; }
function fail(message: string, diagnostics: readonly string[] = []): never { throw new RollingAcceptanceError(message, diagnostics); }
function required(value: Record<string, unknown>, key: string): void { if (!text(value[key])) fail(`${key} is required`); }
function allowed(value: Record<string, unknown>, fields: readonly string[]): void {
  const set = new Set(fields); const unknown = Object.keys(value).filter((key) => !set.has(key));
  if (unknown.length) fail(`unknown field ${unknown[0]}`, unknown.map((key) => `UNKNOWN_FIELD:${key}`));
}
function commonFields(kind: FactKind): string[] {
  return ["schema_version", "fact_id", "kind", "owner_type", "owner_key", "recorded_at", "fingerprint", ...(kind === "gate-acceptance" ? ["gate_key", "gate_version", "gate_fingerprint"] : ["unit_key", "unit_version", "unit_fingerprint", "attempt"])];
}

/** Normalize and validate one canonical execution fact without mutating it. */
export function normalizeRollingExecutionFact(value: unknown): RollingExecutionFact {
  if (!record(value)) fail("execution fact must be an object");
  const source = structuredClone(value) as Record<string, unknown>; const kind = source.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) fail("unsupported fact kind");
  const kindFields = kind === "reservation" ? ["reservation_id", "state"] : kind === "native-attempt" ? ["state"] : kind === "terminal-result" ? ["status", "result", "result_id", "result_fingerprint"] : kind === "safety-verdict" ? ["accepted", "violations"] : kind === "parent-acceptance" ? ["accepted", "evidence"] : kind === "retry" ? ["retry_kind", "retry_of", "reason"] : kind === "release" ? ["released", "released_at"] : kind === "gate-acceptance" ? ["accepted", "evidence", "result_tree"] : ["file", "symbol", "missing_decision"];
  allowed(source, [...commonFields(kind as FactKind), ...kindFields]);
  if (source.schema_version !== undefined && source.schema_version !== ROLLING_ACCEPTANCE_SCHEMA_VERSION) fail("unsupported schema_version");
  source.schema_version = ROLLING_ACCEPTANCE_SCHEMA_VERSION; required(source, "recorded_at");
  if (Number.isNaN(Date.parse(source.recorded_at as string))) fail("recorded_at must be a timestamp");
  if (kind === "gate-acceptance") {
    required(source, "gate_key");
    if (!positive(source.gate_version) || !text(source.gate_fingerprint) || !HASH_RE.test(source.gate_fingerprint)) fail("malformed gate owner");
    if (source.owner_type !== undefined && source.owner_type !== "gate_version") fail("gate fact has a non-gate owner");
    source.owner_type = "gate_version"; const gateId = ref(source.gate_key as string, source.gate_version as number);
    if (source.owner_key !== undefined && source.owner_key !== gateId) fail("gate owner_key does not match gate version");
    source.owner_key = gateId; if (typeof source.accepted !== "boolean") fail("gate acceptance requires accepted");
    if (source.result_tree !== undefined && (!text(source.result_tree) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(source.result_tree as string))) fail("gate acceptance result_tree is malformed");
  } else {
    required(source, "unit_key");
    if (!positive(source.unit_version) || !text(source.unit_fingerprint) || !HASH_RE.test(source.unit_fingerprint)) fail("malformed unit owner");
    if (source.owner_type !== undefined && source.owner_type !== "unit_version" && source.owner_type !== "attempt") fail("unit fact has an unsupported owner");
    const attemptKind = ["reservation", "native-attempt", "terminal-result", "retry", "release"].includes(kind);
    if (attemptKind && source.owner_type !== undefined && source.owner_type !== "attempt") fail(`${kind} must be attempt-owned`);
    const ownerType = source.owner_type === undefined ? (attemptKind ? "attempt" : "unit_version") : source.owner_type;
    source.owner_type = ownerType; if (source.attempt !== undefined && !positive(source.attempt)) fail("attempt must be positive");
    const unitId = ref(source.unit_key as string, source.unit_version as number);
    if (ownerType === "unit_version") { if (source.owner_key !== undefined && source.owner_key !== unitId) fail("unit owner_key does not match unit version"); source.owner_key = unitId; }
    else { if (source.owner_key === undefined) source.owner_key = `${unitId}:attempt-${source.attempt || 1}`; required(source, "owner_key"); if (source.owner_key === unitId) fail("attempt owner_key must identify an attempt"); }
  }
  if (!text(source.owner_key) || !ID_RE.test(source.owner_key as string)) fail("owner_key is malformed");
  if (source.fact_id !== undefined && (!text(source.fact_id) || !ID_RE.test(source.fact_id as string))) fail("fact_id is malformed");
  if (kind === "reservation") {
    required(source, "reservation_id"); if (!["queued", "reserved", "released", "cancelled"].includes(source.state as string)) fail("malformed reservation");
  } else if (kind === "native-attempt") {
    if (!["queued", "reserved", "running", "completed", "failed", "cancelled"].includes(source.state as string)) fail("malformed native attempt");
  } else if (kind === "terminal-result") {
    if (!["completed", "succeeded", "failed", "errored", "timed-out", "cancelled"].includes(source.status as string)) fail("malformed terminal result");
    if (source.result_fingerprint !== undefined && (!text(source.result_fingerprint) || !HASH_RE.test(source.result_fingerprint as string))) fail("malformed result fingerprint");
  } else if (kind === "safety-verdict" || kind === "parent-acceptance") {
    if (typeof source.accepted !== "boolean") fail(`${kind} requires accepted`);
    if (kind === "safety-verdict" && source.violations !== undefined && !Array.isArray(source.violations)) fail("violations must be an array");
  } else if (kind === "retry") {
    if (source.retry_kind !== "route" && source.retry_kind !== "native") fail("retry_kind must be route or native"); required(source, "retry_of");
  } else if (kind === "release") {
    if (typeof source.released !== "boolean") fail("release requires released");
  } else if (kind === "plan-insufficient") {
    required(source, "file"); required(source, "symbol"); required(source, "missing_decision");
  }
  delete source.fingerprint; if (source.fact_id === undefined) source.fact_id = `${kind}:${hash(source).slice(0, 32)}`;
  const computed = fingerprintRollingExecutionFact(source);
  if (record(value) && value.fingerprint !== undefined && value.fingerprint !== computed) fail("fact fingerprint does not match canonical content");
  source.fingerprint = computed; return source as unknown as RollingExecutionFact;
}

export function fingerprintRollingExecutionFact(value: RollingExecutionFact | unknown): string {
  if (!record(value)) fail("execution fact must be an object"); const copy = structuredClone(value) as Record<string, unknown>; delete copy.fingerprint; return hash(copy);
}
function unitRef(unit: UnitVersion): string { return ref(unit.unit_key, unit.version); }
function gateRef(gate: GateVersion): string { return ref(gate.gate_key, gate.version); }
function unitFingerprint(unit: UnitVersion): string { return unit.fingerprint || fingerprintUnitVersion(unit); }
function gateFingerprint(gate: GateVersion): string { return gate.fingerprint || fingerprintGateVersion(gate); }
type UnitFact = Exclude<RollingExecutionFact, GateAcceptanceFact>;
interface AttemptFacts {
  owner_key: string;
  reservations: ReservationFact[];
  native_attempts: NativeAttemptFact[];
  terminals: TerminalResultFact[];
  retries: RetryFact[];
  releases: ReleaseFact[];
}
function newAttemptFacts(owner_key: string): AttemptFacts {
  return { owner_key, reservations: [], native_attempts: [], terminals: [], retries: [], releases: [] };
}
function retryReferencesUnit(retry_of: string, identity: string): boolean {
  if (retry_of === identity) return true;
  const prefix = `${identity}:attempt-`;
  if (!retry_of.startsWith(prefix)) return false;
  const attempt = retry_of.slice(prefix.length);
  return /^[1-9][0-9]*$/u.test(attempt);
}
function blocker(code: string, message: string, owner_type: OwnerType, owner_key: string, refs?: string[]): Blocker { return { code, message, owner_type, owner_key, ...(refs?.length ? { refs } : {}) }; }
function compareBlockers(a: Blocker, b: Blocker): number { return a.owner_key.localeCompare(b.owner_key) || a.code.localeCompare(b.code) || (a.refs?.join("|") || "").localeCompare(b.refs?.join("|") || ""); }
function orderFacts(facts: readonly RollingExecutionFact[]): RollingExecutionFact[] { return [...facts].sort((a, b) => (Date.parse(a.recorded_at) - Date.parse(b.recorded_at)) || a.fact_id.localeCompare(b.fact_id)); }

/** Reduce exactly one immutable unit version; all other facts are ignored. */
export function reduceRollingUnitVersion(unit: UnitVersion, facts: readonly RollingExecutionFact[]): RollingUnitVersionState {
  const identity = unitRef(unit); const expected = unitFingerprint(unit);
  const local = orderFacts(facts.filter((fact): fact is UnitFact => fact.kind !== "gate-acceptance" && fact.unit_key === unit.unit_key && fact.unit_version === unit.version)) as UnitFact[];
  const blockers: Blocker[] = []; const matching = local.filter((fact) => fact.unit_fingerprint === expected);
  for (const fact of local.filter((item) => item.unit_fingerprint !== expected)) blockers.push(blocker("UNIT_FINGERPRINT_MISMATCH", "fact belongs to a different immutable unit contract", fact.owner_type, fact.owner_key, [identity]));
  const attemptFacts = new Map<string, AttemptFacts>();
  for (const fact of matching) {
    if (fact.owner_type !== "attempt") continue;
    const current = attemptFacts.get(fact.owner_key) || newAttemptFacts(fact.owner_key); attemptFacts.set(fact.owner_key, current);
    if (fact.kind === "reservation") current.reservations.push(fact);
    else if (fact.kind === "native-attempt") current.native_attempts.push(fact);
    else if (fact.kind === "terminal-result") current.terminals.push(fact);
    else if (fact.kind === "retry") current.retries.push(fact);
    else if (fact.kind === "release") current.releases.push(fact);
  }
  const attempts = [...attemptFacts.keys()].sort();
  const terminal = matching.filter((fact): fact is TerminalResultFact => fact.kind === "terminal-result"); const successful = terminal.filter((fact) => TERMINAL_SUCCESS.has(fact.status)); const failedTerminal = terminal.filter((fact) => !TERMINAL_SUCCESS.has(fact.status));
  const safety = matching.filter((fact): fact is SafetyVerdictFact => fact.kind === "safety-verdict"); const parent = matching.filter((fact): fact is ParentAcceptanceFact => fact.kind === "parent-acceptance"); const releases = matching.filter((fact): fact is ReleaseFact => fact.kind === "release" && fact.released); const insufficiency = matching.find((fact): fact is PlanInsufficientFact => fact.kind === "plan-insufficient"); const retries = matching.filter((fact): fact is RetryFact => fact.kind === "retry");
  for (const retry of retries) if (!retryReferencesUnit(retry.retry_of, identity)) blockers.push(blocker("RETRY_UNIT_VERSION_MISMATCH", "retry must remain on the same immutable unit version", retry.owner_type, retry.owner_key, [retry.retry_of, identity]));
  if (insufficiency) blockers.push(blocker("PLAN_INSUFFICIENT", "a successor unit version is required", insufficiency.owner_type, insufficiency.owner_key, [identity]));
  if (failedTerminal.length) { const fact = failedTerminal[failedTerminal.length - 1]!; blockers.push(blocker("TERMINAL_RESULT_FAILED", "the latest terminal result failed", fact.owner_type, fact.owner_key, [identity])); }
  const rejectedSafety = safety.find((fact) => !fact.accepted);
  if (rejectedSafety) blockers.push(blocker("SAFETY_NOT_ACCEPTED", "safety verdict was rejected", rejectedSafety.owner_type, rejectedSafety.owner_key, [identity]));
  const safetyAccepted = safety.length > 0 && safety.some((fact) => fact.accepted); const parentAccepted = parent.some((fact) => fact.accepted);
  const released = releases.length > 0;
  const hasRelease = (attempt: AttemptFacts): boolean => attempt.releases.some((fact) => fact.released);
  const acceptedAttempt = [...attemptFacts.values()].find((attempt) => attempt.terminals.some((fact) => TERMINAL_SUCCESS.has(fact.status)) && hasRelease(attempt));
  const accepted = Boolean(acceptedAttempt && safetyAccepted && parentAccepted);
  const unreleasedTerminals = [...attemptFacts.values()].filter((attempt) => attempt.terminals.length > 0 && !hasRelease(attempt));
  const terminalUnreleased = unreleasedTerminals.length > 0;
  for (const attempt of unreleasedTerminals) blockers.push(blocker("TERMINAL_UNRELEASED", "terminal result retains ownership until release", "attempt", attempt.owner_key, [identity]));
  if (acceptedAttempt && !parentAccepted) blockers.push(blocker("PARENT_ACCEPTANCE_REQUIRED", "terminal result awaits parent acceptance", "attempt", acceptedAttempt.owner_key, [identity]));
  const queuedEvidence = [...attemptFacts.values()].some((attempt) => attempt.reservations.some((fact) => fact.state === "queued") || attempt.native_attempts.some((fact) => fact.state === "queued"));
  const reserved = [...attemptFacts.values()].some((attempt) => attempt.reservations.some((fact) => fact.state === "reserved") || attempt.native_attempts.some((fact) => fact.state === "reserved"));
  const running = [...attemptFacts.values()].some((attempt) => attempt.native_attempts.some((fact) => fact.state === "running"));
  let state: UnitState = "queued";
  if (accepted) state = "accepted";
  else if (terminalUnreleased && successful.length > 0) state = "terminal-unreleased";
  else if (insufficiency || failedTerminal.length || safety.some((fact) => !fact.accepted) || blockers.some((item) => item.code === "RETRY_UNIT_VERSION_MISMATCH")) state = "failed";
  else if (released) state = "released";
  else if (running) state = "running";
  else if (reserved) state = "reserved";
  return { unit_key: unit.unit_key, version: unit.version, unit_ref: identity, unit_fingerprint: expected, state, queued: queuedEvidence || state === "queued", reserved, running, terminal_unreleased: terminalUnreleased, failed: state === "failed", accepted, released, requires_successor_version: Boolean(insufficiency), attempts, blockers: blockers.sort(compareBlockers), fact_ids: matching.map((fact) => fact.fact_id).sort() };
}

function values<T>(value: readonly T[] | Readonly<Record<string, T>> | undefined): T[] { return !value ? [] : Array.isArray(value) ? [...value] : Object.values(value); }
function normalizeFacts(facts: readonly unknown[] | undefined): RollingExecutionFact[] { return (facts || []).map(normalizeRollingExecutionFact); }
function unitMap(context: RollingExecutionContext): Map<string, UnitVersion> { return new Map(values(context.units).map((unit) => [unitRef(unit), unit])); }
function gateMap(context: RollingExecutionContext): Map<string, GateVersion> { return new Map(values(context.gates).map((gate) => [gateRef(gate), gate])); }
function resolveUnitDependency(value: string, units: Map<string, UnitVersion>): [string, UnitVersion] | undefined {
  const exact = parseRef(value);
  if (exact) { const unit = units.get(value); return unit ? [value, unit] : undefined; }
  let selected: [string, UnitVersion] | undefined;
  for (const [identity, unit] of units) if (unit.unit_key === value && (!selected || unit.version > selected[1].version)) selected = [identity, unit];
  return selected;
}
function resolveGateDependency(value: string, gates: Map<string, GateVersion>): [string, GateVersion] | undefined {
  const exact = parseRef(value);
  if (exact) { const gate = gates.get(value); return gate ? [value, gate] : undefined; }
  let selected: [string, GateVersion] | undefined;
  for (const [identity, gate] of gates) if (gate.gate_key === value && (!selected || gate.version > selected[1].version)) selected = [identity, gate];
  return selected;
}

function evaluateGate(gate: GateVersion, units: Map<string, UnitVersion>, gates: Map<string, GateVersion>, facts: readonly RollingExecutionFact[], unitMemo: Map<string, RollingUnitVersionState>, gateMemo: Map<string, RollingGateVersionState>, stack: Set<string>): RollingGateVersionState {
  const identity = gateRef(gate); const previous = gateMemo.get(identity); if (previous) return previous;
  const dependencies = [...(gate.depends_on || [])].sort(); const dependencyStates: Record<string, string> = {}; const blockers: Blocker[] = [];
  if (stack.has(identity)) {
    return { gate_key: gate.gate_key, version: gate.version, gate_ref: identity, gate_fingerprint: gateFingerprint(gate), type: gate.type, state: "pending", pending: true, ready: false, failed: false, accepted: false, depends_on: dependencies, dependency_states: {}, blockers: [blocker("DEPENDENCY_CYCLE", "gate dependency cycle", "gate_version", identity, [identity])], acceptance_fact_ids: [] };
  }
  stack.add(identity);
  for (const dependency of dependencies) {
    const resolvedUnit = resolveUnitDependency(dependency, units); const resolvedGate = resolvedUnit ? undefined : resolveGateDependency(dependency, gates);
    if (resolvedUnit) {
      const [resolvedIdentity, unit] = resolvedUnit; const state = unitMemo.get(resolvedIdentity) || reduceRollingUnitVersion(unit, facts); unitMemo.set(resolvedIdentity, state); dependencyStates[dependency] = state.state;
      if (!state.accepted) blockers.push(blocker("DEPENDENCY_NOT_ACCEPTED", `dependency ${resolvedIdentity} is not accepted`, "gate_version", identity, [resolvedIdentity]));
    }
    else if (resolvedGate) {
      const [resolvedIdentity, depGate] = resolvedGate;
      if (stack.has(resolvedIdentity)) { dependencyStates[dependency] = "pending"; blockers.push(blocker("DEPENDENCY_CYCLE", "gate dependency cycle", "gate_version", identity, [resolvedIdentity])); }
      else { const state = evaluateGate(depGate, units, gates, facts, unitMemo, gateMemo, stack); dependencyStates[dependency] = state.state; if (!state.accepted) blockers.push(blocker("DEPENDENCY_NOT_ACCEPTED", `dependency ${resolvedIdentity} is not accepted`, "gate_version", identity, [resolvedIdentity])); }
    }
    else { dependencyStates[dependency] = "missing"; blockers.push(blocker("UNKNOWN_DEPENDENCY", `unknown dependency ${dependency}`, "gate_version", identity, [dependency])); }
  }
  stack.delete(identity);
  const own = orderFacts(facts.filter((fact) => fact.kind === "gate-acceptance" && fact.gate_key === gate.gate_key && fact.gate_version === gate.version && fact.gate_fingerprint === gateFingerprint(gate))) as GateAcceptanceFact[];
  const acceptedFact = own.some((fact) => fact.accepted); const rejectedFact = own.some((fact) => !fact.accepted); if (rejectedFact && !acceptedFact) blockers.push(blocker("GATE_REJECTED", "gate acceptance was rejected", "gate_version", identity, [identity]));
  const dependenciesAccepted = blockers.every((item) => !["DEPENDENCY_NOT_ACCEPTED", "UNKNOWN_DEPENDENCY", "DEPENDENCY_CYCLE"].includes(item.code)); const ready = dependenciesAccepted && !acceptedFact; const accepted = dependenciesAccepted && acceptedFact;
  const result: RollingGateVersionState = { gate_key: gate.gate_key, version: gate.version, gate_ref: identity, gate_fingerprint: gateFingerprint(gate), type: gate.type, state: accepted ? "accepted" : rejectedFact ? "failed" : ready ? "ready" : "pending", pending: !accepted && !rejectedFact, ready, failed: rejectedFact && !accepted, accepted, depends_on: dependencies, dependency_states: dependencyStates, blockers: blockers.sort(compareBlockers), acceptance_fact_ids: own.map((fact) => fact.fact_id).sort() };
  gateMemo.set(identity, result); return result;
}

/** Evaluate one gate using only its explicit dependencies and own acceptance facts. */
export function evaluateRollingGateVersion(gate: GateVersion, context: RollingExecutionContext = {}): RollingGateVersionState { return evaluateGate(gate, unitMap(context), gateMap(context), normalizeFacts(context.facts), new Map(), new Map(), new Set()); }

export interface RollingAcceptanceProjection { units: Record<string, RollingUnitVersionState>; gates: Record<string, RollingGateVersionState>; facts: RollingExecutionFact[]; blockers: Blocker[]; implicit_run_wide_barrier: false; }

/** Derive deterministic maps for all supplied versions; no run-wide barrier is inferred. */
export function deriveRollingAcceptance(context: RollingExecutionContext = {}): RollingAcceptanceProjection {
  const facts = normalizeFacts(context.facts); const units = unitMap(context); const gates = gateMap(context); const unitStates = new Map<string, RollingUnitVersionState>();
  for (const key of [...units.keys()].sort()) unitStates.set(key, reduceRollingUnitVersion(units.get(key)!, facts));
  const gateStates = new Map<string, RollingGateVersionState>(); for (const key of [...gates.keys()].sort()) gateStates.set(key, evaluateGate(gates.get(key)!, units, gates, facts, unitStates, gateStates, new Set()));
  const unitRecord: Record<string, RollingUnitVersionState> = {}; const gateRecord: Record<string, RollingGateVersionState> = {};
  for (const key of [...unitStates.keys()].sort()) unitRecord[key] = unitStates.get(key)!; for (const key of [...gateStates.keys()].sort()) gateRecord[key] = gateStates.get(key)!;
  const blockers = [...Object.values(unitRecord).flatMap((state) => state.blockers), ...Object.values(gateRecord).flatMap((state) => state.blockers)].sort(compareBlockers);
  return { units: unitRecord, gates: gateRecord, facts, blockers, implicit_run_wide_barrier: false };
}
