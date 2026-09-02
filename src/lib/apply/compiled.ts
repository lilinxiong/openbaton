/**
 * The small orchestration boundary for the director-compiled apply protocol.
 *
 * This module intentionally does not contain semantic planning.  It accepts a
 * plan, proves that the source remained stable while the run was persisted,
 * and turns one safe ready frontier into ordinary Baton tickets.
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyPlanFingerprint,
  assertValidApplyExecutionPlan,
  deriveSafeReadyFrontier,
  deriveDependencyReadyUndispatchedUnits,
  type ApplyExecutionPlan,
  type ApplyPlanActiveOwnership,
  type ApplyPlanScopeFact,
} from "../apply-plan.js";
import {
  acceptCompiledApplySource,
  captureCompiledApplySourceFacts,
  type ApplySourceAcceptanceResult,
  type ApplySourceCaptureRequest,
  type CompiledApplySourceFacts,
} from "../apply-source.js";
import {
  appendApplyRun,
  createApplyRun,
  persistApplyRunTicketFacts,
  readApplyRun,
  readApplyRunPlanBody,
  type ApplyRunState,
  type ApplyRunTicketFact,
} from "./run.js";
import {
  buildSelectionUnit,
  type SelectionCandidate,
  type SelectionUnit,
} from "../selection.js";
import { buildRouteCandidates } from "../routes.js";
import { cardsForAutomaticSelection } from "../route-health.js";
import { configuredCodingModelsForHost, effectiveMaxConcurrentForHost, loadConfig } from "../config.js";
import { resolveAgentTreeCapacity } from "../agent-tree-capacity.js";
import { sessionScope } from "../session-scope.js";
import {
  buildReadOnlyReceipt,
  readReceipt,
} from "../receipt.js";
import {
  buildSpawnTicket,
  listSpawns,
  nextSpawnIds,
  type SpawnTicket,
  type StandalonePlan,
} from "../spawn.js";
import {
  assertWriteScopesAvailable,
  materializeStandalonePlansBatchAsync,
  type TicketMaterializationBatchEntry,
  type TicketMaterializationBatchOptions,
} from "../ticket-materialization.js";
import type { ModelCard, ModelSelectionApproval } from "../../types.js";

export interface CompiledApplyIngestionOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  host: string;
  session_uid?: string;
  change?: string;
  runId?: string;
  run_id?: string;
  run?: string;
  planText?: string;
  plan_text?: string;
  plan?: ApplyExecutionPlan | string;
  /** The source request is the director's declared read context. */
  sourceRequest?: ApplySourceCaptureRequest;
  source_request?: ApplySourceCaptureRequest;
  source?: ApplySourceCaptureRequest | CompiledApplySourceFacts;
  expectedSource?: CompiledApplySourceFacts;
  expected?: CompiledApplySourceFacts;
  sourceSnapshot?: CompiledApplySourceFacts;
  captureSource?: () => Promise<CompiledApplySourceFacts> | CompiledApplySourceFacts;
  sourceCapture?: () => Promise<CompiledApplySourceFacts> | CompiledApplySourceFacts;
  capture?: () => Promise<CompiledApplySourceFacts> | CompiledApplySourceFacts;
  ticket_facts?: ApplyRunTicketFact[];
  now?: Date | string | number;
}

export interface CompiledApplyIngestionResult {
  run: ApplyRunState;
  plan: ApplyExecutionPlan;
  source: CompiledApplySourceFacts;
  before: CompiledApplySourceFacts;
  after: CompiledApplySourceFacts;
  mode: "initial" | "successor";
}

export class CompiledApplyError extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.name = "CompiledApplyError"; this.code = code; }
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function samePath(cwd: string, left: string, right: string): boolean {
  const resolve = (value: string) => path.resolve(cwd, value);
  try { return fs.realpathSync(resolve(left)) === fs.realpathSync(resolve(right)); }
  catch { return resolve(left) === resolve(right); }
}
function planValue(input: ApplyExecutionPlan | string): ApplyExecutionPlan {
  if (typeof input === "string") {
    try { return assertValidApplyExecutionPlan(JSON.parse(input)); }
    catch (error) { throw error; }
  }
  return assertValidApplyExecutionPlan(input);
}

