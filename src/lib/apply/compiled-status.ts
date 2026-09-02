import { HostId } from "../hosts.js";
import {
  canonicalChange,
  coded,
  errorCode,
  errorMessage,
  record,
  requireSession,
  resolveInvocationPath,
  samePath,
  text
} from "./compiled-shared.js";
import { buildRouteCandidates } from "../routes.js";
import {
  CompiledApplySourceFacts,
  captureCompiledApplySourceFacts
} from "../apply-source.js";
import { CompiledApplyFrontierResult } from "./compiled.js";
import { SpawnTicket } from "../spawn.js";
import { listSpawns } from "../spawn/store.js";
import { buildSelectionUnit } from "../selection/unit.js";
import { SelectionUnit } from "../selection.js";
import {
  CompiledApplyCliError,
  CompiledApplyCliResult
} from "./compiled-cli.js";
import { dispatchSnapshot } from "../dispatch.js";
import {
  resolveInstructions,
  sourceRequest
} from "./compiled-ops.js";
import {
  availabilityForRoute,
  readModelAvailability
} from "../model-availability.js";
import {
  ApplyExecutionPlan,
  ApplyPlanActiveOwnership
} from "../apply-plan.js";
import {
  ApplyRunState,
  ApplyRunTicketFact,
  readApplyRun,
  readApplyRunPlanBody
} from "./run.js";
import type { ModelCard } from "../../types.js";
import type { CompiledApplyInvocation } from "../../cli.js";
import {
  configuredCodingModelsForHost,
  effectiveMaxConcurrentForHost,
  loadConfig
} from "../config.js";
import { cardsForAutomaticSelection } from "../route-health.js";
import { deriveSafeReadyFrontier } from "../apply-plan.js";
import path from "node:path";
import { readReceipt } from "../receipt.js";
/**
 * Status operation for the compiled-apply CLI handler. Split from
 * compiled-apply-cli.ts.
 */

export function routingInputs(cwd: string, host: HostId, env: NodeJS.ProcessEnv): {
  cards: ModelCard[];
  automaticCards: ModelCard[];
  codingModels: string[];
  capacity: number;
} {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(cwd, { env });
  } catch (error) {
    throw coded(error, "BATON_NOT_INITIALIZED");
  }
  let cards: ModelCard[] = [];
  try {
    cards = buildRouteCandidates(cwd, { host, env }).map((item) => item.card);
  } catch {
    // A persisted run can still be inspected when its route catalog is no
    // longer present.  Selection diagnostics below will report the absence.
    cards = [];
  }
  return {
    cards,
    automaticCards: cards,
    codingModels: [...configuredCodingModelsForHost(config, host)],
    capacity: effectiveMaxConcurrentForHost(config, host, env),
  };
}

export function openSpecSummary(source: CompiledApplySourceFacts | null): Record<string, unknown> | null {
  if (!source) return null;
  return {
    repo_root: source.repo_root,
    repository: {
      head: source.repository.head,
      branch_ref: source.repository.branch_ref,
      staged_tree: source.repository.staged_tree,
      index_control: source.repository.index_control,
    },
    open_spec: source.open_spec,
    fingerprint: source.fingerprint,
  };
}

export function compactFrontier(result: CompiledApplyFrontierResult): Record<string, unknown> {
  return {
    code: result.materialized.length ? "COMPILED_APPLY_FRONTIER_MATERIALIZED" : "COMPILED_APPLY_FRONTIER_EMPTY",
    candidates: [...result.candidates],
    selected: [...result.selected],
    materialized: result.materialized.map((ticket) => ticketIdentity(ticket)),
    blocked: result.blocked.map((item) => ({ unit_id: item.unit_id, exclusion_matrix: item.exclusion_matrix })),
    capacity: result.capacity,
    available_capacity: result.available_capacity,
    revision: result.revision,
    fingerprint: result.fingerprint,
  };
}

export function ticketIdentity(ticket: SpawnTicket): Record<string, unknown> {
  return {
    ticket_id: ticket.id,
    unit_id: ticket.compiled_apply_lineage?.unit_id || null,
    task_refs: [...(ticket.compiled_apply_lineage?.task_refs || [])],
    status: ticket.status,
    host: ticket.target_host || ticket.host || null,
    model_id: ticket.model_id,
    route_id: ticket.route_id || null,
    receipt_id: ticket.receipt_id || null,
    execution_handle: ticket.execution_handle || null,
    native_handle: ticket.execution_handle || null,
    liveness: ticket.liveness || null,
    reservation_id: ticket.reservation_id || null,
    slot_released_at: ticket.slot_released_at || null,
  };
}

