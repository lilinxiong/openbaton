/**
 * Pure rolling-dispatch materialization blueprints.
 *
 * This boundary deliberately stops before persistence.  It projects the
 * selected frontier into ordinary standalone-plan pairs so the caller can
 * hand the pairs to the atomic ticket materializer when it is ready.
 */
import {
  selectRollingFrontier,
  type RollingDispatchSelectionInput,
  type RollingDispatchSelectionResult,
} from "./rolling-dispatch-selection.js";
import { fingerprintUnitVersion, type UnitVersion } from "./rolling-plan.js";
import {
  buildReadOnlyReceipt,
  type DelegationReceipt,
  type RollingUnitLineage,
} from "./receipt.js";
import {
  buildSpawnTicket,
  listSpawns,
  nextSpawnIds,
  type SpawnTicket,
  type StandalonePlan,
} from "./spawn.js";
import {
  materializeStandalonePlansBatchAsync,
  type TicketMaterializationBatchEntry,
  type TicketMaterializationBatchOptions,
} from "./ticket-materialization.js";
import type { ModelCard, ModelSelectionApproval } from "../types.js";
import type { RollingDiagnostic } from "./rolling-plan.js";
import {
  normalizeExactExecutionRootIdentity,
  sameExactExecutionRootIdentity,
  type ExactExecutionRootIdentity,
} from "../adapters/contract.js";
import type { WorktreeRecord } from "./worktree-execution.js";

type RollingStandalonePlan = Extract<StandalonePlan, { director_local: false }>;

/** Input to one in-memory rolling refill/blueprint projection. */
export interface RollingRefillInput extends RollingDispatchSelectionInput {
  /** Fixed timestamp shared by every approval, ticket, and base Receipt. */
  now?: Date | string | number;
  /** Fingerprint of the exact active model catalog used for approval. */
  catalog_fingerprint: string;
  /** Optional caller context; it is diagnostic metadata only. */
  event_reason?: string;
  /** Options passed to the failure-atomic ticket materializer. */
  materialization?: Omit<TicketMaterializationBatchOptions, "env">;
  /** Injectable batch materializer, primarily for adapters and tests. */
  materializer?: typeof materializeStandalonePlansBatchAsync;
  /** Exact setup result accepted by the parent, keyed by `unit_key@version`. */
  exact_execution_roots?: Readonly<Record<string, ExactExecutionRootIdentity>>;
  /** Equivalent setup-record input; accepted only when its immutable lineage is exact. */
  worktree_records?: Readonly<Record<string, WorktreeRecord>>;
}

export interface RollingRefillResult {
  run_id: string;
  frontier: string[];
  selected: string[];
  represented_units: string[];
  blocked: RollingDispatchSelectionResult["blockers"];
  capacity: number | null;
  available_capacity: number | null;
  event_reason: string | null;
  /** Standalone plans in exactly frontier order. */
  plans: RollingStandalonePlan[];
  /** The plans in the shape accepted by ticket-materialization. */
  entries: TicketMaterializationBatchEntry[];
  selection: RollingDispatchSelectionResult;
  diagnostics: RollingDiagnostic[];
  /** Tickets persisted for this refill, if materialization was requested. */
  materialized: SpawnTicket[];
}

function unitRef(unit: UnitVersion): string {
  return `${unit.unit_key}@${unit.version}`;
}

function unitsByRef(deltas: RollingRefillInput["accepted_deltas"]): Map<string, UnitVersion> {
  const result = new Map<string, UnitVersion>();
  for (const delta of deltas) {
    for (const unit of delta.unit_versions || []) result.set(unitRef(unit), unit);
  }
  return result;
}

function executionNamespaces(input: RollingRefillInput): NonNullable<RollingDispatchSelectionInput["execution_roots_by_unit"]> {
  const result: Record<string, { repository_id: string; execution_root: string; base_tree: string }> = {};
  for (const [ref, unit] of unitsByRef(input.accepted_deltas)) {
    const direct = input.exact_execution_roots?.[ref] ?? input.exact_execution_roots?.[unit.unit_key];
    const record = input.worktree_records?.[ref] ?? input.worktree_records?.[unit.unit_key];
    if (direct) {
      const normalized = normalizeExactExecutionRootIdentity(direct);
      result[ref] = { repository_id: normalized.repository_id, execution_root: normalized.execution_root, base_tree: normalized.base_tree };
    } else if (record?.execution_mode === "isolated-worktree" && record.setup_state === "verified"
      && record.run_id === input.run_id && record.unit_key === unit.unit_key && record.unit_version === unit.version) {
      result[ref] = { repository_id: record.repository_id, execution_root: record.execution_root, base_tree: record.base_tree };
    }
  }
  return result;
}

