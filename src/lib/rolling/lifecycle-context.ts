/**
 * Lifecycle-context extraction: normalize the heterogeneous caller-supplied
 * context into manifest/version/seal views. Split from rolling-lifecycle.ts
 * (leaf module; only type imports point back).
 */
import type {
  GateVersion,
  PlanDelta,
  RollingDiagnostic,
  TaskManifestEntry,
  TaskSeal,
  UnitVersion,
} from "../rolling-plan.js";
import { isNonBlankString } from "../validate-utils.js";
import type { RollingLifecycleContext } from "../rolling-lifecycle.js";

export type AnyRecord = Record<string, unknown>;

export function record(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
export function issue(
  diagnostics: RollingDiagnostic[],
  code: string,
  message: string,
  path?: string,
  refs: readonly string[] = [],
): void {
  diagnostics.push({ code, message, ...(path ? { path } : {}), ...(refs.length ? { refs: [...refs] } : {}) });
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function arrayValue(value: unknown, keys: readonly string[]): unknown[] {
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

export function allArrayValues(value: unknown, keys: readonly string[]): unknown[] {
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

export function contextOf(value: RollingLifecycleContext | unknown): AnyRecord {
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

export function contextFacts(source: AnyRecord): unknown[] {
  return [
    ...allArrayValues(source, ["facts", "rolling_facts", "rollingFacts", "execution_facts", "executionFacts"]),
  ];
}

export function contextDeltas(source: AnyRecord): PlanDelta[] {
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

export function contextManifest(source: AnyRecord, deltas: readonly PlanDelta[]): Map<string, TaskManifestEntry> {
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

export function contextVersions(source: AnyRecord, deltas: readonly PlanDelta[]): { units: Map<string, UnitVersion>; gates: Map<string, GateVersion> } {
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

export function contextSeals(source: AnyRecord, deltas: readonly PlanDelta[]): TaskSeal[] {
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

export function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every((item) => expected.includes(item));
}
