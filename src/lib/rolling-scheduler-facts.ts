/**
 * State/route normalization helpers for the rolling scheduler projection.
 * Split from rolling-scheduler.ts (internal helpers only).
 */
import type { ApplyPlanOwnershipNamespace, ApplyPlanUnit } from "./apply-plan.js";
import type { GateVersion, PlanDelta, UnitVersion } from "./rolling-plan.js";
import type {
  RollingRouteFact,
  RollingSchedulerBlocker,
  RollingSchedulerInput,
} from "./rolling-scheduler.js";

export type AnyRecord = Record<string, unknown>;
export type Kind = "unit" | "gate";
export type Identity = { kind: Kind; key: string; version?: number; id: string };

const ACCEPTED = new Set(["accepted", "succeeded", "success", "done", "reconciled"]);
const TERMINAL = new Set(["reserved", "running", "terminal", "terminal-unreleased", "terminal-awaiting-release"]);
const EXCLUDED = new Set(["failed", "blocked", "cancelled", "stale", "superseded"]);
const VERSION_REF = /^([^@]+)@([1-9][0-9]*)$/;

export function record(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
export function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export function state(value: unknown): string | null {
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
export function normalizeState(value: unknown): string | null {
  const valueState = state(value);
  if (!valueState) return null;
  if (ACCEPTED.has(valueState)) return "accepted";
  if (TERMINAL.has(valueState)) return valueState === "terminal" || valueState === "terminal-awaiting-release" ? "terminal-unreleased" : valueState;
  if (EXCLUDED.has(valueState)) return valueState;
  if (["planned", "ready", "queued", "open", "undispatched"].includes(valueState)) return "undispatched";
  return valueState;
}
export function stateFromFact(value: unknown): string | null {
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
export function identity(value: unknown, fallback?: Kind, fallbackKey?: string): Identity | null {
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
export function runtimeFacts(input: RollingSchedulerInput): unknown[] {
  return input.runtime_facts ? [...input.runtime_facts] : [];
}
export function executionRootFor(input: RollingSchedulerInput, id: string, key: string): ApplyPlanOwnershipNamespace | undefined {
  const values = input.execution_roots_by_unit;
  return values instanceof Map ? values.get(id) ?? values.get(key) : values?.[id] ?? values?.[key];
}

/**
 * Planned isolated units already own distinct future roots even before the
 * selected frontier has passed repository setup.  Model that fact only for
 * conflict selection; exact base/root identity is still required by the
 * dispatch boundary and is never inferred here.
 */
export function schedulingOwnershipNamespaces(
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
export function versionId(key: string, version: number): string { return `${key}@${version}`; }
export function parseRef(value: string): { key: string; version?: number } { const parsed = value.match(VERSION_REF); return parsed ? { key: parsed[1]!, version: Number(parsed[2]) } : { key: value }; }
export function addBlocker(map: Map<string, RollingSchedulerBlocker[]>, id: string, code: string, message: string, refs: string[] = []): void {
  const values = map.get(id) || [];
  const signature = `${code}\0${message}\0${refs.join(",")}`;
  if (!values.some((item) => `${item.code}\0${item.message}\0${(item.refs || []).join(",")}` === signature)) values.push({ code, message, ...(refs.length ? { refs } : {}) });
  map.set(id, values);
}
export function routeId(value: unknown): string | null {
  if (!record(value)) return text(value) ? value : null;
  return text(value.route_id) ? value.route_id : text(value.model_id) ? value.model_id : text(value.id) ? value.id : null;
}
export function routeMatchesUnit(route: RollingRouteFact, id: string): boolean {
  const linked = route.unit_id ?? route.unit_key ?? route.unit_version_id;
  if (linked === undefined) return true;
  return identity(route, "unit")?.id === id || identity(route, "unit")?.key === id;
}
export function routeList(input: RollingSchedulerInput, unit: UnitVersion, id: string): RollingRouteFact[] {
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
export function configuredRoutes(input: RollingSchedulerInput): string[] {
  return [...new Set((input.configured_routes || []).map(String).map((v) => v.trim()).filter(Boolean))];
}
export function routeBase(id: string): string {
  const at = id.lastIndexOf("@");
  return at > 0 ? id.slice(0, at) : id;
}
export function routeMatchesConfigured(id: string, configured: string): boolean {
  return id === configured || routeBase(id) === routeBase(configured);
}
export function prioritizedRoutes(candidates: readonly RollingRouteFact[], configured: readonly string[]): RollingRouteFact[] {
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
export function availabilityFor(input: RollingSchedulerInput, id: string): AnyRecord | null {
  const source = input.current_session_availability;
  const base = id.includes("@") ? id.slice(0, id.lastIndexOf("@")) : id;
  const value = source instanceof Map ? source.get(id) ?? source.get(base) : source?.[id] ?? source?.[base];
  return record(value) ? value : typeof value === "string" ? { status: value } : null;
}
export function candidateEligible(route: RollingRouteFact, input: RollingSchedulerInput, unit: UnitVersion): { ok: boolean; code?: string; message?: string } {
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

export function unitState(states: Map<string, string>, id: string, key: string): string | null { return states.get(`unit:${id}`) || states.get(`unit:${key}`) || null; }
export function gateState(states: Map<string, string>, id: string, key: string): string | null { return states.get(`gate:${id}`) || states.get(`gate:${key}`) || null; }
export function stableUnitIds(ids: readonly string[], stableOrder: readonly string[]): string[] {
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