function sourceRequestFor(input: CompiledApplyIngestionOptions, plan: ApplyExecutionPlan): ApplySourceCaptureRequest {
  const supplied = input.sourceRequest || input.source_request || input.source;
  if (supplied) {
    const candidate = supplied as ApplySourceCaptureRequest & { repoRoot?: string };
    const repoRoot = candidate.repo_root || candidate.repoRoot || plan.source_snapshot.repo_root;
    const openSpec = candidate.open_spec || candidate.openSpec;
    const taskPath = openSpec && (openSpec.tasks_path || openSpec.tasksPath);
    return {
      ...candidate,
      repo_root: repoRoot,
      ...(openSpec && taskPath ? { open_spec: { ...openSpec, tasks_path: path.resolve(input.cwd, taskPath) } } : {}),
    } as ApplySourceCaptureRequest;
  }
  // A plan is still source-checkable without optional OpenSpec context.  The
  // caller can provide richer context through sourceRequest when it has it.
  const tasksPath = plan.source_snapshot.tasks_path;
  return {
    repo_root: plan.source_snapshot.repo_root,
    units: plan.units.map((unit) => ({ id: unit.id, write_paths: unit.write_paths || [] })),
    open_spec: { tasks_path: tasksPath ? path.resolve(input.cwd, tasksPath) : "" },
  };
}

function enrichPlanWithAcceptedSource(plan: ApplyExecutionPlan, source: CompiledApplySourceFacts): ApplyExecutionPlan {
  const snapshot = plan.source_snapshot;
  const taskLedgerPath = source.open_spec.task_ledger?.path;
  return assertValidApplyExecutionPlan({
    ...plan,
    source_snapshot: {
      ...snapshot,
      ...(text(snapshot.fingerprint) ? {} : { fingerprint: source.fingerprint }),
      ...(text(snapshot.tasks_path) || !taskLedgerPath ? {} : { tasks_path: taskLedgerPath }),
    },
  });
}

function assertIngestionIdentity(plan: ApplyExecutionPlan, input: CompiledApplyIngestionOptions, successor: boolean): { runId: string; env: NodeJS.ProcessEnv; current?: ApplyRunState } {
  const env = input.env || process.env;
  const host = text(input.host);
  if (!host) throw new CompiledApplyError("host is required", "RUN_HOST_MISMATCH");
  const session = sessionScope(env);
  const runId = text(input.runId || input.run_id || input.run || (successor ? "" : plan.identity.plan_id));
  if (!runId) throw new CompiledApplyError("run id is required", "RUN_ID_MISMATCH");
  const change = text(input.change);
  if (change && change !== plan.identity.change_id) throw new CompiledApplyError("plan change does not match requested change", "RUN_CHANGE_MISMATCH");
  // Keep this explicit: createApplyRun also checks the session, but doing the
  // identity checks before source capture prevents surprising filesystem work.
  if (!session.session_uid) throw new CompiledApplyError("Baton session identity is required", "SESSION_SCOPE_MISMATCH");
  if (input.session_uid && input.session_uid !== session.session_uid) throw new CompiledApplyError("request session does not match current Baton session", "SESSION_SCOPE_MISMATCH");
  if (successor) {
    const current = readApplyRun(input.cwd, runId, { env });
    if (current.host !== host) throw new CompiledApplyError("run host does not match requested host", "RUN_HOST_MISMATCH");
    if (current.change !== plan.identity.change_id) throw new CompiledApplyError("run change does not match plan", "RUN_CHANGE_MISMATCH");
    if (current.session_uid !== session.session_uid) throw new CompiledApplyError("run session does not match current Baton session", "SESSION_SCOPE_MISMATCH");
    const declaredParent = text(plan.revision_lineage?.parent);
    if (declaredParent && declaredParent !== current.current_revision) throw new CompiledApplyError("successor parent revision is stale", "RUN_PARENT_MISMATCH");
    return { runId, env, current };
  }
  return { runId, env };
}

