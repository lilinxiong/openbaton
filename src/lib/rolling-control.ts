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
import {
  cliProfileForHost,
  configuredCodingModelsForHost,
  loadConfig,
} from "./config.js";
import { dispatchSnapshot } from "./dispatch.js";
import { createDirectorTaskSourceAdapter, type DirectorTaskDefinition } from "./director-task-source.js";
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
import { collectRollingUnitVersions } from "./rolling-dispatch-state.js";
import { buildRouteCandidates, readRouteSnapshot } from "./routes.js";
import { listSpawns, type SpawnTicket } from "./spawn.js";
import { createTaskSourceAdapterRegistry, type TaskSourceAdapterRegistry, type TaskSourceDiagnostic } from "./task-source.js";

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
  tickets: Array<{ ticket_id: string; unit_ref: string; status: string; released: boolean }>;
  recovery: { appended_execution_facts: number; source_diagnostics: readonly TaskSourceDiagnostic[] };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stamp(value: RollingControlContext["now"]): string {
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value || "");
  return new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now()).toISOString();
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceFromRun(run: RollingExecutionRun): TaskSourceDescriptor {
  const sourceFact = run.facts.find((fact) => fact.kind === "source");
  if (!sourceFact || !record(sourceFact.payload)) throw new RollingControlError("rolling run source fact is missing", "ROLLING_STATE_CORRUPT");
  const source = structuredClone(sourceFact.payload) as Record<string, unknown>;
  delete source.__run_identity;
  return source as unknown as TaskSourceDescriptor;
}

function directorTasks(source: TaskSourceDescriptor): readonly DirectorTaskDefinition[] {
  if (!record(source.selection)) return [];
  const raw = source.selection.tasks;
  return Array.isArray(raw) ? raw as DirectorTaskDefinition[] : [];
}

/** Recreate only the adapter selected by the accepted source descriptor. */
export function rollingTaskSourceRegistry(cwd: string, source: TaskSourceDescriptor): TaskSourceAdapterRegistry {
  if (source.source_kind === "openspec") {
    return createTaskSourceAdapterRegistry([createOpenSpecTaskSourceAdapter({ cwd })]);
  }
  if (source.source_kind === "director") {
    return createTaskSourceAdapterRegistry([
      createDirectorTaskSourceAdapter(directorTasks(source), { adapter: source.adapter }),
    ]);
  }
  throw new RollingControlError(`unsupported rolling source kind ${source.source_kind}`, "ROLLING_SOURCE_UNSUPPORTED");
}

export async function discoverRollingTaskManifest(
  cwd: string,
  source: TaskSourceDescriptor,
  registry: TaskSourceAdapterRegistry = rollingTaskSourceRegistry(cwd, source),
): Promise<{ entries: TaskManifestEntry[]; diagnostics: readonly TaskSourceDiagnostic[]; complete: boolean }> {
  const entries: TaskManifestEntry[] = [];
  const diagnostics: TaskSourceDiagnostic[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const result = await registry.discover(source, { cursor, limit: registry.max_page_size });
    diagnostics.push(...result.diagnostics);
    if (!result.ok) return { entries, diagnostics, complete: false };
    entries.push(...result.value.entries);
    const next = result.value.next_cursor ?? null;
    if (next !== null) {
      if (seenCursors.has(next)) throw new RollingControlError("task source repeated a discovery cursor", "ROLLING_DISCOVERY_CURSOR_CYCLE", diagnostics);
      seenCursors.add(next);
    }
    cursor = next;
  } while (cursor !== null);
  return { entries, diagnostics, complete: true };
}

