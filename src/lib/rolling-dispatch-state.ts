import { fingerprintUnitVersion, type PlanDelta, type UnitVersion } from "./rolling-plan.js";
import type { SpawnTicket } from "./spawn.js";

export interface RollingRepresentationBlocker {
  code: string;
  message: string;
  refs: string[];
}

export interface RollingRepresentationIndex {
  represented: Set<string>;
  ticket_ids_by_unit: Map<string, string[]>;
  blockers: Record<string, RollingRepresentationBlocker[]>;
}

/** Return the stable identity used by rolling unit versions and their tickets. */
export function rollingUnitRef(unit: UnitVersion): string {
  return `${unit.unit_key}@${unit.version}`;
}

/**
 * Collect accepted unit versions without allowing two meanings for one
 * version identity.  Map insertion order is the first delta/unit order.
 */
export function collectRollingUnitVersions(
  accepted_deltas: readonly PlanDelta[],
): Map<string, UnitVersion> {
  const units = new Map<string, UnitVersion>();
  const fingerprints = new Map<string, string>();
  for (const delta of accepted_deltas) {
    for (const unit of delta.unit_versions || []) {
      const ref = rollingUnitRef(unit);
      const fingerprint = fingerprintUnitVersion(unit);
      const prior = fingerprints.get(ref);
      if (prior !== undefined && prior !== fingerprint) {
        const error = new Error(`rolling unit ${ref} has conflicting fingerprints`) as Error & { code: string };
        error.code = "ROLLING_LINEAGE_MISMATCH";
        throw error;
      }
      if (prior === undefined) {
        fingerprints.set(ref, fingerprint);
        units.set(ref, unit);
      }
    }
  }
  return units;
}

type RollingUnits = ReadonlyMap<string, UnitVersion> | readonly UnitVersion[];

function valuesOf(units: RollingUnits): Iterable<UnitVersion> {
  return Array.isArray(units) ? units : units.values();
}

/**
 * Project existing rolling tickets into represented unit identities.  This
 * deliberately does not inspect ticket lifecycle, receipts, or run state.
 */
export function indexRepresentedRollingTickets(
  run_id: string,
  units: RollingUnits,
  existing_tickets: readonly SpawnTicket[],
): RollingRepresentationIndex {
  const known = new Map<string, UnitVersion>();
  for (const unit of valuesOf(units)) {
    const ref = rollingUnitRef(unit);
    if (!known.has(ref)) known.set(ref, unit);
  }

  const ticketIdsByRef = new Map<string, Set<string>>();
  const mismatched = new Set<string>();
  for (const ticket of existing_tickets) {
    const lineage = ticket.rolling_unit_lineage;
    if (!lineage || lineage.run_id !== run_id) continue;
    const ref = `${lineage.unit_key}@${lineage.unit_version}`;
    const unit = known.get(ref);
    if (!unit) continue;

    let ticketIds = ticketIdsByRef.get(ref);
    if (!ticketIds) {
      ticketIds = new Set<string>();
      ticketIdsByRef.set(ref, ticketIds);
    }
    ticketIds.add(ticket.id);
    if (lineage.unit_fingerprint !== fingerprintUnitVersion(unit)) mismatched.add(ref);
  }

  const refs = [...ticketIdsByRef.keys()].sort((left, right) => left.localeCompare(right));
  const represented = new Set(refs);
  const ticket_ids_by_unit = new Map<string, string[]>();
  const blockers: Record<string, RollingRepresentationBlocker[]> = {};
  for (const ref of refs) {
    const ticketIds = [...ticketIdsByRef.get(ref)!].sort((left, right) => left.localeCompare(right));
    ticket_ids_by_unit.set(ref, ticketIds);
    if (mismatched.has(ref)) {
      blockers[ref] = [{
        code: "ROLLING_LINEAGE_MISMATCH",
        message: `existing rolling ticket lineage does not match unit ${ref}`,
        refs: [ref, ...ticketIds],
      }];
    }
  }
  return { represented, ticket_ids_by_unit, blockers };
}