async function ingest(input: CompiledApplyIngestionOptions, successor: boolean): Promise<CompiledApplyIngestionResult> {
  const plan = planValue(input.plan ?? input.planText ?? input.plan_text ?? "");
  const { runId, env, current } = assertIngestionIdentity(plan, input, successor);
  const suppliedSource = input.source;
  const sourceAsFacts = record(suppliedSource) && suppliedSource.schema_version === 1 && record(suppliedSource.repository)
    ? suppliedSource as unknown as CompiledApplySourceFacts : undefined;
  const expected = input.expectedSource || input.expected || input.sourceSnapshot || sourceAsFacts;
  const sourceRequest = sourceRequestFor(input, plan);
  const sourceCapture = input.captureSource || input.sourceCapture || input.capture || (() => captureCompiledApplySourceFacts(sourceRequest));
  let capturedFingerprint: string | undefined;
  const stableSourceCapture = async (): Promise<CompiledApplySourceFacts> => {
    const source = await sourceCapture();
    if (capturedFingerprint === undefined) capturedFingerprint = source.fingerprint;
    else if (source.fingerprint !== capturedFingerprint) {
      throw new CompiledApplyError("source fingerprint changed during capture", "APPLY_PLAN_STALE");
    }
    return source;
  };
  const verifySource = (source: CompiledApplySourceFacts): void => {
    if (source.repo_root !== plan.source_snapshot.repo_root) throw new CompiledApplyError("source repository does not match plan", "APPLY_PLAN_STALE");
    if (plan.source_snapshot.revision && source.repository.head !== plan.source_snapshot.revision) throw new CompiledApplyError("source revision does not match plan", "APPLY_PLAN_STALE");
    if (plan.source_snapshot.fingerprint && source.fingerprint !== plan.source_snapshot.fingerprint) {
      throw new CompiledApplyError("source fingerprint does not match plan", "APPLY_PLAN_STALE");
    }
    const declaredTasksPath = text(plan.source_snapshot.tasks_path);
    const acceptedTasksPath = text(source.open_spec.task_ledger?.path);
    if (declaredTasksPath && acceptedTasksPath && !samePath(input.cwd, declaredTasksPath, acceptedTasksPath)) {
      throw new CompiledApplyError("source task ledger does not match plan", "APPLY_PLAN_STALE");
    }
  };
  let persisted: ApplyRunState | undefined;
  let persistedPlan: ApplyExecutionPlan = plan;
  const accepted: ApplySourceAcceptanceResult<ApplyRunState> = await acceptCompiledApplySource({
    ...sourceRequest,
    expected,
    capture: stableSourceCapture,
    validate: (before) => verifySource(before),
    persistence: (after) => {
      verifySource(after);
      persistedPlan = enrichPlanWithAcceptedSource(plan, after);
      persisted = successor
        ? appendApplyRun({ cwd: input.cwd, env, runId, host: input.host, change: input.change, plan: persistedPlan, ticket_facts: input.ticket_facts, now: input.now,
          parent_revision: current!.current_revision,
          parent_fingerprint: current!.current_fingerprint })
        : createApplyRun({ cwd: input.cwd, env, runId, host: input.host, change: input.change, plan: persistedPlan, ticket_facts: input.ticket_facts, now: input.now });
      return persisted;
    },
  });
  if (!persisted) throw new CompiledApplyError("compiled apply run was not persisted", "RUN_PERSIST_FAILED");
  return { ...accepted, run: persisted, plan: persistedPlan, mode: successor ? "successor" : "initial" };
}

export async function ingestInitialApplyExecutionPlan(input: CompiledApplyIngestionOptions): Promise<CompiledApplyIngestionResult> { return ingest(input, false); }
export async function ingestSuccessorApplyExecutionPlan(input: CompiledApplyIngestionOptions): Promise<CompiledApplyIngestionResult> { return ingest(input, true); }