export function ticketFactsForRun(cwd: string, state: ApplyRunState, env: NodeJS.ProcessEnv): ApplyRunTicketFact[] {
  const facts: ApplyRunTicketFact[] = [];
  for (const ticket of listSpawns(cwd, env)) {
    const lineage = ticket.compiled_apply_lineage;
    if (!lineage || lineage.run_id !== state.run_id || ticket.session_uid !== state.session_uid || (ticket.target_host || ticket.host || "") !== state.host) continue;
    const status = ticket.status === "done" ? "closed" : ticket.status;
    if (!["queued", "dispatching", "running", "completed", "errored", "timed_out", "closed"].includes(status)) continue;
    facts.push({
      ticket_id: ticket.id,
      status: status as ApplyRunTicketFact["status"],
      run_id: state.run_id,
      host: state.host,
      session_uid: state.session_uid,
      unit_ids: lineage.unit_id ? [lineage.unit_id] : [],
      task_ids: [...lineage.task_refs],
      model_id: ticket.model_id,
      receipt_id: ticket.receipt_id || undefined,
      result: ticket.conclusion || undefined,
      slot_released_at: ticket.slot_released_at || null,
    });
  }
  return facts.sort((left, right) => left.ticket_id.localeCompare(right.ticket_id));
}

export function ownershipForStatus(cwd: string, env: NodeJS.ProcessEnv): ApplyPlanActiveOwnership[] {
  const result: ApplyPlanActiveOwnership[] = [];
  for (const ticket of listSpawns(cwd, env)) {
    if (ticket.slot_released_at || !ticket.receipt_id) continue;
    if (!["queued", "dispatching", "running", "completed", "errored", "timed_out", "closed"].includes(ticket.status)) continue;
    try {
      const receipt = readReceipt(cwd, ticket.receipt_id, env);
      if (!receipt.scope.write_allowlist.length) continue;
      const terminal = ["completed", "errored", "timed_out", "closed"].includes(ticket.status);
      result.push({
        key: ticket.id,
        terminal,
        terminal_unreleased: terminal,
        slot_released_at: ticket.slot_released_at || null,
        facts: receipt.scope.write_allowlist.map((file) => ({ unit_id: ticket.id, path: file, kind: "path" })),
      });
    } catch {
      // A malformed unrelated receipt must not make status probe or mutate it.
    }
  }
  return result.sort((left, right) => left.key.localeCompare(right.key));
}

export function runWithFacts(cwd: string, runId: string, env: NodeJS.ProcessEnv): { state: ApplyRunState; plan: ApplyExecutionPlan; facts: ApplyRunTicketFact[] } {
  let initial: ApplyRunState;
  try {
    initial = readApplyRun(cwd, runId, { env });
  } catch (error) {
    throw coded(error, "RUN_NOT_FOUND");
  }
  const facts = ticketFactsForRun(cwd, initial, env);
  const state = facts.length ? readApplyRun(cwd, runId, { env, ticket_facts: facts }) : initial;
  let plan: ApplyExecutionPlan;
  try {
    plan = readApplyRunPlanBody(cwd, runId, state.current_revision, env);
  } catch (error) {
    throw coded(error, "RUN_STATE_CORRUPT");
  }
  return { state, plan, facts };
}

export function statusSelections(
  cwd: string,
  host: HostId,
  env: NodeJS.ProcessEnv,
  plan: ApplyExecutionPlan,
  routeInputs: ReturnType<typeof routingInputs>,
): Array<Record<string, unknown>> {
  return plan.units.map((unit) => {
    const prompt = unit.prompt || unit.description || unit.id;
    try {
      const selection = buildSelectionUnit({
        cwd,
        host,
        key: unit.id,
        description: unit.description || unit.id,
        prompt,
        cards: routeInputs.cards,
        automaticCards: cardsForAutomaticSelection(cwd, routeInputs.automaticCards, prompt, host, env),
        codingModels: routeInputs.codingModels,
        probeRouteIds: [],
        env,
        requestedModelId: null,
        directorLocal: false,
        metadata: { compiled_apply: true, unit_id: unit.id },
      });
      return selectionReport(unit, selection, routeInputs.codingModels);
    } catch (error) {
      const exclusions = routeInputs.codingModels.map((model) => ({
        model_id: model,
        route_id: model,
        codes: ["ROUTE_ABSENT_FROM_ACTIVE_CATALOG"],
        reasons: [errorMessage(error)],
      }));
      return {
        unit_id: unit.id,
        minimum_requirements: null,
        qualification_status: "no-qualified-candidate",
        selected_configured_priority_position: null,
        candidates: [],
        no_qualified_result: { code: "NO_QUALIFIED_CANDIDATE", configured_route_ids: [...routeInputs.codingModels], exclusions },
        error: { code: errorCode(error, "ROUTE_CATALOG_UNAVAILABLE"), message: errorMessage(error) },
      };
    }
  });
}

