/**
 * Pure, in-memory projection used by rolling dispatch.
 *
 * Selection is deliberately done before scheduling: the scheduler must see
 * only the one route/profile selected for each unit.  This keeps a failed
 * route local to its unit and prevents an unselected route from influencing
 * capacity or write-scope decisions.
 */
import {
  deriveRollingSafeFrontier,
  type RollingRouteFact,
  type RollingSchedulerBlocker,
  type RollingSchedulerInput,
  type RollingSchedulerResult,
} from "./rolling-scheduler.js";
import {
  collectRollingUnitVersions,
  indexRepresentedRollingTickets,
} from "./rolling-dispatch-state.js";
import {
  buildSelectionUnit,
  type SelectionCandidate,
  type SelectionUnit,
} from "./selection.js";
import { cardsForAutomaticSelection } from "./route-health.js";
import type { ApplyPlanActiveOwnership } from "./apply-plan.js";
import type { PlanDelta, UnitVersion } from "./rolling-plan.js";
import type { SpawnTicket } from "./spawn.js";
import type { ModelCard } from "../types.js";

export interface RollingDispatchSelectionInput {
  cwd: string;
  run_id: string;
  host: string;
  accepted_deltas: readonly PlanDelta[];
  existing_tickets?: readonly SpawnTicket[];
  cards: readonly ModelCard[];
  automatic_cards?: readonly ModelCard[];
  coding_models?: readonly string[];
  /** Exact configured routes behind policy profile names. */
  route_profiles?: Readonly<Partial<Record<"runner" | "longctx", string>>>;
  probe_route_ids?: readonly string[];
  current_session_availability?: RollingSchedulerInput["current_session_availability"];
  available_capacity?: number | null;
  capacity?: number | null;
  active_ownership?: readonly ApplyPlanActiveOwnership[];
  stable_order?: readonly string[];
  runtime_facts?: RollingSchedulerInput["runtime_facts"];
  env?: NodeJS.ProcessEnv;
  select_unit?: (selection: SelectionUnit, unit: UnitVersion) => SelectionCandidate | null | undefined;
}

export interface RollingDispatchSelectionResult extends RollingSchedulerResult {
  /** Exact candidate selected for each unit which qualified. */
  selected_candidates: Record<string, SelectionCandidate>;
  /** Selection diagnostics retained per unit, without persistence. */
  selection_units: Record<string, SelectionUnit>;
  /** Unit identities represented by an existing ticket in this run. */
  represented_units: string[];
}

const NO_CAPACITY = Number.MAX_SAFE_INTEGER;

function unitPrompt(unit: UnitVersion): string {
  return String(unit.prompt || unit.description || unit.recipe || unit.unit_key);
}

function routeForCandidate(
  candidate: SelectionCandidate,
  unit_id: string,
): RollingRouteFact {
  return {
    id: candidate.model_id,
    model_id: candidate.model_id,
    route_id: candidate.route_id,
    unit_id,
    selectable: candidate.selectable,
    eligible: candidate.selectable,
    automatic_eligible: candidate.automatic_eligible,
    disabled: !candidate.selectable,
    availability_status: candidate.availability_status,
    probe_available: candidate.probe_available,
    execution_capabilities: candidate.execution_capabilities,
  };
}

function selectionBlocker(unit_id: string, selection: SelectionUnit | null, error?: unknown): RollingSchedulerBlocker {
  if (selection) {
    const diagnostic = selection.candidates
      .flatMap((candidate) => candidate.diagnostics || [])
      .find((item) => item.code !== "AVAILABLE");
    if (selection.no_qualified_result) {
      return { code: "NO_QUALIFIED_CANDIDATE", message: `unit ${unit_id} has no automatic candidate`, refs: [unit_id] };
    }
  }
  const value = error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof value?.code === "string" && value.code.trim() ? value.code : "NO_QUALIFIED_CANDIDATE";
  const message = typeof value?.message === "string" && value.message.trim()
    ? value.message
    : `unit ${unit_id} has no qualified route candidate`;
  return { code, message, refs: [unit_id] };
}

function routeBase(value: string): string {
  const at = value.lastIndexOf("@");
  return at > 0 ? value.slice(0, at) : value;
}

function profileCandidate(selection: SelectionUnit, unit: UnitVersion, input: RollingDispatchSelectionInput): SelectionCandidate | null {
  if (!unit.route_profile || unit.route_profile === "coding") return selection.candidates.find((item) => item.automatic_eligible) || null;
  const configured = String(input.route_profiles?.[unit.route_profile] || "").trim();
  if (!configured) return null;
  const exact = selection.candidates.find((item) => item.automatic_eligible && item.model_id === configured);
  if (exact) return exact;
  const base = routeBase(configured);
  return selection.candidates.find((item) => item.automatic_eligible && (item.route_id === base || routeBase(item.model_id) === base)) || null;
}

