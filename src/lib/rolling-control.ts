/**
 * Stateful control plane for the rolling execution protocol.
 *
 * The durable rolling log remains authoritative for accepted planning and
 * parent decisions. Ordinary spawn tickets remain authoritative for native
 * execution. This module joins the two with an idempotent recovery projection
 * so a crash between those stores can be repaired without creating another
 * ticket, attempt, acceptance, release, or reconciliation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { getCliAdapter } from "../adapters/registry.js";
import {
  cliProfileForHost,
  configuredCodingModelsForHost,
  loadConfig,
} from "./config.js";
import { dispatchSnapshot } from "./dispatch.js";
import { createDirectorTaskSourceAdapter, type DirectorTaskDefinition } from "./director-task-source.js";
import { extractExactExecutionRootIdentity, sameExactExecutionRootIdentity } from "../adapters/contract.js";
import { availabilityForRoute } from "./model-availability.js";
import { createOpenSpecTaskSourceAdapter } from "./openspec-task-source.js";
import {
  fingerprintGateVersion,
  fingerprintPlanDelta,
  fingerprintTaskManifestEntry,
  fingerprintTaskSeal,
  fingerprintUnitVersion,
  type GateVersion,
  type PlanDelta,
  type TaskManifestEntry,
  type TaskSeal,
  type TaskSourceDescriptor,
  type UnitVersion,
  type WorktreeExecutionMode,
} from "./rolling-plan.js";
import { recoverWorktreeRun, type WorktreeRunIsolationStatus } from "./worktree-lifecycle.js";
import {
  appendRollingFact,
  appendRollingPlanDelta,
  appendRollingSeal,
  createRollingExecutionRun,
  readRollingExecutionRun,
  type RollingExecutionRun,
  type RollingFact,
} from "./rolling-run.js";
import {
  deriveRollingAcceptance,
  evaluateRollingGateVersion,
  normalizeRollingExecutionFact,
  type RollingAcceptanceProjection,
  type RollingExecutionFact,
} from "./rolling-acceptance.js";
import { deriveRollingLifecycle, type RollingTaskLifecycle } from "./rolling-lifecycle.js";
import { refillRollingCapacity, type RollingRefillResult } from "./rolling-dispatch.js";
import { selectRollingFrontier } from "./rolling-dispatch-selection.js";
import { collectRollingUnitVersions } from "./rolling-dispatch-state.js";
import { worktreeExecutionRootPath } from "./paths.js";
import { readReceipt } from "./receipt.js";
import { createWorktreeChangeBundle, type WorktreeChangeBundleResult } from "./worktree-bundle.js";
import { readPersistedWorktreeRecord, type ChangeBundleOperation, type WorktreeRecord } from "./worktree-execution.js";
import { setupDetachedWorktree } from "./worktree-setup.js";
import { resolveWorktreeTopology } from "./worktree-topology.js";
import { buildRouteCandidates, readRouteSnapshot } from "./routes.js";
import { listSpawns, type SpawnTicket } from "./spawn.js";
import { createTaskSourceAdapterRegistry, type TaskSourceAdapterRegistry, type TaskSourceDiagnostic } from "./task-source.js";
import { sha256Hex } from "./json-utils.js";
import { synchronizeRollingTicketFacts } from "./rolling-control-tickets.js";
import {
  statusRollingControl,
  taskRefs
} from "./rolling-control-status.js";
import {
  discoverRollingTaskManifest,
  manifestDelta,
  manifestDiff,
  mergeManifest,
  rollingTaskSourceRegistry
} from "./rolling-control-manifest.js";
import {
  persistedRollingWorktreeRecords,
  prepareRollingFrontierWorktrees,
  routeAvailability
} from "./rolling-control-worktrees.js";

export const ROLLING_CONTROL_SCHEMA_VERSION = 1 as const;
export const ROLLING_EXECUTION_DOCUMENT_KIND = "execution" as const;
export const ROLLING_RECONCILIATION_DOCUMENT_KIND = "reconciliation" as const;

export class RollingControlError extends Error {
  readonly code: string;
  readonly diagnostics?: readonly TaskSourceDiagnostic[];
  constructor(message: string, code: string, diagnostics?: readonly TaskSourceDiagnostic[]) {
    super(message);
    this.name = "RollingControlError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface RollingControlContext {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  now?: string | number | Date;
}

export interface StartRollingControlInput extends RollingControlContext {
  run_id: string;
  host: string;
  worktree_mode?: WorktreeExecutionMode;
  source: TaskSourceDescriptor;
  delta?: PlanDelta | null;
  dispatch?: boolean;
}

export interface AppendRollingControlInput extends RollingControlContext {
  run_id: string;
  delta: PlanDelta;
  dispatch?: boolean;
}

export interface AcceptRollingGateInput extends RollingControlContext {
  run_id: string;
  gate_ref: string;
  evidence: string;
  result_tree?: string;
  dispatch?: boolean;
}

export interface SealRollingTaskInput extends RollingControlContext {
  run_id: string;
  seal: TaskSeal;
}

export interface ReconcileRollingTasksInput extends RollingControlContext {
  run_id: string;
  task_key?: string | null;
}

export interface FreezeRollingUnitInput extends RollingControlContext {
  run_id: string;
  unit_key: string;
  attempt_id: string;
  conclusion: string;
  validation_summaries?: readonly string[];
  allow_noop?: boolean;
}

export interface RollingControlMutationResult {
  schema_version: typeof ROLLING_CONTROL_SCHEMA_VERSION;
  code: string;
  run_id: string;
  append_sequence: number;
  dispatch: RollingRefillResult | null;
  status: RollingControlStatus;
}

export type RollingTaskControlState =
  | "unplanned"
  | "planned"
  | "blocked"
  | "active"
  | "terminal-unreleased"
  | "accepted"
  | "sealed"
  | "reconciled";

export interface RollingTaskControlStatus {
  task_key: string;
  display_id: string;
  title: string;
  state: RollingTaskControlState;
  source_state: TaskManifestEntry["source_state"];
  unit_versions: string[];
  gate_versions: string[];
  unit_states: Record<string, string>;
  gate_states: Record<string, string>;
  ticket_ids: string[];
  blockers: Array<{ code: string; message: string; refs?: string[] }>;
  next_legal_action: string | null;
}

export interface RollingControlStatus {
  schema_version: typeof ROLLING_CONTROL_SCHEMA_VERSION;
  code: "ROLLING_RUN_STATUS";
  run_id: string;
  host: string;
  session_uid: string;
  adapter: string;
  source_kind: string;
  append_sequence: number;
  state: "open" | "blocked" | "sealed" | "reconciled";
  next_legal_action: string | null;
  tasks: RollingTaskControlStatus[];
  task_status: Record<string, RollingTaskControlStatus>;
  acceptance: RollingAcceptanceProjection;
  tickets: Array<{
    ticket_id: string;
    unit_ref: string;
    status: string;
    released: boolean;
    execution_root: string | null;
    progress: SpawnTicket["progress"];
    liveness: SpawnTicket["liveness"];
  }>;
  isolation: WorktreeRunIsolationStatus;
  recovery: { appended_execution_facts: number; repaired_worktree_record_ids: string[]; source_diagnostics: readonly TaskSourceDiagnostic[] };
}

export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function stamp(value: RollingControlContext["now"]): string {
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value || "");
  return new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now()).toISOString();
}

export function hash(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

export function sourceFromRun(run: RollingExecutionRun): TaskSourceDescriptor {
  const sourceFact = run.facts.find((fact) => fact.kind === "source");
  if (!sourceFact || !record(sourceFact.payload)) throw new RollingControlError("rolling run source fact is missing", "ROLLING_STATE_CORRUPT");
  const source = structuredClone(sourceFact.payload) as Record<string, unknown>;
  delete source.__run_identity;
  return source as unknown as TaskSourceDescriptor;
}

export function directorTasks(source: TaskSourceDescriptor): readonly DirectorTaskDefinition[] {
  if (!record(source.selection)) return [];
  const raw = source.selection.tasks;
  return Array.isArray(raw) ? raw as DirectorTaskDefinition[] : [];
}

/** Recreate only the adapter selected by the accepted source descriptor. */
export function allUnits(run: RollingExecutionRun): UnitVersion[] {
  return [...collectRollingUnitVersions(run.accepted_deltas).values()];
}