export function selectedPriority(selection: SelectionUnit, codingModels: string[]): Record<string, unknown> | null {
  const chosen = selection.candidates.find((candidate) => candidate.automatic_eligible)
    || selection.candidates.find((candidate) => candidate.selectable)
    || null;
  if (!chosen) return null;
  const index = codingModels.findIndex((id) => id === chosen.route_id || id === chosen.model_id);
  return {
    model_id: chosen.model_id,
    route_id: chosen.route_id,
    index,
    position: index < 0 ? null : index + 1,
  };
}

export function selectionReport(unit: ApplyExecutionPlan["units"][number], selection: SelectionUnit, codingModels: string[]): Record<string, unknown> {
  return {
    unit_id: unit.id,
    minimum_requirements: selection.minimum_requirements || null,
    qualification_status: selection.qualification_status || (selection.candidates.some((candidate) => candidate.automatic_eligible) ? "qualified" : "no-qualified-candidate"),
    selected_configured_priority_position: selectedPriority(selection, codingModels),
    candidates: selection.candidates,
    no_qualified_result: selection.no_qualified_result || null,
    task_exclusions: selection.task_exclusions,
  };
}

export function currentAvailability(cwd: string, host: HostId, env: NodeJS.ProcessEnv, routeIds: string[]): {
  current_session: Array<Record<string, unknown>>;
  legacy_historical_records: Array<Record<string, unknown>>;
} {
  const sessionUid = requireSession(env);
  const store = readModelAvailability(cwd, env);
  const currentSession = routeIds.map((routeId) => {
    try {
      const state = availabilityForRoute(cwd, { host, routeId }, new Date(), env);
      return { route_id: routeId, ...state, current_session: true, gating: true };
    } catch (error) {
      return { route_id: routeId, current_session: true, gating: true, status: "unknown", reason: errorMessage(error) };
    }
  });
  const records = store.records
    .filter((item) => item.session_uid === sessionUid && item.host === host && routeIds.includes(item.route_id))
    .sort((left, right) => left.route_id.localeCompare(right.route_id));
  const byRoute = new Map(currentSession.map((item) => [String(item.route_id), item]));
  for (const item of records) byRoute.set(item.route_id, { ...item, current_session: true, gating: true });
  return {
    current_session: [...byRoute.values()].sort((left, right) => String(left.route_id).localeCompare(String(right.route_id))),
    legacy_historical_records: store.historical_records.map((item) => ({ ...item, legacy_historical: true, historical: true, gating: false })).sort((left, right) => String(left.route_id).localeCompare(String(right.route_id))),
  };
}

export async function sourceStatus(cwd: string, host: HostId, env: NodeJS.ProcessEnv, plan: ApplyExecutionPlan): Promise<Record<string, unknown>> {
  const expected = {
    repo_root: path.resolve(plan.source_snapshot.repo_root),
    revision: plan.source_snapshot.revision,
    tasks_path: plan.source_snapshot.tasks_path ? resolveInvocationPath(cwd, plan.source_snapshot.tasks_path) : null,
    fingerprint: plan.source_snapshot.fingerprint || null,
  };
  try {
    const instructions = resolveInstructions(cwd, plan, plan.identity.change_id, env);
    const request = sourceRequest(cwd, plan, instructions);
    const current = await captureCompiledApplySourceFacts(request);
    const differences: string[] = [];
    if (current.repo_root !== expected.repo_root) differences.push("repo_root");
    if (expected.revision && current.repository.head !== expected.revision) differences.push("revision");
    if (expected.fingerprint && current.fingerprint !== expected.fingerprint) differences.push("fingerprint");
    if (expected.tasks_path && current.open_spec.task_ledger?.path && !samePath(current.open_spec.task_ledger.path, expected.tasks_path, cwd)) differences.push("tasks_path");
    return {
      identity: { repo_root: current.repo_root, revision: current.repository.head, fingerprint: current.fingerprint, task_ledger: current.open_spec.task_ledger },
      expected,
      valid: differences.length === 0,
      differences,
      source: openSpecSummary(current),
    };
  } catch (error) {
    return { identity: null, expected, valid: false, differences: [errorCode(error, "SOURCE_CAPTURE_UNAVAILABLE")], error: { code: errorCode(error, "SOURCE_CAPTURE_UNAVAILABLE"), message: errorMessage(error) } };
  }
}