function stableBlockers(
  blockers: Record<string, RollingSchedulerBlocker[]>,
  represented: ReadonlySet<string>,
  representedTickets: ReadonlyMap<string, string[]>,
  representationBlockers: Readonly<Record<string, readonly RollingSchedulerBlocker[]>>,
  local: ReadonlyMap<string, RollingSchedulerBlocker>,
): Record<string, RollingSchedulerBlocker[]> {
  const ids = new Set([...Object.keys(blockers), ...Object.keys(representationBlockers), ...local.keys(), ...represented]);
  const result: Record<string, RollingSchedulerBlocker[]> = {};
  for (const id of [...ids].sort((left, right) => left.localeCompare(right))) {
    const representation = representationBlockers[id] || [];
    const lineageMismatch = representation.filter((item) => item.code === "ROLLING_LINEAGE_MISMATCH");
    if (lineageMismatch.length) {
      result[id] = [...lineageMismatch].sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
      continue;
    }
    if (represented.has(id)) {
      const ticketIds = representedTickets.get(id) || [];
      result[id] = [{ code: "ALREADY_MATERIALIZED", message: `unit ${id} is already represented by an existing rolling ticket`, refs: [id, ...ticketIds] }];
      continue;
    }
    const values = local.has(id) ? [local.get(id)!] : (representation.length ? representation : (blockers[id] || []));
    result[id] = [...values].sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  }
  return result;
}

/** Select one exact model candidate per ready rolling unit, then schedule it. */
export function selectRollingFrontier(input: RollingDispatchSelectionInput): RollingDispatchSelectionResult {
  const units = collectRollingUnitVersions(input.accepted_deltas);
  const configured = [...(input.coding_models || [])];

  // The first pass intentionally has no route allowlist and effectively
  // infinite capacity.  It answers only dependency/safety readiness.
  const ready = deriveRollingSafeFrontier({
    accepted_deltas: input.accepted_deltas,
    runtime_facts: input.runtime_facts,
    capacity: NO_CAPACITY,
    shared_worktree: false,
    stable_order: input.stable_order,
  });
  const representedIndex = indexRepresentedRollingTickets(input.run_id, units, input.existing_tickets || []);
  const represented = representedIndex.represented;
  const readyIds = ready.frontier.filter((id) => !represented.has(id));
  const selectedCandidates: Record<string, SelectionCandidate> = {};
  const selectionUnits: Record<string, SelectionUnit> = {};
  const routesByUnit: Record<string, readonly RollingRouteFact[]> = {};
  const localBlockers = new Map<string, RollingSchedulerBlocker>();
  const automatic = [...(input.automatic_cards || input.cards)];

  for (const unitId of readyIds) {
    const unit = units.get(unitId);
    if (!unit) {
      localBlockers.set(unitId, selectionBlocker(unitId, null));
      continue;
    }
    const prompt = unitPrompt(unit);
    let selection: SelectionUnit | null = null;
    try {
      selection = buildSelectionUnit({
        cwd: input.cwd,
        host: input.host,
        key: unitId,
        description: String(unit.description || unit.unit_key),
        prompt,
        cards: [...input.cards],
        automaticCards: cardsForAutomaticSelection(input.cwd, automatic, prompt, input.host, input.env),
        codingModels: configured,
        probeRouteIds: [...(input.probe_route_ids || [])],
        env: input.env,
        metadata: { rolling_unit: unitId, execution_mode: unit.execution_mode },
      });
      selectionUnits[unitId] = selection;
      const hooked = input.select_unit?.(selection, unit);
      const candidate = hooked === null
        ? null
        : hooked === undefined
          ? profileCandidate(selection, unit, input)
          : selection.candidates.find((item) => item.model_id === hooked.model_id && item.route_id === hooked.route_id) || null;
      if (!candidate) {
        localBlockers.set(unitId, selectionBlocker(unitId, selection));
        continue;
      }
      selectedCandidates[unitId] = candidate;
      routesByUnit[unitId] = [routeForCandidate(candidate, unitId)];
    } catch (error) {
      if (selection) selectionUnits[unitId] = selection;
      localBlockers.set(unitId, selectionBlocker(unitId, selection, error));
    }
  }

  const capacity = input.available_capacity === undefined ? input.capacity : input.available_capacity;
  const scheduled = deriveRollingSafeFrontier({
    accepted_deltas: input.accepted_deltas,
    runtime_facts: input.runtime_facts,
    routes_by_unit: routesByUnit,
    configured_routes: configured,
    current_session_availability: input.current_session_availability,
    capacity: capacity === undefined ? null : capacity,
    shared_worktree: true,
    active_ownership: input.active_ownership,
    stable_order: input.stable_order,
  });
  const blockers = stableBlockers(scheduled.blockers, represented, representedIndex.ticket_ids_by_unit, representedIndex.blockers, localBlockers);
  const frontier = scheduled.frontier.filter((id) => !represented.has(id) && !localBlockers.has(id));
  const eligible = scheduled.eligible.filter((id) => !represented.has(id) && !localBlockers.has(id));
  const selectedRoutes = Object.fromEntries(frontier
    .filter((id) => scheduled.selected_routes[id])
    .map((id) => [id, scheduled.selected_routes[id]!])) as Record<string, string>;
  const routeByUnit = Object.fromEntries(scheduled.known_unit_versions
    .filter((id) => !represented.has(id))
    .map((id) => [id, scheduled.route_by_unit[id] ?? null]));
  return {
    ...scheduled,
    frontier,
    eligible,
    selected_routes: selectedRoutes,
    route_by_unit: routeByUnit,
    blockers,
    selected_candidates: selectedCandidates,
    selection_units: selectionUnits,
    represented_units: [...represented].sort((left, right) => left.localeCompare(right)),
  };
}