function manifestDiff(
  accepted: readonly TaskManifestEntry[],
  discovered: readonly TaskManifestEntry[],
): { additions: TaskManifestEntry[]; refreshes: TaskManifestEntry[] } {
  const current = new Map(accepted.map((entry) => [entry.task_key, entry]));
  const additions: TaskManifestEntry[] = [];
  const refreshes: TaskManifestEntry[] = [];
  for (const entry of discovered) {
    const prior = current.get(entry.task_key);
    if (!prior) additions.push(entry);
    else if (fingerprintTaskManifestEntry(prior) !== fingerprintTaskManifestEntry(entry)) refreshes.push(entry);
  }
  return { additions, refreshes };
}

function mergeManifest(delta: PlanDelta, additions: readonly TaskManifestEntry[], refreshes: readonly TaskManifestEntry[]): PlanDelta {
  const copy = structuredClone(delta) as PlanDelta;
  const local = new Set([...(copy.manifest_additions || []), ...(copy.manifest_refreshes || [])].map((entry) => entry.task_key));
  const nextAdditions = [...(copy.manifest_additions || []), ...additions.filter((entry) => !local.has(entry.task_key))];
  const nextRefreshes = [...(copy.manifest_refreshes || []), ...refreshes.filter((entry) => !local.has(entry.task_key))];
  if (nextAdditions.length) copy.manifest_additions = nextAdditions;
  else delete copy.manifest_additions;
  if (nextRefreshes.length) copy.manifest_refreshes = nextRefreshes;
  else delete copy.manifest_refreshes;
  delete copy.fingerprint;
  copy.fingerprint = fingerprintPlanDelta(copy);
  return copy;
}

function manifestDelta(entries: readonly TaskManifestEntry[], sequence: number): PlanDelta {
  const value: PlanDelta = {
    schema_version: 1,
    delta_id: `manifest-${hash(entries.map((entry) => [entry.task_key, fingerprintTaskManifestEntry(entry)])).slice(0, 24)}`,
    prepared_from_append_sequence: sequence,
    manifest_additions: [...entries],
    unit_versions: [],
    gate_versions: [],
    task_coverage: [],
  };
  value.fingerprint = fingerprintPlanDelta(value);
  return value;
}

function allUnits(run: RollingExecutionRun): UnitVersion[] {
  return [...collectRollingUnitVersions(run.accepted_deltas).values()];
}

function allGates(run: RollingExecutionRun): GateVersion[] {
  const gates = new Map<string, GateVersion>();
  for (const delta of run.accepted_deltas) {
    for (const gate of delta.gate_versions || []) gates.set(`${gate.gate_key}@${gate.version}`, gate);
  }
  return [...gates.values()];
}

function executionFacts(run: RollingExecutionRun): RollingExecutionFact[] {
  const out: RollingExecutionFact[] = [];
  for (const fact of run.facts) {
    if (fact.kind !== ROLLING_EXECUTION_DOCUMENT_KIND) continue;
    out.push(normalizeRollingExecutionFact(fact.payload));
  }
  return out;
}

function ticketsForRun(cwd: string, runId: string, env?: NodeJS.ProcessEnv): SpawnTicket[] {
  return listSpawns(cwd, env)
    .filter((ticket) => ticket.rolling_unit_lineage?.run_id === runId)
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || left.id.localeCompare(right.id));
}

function ticketAttemptOrdinals(tickets: readonly SpawnTicket[]): Map<string, number> {
  const counts = new Map<string, number>();
  const result = new Map<string, number>();
  for (const ticket of tickets) {
    const lineage = ticket.rolling_unit_lineage;
    if (!lineage) continue;
    const ref = `${lineage.unit_key}@${lineage.unit_version}`;
    const next = (counts.get(ref) || 0) + 1;
    counts.set(ref, next);
    result.set(ticket.id, next);
  }
  return result;
}

function executionBase(ticket: SpawnTicket, attempt: number, recordedAt: string): Record<string, unknown> {
  const lineage = ticket.rolling_unit_lineage!;
  const unitRef = `${lineage.unit_key}@${lineage.unit_version}`;
  return {
    schema_version: 1,
    unit_key: lineage.unit_key,
    unit_version: lineage.unit_version,
    unit_fingerprint: lineage.unit_fingerprint,
    owner_type: "attempt",
    owner_key: `${unitRef}:attempt-${attempt}`,
    attempt,
    recorded_at: recordedAt,
  };
}