export async function statusResult(input: CompiledApplyInvocation, host: HostId): Promise<CompiledApplyCliResult> {
  const runId = text(input.run || input.run_id);
  if (!runId) throw new CompiledApplyCliError("RUN_ID_MISMATCH", "RUN_ID_MISMATCH: --run is required");
  const sessionUid = requireSession(input.env);
  const { state, plan } = runWithFacts(input.cwd, runId, input.env);
  if (state.host !== host) throw new CompiledApplyCliError("RUN_HOST_MISMATCH", "RUN_HOST_MISMATCH: run host differs from requested host");
  if (state.session_uid !== sessionUid) throw new CompiledApplyCliError("SESSION_SCOPE_MISMATCH", "SESSION_SCOPE_MISMATCH: run belongs to another Baton session");
  if (input.change && canonicalChange(input.change) !== canonicalChange(state.change)) throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: requested change differs from run");
  const route = routingInputs(input.cwd, host, input.env);
  const capacity = dispatchSnapshot(input.cwd, { host, env: input.env, capacity: route.capacity });
  const safePlan = structuredClone(plan) as ApplyExecutionPlan;
  for (const unit of safePlan.units) {
    const status = state.unit_state[unit.id]?.status;
    unit.runtime_state = status === "accepted" || status === "reconciled" ? "succeeded" : status === "undispatched" ? "planned" : status === "reserved" || status === "running" || status === "terminal-unreleased" ? "running" : status as ApplyExecutionPlan["units"][number]["runtime_state"];
  }
  for (const gate of safePlan.parent_gates || []) {
    const status = state.gate_state[gate.id]?.status;
    gate.runtime_state = status === "accepted" || status === "reconciled" ? "succeeded" : status === "undispatched" ? "planned" : status === "reserved" || status === "running" || status === "terminal-unreleased" ? "running" : status as ApplyExecutionPlan["parent_gates"][number]["runtime_state"];
  }
  const safeFrontier = deriveSafeReadyFrontier(safePlan, { capacity: capacity.available, activeOwnership: ownershipForStatus(input.cwd, input.env) });
  const tickets = listSpawns(input.cwd, input.env)
    .filter((ticket) => ticket.compiled_apply_lineage?.run_id === runId && ticket.session_uid === state.session_uid && (ticket.target_host || ticket.host || "") === state.host)
    .sort((left, right) => left.id.localeCompare(right.id));
  const linked = tickets.map(ticketIdentity);
  const selections = statusSelections(input.cwd, host, input.env, plan, route);
  const availability = currentAvailability(input.cwd, host, input.env, route.codingModels);
  const fixed = Object.entries(state.unit_state).filter(([, item]) => item.status !== "undispatched").map(([id]) => id).sort();
  const replaceable = Object.entries(state.unit_state).filter(([, item]) => item.status === "undispatched").map(([id]) => id).sort();
  const fixedGates = Object.entries(state.gate_state).filter(([, item]) => item.status !== "undispatched").map(([id]) => id).sort();
  const replaceableGates = Object.entries(state.gate_state).filter(([, item]) => item.status === "undispatched").map(([id]) => id).sort();
  const unitLifecycle = Object.fromEntries(Object.entries(state.unit_state).sort(([a], [b]) => a.localeCompare(b)).map(([id, item]) => [id, {
    status: item.status,
    ticket_ids: [...item.ticket_ids].sort(),
    fixed: item.status !== "undispatched",
    replaceable: item.status === "undispatched",
    frozen_plan_facts: item.frozen_plan_facts,
    frozen_execution_facts: item.frozen_execution_facts,
  }]));
  const gateLifecycle = Object.fromEntries(Object.entries(state.gate_state).sort(([a], [b]) => a.localeCompare(b)).map(([id, item]) => [id, {
    status: item.status,
    ticket_ids: [...item.ticket_ids].sort(),
    fixed: item.status !== "undispatched",
    replaceable: item.status === "undispatched",
    frozen_plan_facts: item.frozen_plan_facts,
    frozen_execution_facts: item.frozen_execution_facts,
  }]));
  const taskLifecycle = Object.fromEntries(Object.entries(state.task_state).sort(([a], [b]) => a.localeCompare(b)).map(([id, item]) => [id, {
    status: item.status,
    ticket_ids: [...item.ticket_ids].sort(),
    fixed: item.status !== "undispatched",
    replaceable: item.status === "undispatched",
    frozen_execution_facts: item.frozen_execution_facts,
  }]));
  return {
    code: "COMPILED_APPLY_STATUS",
    operation: "status",
    mode: "status",
    run_id: state.run_id,
    change: state.change,
    host: state.host,
    session_uid: state.session_uid,
    revision: state.current_revision,
    fingerprint: state.current_fingerprint,
    source: await sourceStatus(input.cwd, host, input.env, plan),
    fixed_units: fixed,
    replaceable_units: replaceable,
    fixed_vs_replaceable: { fixed_units: fixed, replaceable_units: replaceable },
    unit_lifecycle: unitLifecycle,
    gate_lifecycle: gateLifecycle,
    task_lifecycle: taskLifecycle,
    safe_frontier_candidates: safeFrontier,
    live_root_tree_capacity: capacity,
    capacity_trees: capacity,
    linked_ticket_lifecycle: linked,
    linked_ticket_ids: [...new Set([...state.linked_ticket_ids, ...linked.map((item) => String(item.ticket_id))])].sort(),
    native_handle_lifecycle: linked.map((item) => ({ ticket_id: item.ticket_id, execution_handle: item.execution_handle, native_handle: item.native_handle, liveness: item.liveness })),
    model_routing: selections,
    current_session_availability: availability.current_session,
    current_session_quota: availability.current_session,
    legacy_historical_records: availability.legacy_historical_records,
    fixed_gates: fixedGates,
    replaceable_gates: replaceableGates,
    blockers: selections.filter((item) => item.qualification_status === "no-qualified-candidate" || item.error).map((item) => ({ unit_id: item.unit_id, no_qualified_result: item.no_qualified_result, error: item.error || null })),
    state: { reconciled: state.reconciled, selected_tasks: [...state.selected_tasks], linked_ticket_ids: [...state.linked_ticket_ids] },
  };
}