export function allGates(run: RollingExecutionRun): GateVersion[] {
  const gates = new Map<string, GateVersion>();
  for (const delta of run.accepted_deltas) {
    for (const gate of delta.gate_versions || []) gates.set(`${gate.gate_key}@${gate.version}`, gate);
  }
  return [...gates.values()];
}

export function executionFacts(run: RollingExecutionRun): RollingExecutionFact[] {
  const out: RollingExecutionFact[] = [];
  for (const fact of run.facts) {
    if (fact.kind !== ROLLING_EXECUTION_DOCUMENT_KIND) continue;
    out.push(normalizeRollingExecutionFact(fact.payload));
  }
  return out;
}

export async function refillRollingRun(context: RollingControlContext & { run_id: string; event_reason?: string }): Promise<RollingRefillResult> {
  const recovered = synchronizeRollingTicketFacts(context);
  const run = recovered.run;
  const host = run.identity.host;
  const config = loadConfig(context.cwd, { env: context.env });
  const configured = configuredCodingModelsForHost(config, host as never);
  const profile = cliProfileForHost(config, host as never);
  const cards = buildRouteCandidates(context.cwd, { host, env: context.env }).map((candidate) => candidate.card);
  const snapshot = readRouteSnapshot(context.cwd, { host, env: context.env });
  if (!snapshot) throw new RollingControlError(`rolling run ${context.run_id} has no active model catalog for ${host}`, "ROLLING_MODEL_CATALOG_MISSING");
  const capacity = dispatchSnapshot(context.cwd, { host, env: context.env });
  const refillInput: Parameters<typeof refillRollingCapacity>[0] = {
    cwd: context.cwd,
    env: context.env,
    run_id: context.run_id,
    host,
    accepted_deltas: run.accepted_deltas,
    existing_tickets: recovered.tickets,
    cards,
    automatic_cards: cards,
    coding_models: configured,
    route_profiles: { runner: profile.runner, longctx: profile.longctx },
    current_session_availability: routeAvailability(context.cwd, host, cards, context.env),
    available_capacity: capacity.available,
    capacity: capacity.capacity,
    runtime_facts: executionFacts(run).map((fact) => ({ ...fact })),
    worktree_records: persistedRollingWorktreeRecords(context.cwd, run, context.env),
    catalog_fingerprint: snapshot.fingerprint,
    event_reason: context.event_reason,
    now: context.now,
  };
  await prepareRollingFrontierWorktrees(context, run, refillInput);
  refillInput.worktree_records = persistedRollingWorktreeRecords(context.cwd, run, context.env);
  const result = await refillRollingCapacity(refillInput);
  // A queued ticket is itself a recovered execution fact. Keep the log caught
  // up before returning so a caller can immediately reconnect by run id.
  if (result.materialized.length) synchronizeRollingTicketFacts(context);
  return result;
}

