/**
 * Production transport for the director-compiled `apply` protocol.
 *
 * The CLI owns argument parsing, while this module owns the small amount of
 * orchestration needed to connect a parsed invocation to the already existing
 * source, run, selection, dispatch, gate, and reconciliation APIs.  In
 * particular, this module never edits an OpenSpec artifact for a worker.
 */
import fs from "node:fs";
import path from "node:path";
import type { CompiledApplyInvocation } from "../cli.js";
import {
  ingestInitialApplyExecutionPlan,
  ingestSuccessorApplyExecutionPlan,
  materializeCompiledApplyFrontier,
  type CompiledApplyFrontierResult,
  type CompiledApplyIngestionResult,
} from "./compiled-apply.js";
import {
  deriveSafeReadyFrontier,
  type ApplyExecutionPlan,
  type ApplyPlanActiveOwnership,
} from "./apply-plan.js";
import {
  captureCompiledApplySourceFacts,
  type ApplySourceCaptureRequest,
  type CompiledApplySourceFacts,
} from "./apply-source.js";
import {
  deriveApplyTaskEligibility,
  reconcileApplyRun,
  acceptApplyGate,
  type ApplyTaskEligibility,
} from "./apply-reconcile.js";
import {
  readApplyRun,
  readApplyRunPlanBody,
  type ApplyRunState,
  type ApplyRunTicketFact,
} from "./apply-run.js";
import {
  resolveOpenSpecApplyInstructions,
  openspecCliAvailable,
  type OpenSpecApplyInstructions,
} from "./openspec.js";
import { resolveRuntimeHost, type HostId } from "./hosts.js";
import {
  configuredCodingModelsForHost,
  effectiveMaxConcurrentForHost,
  loadConfig,
} from "./config.js";
import { buildRouteCandidates } from "./routes.js";
import { cardsForAutomaticSelection } from "./route-health.js";
import {
  buildSelectionUnit,
  type SelectionCandidate,
  type SelectionUnit,
} from "./selection.js";
import { readModelAvailability, availabilityForRoute } from "./model-availability.js";
import { dispatchSnapshot } from "./dispatch.js";
import { listSpawns, type SpawnTicket } from "./spawn.js";
import { readReceipt } from "./receipt.js";
import { sessionScope } from "./session-scope.js";
import type { ModelCard } from "../types.js";

export interface CompiledApplyCliResult {
  code: string;
  operation: CompiledApplyInvocation["operation"];
  mode: CompiledApplyInvocation["mode"];
  run_id?: string;
  change?: string;
  host?: string;
  session_uid?: string;
  revision?: string;
  fingerprint?: string;
  [key: string]: unknown;
}

class CompiledApplyCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompiledApplyCliError";
    this.code = code;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => text(value)).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function errorCode(error: unknown, fallback: string): string {
  return record(error) && typeof error.code === "string" && error.code.trim() ? error.code : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coded(error: unknown, fallback: string): CompiledApplyCliError {
  const code = errorCode(error, fallback);
  const message = errorMessage(error);
  if (message.startsWith(`${code}:`)) return new CompiledApplyCliError(code, message);
  return new CompiledApplyCliError(code, `${code}: ${message}`);
}

function requireHost(input: CompiledApplyInvocation): HostId {
  try {
    return resolveRuntimeHost({ cwd: input.cwd, env: input.env, explicitHost: input.host });
  } catch (error) {
    throw coded(error, "HOST_REQUIRED");
  }
}

function requireSession(env: NodeJS.ProcessEnv): string {
  try {
    return sessionScope(env).session_uid;
  } catch (error) {
    throw coded(error, "SESSION_SCOPE_REQUIRED");
  }
}

function canonicalChange(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function samePath(left: string, right: string, cwd: string): boolean {
  try {
    return fs.realpathSync(resolveInvocationPath(cwd, left)) === fs.realpathSync(resolveInvocationPath(cwd, right));
  } catch {
    return resolveInvocationPath(cwd, left) === resolveInvocationPath(cwd, right);
  }
}

function resolveInvocationPath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

function requirePlan(input: CompiledApplyInvocation): ApplyExecutionPlan {
  if (typeof input.plan !== "string" || !input.plan.trim()) {
    throw new CompiledApplyCliError("COMPILED_APPLY_PLAN_REQUIRED", "COMPILED_APPLY_PLAN_REQUIRED: --plan-file did not provide a plan");
  }
  try {
    // The ingestion API performs the same validation.  Parsing here gives the
    // CLI a chance to resolve identity before any source capture occurs.
    return JSON.parse(input.plan) as ApplyExecutionPlan;
  } catch (error) {
    throw coded(error, "INVALID_JSON");
  }
}

function planUnitReads(unit: ApplyExecutionPlan["units"][number]): string[] {
  const raw = unit as unknown as Record<string, unknown>;
  const values = [raw.read_context, raw.readContext, raw.read_paths, raw.readPaths, raw.read_inputs, raw.readInputs];
  return sorted(values.flatMap((value) => Array.isArray(value) ? value.map(String) : []));
}

function sourceRequest(
  cwd: string,
  plan: ApplyExecutionPlan,
  instructions: OpenSpecApplyInstructions,
): ApplySourceCaptureRequest {
  const contextFiles = instructions.contextFiles.map((file) => ({
    ...(file.artifact ? { artifact: file.artifact } : {}),
    path: file.path,
    sha256: file.sha256,
  }));
  const sourceRoot = path.resolve(plan.source_snapshot.repo_root);
  const currentRoot = path.resolve(cwd);
  if (sourceRoot !== currentRoot) {
    throw new CompiledApplyCliError(
      "APPLY_PLAN_REPOSITORY_MISMATCH",
      `APPLY_PLAN_REPOSITORY_MISMATCH: plan repo_root ${sourceRoot} does not match invocation root ${currentRoot}`,
    );
  }
  const selected = new Set(plan.selected_tasks);
  const pending = new Set(instructions.pendingTaskNumbers);
  const missing = [...selected].filter((task) => !pending.has(task)).sort();
  if (missing.length) {
    throw new CompiledApplyCliError(
      "APPLY_PLAN_TASK_NOT_PENDING",
      `APPLY_PLAN_TASK_NOT_PENDING: selected tasks are no longer pending: ${missing.join(", ")}`,
    );
  }
  if (plan.source_snapshot.tasks_path && !samePath(plan.source_snapshot.tasks_path, instructions.taskLedger.path, cwd)) {
    throw new CompiledApplyCliError(
      "APPLY_PLAN_TASK_LEDGER_MISMATCH",
      "APPLY_PLAN_TASK_LEDGER_MISMATCH: plan task ledger differs from OpenSpec instructions",
    );
  }
  return {
    repo_root: sourceRoot,
    open_spec: {
      context_files: contextFiles,
      context_file_hashes: Object.fromEntries(Object.entries(instructions.contextFileHashes).sort(([a], [b]) => a.localeCompare(b))),
      selected_task_snapshot_fingerprint: instructions.selectedTaskSnapshotFingerprint,
      selected_task_numbers: [...instructions.selectedTaskNumbers].sort(),
      selected_tasks: instructions.selectedTasks,
      task_ledger: instructions.taskLedger,
      task_ledger_identity: instructions.taskLedgerIdentity,
    tasks_path: resolveInvocationPath(cwd, instructions.taskLedger.path),
      schema: instructions.schema,
      change_name: instructions.changeName,
    },
    units: plan.units.map((unit) => ({
      id: unit.id,
      read_paths: planUnitReads(unit),
      write_paths: [...(unit.write_paths || [])],
    })),
  };
}

function resolveInstructions(cwd: string, plan: ApplyExecutionPlan, requestedChange: string | null, env: NodeJS.ProcessEnv = process.env): OpenSpecApplyInstructions {
  const planChange = text(plan.identity.change_id);
  if (!planChange) throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: plan identity.change_id is empty");
  if (requestedChange && canonicalChange(requestedChange) !== canonicalChange(planChange)) {
    throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: requested change does not match plan identity");
  }
  try {
    const cli = openspecCliAvailable(env);
    if (!cli) throw new CompiledApplyCliError("APPLY_INSTRUCTIONS_FAILED", "APPLY_INSTRUCTIONS_FAILED: OpenSpec CLI is not available");
    const instructions = resolveOpenSpecApplyInstructions(cwd, planChange, { cli });
    if (canonicalChange(instructions.changeName) !== canonicalChange(planChange)) {
      throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: OpenSpec returned a different change");
    }
    return instructions;
  } catch (error) {
    if (error instanceof CompiledApplyCliError) throw error;
    throw coded(error, "APPLY_INSTRUCTIONS_FAILED");
  }
}

function routingInputs(cwd: string, host: HostId, env: NodeJS.ProcessEnv): {
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

function openSpecSummary(source: CompiledApplySourceFacts | null): Record<string, unknown> | null {
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

function compactFrontier(result: CompiledApplyFrontierResult): Record<string, unknown> {
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

function ticketIdentity(ticket: SpawnTicket): Record<string, unknown> {
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

function ticketFactsForRun(cwd: string, state: ApplyRunState, env: NodeJS.ProcessEnv): ApplyRunTicketFact[] {
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

function ownershipForStatus(cwd: string, env: NodeJS.ProcessEnv): ApplyPlanActiveOwnership[] {
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

function runWithFacts(cwd: string, runId: string, env: NodeJS.ProcessEnv): { state: ApplyRunState; plan: ApplyExecutionPlan; facts: ApplyRunTicketFact[] } {
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

function statusSelections(
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

function selectedPriority(selection: SelectionUnit, codingModels: string[]): Record<string, unknown> | null {
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

function selectionReport(unit: ApplyExecutionPlan["units"][number], selection: SelectionUnit, codingModels: string[]): Record<string, unknown> {
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

function currentAvailability(cwd: string, host: HostId, env: NodeJS.ProcessEnv, routeIds: string[]): {
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

async function sourceStatus(cwd: string, host: HostId, env: NodeJS.ProcessEnv, plan: ApplyExecutionPlan): Promise<Record<string, unknown>> {
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

async function statusResult(input: CompiledApplyInvocation, host: HostId): Promise<CompiledApplyCliResult> {
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

function humanStatus(result: CompiledApplyCliResult): string {
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

function stablePlanResult(input: CompiledApplyInvocation, host: HostId, result: CompiledApplyIngestionResult, frontier: Record<string, unknown> | null): CompiledApplyCliResult {
  return {
    code: result.mode === "initial" ? "COMPILED_APPLY_INITIAL_PERSISTED" : "COMPILED_APPLY_SUCCESSOR_PERSISTED",
    operation: "plan",
    mode: result.mode,
    run_id: result.run.run_id,
    change: result.run.change,
    host: result.run.host,
    session_uid: result.run.session_uid,
    revision: result.run.current_revision,
    fingerprint: result.run.current_fingerprint,
    identity: { run_id: result.run.run_id, change: result.run.change, host: result.run.host, session_uid: result.run.session_uid, revision: result.run.current_revision, fingerprint: result.run.current_fingerprint },
    source: openSpecSummary(result.source),
    persisted: { code: result.mode === "initial" ? "RUN_INITIAL_PERSISTED" : "RUN_SUCCESSOR_PERSISTED", run_id: result.run.run_id, revision: result.run.current_revision, fingerprint: result.run.current_fingerprint },
    parent: result.mode === "successor" ? { revision: result.run.revisions.at(-1)?.parent_revision || null, fingerprint: result.run.revisions.at(-1)?.parent_fingerprint || null } : null,
    frontier,
    run: result.run,
    plan: { plan_id: result.plan.identity.plan_id, change_id: result.plan.identity.change_id, selected_tasks: [...result.plan.selected_tasks], unit_ids: result.plan.units.map((unit) => unit.id).sort() },
    requested_dispatch: input.dispatch,
    selected_host: host,
  };
}

async function persistPlan(input: CompiledApplyInvocation, host: HostId): Promise<CompiledApplyCliResult> {
  const plan = requirePlan(input);
  let validated: ApplyExecutionPlan;
  try {
    // Keep validation in the ingestion boundary, but fail with a stable CLI
    // code before resolving OpenSpec when the JSON shape is plainly invalid.
    validated = (await import("./apply-plan.js")).assertValidApplyExecutionPlan(plan);
  } catch (error) {
    throw coded(error, "INVALID_PLAN");
  }
  const instructions = resolveInstructions(input.cwd, validated, input.change, input.env);
  const source = sourceRequest(input.cwd, validated, instructions);
  if (input.mode === "successor") {
    const runId = text(input.run || input.run_id);
    if (runId && validated.identity.plan_id !== runId) {
      throw new CompiledApplyCliError(
        "RUN_ID_MISMATCH",
        "RUN_ID_MISMATCH: successor plan identity.plan_id does not match --run",
      );
    }
    const parent = text(validated.revision_lineage?.parent);
    if (!parent) {
      throw new CompiledApplyCliError(
        "RUN_PARENT_MISMATCH",
        "RUN_PARENT_MISMATCH: successor plan must declare revision_lineage.parent",
      );
    }
    let current: ApplyRunState;
    try {
      current = readApplyRun(input.cwd, runId || "", { env: input.env });
    } catch (error) {
      throw coded(error, "RUN_NOT_FOUND");
    }
    if (parent !== current.current_revision) {
      throw new CompiledApplyCliError(
        "RUN_PARENT_MISMATCH",
        `RUN_PARENT_MISMATCH: successor parent ${parent} does not match current revision ${current.current_revision}`,
      );
    }
    // The parent fingerprint is deliberately read from the current run, not
    // trusted from plan JSON.  appendApplyRun receives and checks this exact
    // value under its lock, so a stale concurrent successor cannot advance the
    // run even when its revision number happens to match.
  }
  let persisted: CompiledApplyIngestionResult;
  try {
    persisted = input.mode === "successor"
      ? await ingestSuccessorApplyExecutionPlan({ cwd: input.cwd, env: input.env, host, runId: input.run || input.run_id || undefined, change: validated.identity.change_id, plan: validated, sourceRequest: source })
      : await ingestInitialApplyExecutionPlan({ cwd: input.cwd, env: input.env, host, runId: validated.identity.plan_id, change: validated.identity.change_id, plan: validated, sourceRequest: source });
  } catch (error) {
    throw coded(error, input.mode === "successor" ? "RUN_SUCCESSOR_REJECTED" : "RUN_INITIAL_REJECTED");
  }
  let frontier: Record<string, unknown> | null = null;
  if (input.dispatch) {
    try {
      const route = routingInputs(input.cwd, host, input.env);
      const result = await materializeCompiledApplyFrontier({ cwd: input.cwd, env: input.env, host, runId: persisted.run.run_id, capacity: route.capacity, cards: route.cards, automaticCards: route.automaticCards, codingModels: route.codingModels });
      frontier = compactFrontier(result);
    } catch (error) {
      throw coded(error, "COMPILED_APPLY_FRONTIER_FAILED");
    }
  }
  return stablePlanResult(input, host, persisted, frontier);
}

function acceptGateResult(input: CompiledApplyInvocation, host: HostId): CompiledApplyCliResult {
  const runId = text(input.run || input.run_id);
  if (!runId || !input.accept_gate) throw new CompiledApplyCliError("GATE_IDENTITY_MISMATCH", "GATE_IDENTITY_MISMATCH: run and gate are required");
  const { state } = runWithFacts(input.cwd, runId, input.env);
  const sessionUid = requireSession(input.env);
  if (state.host !== host) throw new CompiledApplyCliError("RUN_HOST_MISMATCH", "RUN_HOST_MISMATCH: run host differs from requested host");
  if (state.session_uid !== sessionUid) throw new CompiledApplyCliError("SESSION_SCOPE_MISMATCH", "SESSION_SCOPE_MISMATCH: run belongs to another Baton session");
  if (input.change && canonicalChange(input.change) !== canonicalChange(state.change)) throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: requested change differs from run");
  const evidence = text(input.text).replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 240);
  if (!evidence) throw new CompiledApplyCliError("GATE_IDENTITY_MISMATCH", "GATE_IDENTITY_MISMATCH: gate evidence is empty");
  let accepted: ReturnType<typeof acceptApplyGate>;
  try {
    accepted = acceptApplyGate({ cwd: input.cwd, env: input.env, host, runId, gateId: input.accept_gate, revision: state.current_revision, fingerprint: state.current_fingerprint, evidence });
  } catch (error) {
    throw coded(error, "GATE_ACCEPT_REJECTED");
  }
  return {
    code: "COMPILED_APPLY_GATE_ACCEPTED",
    operation: "accept-gate",
    mode: "accept-gate",
    run_id: accepted.run_id,
    change: state.change,
    host: state.host,
    session_uid: state.session_uid,
    revision: accepted.revision,
    fingerprint: accepted.fingerprint,
    gate: { id: accepted.id, accepted: accepted.accepted, evidence: accepted.evidence, code: accepted.code || null },
    identity: { run_id: accepted.run_id, gate_id: accepted.id, revision: accepted.revision, fingerprint: accepted.fingerprint },
    requested_dispatch: false,
  };
}

function reconcileResult(input: CompiledApplyInvocation, host: HostId): CompiledApplyCliResult {
  const runId = text(input.run || input.run_id);
  if (!runId) throw new CompiledApplyCliError("RUN_ID_MISMATCH", "RUN_ID_MISMATCH: --run is required");
  const { state, plan } = runWithFacts(input.cwd, runId, input.env);
  const sessionUid = requireSession(input.env);
  if (state.host !== host) throw new CompiledApplyCliError("RUN_HOST_MISMATCH", "RUN_HOST_MISMATCH: run host differs from requested host");
  if (state.session_uid !== sessionUid) throw new CompiledApplyCliError("SESSION_SCOPE_MISMATCH", "SESSION_SCOPE_MISMATCH: run belongs to another Baton session");
  if (input.change && canonicalChange(input.change) !== canonicalChange(state.change)) throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: requested change differs from run");
  const tasksPath = plan.source_snapshot.tasks_path
    ? resolveInvocationPath(input.cwd, plan.source_snapshot.tasks_path)
    : path.join(input.cwd, "openspec", "changes", state.change, "tasks.md");
  let eligibility: ApplyTaskEligibility[];
  try {
    eligibility = deriveApplyTaskEligibility({ cwd: input.cwd, env: input.env, runId, tasksPath, task: input.task || undefined });
  } catch (error) {
    throw coded(error, "RECONCILE_ELIGIBILITY_FAILED");
  }
  let reconciled;
  const evidence = `reconciled run ${runId} revision ${state.current_revision}`;
  try {
    reconciled = reconcileApplyRun({ cwd: input.cwd, env: input.env, runId, tasksPath, task: input.task || undefined, evidence });
  } catch (error) {
    throw coded(error, "RECONCILE_FAILED");
  }
  const conclusions = Object.fromEntries(reconciled.task_ids.map((task) => [task, evidence]));
  return {
    code: "COMPILED_APPLY_RECONCILED",
    operation: "reconcile",
    mode: "reconcile",
    run_id: reconciled.run_id,
    change: state.change,
    host: state.host,
    session_uid: state.session_uid,
    revision: state.current_revision,
    fingerprint: state.current_fingerprint,
    reconciled: reconciled.reconciled,
    task_ids: [...reconciled.task_ids].sort(),
    eligibility,
    conclusions,
    ledger: reconciled.ledger,
    identity: { run_id: state.run_id, change: state.change, host: state.host, session_uid: state.session_uid, revision: state.current_revision, fingerprint: state.current_fingerprint },
  };
}

/** Execute one parsed compiled-apply invocation using production APIs. */
export async function runCompiledApplyInvocation(input: CompiledApplyInvocation): Promise<CompiledApplyCliResult | string> {
  const host = requireHost(input);
  if (input.operation === "plan") return await persistPlan(input, host);
  if (input.mode === "status" || input.operation === "status") {
    const result = await statusResult(input, host);
    return input.json ? result : humanStatus(result);
  }
  if (input.mode === "accept-gate" || input.operation === "accept-gate") return acceptGateResult(input, host);
  return reconcileResult(input, host);
}

/** Stable production default retained as a replaceable test boundary in cli.ts. */
export const defaultCompiledApplyHandler = runCompiledApplyInvocation;
export const createDefaultCompiledApplyHandler = (): typeof runCompiledApplyInvocation => runCompiledApplyInvocation;