export function humanStatus(result: CompiledApplyCliResult): string {
  const source = record(result.source) ? result.source : {};
  const sourceState = record(source) ? (source.valid === true ? "valid" : "invalid") : "unknown";
  const capacity = record(result.live_root_tree_capacity) ? result.live_root_tree_capacity : {};
  const fixed = Array.isArray(result.fixed_units) ? result.fixed_units.join(", ") || "none" : "none";
  const replaceable = Array.isArray(result.replaceable_units) ? result.replaceable_units.join(", ") || "none" : "none";
  const frontier = Array.isArray(result.safe_frontier_candidates) ? result.safe_frontier_candidates.join(", ") || "none" : "none";
  const lines = [
    `compiled apply ${String(result.run_id)} revision=${String(result.revision)} fingerprint=${String(result.fingerprint)}`,
    `  change=${String(result.change)} host=${String(result.host)} session=${String(result.session_uid)}`,
    `  source=${sourceState}; fixed=${fixed}; replaceable=${replaceable}; safe frontier=${frontier}`,
    `  capacity active=${String(capacity.active ?? "?")} available=${String(capacity.available ?? "?")} limit=${String(capacity.capacity ?? "?")}`,
  ];
  const units = record(result.unit_lifecycle) ? result.unit_lifecycle : {};
  for (const [id, item] of Object.entries(units)) {
    const status = record(item) ? String(item.status) : "unknown";
    lines.push(`  unit ${id}: ${status}`);
  }
  if (Array.isArray(result.blockers) && result.blockers.length) lines.push(`  blockers: ${result.blockers.map((item) => record(item) ? `${String(item.unit_id)} no-qualified` : String(item)).join("; ")}`);
  const routing = Array.isArray(result.model_routing) ? result.model_routing : [];
  for (const item of routing) {
    if (!record(item)) continue;
    const candidates = Array.isArray(item.candidates) ? item.candidates : [];
    const reasons = candidates.map((candidate) => {
      if (!record(candidate)) return String(candidate);
      return `${String(candidate.model_id)}=${String(candidate.diagnostic_code || candidate.selection_code || candidate.availability_status || "unknown")}`;
    });
    lines.push(`  models ${String(item.unit_id)}: ${reasons.join(", ") || "none configured/visible"}`);
  }
  if (Array.isArray(result.legacy_historical_records) && result.legacy_historical_records.length) lines.push(`  legacy historical availability=${result.legacy_historical_records.length} (evidence only; non-gating)`);
  return `${lines.join("\n")}\n`;
}