async function mutationResult(context: RollingControlContext & { run_id: string }, code: string, dispatch: RollingRefillResult | null): Promise<RollingControlMutationResult> {
  const status = await statusRollingControl(context);
  return { schema_version: ROLLING_CONTROL_SCHEMA_VERSION, code, run_id: context.run_id, append_sequence: status.append_sequence, dispatch, status };
}

export async function startRollingControl(input: StartRollingControlInput): Promise<RollingControlMutationResult> {
  const mode = input.worktree_mode || "isolated-worktree";
  createRollingExecutionRun({ cwd: input.cwd, env: input.env, runId: input.run_id, host: input.host, execution_mode: mode, source: input.source, now: input.now });
  const discovery = await discoverRollingTaskManifest(input.cwd, input.source);
  if (!discovery.complete) {
    throw new RollingControlError("rolling task source is unavailable during initial discovery", "ROLLING_DISCOVERY_UNAVAILABLE", discovery.diagnostics);
  }
  const delta = input.delta
    ? mergeManifest(input.delta, discovery.entries, [])
    : manifestDelta(discovery.entries, 0);
  appendRollingPlanDelta({ cwd: input.cwd, env: input.env, runId: input.run_id, delta, now: input.now });
  const dispatch = input.dispatch ? await refillRollingRun({ ...input, event_reason: "run-start" }) : null;
  return mutationResult(input, "ROLLING_RUN_STARTED", dispatch);
}

