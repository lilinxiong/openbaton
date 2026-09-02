/**
 * Ticket normalization and lineage validation. Split from spawn.ts (leaf;
 * type-only imports point back at the public types).
 */
import type { NativeExecutionHandleKind } from "../adapters/contract.js";
import type { RollingWorkUnitContract } from "./work-unit.js";
import type { NativeExecutionHandle, SpawnTicket } from "./spawn.js";
import {
  normalizeCompiledApplyLineage,
  normalizeRollingUnitLineage
} from "./receipt.js";
import {
  compileRollingWorkUnit,
  coordinationFor
} from "./work-unit.js";
import { extractExactExecutionRootIdentity, sameExactExecutionRootIdentity, type ExactExecutionRootIdentity } from "../adapters/contract.js";

export function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

export function isHandleKind(value: unknown): value is NativeExecutionHandleKind {
  return typeof value === "string" && /^[a-z][a-z0-9._-]*$/.test(value);
}

export function normalizeExecutionHandle(value: unknown): NativeExecutionHandle | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const handle = stringValue(item.value);
  if (!handle || !isHandleKind(item.kind)) return null;
  const source = item.source === "native-return" || item.source === "manual"
    ? item.source
    : null;
  if (!source) return null;
  let exactRoot: ExactExecutionRootIdentity | undefined;
  try {
    exactRoot = extractExactExecutionRootIdentity(item);
  } catch {
    throw new Error("native execution handle exact-root acknowledgement is partial or invalid");
  }
  return { kind: item.kind, value: handle, source, ...(exactRoot || {}) };
}

export function sameCanonicalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameCanonicalValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key)
      && sameCanonicalValue(leftRecord[key], rightRecord[key]));
}

/** Validate and require the exact persisted shape of a schema-3 work unit. */
export function normalizePersistedRollingWorkUnit(value: unknown): RollingWorkUnitContract {
  const normalized = compileRollingWorkUnit(value);
  if (!sameCanonicalValue(normalized, value)) {
    throw new Error("rolling work unit is not canonical");
  }
  return normalized;
}

export function assertRollingTicketExecutionMode(ticket: SpawnTicket, unit: RollingWorkUnitContract): void {
  if (unit.mode === "verification-only" && ticket.mode !== "read-only") {
    throw new Error("verification-only ticket must be read-only");
  }
  if (unit.mode === "patch-only" && ticket.mode === "commit-only") {
    throw new Error("patch-only ticket cannot be commit-only");
  }
  if (unit.mode === "patch-only" && ticket.mode !== "read-only" && ticket.mode !== "write") {
    throw new Error("patch-only ticket must be read-only or write");
  }
}

/**
 * Normalize a current ticket without writing it. Historical records are not
 * migrated and execution handles are accepted only from native/manual APIs.
 */
export function normalizeSpawnTicket(value: unknown): SpawnTicket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("spawn ticket must be an object");
  }
  const ticket = structuredClone(value) as SpawnTicket & Record<string, unknown>;
  if (ticket.mode !== "read-only" && ticket.mode !== "write" && ticket.mode !== "commit-only") {
    throw new Error("spawn ticket mode is invalid");
  }
  if (typeof ticket.read_only !== "boolean" || ticket.read_only !== (ticket.mode === "read-only")) {
    throw new Error("spawn ticket read_only does not match mode");
  }
  let unitRecord = ticket.work_unit as unknown as Record<string, unknown>;
  if (ticket.compiled_apply_lineage !== undefined && ticket.rolling_unit_lineage !== undefined) {
    throw new Error("compiled and rolling lineages are mutually exclusive");
  }
  if (unitRecord && unitRecord.schema_version === 2 && ticket.compiled_apply_lineage === undefined) {
    throw new Error("compiled work unit requires compiled apply lineage");
  }
  if (unitRecord && unitRecord.schema_version === 3 && ticket.rolling_unit_lineage === undefined) {
    throw new Error("rolling work unit requires rolling unit lineage");
  }
  if (unitRecord && unitRecord.schema_version === 3) {
    const normalizedUnit = normalizePersistedRollingWorkUnit(unitRecord);
    if (!sameCanonicalValue(ticket.coordination, coordinationFor(normalizedUnit))) {
      throw new Error("rolling ticket coordination mismatch");
    }
    ticket.work_unit = normalizedUnit;
    unitRecord = normalizedUnit as unknown as Record<string, unknown>;
    assertRollingTicketExecutionMode(ticket, normalizedUnit);
  }
  let ticketExactRoot: ExactExecutionRootIdentity | undefined;
  try {
    ticketExactRoot = extractExactExecutionRootIdentity(ticket);
  } catch {
    throw new Error("spawn ticket exact-root identity is partial or invalid");
  }
  const unitExactRoot = unitRecord?.schema_version === 3
    ? extractExactExecutionRootIdentity(ticket.work_unit)
    : undefined;
  if ((ticketExactRoot === undefined) !== (unitExactRoot === undefined)
    || (ticketExactRoot && !sameExactExecutionRootIdentity(ticketExactRoot, unitExactRoot))) {
    throw new Error("spawn ticket exact-root identity mismatch");
  }
  if (ticket.rolling_unit_lineage !== undefined) {
    const normalized = normalizeRollingUnitLineage(ticket.rolling_unit_lineage);
    if (JSON.stringify(normalized) !== JSON.stringify(ticket.rolling_unit_lineage)) {
      throw new Error("rolling unit lineage is not normalized");
    }
    if (!unitRecord || unitRecord.schema_version !== 3) {
      throw new Error("rolling unit lineage requires a rolling work unit");
    }
    if (JSON.stringify(normalized) !== JSON.stringify(unitRecord.rolling_unit_lineage)) {
      throw new Error("rolling work unit lineage mismatch");
    }
    ticket.rolling_unit_lineage = normalized;
  }
  if (ticket.compiled_apply_lineage !== undefined) {
    const normalized = normalizeCompiledApplyLineage(ticket.compiled_apply_lineage);
    if (JSON.stringify(normalized) !== JSON.stringify(ticket.compiled_apply_lineage)) {
      throw new Error("compiled apply lineage is not normalized");
    }
    ticket.compiled_apply_lineage = normalized;
    const unit = unitRecord;
    if (unit.schema_version !== 2) throw new Error("compiled apply lineage requires a compiled work unit");
    for (const field of ["run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "mode"] as const) {
      if (JSON.stringify(normalized[field]) !== JSON.stringify(unit[field])) throw new Error(`compiled work unit lineage mismatch: ${field}`);
    }
    if (normalized.mode === "verification-only" && (ticket.mode !== "read-only" || ticket.read_only !== true)) throw new Error("verification-only ticket must be read-only");
    if (normalized.mode === "patch-only" && ticket.mode === "read-only" && ticket.read_only !== true) throw new Error("patch-only ticket read_only mismatch");
  }
  const existing = normalizeExecutionHandle(ticket.execution_handle);
  const handleExactRoot = existing ? extractExactExecutionRootIdentity(existing) : undefined;
  if (existing && ticketExactRoot && (!handleExactRoot || !sameExactExecutionRootIdentity(handleExactRoot, ticketExactRoot))) {
    throw new Error("native execution handle exact-root acknowledgement mismatch");
  }
  if (existing && !ticketExactRoot && handleExactRoot) {
    throw new Error("shared or legacy ticket cannot bind an isolated execution handle");
  }
  ticket.execution_handle = existing;
  // A terminal ticket that never received a native handle never owned a
  // host slot. Normalize that fact on reads as well as writes so legacy
  // records cannot retain stale capacity/workspace scope indefinitely.
  if (!existing
    && ["completed", "errored", "timed_out", "closed"].includes(String(ticket.status))
    && !ticket.slot_released_at) {
    const terminalAt = stringValue(ticket.finished_at)
      || stringValue(ticket.updated_at)
      || stringValue(ticket.created_at);
    if (terminalAt) ticket.slot_released_at = terminalAt;
  }
  if (ticket.liveness && typeof ticket.liveness === "object" && !Array.isArray(ticket.liveness)) {
    const live = ticket.liveness as unknown as Record<string, unknown>;
    const liveHandle = normalizeExecutionHandle(live.execution_handle);
    if (liveHandle) {
      if (!sameExactExecutionRootIdentity(liveHandle, existing)) {
        throw new Error("liveness execution handle exact-root acknowledgement mismatch");
      }
      ticket.liveness = {
        ...ticket.liveness,
        execution_handle: liveHandle,
      } as SpawnTicket["liveness"];
    }
  }
  return ticket;
}