function isoNow(value: RollingRefillInput["now"]): string {
  return (value instanceof Date ? value : new Date(value === undefined ? Date.now() : value)).toISOString();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function approvalFor(
  input: RollingRefillInput,
  selection: RollingDispatchSelectionResult,
  ref: string,
  candidate: NonNullable<RollingDispatchSelectionResult["selected_candidates"][string]>,
  approvedAt: string,
): ModelSelectionApproval {
  const selectionUnit = selection.selection_units[ref];
  return {
    host: input.host,
    proposal_id: `rolling-${input.run_id}`,
    approval_id: `rolling-${input.run_id}-${ref}`,
    unit_key: ref,
    approved_at: approvedAt,
    confirmed_by: "baton-recommendation",
    catalog_fingerprint: input.catalog_fingerprint,
    recommended_model_id: selectionUnit?.recommended_model_id ?? candidate.model_id,
    selected_model_id: candidate.model_id,
    service_tier: candidate.service_tier,
    changed_by_user: false,
  };
}

function exactRootFor(input: RollingRefillInput, unit: UnitVersion, ref: string): ExactExecutionRootIdentity | undefined {
  const direct = input.exact_execution_roots?.[ref] ?? input.exact_execution_roots?.[unit.unit_key];
  const record = input.worktree_records?.[ref] ?? input.worktree_records?.[unit.unit_key];
  let fromRecord: ExactExecutionRootIdentity | undefined;
  if (record) {
    if (record.execution_mode !== "isolated-worktree" || record.setup_state !== "verified"
      || record.run_id !== input.run_id || record.unit_key !== unit.unit_key || record.unit_version !== unit.version) {
      throw new Error(`WORKTREE_RECORD_DRIFT: ${ref} setup record does not match the selected rolling unit`);
    }
    fromRecord = normalizeExactExecutionRootIdentity({
      repository_id: record.repository_id,
      git_common_dir_identity: record.git_common_dir_identity,
      execution_root: record.execution_root,
      base_tree: record.base_tree,
      worktree_record_id: record.record_id,
    });
  }
  const normalized = direct ? normalizeExactExecutionRootIdentity(direct) : undefined;
  if (normalized && fromRecord && !sameExactExecutionRootIdentity(normalized, fromRecord)) {
    throw new Error(`WORKTREE_RECORD_DRIFT: ${ref} exact-root inputs disagree`);
  }
  const identity = normalized ?? fromRecord;
  if (unit.worktree_mode === "isolated-worktree" && !identity) {
    throw new Error(`ISOLATED_EXECUTION_IDENTITY_PARTIAL: ${ref} has no accepted exact execution root`);
  }
  if (unit.worktree_mode !== "isolated-worktree" && identity) {
    throw new Error(`ISOLATED_EXECUTION_IDENTITY_FORBIDDEN: ${ref} is not isolated-worktree`);
  }
  return identity;
}

function planFor(
  input: RollingRefillInput,
  unit: UnitVersion,
  ref: string,
  id: string,
  candidate: NonNullable<RollingDispatchSelectionResult["selected_candidates"][string]>,
  selection: RollingDispatchSelectionResult,
  now: string,
): RollingStandalonePlan {
  const description = String(unit.description || unit.prompt || unit.recipe || unit.unit_key);
  const prompt = String(unit.prompt || unit.description || unit.recipe || unit.unit_key);
  const completionCriteria = unit.completion_criteria && unit.completion_criteria.length
    ? unit.completion_criteria
    : [description];
  const permittedValidation = unit.permitted_validation && unit.permitted_validation.length
    ? unit.permitted_validation
    : ["read"];
  const patch = unit.execution_mode === "patch-only";
  const writePaths = patch ? (unit.write_paths || []) : [];
  const allowedOperations = patch ? (unit.allowed_operations || []) : [];
  const exactRoot = exactRootFor(input, unit, ref);
  const lineage: RollingUnitLineage = {
    schema_version: 1,
    run_id: input.run_id,
    unit_key: unit.unit_key,
    unit_version: unit.version,
    unit_fingerprint: fingerprintUnitVersion(unit),
    task_keys: [...unit.task_keys].sort(),
    mode: unit.execution_mode,
    ...(unit.worktree_mode === undefined ? {} : { worktree_mode: unit.worktree_mode }),
    ...(exactRoot || {}),
  };
  const approval = approvalFor(input, selection, ref, candidate, now);
  const ticket = buildSpawnTicket({
    id,
    cwd: input.cwd,
    env: input.env,
    description,
    prompt,
    modelId: candidate.model_id,
    routeId: candidate.route_id,
    reasoningEffort: candidate.reasoning_effort,
    serviceTier: candidate.service_tier,
    source: "rolling-run",
    taskKind: "concrete",
    deliverable: description,
    doneWhen: completionCriteria.join("; "),
    selection: approval,
    targetHost: input.host,
    now,
    rollingUnitLineage: lineage,
    read_context: strings(unit.read_context),
    write_paths: writePaths,
    allowed_operations: allowedOperations,
    completion_criteria: completionCriteria,
    permitted_validation: permittedValidation,
  });
  const card: ModelCard = {
    id: candidate.model_id,
    strengths: candidate.strengths,
    route_id: candidate.route_id,
    reasoning_effort: candidate.reasoning_effort || undefined,
    provider: candidate.provider,
  };
  const receipt: DelegationReceipt = buildReadOnlyReceipt({
    ticketId: ticket.id,
    card,
    issuedAt: now,
    selection: approval,
    host: input.host,
    rollingUnitLineage: lineage,
  });
  ticket.receipt_id = receipt.receipt_id;
  return {
    director_local: false,
    ticket,
    receipt,
    queue: { running: 0, queued: 0 },
  };
}

/** Build deterministic schema-3 ticket/Receipt blueprints for one frontier. */
export function buildRollingStandalonePlans(input: RollingRefillInput): RollingRefillResult {
  const selectionInput: RollingDispatchSelectionInput = {
    cwd: input.cwd,
    run_id: input.run_id,
    host: input.host,
    accepted_deltas: input.accepted_deltas,
    existing_tickets: input.existing_tickets,
    cards: input.cards,
    automatic_cards: input.automatic_cards,
    coding_models: input.coding_models,
    route_profiles: input.route_profiles,
    probe_route_ids: input.probe_route_ids,
    current_session_availability: input.current_session_availability,
    available_capacity: input.available_capacity,
    capacity: input.capacity,
    active_ownership: input.active_ownership,
    execution_roots_by_unit: executionNamespaces(input),
    stable_order: input.stable_order,
    runtime_facts: input.runtime_facts,
    env: input.env,
    select_unit: input.select_unit,
  };
  const selection = selectRollingFrontier(selectionInput);
  const now = isoNow(input.now);
  // Allocate the complete contiguous range once, after the final frontier is
  // known.  IDs therefore never depend on candidate details or diagnostics.
  const ids = nextSpawnIds(input.cwd, "spn", selection.frontier.length, input.env);
  const units = unitsByRef(input.accepted_deltas);
  const plans: RollingStandalonePlan[] = [];
  const entries: TicketMaterializationBatchEntry[] = [];
  for (const [index, ref] of selection.frontier.entries()) {
    const unit = units.get(ref);
    const candidate = selection.selected_candidates[ref];
    if (!unit || !candidate) continue;
    const planned = planFor(input, unit, ref, ids[index]!, candidate, selection, now);
    plans.push(planned);
    const patch = unit.execution_mode === "patch-only";
    entries.push({
      planned,
      // Keep patch declarations as supplied by the unit. Verification-only
      // units can never smuggle write authority through a materialization.
      writeAllowlist: patch ? (unit.write_paths || []) : [],
      allowedOperations: patch ? (unit.allowed_operations || []) : [],
    });
  }
  const diagnostics = [] as RollingDiagnostic[];
  if (input.event_reason) diagnostics.push({ code: "EVENT_REASON", message: input.event_reason });
  return {
    run_id: input.run_id,
    frontier: [...selection.frontier],
    selected: plans.map((plan) => plan.ticket.rolling_unit_lineage
      ? `${plan.ticket.rolling_unit_lineage.unit_key}@${plan.ticket.rolling_unit_lineage.unit_version}`
      : plan.ticket.id),
    represented_units: [...selection.represented_units],
    blocked: selection.blockers,
    capacity: input.capacity ?? null,
    available_capacity: input.available_capacity === undefined ? (input.capacity ?? null) : input.available_capacity,
    event_reason: input.event_reason ?? null,
    plans,
    entries,
    selection,
    diagnostics,
    materialized: [],
  };
}

/** Build and failure-atomically persist one rolling capacity refill. */
export async function refillRollingCapacity(input: RollingRefillInput): Promise<RollingRefillResult> {
  const existingTickets = input.existing_tickets === undefined
    ? listSpawns(input.cwd, input.env)
    : input.existing_tickets;
  const blueprint = buildRollingStandalonePlans({ ...input, existing_tickets: existingTickets });
  if (!blueprint.entries.length) return blueprint;
  const materializer = input.materializer || materializeStandalonePlansBatchAsync;
  const materialized = await materializer(input.cwd, blueprint.entries, { ...input.materialization, env: input.env });
  return { ...blueprint, materialized };
}