export interface CompiledApplyFrontierOptions {
  cwd: string;
  runId?: string;
  run_id?: string;
  run?: string;
  host: string;
  env?: NodeJS.ProcessEnv;
  capacity?: number;
  availableCapacity?: number;
  hostLimit?: number;
  configuredPolicy?: number;
  operationLimit?: number;
  cards?: ModelCard[];
  automaticCards?: ModelCard[];
  codingModels?: string[];
  probeRouteIds?: string[];
  ticket_facts?: ApplyRunTicketFact[];
  activeOwnership?: ApplyPlanActiveOwnership[];
  /** Tests and adapters may provide the already selected unit directly. */
  selectUnit?: (unit: SelectionUnit, planUnit: ApplyExecutionPlan["units"][number]) => SelectionCandidate | null;
  now?: Date;
  materialization?: Omit<TicketMaterializationBatchOptions, "env" | "onComplete">;
}

export interface CompiledApplyBlockedUnit { unit_id: string; selection: SelectionUnit; exclusion_matrix: NonNullable<SelectionUnit["no_qualified_result"]>; }
export interface CompiledApplyFrontierResult {
  run_id: string;
  revision: string;
  fingerprint: string;
  candidates: string[];
  selected: string[];
  materialized: SpawnTicket[];
  blocked: CompiledApplyBlockedUnit[];
  capacity: number;
  available_capacity: number;
  run: ApplyRunState;
}

function ticketFactsForRun(cwd: string, runId: string, state: ApplyRunState, env: NodeJS.ProcessEnv, provided: ApplyRunTicketFact[] = []): ApplyRunTicketFact[] {
  const facts = [...provided];
  const seen = new Set(facts.map((fact) => fact.ticket_id));
  for (const ticket of listSpawns(cwd, env)) {
    const lineage = ticket.compiled_apply_lineage;
    if (!lineage || lineage.run_id !== runId || ticket.session_uid !== state.session_uid || (ticket.target_host || ticket.host || "") !== state.host || seen.has(ticket.id)) continue;
    const status = ticket.status === "done" ? "closed" : ticket.status;
    if (!["queued", "dispatching", "running", "completed", "errored", "timed_out", "closed"].includes(status)) continue;
    facts.push({ ticket_id: ticket.id, status: status as ApplyRunTicketFact["status"], run_id: runId, host: state.host, session_uid: state.session_uid,
      unit_ids: [lineage.unit_id], task_ids: [...lineage.task_refs], model_id: ticket.model_id, receipt_id: ticket.receipt_id || undefined,
      result: ticket.conclusion || undefined, slot_released_at: ticket.slot_released_at || null });
    seen.add(ticket.id);
  }
  return facts;
}

function ownershipFromTickets(cwd: string, env: NodeJS.ProcessEnv, supplied: ApplyPlanActiveOwnership[] | undefined): ApplyPlanActiveOwnership[] {
  if (supplied) return supplied;
  const result: ApplyPlanActiveOwnership[] = [];
  for (const ticket of listSpawns(cwd, env)) {
    if (ticket.slot_released_at) continue;
    if (!["queued", "dispatching", "running", "completed", "errored", "timed_out", "closed"].includes(ticket.status)) continue;
    const receiptId = ticket.receipt_id;
    if (!receiptId) continue;
    try {
      const receipt = readReceipt(cwd, receiptId, env);
      const facts: ApplyPlanScopeFact[] = receipt.scope.write_allowlist.map((entry) => ({ unit_id: ticket.id, path: entry, kind: "path" }));
      if (facts.length) {
        const terminal = ["completed", "errored", "timed_out", "closed"].includes(ticket.status);
        result.push({ key: ticket.id, terminal, terminal_unreleased: terminal && !ticket.slot_released_at, slot_released_at: ticket.slot_released_at || null, facts });
      }
    } catch { /* malformed receipts are rejected by lifecycle validation */ }
  }
  return result;
}

function slotConsumed(status: string, slotReleasedAt?: string | null): boolean {
  return ["dispatching", "running"].includes(status)
    || (["completed", "errored", "timed_out", "closed"].includes(status) && !slotReleasedAt);
}