function unitBase(ticket: SpawnTicket, recordedAt: string): Record<string, unknown> {
  const lineage = ticket.rolling_unit_lineage!;
  return {
    schema_version: 1,
    unit_key: lineage.unit_key,
    unit_version: lineage.unit_version,
    unit_fingerprint: lineage.unit_fingerprint,
    owner_type: "unit_version",
    owner_key: `${lineage.unit_key}@${lineage.unit_version}`,
    recorded_at: recordedAt,
  };
}

type ProjectedExecution = { idempotency_key: string; fact: RollingExecutionFact };

function projectedTicketFacts(ticket: SpawnTicket, attempt: number): ProjectedExecution[] {
  const out: ProjectedExecution[] = [];
  const created = String(ticket.created_at || new Date(0).toISOString());
  const updated = String(ticket.updated_at || created);
  const started = String(ticket.started_at || updated);
  const finished = String(ticket.finished_at || updated);
  const released = String(ticket.slot_released_at || finished);
  const base = executionBase(ticket, attempt, created);
  const add = (suffix: string, value: Record<string, unknown>) => {
    out.push({
      idempotency_key: `ticket:${ticket.id}:${suffix}`,
      fact: normalizeRollingExecutionFact(value),
    });
  };
  add("native:queued", { ...base, kind: "native-attempt", state: "queued" });
  if (["dispatching", "running", "completed", "errored", "timed_out", "closed"].includes(ticket.status)) {
    const reservationId = String(ticket.reservation_id || `recovered-${ticket.id}`);
    add("reservation:reserved", { ...executionBase(ticket, attempt, String(ticket.dispatch_requested_at || updated)), kind: "reservation", reservation_id: reservationId, state: "reserved" });
    add("native:reserved", { ...executionBase(ticket, attempt, String(ticket.dispatch_requested_at || updated)), kind: "native-attempt", state: "reserved" });
  }
  if (["running", "completed", "errored", "timed_out", "closed"].includes(ticket.status) && ticket.execution_handle) {
    add("native:running", { ...executionBase(ticket, attempt, started), kind: "native-attempt", state: "running" });
  }
  if (["completed", "errored", "timed_out", "closed"].includes(ticket.status)) {
    const success = ticket.status === "completed";
    const terminalStatus = success ? "completed" : ticket.status === "timed_out" ? "timed-out" : ticket.status === "closed" ? "cancelled" : "errored";
    add("terminal", {
      ...executionBase(ticket, attempt, finished),
      kind: "terminal-result",
      status: terminalStatus,
      result: success ? ticket.conclusion || "completed" : ticket.error || ticket.conclusion || terminalStatus,
      result_id: `ticket:${ticket.id}`,
    });
    add("native:terminal", { ...executionBase(ticket, attempt, finished), kind: "native-attempt", state: success ? "completed" : ticket.status === "closed" ? "cancelled" : "failed" });
    if (record(ticket.safety_verdict)) {
      add("safety", {
        ...unitBase(ticket, finished),
        kind: "safety-verdict",
        accepted: ticket.safety_verdict.accepted === true,
        violations: Array.isArray(ticket.safety_verdict.violations) ? ticket.safety_verdict.violations : [],
      });
    } else if (ticket.mode === "read-only") {
      add("safety", { ...unitBase(ticket, finished), kind: "safety-verdict", accepted: success, violations: [] });
    }
    if (success && !ticket.plan_insufficient_evidence && (ticket.mode === "read-only" || ticket.safety_verdict?.accepted === true)) {
      add("parent-acceptance", { ...unitBase(ticket, finished), kind: "parent-acceptance", accepted: true, evidence: String(ticket.conclusion || `accepted ticket ${ticket.id}`) });
    }
    if (record(ticket.plan_insufficient_evidence)) {
      add("plan-insufficient", {
        ...unitBase(ticket, finished),
        kind: "plan-insufficient",
        file: String(ticket.plan_insufficient_evidence.file || "unknown"),
        symbol: String(ticket.plan_insufficient_evidence.symbol || "unknown"),
        missing_decision: String(ticket.plan_insufficient_evidence.missing_decision || "successor plan required"),
      });
    }
  }
  if (ticket.successor_from_ticket_id) {
    add("retry", { ...executionBase(ticket, attempt, created), kind: "retry", retry_kind: "route", retry_of: `${ticket.rolling_unit_lineage!.unit_key}@${ticket.rolling_unit_lineage!.unit_version}`, reason: String(ticket.successor_reason || "route retry") });
  }
  if (ticket.slot_released_at) {
    add("release", { ...executionBase(ticket, attempt, released), kind: "release", released: true, released_at: released });
  }
  return out;
}

