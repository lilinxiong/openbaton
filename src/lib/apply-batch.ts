import { pathAllowed } from "./safety.js";
import type { ApplyUnitMode } from "./apply-scope.js";

export const APPLY_WRITE_CONFLICT = "APPLY_WRITE_CONFLICT";

const LIVE_STATUSES = new Set(["reserved", "dispatching", "running"]);

export type InFlightTicket = {
  id: string;
  status: string;
  mode?: string | null;
  write_allowlist?: string[] | null;
  read_only?: boolean;
};

type ScopeLike = { mode: ApplyUnitMode; write_paths: string[] };

/** True when any path from either side is allowed by the other allowlist. */
export function scopesOverlap(aPaths: string[], bPaths: string[]): boolean {
  if (!aPaths.length || !bPaths.length) return false;
  for (const path of aPaths) {
    if (pathAllowed(path, bPaths)) return true;
  }
  for (const path of bPaths) {
    if (pathAllowed(path, aPaths)) return true;
  }
  return false;
}

/** Two read-only scopes never conflict; otherwise conflict iff write paths overlap. */
export function scopesConflict(a: ScopeLike, b: ScopeLike): boolean {
  if (a.mode === "read-only" && b.mode === "read-only") return false;
  return scopesOverlap(a.write_paths, b.write_paths);
}

function scopeEntries(
  scopes: Map<string, ScopeLike> | Record<string, ScopeLike>,
): Array<[string, ScopeLike]> {
  return scopes instanceof Map ? [...scopes.entries()] : Object.entries(scopes);
}

/** Pairwise write-set conflicts among director-scoped units in one dispatch. */
export function findBatchWriteConflicts(
  scopes: Map<string, ScopeLike> | Record<string, ScopeLike>,
): Array<{ a: string; b: string }> {
  const entries = scopeEntries(scopes);
  const conflicts: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [aId, aScope] = entries[i]!;
      const [bId, bScope] = entries[j]!;
      if (scopesConflict(aScope, bScope)) conflicts.push({ a: aId, b: bId });
    }
  }
  return conflicts;
}

function ticketScope(ticket: InFlightTicket): ScopeLike {
  const readOnly = ticket.read_only === true || ticket.mode === "read-only";
  return {
    mode: readOnly ? "read-only" : "write",
    write_paths: ticket.write_allowlist ? [...ticket.write_allowlist] : [],
  };
}

function isLiveTicket(ticket: InFlightTicket): boolean {
  return LIVE_STATUSES.has(ticket.status);
}

/** Conflicts between scoped units and reserved/dispatching/running host tickets. */
export function findInFlightWriteConflicts(
  scopes: Map<string, ScopeLike> | Record<string, ScopeLike>,
  inflight: InFlightTicket[],
): Array<{ unit: string; ticket_id: string }> {
  const live = inflight.filter(isLiveTicket);
  const conflicts: Array<{ unit: string; ticket_id: string }> = [];
  for (const [unitId, unitScope] of scopeEntries(scopes)) {
    for (const ticket of live) {
      if (scopesConflict(unitScope, ticketScope(ticket))) {
        conflicts.push({ unit: unitId, ticket_id: ticket.id });
      }
    }
  }
  return conflicts;
}