function activeCount(cwd: string, env: NodeJS.ProcessEnv, state: ApplyRunState, facts: ApplyRunTicketFact[]): number {
  const ids = new Set<string>();
  for (const ticket of listSpawns(cwd, env)) {
    const host = ticket.target_host || ticket.host || "";
    if (ticket.session_uid === state.session_uid && host === state.host && slotConsumed(ticket.status, ticket.slot_released_at)) ids.add(ticket.id);
  }
  for (const fact of facts) {
    if (fact.run_id && fact.run_id !== state.run_id) continue;
    if (fact.host && fact.host !== state.host) continue;
    if (fact.session_uid && fact.session_uid !== state.session_uid) continue;
    if (slotConsumed(fact.status, fact.slot_released_at)) ids.add(fact.ticket_id);
  }
  return ids.size;
}

function configuredCandidate(candidate: SelectionCandidate, codingModels: readonly string[]): boolean {
  return codingModels.some((configured) => configured === candidate.model_id
    || configured === candidate.route_id
    || configured.startsWith(`${candidate.route_id}@`));
}

function exclusionMatrix(selection: SelectionUnit, codingModels: readonly string[]): NonNullable<SelectionUnit["no_qualified_result"]> {
  return selection.no_qualified_result || {
    code: "NO_QUALIFIED_CANDIDATE",
    configured_route_ids: [...codingModels],
    exclusions: selection.candidates.map((candidate) => ({
      model_id: candidate.model_id,
      route_id: candidate.route_id,
      codes: [...new Set((candidate.diagnostics || []).map((diagnostic) => diagnostic.code))],
      reasons: [...new Set((candidate.diagnostics || []).map((diagnostic) => diagnostic.reason))],
    })),
  };
}

function cloneRuntimePlan(plan: ApplyExecutionPlan, state: ApplyRunState): ApplyExecutionPlan {
  const copy = structuredClone(plan);
  const runtime = (status: ApplyRunState["unit_state"][string]["status"] | undefined) => {
    if (status === "accepted" || status === "reconciled") return "succeeded" as const;
    if (status === "undispatched") return "planned" as const;
    if (status === "reserved" || status === "terminal-unreleased") return "running" as const;
    return status as Exclude<ApplyExecutionPlan["units"][number]["runtime_state"], undefined>;
  };
  for (const unit of copy.units) {
    const status = state.unit_state[unit.id]?.status;
    unit.runtime_state = runtime(status);
  }
  for (const gate of copy.parent_gates || []) {
    const status = state.gate_state[gate.id]?.status;
    gate.runtime_state = runtime(status);
  }
  return copy;
}

function defaultCards(cwd: string, host: string, env: NodeJS.ProcessEnv, explicit?: ModelCard[]): ModelCard[] {
  if (explicit) return explicit;
  return buildRouteCandidates(cwd, { host, env }).map((item) => item.card);
}

function approvalFor(runId: string, fingerprint: string, host: string, unit: SelectionUnit, candidate: SelectionCandidate): ModelSelectionApproval {
  return { host, proposal_id: `compiled-${runId}`, approval_id: `compiled-${runId}-${unit.key}`, unit_key: unit.key,
    approved_at: new Date().toISOString(), confirmed_by: "baton-recommendation", catalog_fingerprint: fingerprint,
    recommended_model_id: unit.recommended_model_id, selected_model_id: candidate.model_id, service_tier: candidate.service_tier,
    changed_by_user: false };
}