/**
 * Persist every ticket-observable rolling fact that is not yet in the log.
 * Identical calls are no-ops; a crash after either store is repaired by the
 * next status, append, refill, gate, seal, or reconcile operation.
 */
export function synchronizeRollingTicketFacts(context: RollingControlContext & { run_id: string }): { run: RollingExecutionRun; appended: number; tickets: SpawnTicket[] } {
  let run = readRollingExecutionRun(context.cwd, context.run_id, { env: context.env });
  const tickets = ticketsForRun(context.cwd, context.run_id, context.env);
  const attempts = ticketAttemptOrdinals(tickets);
  let appended = 0;
  for (const ticket of tickets) {
    for (const projected of projectedTicketFacts(ticket, attempts.get(ticket.id) || 1)) {
      const before = run.append_sequence;
      run = appendRollingFact({
        cwd: context.cwd,
        env: context.env,
        runId: context.run_id,
        kind: ROLLING_EXECUTION_DOCUMENT_KIND,
        idempotency_key: projected.idempotency_key,
        fact_id: `execution:${projected.fact.fact_id}`,
        document_id: `execution-${projected.fact.fact_id}`,
        payload: projected.fact,
        document: projected.fact,
        now: context.now,
      });
      if (run.append_sequence !== before) appended += 1;
    }
  }
  return { run, appended, tickets };
}

function routeAvailability(cwd: string, host: string, cards: readonly { route_id?: string }[], env?: NodeJS.ProcessEnv): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const routeId of [...new Set(cards.map((card) => card.route_id).filter((value): value is string => Boolean(value)))]) {
    result[routeId] = availabilityForRoute(cwd, { host, routeId }, undefined, env);
  }
  return result;
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
  const result = await refillRollingCapacity({
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
    catalog_fingerprint: snapshot.fingerprint,
    event_reason: context.event_reason,
    now: context.now,
  });
  // A queued ticket is itself a recovered execution fact. Keep the log caught
  // up before returning so a caller can immediately reconnect by run id.
  if (result.materialized.length) synchronizeRollingTicketFacts(context);
  return result;
}

function taskRefs(run: RollingExecutionRun, taskKey: string): { units: string[]; gates: string[] } {
  const units = new Set<string>();
  const gates = new Set<string>();
  const supersededUnits = new Set<string>();
  const supersededGates = new Set<string>();
  for (const delta of run.accepted_deltas) {
    for (const supersession of delta.supersessions || []) {
      if (supersession.owner === "unit_version") supersededUnits.add(supersession.previous);
      if (supersession.owner === "gate_version") supersededGates.add(supersession.previous);
    }
    for (const coverage of delta.task_coverage || []) {
      if (coverage.task_key !== taskKey) continue;
      for (const ref of coverage.unit_versions || []) units.add(ref);
      for (const ref of coverage.gate_versions || []) gates.add(ref);
    }
  }
  return {
    units: [...units].filter((ref) => !supersededUnits.has(ref)).sort(),
    gates: [...gates].filter((ref) => !supersededGates.has(ref)).sort(),
  };
}