export async function appendRollingControl(input: AppendRollingControlInput): Promise<RollingControlMutationResult> {
  const recovered = synchronizeRollingTicketFacts(input);
  const source = sourceFromRun(recovered.run);
  const discovery = await discoverRollingTaskManifest(input.cwd, source);
  if (!discovery.complete) {
    throw new RollingControlError("rolling task source is unavailable during incremental discovery", "ROLLING_DISCOVERY_UNAVAILABLE", discovery.diagnostics);
  }
  const diff = manifestDiff(recovered.run.manifest_entries, discovery.entries);
  const delta = mergeManifest(input.delta, diff.additions, diff.refreshes);
  appendRollingPlanDelta({ cwd: input.cwd, env: input.env, runId: input.run_id, delta, now: input.now });
  const dispatch = input.dispatch ? await refillRollingRun({ ...input, event_reason: "delta-append" }) : null;
  return mutationResult(input, "ROLLING_PLAN_APPENDED", dispatch);
}

export async function freezeRollingUnitBundle(input: FreezeRollingUnitInput): Promise<WorktreeChangeBundleResult> {
  const recovered = synchronizeRollingTicketFacts(input);
  const record = readPersistedWorktreeRecord(input.cwd, input.run_id, input.unit_key, input.attempt_id, input.env);
  const ticket = recovered.tickets.find((candidate) => candidate.rolling_unit_lineage?.worktree_record_id === record.record_id);
  if (!ticket || !ticket.receipt_id) {
    throw new RollingControlError(
      `isolated attempt ${input.unit_key}/${input.attempt_id} has no exact persisted ticket and Receipt`,
      "ROLLING_BUNDLE_RECEIPT_MISSING",
    );
  }
  const receipt = readReceipt(input.cwd, ticket.receipt_id, input.env);
  const receiptIdentity = extractExactExecutionRootIdentity(receipt);
  const lineage = receipt.rolling_unit_lineage;
  const recordIdentity = {
    repository_id: record.repository_id,
    git_common_dir_identity: record.git_common_dir_identity,
    execution_root: record.execution_root,
    base_tree: record.base_tree,
    worktree_record_id: record.record_id,
  };
  if (!receiptIdentity || !sameExactExecutionRootIdentity(receiptIdentity, recordIdentity)
    || lineage?.worktree_mode !== "isolated-worktree"
    || lineage.run_id !== record.run_id
    || lineage.unit_key !== record.unit_key
    || lineage.unit_version !== record.unit_version) {
    throw new RollingControlError("isolated bundle Receipt does not match the persisted attempt", "ROLLING_BUNDLE_RECEIPT_INVALID");
  }
  const operations = receipt.scope.allowed_operations.filter((operation) =>
    operation === "write" || operation === "create" || operation === "delete" || operation === "rename" || operation === "chmod") as ChangeBundleOperation[];
  if (!operations.length || operations.length !== receipt.scope.allowed_operations.length) {
    throw new RollingControlError("isolated bundle Receipt contains a non-bundle operation", "ROLLING_BUNDLE_RECEIPT_INVALID");
  }
  return createWorktreeChangeBundle({
    record,
    receipt: {
      receipt_id: receipt.receipt_id,
      ...receiptIdentity,
      run_id: record.run_id,
      unit_key: record.unit_key,
      unit_version: record.unit_version,
      attempt_id: record.attempt_id,
      write_allowlist: receipt.scope.write_allowlist,
      allowed_operations: operations,
      ...(input.allow_noop ? { allow_noop: true } : {}),
    },
    terminal_conclusion: input.conclusion,
    validation_summaries: input.validation_summaries,
    created_at: input.now,
    env: input.env,
  });
}