/** Pure ticket-side lineage validator; legacy tickets intentionally return null. */
export function validateSpawnTicketLineage(value: unknown): string | null {
  let mismatchCode = "COMPILED_LINEAGE_MISMATCH";
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "COMPILED_LINEAGE_MALFORMED";
    const ticket = value as SpawnTicket & Record<string, unknown>;
    if (ticket.compiled_apply_lineage !== undefined && ticket.rolling_unit_lineage !== undefined) {
      return "SPAWN_LINEAGE_MUTUALLY_EXCLUSIVE";
    }
    if (ticket.compiled_apply_lineage === undefined) {
      const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
      if (ticket.rolling_unit_lineage !== undefined) {
        mismatchCode = "ROLLING_LINEAGE_MISMATCH";
        normalizeSpawnTicket(ticket);
        return null;
      }
      if (unit?.schema_version === 2) return "COMPILED_LINEAGE_PARTIAL";
      if (unit?.schema_version === 3) return "ROLLING_LINEAGE_PARTIAL";
      return null;
    }
    normalizeSpawnTicket(ticket);
    return null;
  } catch (error) {
    return error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : mismatchCode;
  }
}

export function assertValidSpawnTicketLineage(ticket: unknown): void {
  const error = validateSpawnTicketLineage(ticket);
  if (error) throw new Error(`spawn ticket lineage is invalid: ${error}`);
}

export function isCurrentSpawnRecord(value: unknown): value is SpawnTicket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const validHandle = (handle: unknown): boolean => {
    if (handle === null || handle === undefined) return true;
    if (typeof handle !== "object" || Array.isArray(handle)) return false;
    const h = handle as Record<string, unknown>;
    return isHandleKind(h.kind) && typeof h.value === "string" && Boolean(h.value.trim())
      && (h.source === "native-return" || h.source === "manual");
  };
  const liveness = v.liveness;
  const baseShapeValid = v.schema_version === 8 && typeof v.id === "string"
    && typeof v.session_uid === "string" && Number.isInteger(v.session_ordinal)
    && v.work_unit !== null && typeof v.work_unit === "object" && !Array.isArray(v.work_unit)
    && v.coordination !== null && typeof v.coordination === "object"
    && Object.hasOwn(v, "progress") && Object.hasOwn(v, "liveness")
    && Object.hasOwn(v, "selection") && Object.hasOwn(v, "service_tier")
    && validHandle(v.execution_handle)
    && (liveness === null || (typeof liveness === "object" && !Array.isArray(liveness)
      && validHandle((liveness as Record<string, unknown>).execution_handle)));
  if (!baseShapeValid) return false;
  try {
    // This is deliberately the same complete validator used by read and
    // write normalization, including the schema-3 work-unit contract.
    normalizeSpawnTicket(v);
    return true;
  } catch {
    return false;
  }
}