function planUnitReadContext(unit: ApplyExecutionPlan["units"][number]): string[] {
  const candidate = unit as unknown as Record<string, unknown>;
  const values = candidate.read_context ?? candidate.readContext ?? candidate.read_paths ?? candidate.readPaths;
  return Array.isArray(values) ? values.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

/** Reconstruct one run and materialize exactly one capacity-bounded frontier. */
export async function materializeCompiledApplyFrontier(input: CompiledApplyFrontierOptions): Promise<CompiledApplyFrontierResult> {
  const env = input.env || process.env;
  const runId = text(input.runId || input.run_id || input.run);
  if (!runId) throw new CompiledApplyError("run id is required", "RUN_ID_MISMATCH");
  const existing = readApplyRun(input.cwd, runId, { env });
  if (existing.host !== input.host) throw new CompiledApplyError("run host does not match requested host", "RUN_HOST_MISMATCH");
  const facts = ticketFactsForRun(input.cwd, runId, existing, env, input.ticket_facts);
  const run = readApplyRun(input.cwd, runId, { env, ticket_facts: facts });
  const plan = cloneRuntimePlan(readApplyRunPlanBody(input.cwd, runId, run.current_revision, env), run);
  let configuredHostLimit = input.hostLimit;
  if (configuredHostLimit === undefined) {
    try { configuredHostLimit = effectiveMaxConcurrentForHost(loadConfig(input.cwd, { env }), input.host as never, env); } catch { /* uninitialized test roots use explicit capacity */ }
  }
  const resolved = resolveAgentTreeCapacity({ hostLimit: configuredHostLimit, configuredPolicy: input.configuredPolicy, operationLimit: input.operationLimit, env });
  const capacity = Math.max(0, Math.floor(Number(input.capacity ?? resolved.capacity ?? 0)));
  const available = input.availableCapacity !== undefined
    ? Math.max(0, Math.floor(Number(input.availableCapacity)))
    : Math.max(0, capacity - activeCount(input.cwd, env, run, facts));
  const cards = defaultCards(input.cwd, input.host, env, input.cards);
  const automatic = input.automaticCards || cards;
  const codingModels = input.codingModels || (() => { try { return [...configuredCodingModelsForHost(loadConfig(input.cwd, { env }), input.host as never)]; } catch { return []; } })();
  const blocked: CompiledApplyBlockedUnit[] = [];
  const selections = new Map<string, { unit: ApplyExecutionPlan["units"][number]; selection: SelectionUnit; candidate: SelectionCandidate }>();
  const materializedRevisionUnits = new Set(listSpawns(input.cwd, env)
    .filter((ticket) => {
      const lineage = ticket.compiled_apply_lineage;
      return lineage?.run_id === runId && lineage.plan_revision === run.current_revision
        && ticket.session_uid === run.session_uid && (ticket.target_host || ticket.host || "") === run.host;
    })
    .map((ticket) => ticket.compiled_apply_lineage!.unit_id));
  const ready = deriveDependencyReadyUndispatchedUnits(plan)
    .filter((unitId) => !materializedRevisionUnits.has(unitId));
  const qualified = new Set<string>();
  for (const unitId of ready) {
    const unit = plan.units.find((candidate) => candidate.id === unitId)!;
    const prompt = unit.prompt || unit.description || unit.id;
    const selection = buildSelectionUnit({ cwd: input.cwd, host: input.host, key: unit.id, description: unit.description || unit.id, prompt,
        cards, automaticCards: cardsForAutomaticSelection(input.cwd, automatic, prompt, input.host, env), codingModels, probeRouteIds: input.probeRouteIds || [], env,
        requestedModelId: null, directorLocal: false, metadata: { compiled_apply: true, unit_id: unit.id } });
    const candidate = input.selectUnit ? input.selectUnit(selection, unit) : selection.candidates.find((item) => item.automatic_eligible) || null;
    if (!candidate || !configuredCandidate(candidate, codingModels)) {
      if (selection) blocked.push({ unit_id: unit.id, selection, exclusion_matrix: exclusionMatrix(selection, codingModels) });
      continue;
    }
    qualified.add(unit.id);
    selections.set(unit.id, { unit, selection, candidate });
  }
  const frontier = deriveSafeReadyFrontier(plan, { capacity: available, excludedUnitIds: ready.filter((unitId) => !qualified.has(unitId)), activeOwnership: ownershipFromTickets(input.cwd, env, input.activeOwnership), criticalPathByUnit: undefined });
  const entries: TicketMaterializationBatchEntry[] = [];
  const ids = nextSpawnIds(input.cwd, "spn", frontier.length, env);
  for (let index = 0; index < frontier.length; index += 1) {
    const unitId = frontier[index]!;
    const selected = selections.get(unitId);
    if (!selected) continue;
    const { unit, selection, candidate } = selected;
    const prompt = unit.prompt || unit.description || unit.id;
    const revision = run.current_revision;
    const fingerprint = run.current_fingerprint || applyPlanFingerprint(plan);
    const lineage = { run_id: runId, plan_revision: revision, plan_fingerprint: fingerprint, unit_id: unit.id, task_refs: [...unit.task_ids], mode: unit.mode } as const;
    const approval = approvalFor(runId, fingerprint, input.host, selection, candidate);
    const ticket = buildSpawnTicket({ id: ids[index], cwd: input.cwd, env, description: unit.description || unit.id, prompt,
      modelId: candidate.model_id, routeId: candidate.route_id, reasoningEffort: candidate.reasoning_effort, serviceTier: candidate.service_tier,
      source: "compiled-apply", taskKind: "concrete", selection: approval, targetHost: input.host, mode: unit.mode, runId, planRevision: revision,
      planFingerprint: fingerprint, unitId: unit.id, taskRefs: unit.task_ids, satisfiedDependencies: [...(unit.depends_on || []), ...(unit.parent_gate_ids || [])],
      readContext: planUnitReadContext(unit), writePaths: unit.write_paths || [], allowedOperations: unit.allowed_operations || [], patchRecipe: unit.patch || unit.prompt || unit.description,
      completionCriteria: unit.mode === "verification-only" ? unit.verification || ["validation completed"] : [unit.description || "patch completed"],
      permittedValidation: unit.verification || ["read"], compiledApplyLineage: lineage });
    const base = buildReadOnlyReceipt({ ticketId: ticket.id, card: { id: candidate.model_id, strengths: candidate.strengths, route_id: candidate.route_id, reasoning_effort: candidate.reasoning_effort, provider: candidate.provider || undefined },
      issuedAt: ticket.created_at, selection: approval, host: input.host, compiledApplyLineage: lineage });
    ticket.receipt_id = base.receipt_id;
    const planned = { director_local: false as const, ticket, receipt: base, queue: { running: 0, queued: 0 } } satisfies Extract<StandalonePlan, { director_local: false }>;
    entries.push({ planned, writeAllowlist: unit.mode === "patch-only" ? [...(unit.write_paths || [])] : [], allowedOperations: unit.mode === "patch-only" ? [...(unit.allowed_operations || [])] : [] });
  }
  const scopes = entries.filter((entry) => entry.writeAllowlist?.length).map((entry) => ({ key: entry.planned.ticket.id, write_paths: entry.writeAllowlist! }));
  assertWriteScopesAvailable(input.cwd, scopes, env);
  const materialized = entries.length ? await materializeStandalonePlansBatchAsync(input.cwd, entries, { ...input.materialization, env, onComplete: async (tickets) => {
    const latestFacts = tickets.map((ticket) => ({ ticket_id: ticket.id, status: "queued" as const, run_id: runId, host: input.host, session_uid: run.session_uid, unit_ids: [ticket.compiled_apply_lineage!.unit_id], task_ids: [...ticket.compiled_apply_lineage!.task_refs], model_id: ticket.model_id, receipt_id: ticket.receipt_id || undefined }));
    persistApplyRunTicketFacts(input.cwd, runId, [...facts, ...latestFacts], env);
  } }) : [];
  const finalRun = readApplyRun(input.cwd, runId, { env, ticket_facts: [...facts, ...materialized.map((ticket) => ({ ticket_id: ticket.id, status: "queued" as const, run_id: runId, host: input.host, session_uid: run.session_uid, unit_ids: [ticket.compiled_apply_lineage!.unit_id], task_ids: [...ticket.compiled_apply_lineage!.task_refs], model_id: ticket.model_id, receipt_id: ticket.receipt_id || undefined }))] });
  return { run_id: runId, revision: run.current_revision, fingerprint: run.current_fingerprint, candidates: frontier, selected: entries.map((entry) => entry.planned.ticket.compiled_apply_lineage!.unit_id), materialized, blocked,
    capacity, available_capacity: available, run: finalRun };
}