function parseGateRef(value: string): { gate_key: string; gate_version: number } {
  const match = String(value).match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)@([1-9][0-9]*)$/u);
  if (!match) throw new RollingControlError("gate reference must be GATE@VERSION", "ROLLING_GATE_REF_INVALID");
  return { gate_key: match[1]!, gate_version: Number(match[2]) };
}

export async function acceptRollingGate(input: AcceptRollingGateInput): Promise<RollingControlMutationResult> {
  const recovered = synchronizeRollingTicketFacts(input);
  const parsed = parseGateRef(input.gate_ref);
  const gate = allGates(recovered.run).find((item) => item.gate_key === parsed.gate_key && item.version === parsed.gate_version);
  if (!gate) throw new RollingControlError(`rolling gate is unknown: ${input.gate_ref}`, "ROLLING_GATE_UNKNOWN");
  const facts = executionFacts(recovered.run);
  const state = evaluateRollingGateVersion(gate, { units: allUnits(recovered.run), gates: allGates(recovered.run), facts });
  if (state.state !== "ready" && state.state !== "accepted") {
    throw new RollingControlError(`rolling gate ${input.gate_ref} is ${state.state}, not ready`, "ROLLING_GATE_NOT_READY");
  }
  const fact = normalizeRollingExecutionFact({
    schema_version: 1,
    kind: "gate-acceptance",
    gate_key: gate.gate_key,
    gate_version: gate.version,
    gate_fingerprint: gate.fingerprint || fingerprintGateVersion(gate),
    owner_type: "gate_version",
    owner_key: input.gate_ref,
    accepted: true,
    evidence: input.evidence,
    ...(input.result_tree ? { result_tree: input.result_tree } : {}),
    recorded_at: stamp(input.now),
  });
  appendRollingFact({
    cwd: input.cwd,
    env: input.env,
    runId: input.run_id,
    kind: ROLLING_EXECUTION_DOCUMENT_KIND,
    idempotency_key: `gate-acceptance:${input.gate_ref}`,
    fact_id: `execution:${fact.fact_id}`,
    document_id: `execution-${fact.fact_id}`,
    payload: fact,
    document: fact,
    now: input.now,
  });
  const dispatch = input.dispatch === false ? null : await refillRollingRun({ ...input, event_reason: "gate-acceptance" });
  return mutationResult(input, "ROLLING_GATE_ACCEPTED", dispatch);
}

export async function sealRollingTask(input: SealRollingTaskInput): Promise<RollingControlMutationResult> {
  synchronizeRollingTicketFacts(input);
  const seal = structuredClone(input.seal);
  if (!seal.fingerprint) seal.fingerprint = fingerprintTaskSeal(seal);
  appendRollingSeal({ cwd: input.cwd, env: input.env, runId: input.run_id, seal, now: input.now });
  return mutationResult(input, "ROLLING_TASK_SEALED", null);
}