function reconciliationFacts(run: RollingExecutionRun): RollingFact[] {
  return run.facts.filter((fact) => fact.kind === ROLLING_RECONCILIATION_DOCUMENT_KIND);
}

function lifecycleWithAcceptance(run: RollingExecutionRun, acceptance: RollingAcceptanceProjection) {
  return deriveRollingLifecycle({
    manifest_entries: run.manifest_entries,
    accepted_deltas: run.accepted_deltas,
    seals: run.seals,
    unit_states: acceptance.units,
    gate_states: acceptance.gates,
    facts: reconciliationFacts(run),
  });
}

function taskControlState(lifecycle: RollingTaskLifecycle, refs: { units: string[]; gates: string[] }, acceptance: RollingAcceptanceProjection): RollingTaskControlState {
  if (lifecycle.reconciled) return "reconciled";
  if (lifecycle.sealed) return "sealed";
  const unitStates = refs.units.map((ref) => acceptance.units[ref]?.state || "queued");
  const gateStates = refs.gates.map((ref) => acceptance.gates[ref]?.state || "pending");
  if (unitStates.includes("terminal-unreleased")) return "terminal-unreleased";
  if (unitStates.some((state) => state === "running" || state === "reserved")) return "active";
  if (unitStates.includes("failed") || gateStates.includes("failed") || lifecycle.state === "blocked") return "blocked";
  if (refs.units.length + refs.gates.length === 0) return "unplanned";
  if (refs.units.every((ref) => acceptance.units[ref]?.accepted) && refs.gates.every((ref) => acceptance.gates[ref]?.accepted)) return "accepted";
  return "planned";
}

function nextAction(state: RollingTaskControlState, runId: string, taskKey: string): string | null {
  if (state === "unplanned") return `baton run ${runId} --append-plan <delta.json> --dispatch`;
  if (state === "planned") return `baton run ${runId} --status`;
  if (state === "active") return "await native completion";
  if (state === "terminal-unreleased") return "baton dispatch release <ticket> --host <host>";
  if (state === "blocked") return `baton run ${runId} --append-plan <successor-delta.json> --dispatch`;
  if (state === "accepted") return `baton run ${runId} --seal-task ${taskKey} --seal-file <seal.json>`;
  if (state === "sealed") return `baton run ${runId} --reconcile --task ${taskKey}`;
  return null;
}