function acceptedConclusion(taskKey: string, run: RollingExecutionRun, tickets: readonly SpawnTicket[]): string {
  const refs = new Set(taskRefs(run, taskKey).units);
  const conclusions = tickets
    .filter((ticket) => ticket.rolling_unit_lineage && refs.has(`${ticket.rolling_unit_lineage.unit_key}@${ticket.rolling_unit_lineage.unit_version}`))
    .map((ticket) => String(ticket.conclusion || "").trim())
    .filter(Boolean);
  return conclusions.length ? conclusions.join("; ") : `reconciled rolling run ${run.identity.run_id}`;
}

export async function reconcileRollingTasks(input: ReconcileRollingTasksInput): Promise<RollingControlMutationResult> {
  const recovered = synchronizeRollingTicketFacts(input);
  let run = recovered.run;
  const source = sourceFromRun(run);
  const registry = rollingTaskSourceRegistry(input.cwd, source);
  const status = await statusRollingControl(input);
  const targets = input.task_key ? [input.task_key] : status.tasks.filter((task) => task.state === "sealed").map((task) => task.task_key);
  if (!targets.length) throw new RollingControlError("no sealed rolling task is eligible for reconciliation", "ROLLING_RECONCILE_NOT_READY");
  const pending = targets.filter((taskKey) => !run.facts.some((fact) => fact.kind === ROLLING_RECONCILIATION_DOCUMENT_KIND && record(fact.payload) && fact.payload.task_key === taskKey && fact.payload.status === "reconciled"));
  const requests = pending.map((taskKey) => {
    const task = status.task_status[taskKey];
    if (!task) throw new RollingControlError(`rolling task is unknown: ${taskKey}`, "ROLLING_TASK_UNKNOWN");
    if (task.state !== "sealed") throw new RollingControlError(`rolling task ${taskKey} is ${task.state}, not sealed`, "ROLLING_RECONCILE_NOT_READY");
    const entry = run.manifest_entries.find((item) => item.task_key === taskKey)!;
    const conclusion = acceptedConclusion(taskKey, run, recovered.tickets);
    return { task_key: taskKey, conclusion, expected_source_fingerprint: entry.source_fingerprint, expected_source_state: entry.source_state };
  });
  if (!requests.length) return mutationResult(input, "ROLLING_TASKS_RECONCILED", null);
  const result = requests.length === 1
    ? await registry.reconcile(source, requests[0]!.task_key, requests[0]!.conclusion, requests[0]!.expected_source_fingerprint)
    : await registry.reconcileBatch(source, requests);
  if (!result.ok) throw new RollingControlError("rolling source reconciliation is unavailable for the sealed task batch", "ROLLING_RECONCILIATION_UNAVAILABLE", result.diagnostics);
  const sourceResults = Array.isArray(result.value) ? result.value : [result.value];
  const byTask = new Map(sourceResults.map((value) => [value.task_key, value]));
  if (byTask.size !== requests.length || requests.some((request) => !byTask.has(request.task_key))) {
    throw new RollingControlError("rolling source reconciliation returned an incomplete task batch", "ROLLING_RECONCILIATION_INCOMPLETE");
  }
  for (const request of requests) {
    const payload = { task_key: request.task_key, status: "reconciled", conclusion: request.conclusion, source_result: byTask.get(request.task_key) };
    run = appendRollingFact({
      cwd: input.cwd,
      env: input.env,
      runId: input.run_id,
      kind: ROLLING_RECONCILIATION_DOCUMENT_KIND,
      idempotency_key: `reconciliation:${request.task_key}`,
      fact_id: `reconciliation:${request.task_key}`,
      document_id: `reconciliation-${request.task_key}`,
      payload,
      document: payload,
      now: input.now,
    });
  }
  return mutationResult(input, "ROLLING_TASKS_RECONCILED", null);
}

/** Human output remains task-first; JSON callers receive the complete report. */

export { rollingTaskSourceRegistry, discoverRollingTaskManifest } from "./rolling-control-manifest.js";
export { synchronizeRollingTicketFacts } from "./rolling-control-tickets.js";
export { statusRollingControl, formatRollingControlStatus } from "./rolling-control-status.js";