export async function statusRollingControl(context: RollingControlContext & { run_id: string }): Promise<RollingControlStatus> {
  const recovered = synchronizeRollingTicketFacts(context);
  const run = recovered.run;
  const source = sourceFromRun(run);
  const sourceDiagnostics = await rollingTaskSourceRegistry(context.cwd, source).diagnostics(source);
  const acceptance = deriveRollingAcceptance({ units: allUnits(run), gates: allGates(run), facts: executionFacts(run) });
  const lifecycle = lifecycleWithAcceptance(run, acceptance);
  const ticketByTask = new Map<string, Set<string>>();
  for (const ticket of recovered.tickets) {
    for (const taskKey of ticket.rolling_unit_lineage?.task_keys || []) {
      const ids = ticketByTask.get(taskKey) || new Set<string>();
      ids.add(ticket.id);
      ticketByTask.set(taskKey, ids);
    }
  }
  const tasks = run.manifest_entries.map((entry) => {
    const localLifecycle = lifecycle.task_lifecycle[entry.task_key];
    const refs = taskRefs(run, entry.task_key);
    if (!localLifecycle) throw new RollingControlError(`rolling lifecycle omitted manifest task ${entry.task_key}`, "ROLLING_STATE_CORRUPT");
    const state = taskControlState(localLifecycle, refs, acceptance);
    const blockers = [
      ...localLifecycle.blockers,
      ...refs.units.flatMap((ref) => acceptance.units[ref]?.blockers || []),
      ...refs.gates.flatMap((ref) => acceptance.gates[ref]?.blockers || []),
    ].map((item) => ({ code: item.code, message: item.message, ...(item.refs?.length ? { refs: [...item.refs] } : {}) }));
    return {
      task_key: entry.task_key,
      display_id: entry.display_id,
      title: entry.title,
      state,
      source_state: entry.source_state,
      unit_versions: refs.units,
      gate_versions: refs.gates,
      unit_states: Object.fromEntries(refs.units.map((ref) => [ref, acceptance.units[ref]?.state || "queued"])),
      gate_states: Object.fromEntries(refs.gates.map((ref) => [ref, acceptance.gates[ref]?.state || "pending"])),
      ticket_ids: [...(ticketByTask.get(entry.task_key) || [])].sort(),
      blockers,
      next_legal_action: nextAction(state, context.run_id, entry.task_key),
    } satisfies RollingTaskControlStatus;
  });
  const task_status = Object.fromEntries(tasks.map((task) => [task.task_key, task]));
  const state = tasks.length > 0 && tasks.every((task) => task.state === "reconciled")
    ? "reconciled"
    : tasks.length > 0 && tasks.every((task) => task.state === "sealed" || task.state === "reconciled")
      ? "sealed"
      : tasks.some((task) => task.state === "blocked" || task.state === "terminal-unreleased")
        ? "blocked"
        : "open";
  const firstAction = tasks.map((task) => task.next_legal_action).find((value): value is string => Boolean(value)) || null;
  return {
    schema_version: ROLLING_CONTROL_SCHEMA_VERSION,
    code: "ROLLING_RUN_STATUS",
    run_id: context.run_id,
    host: run.identity.host,
    session_uid: run.identity.session_uid,
    adapter: run.identity.adapter,
    source_kind: run.identity.source_kind,
    append_sequence: run.append_sequence,
    state,
    next_legal_action: firstAction,
    tasks,
    task_status,
    acceptance,
    tickets: recovered.tickets.map((ticket) => ({ ticket_id: ticket.id, unit_ref: `${ticket.rolling_unit_lineage!.unit_key}@${ticket.rolling_unit_lineage!.unit_version}`, status: ticket.status, released: Boolean(ticket.slot_released_at) })),
    recovery: { appended_execution_facts: recovered.appended, source_diagnostics: sourceDiagnostics.diagnostics },
  };
}

async function mutationResult(context: RollingControlContext & { run_id: string }, code: string, dispatch: RollingRefillResult | null): Promise<RollingControlMutationResult> {
  const status = await statusRollingControl(context);
  return { schema_version: ROLLING_CONTROL_SCHEMA_VERSION, code, run_id: context.run_id, append_sequence: status.append_sequence, dispatch, status };
}

export async function startRollingControl(input: StartRollingControlInput): Promise<RollingControlMutationResult> {
  createRollingExecutionRun({ cwd: input.cwd, env: input.env, runId: input.run_id, host: input.host, execution_mode: input.worktree_mode || "shared-worktree", source: input.source, now: input.now });
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
export function formatRollingControlStatus(status: RollingControlStatus): string {
  const lines = [
    `rolling run ${status.run_id}  ${status.state}`,
    `  host ${status.host}  append ${status.append_sequence}  session ${status.session_uid}`,
  ];
  for (const task of status.tasks) {
    lines.push(`  ${task.display_id}  ${task.state}  ${task.title}`);
    if (task.ticket_ids.length) lines.push(`    tickets ${task.ticket_ids.join(", ")}`);
    if (task.next_legal_action) lines.push(`    next ${task.next_legal_action}`);
    for (const blocker of task.blockers.slice(0, 3)) lines.push(`    blocked ${blocker.code}: ${blocker.message}`);
  }
  if (status.next_legal_action) lines.push(`  next ${status.next_legal_action}`);
  return `${lines.join("\n")}\n`;
}
