import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeConclusion, sanitizeProgress } from "./hygiene.js";
import { listSpawns, readSpawn, writeSpawn, sessionTicketId, sessionUid, validateSpawnSessionScope } from "./spawn.js";
import type {
  AgentProbeActivity,
  AgentProbeState,
  SpawnTicket,
  TicketError,
  TicketProgressPhase,
  TicketStatus,
  NativeExecutionHandle,
} from "./spawn.js";
import { normalizeSpawnTicket } from "./spawn.js";
import type { NativeExecutionHandleKind } from "../adapters/contract.js";
import { getCliAdapter } from "../adapters/index.js";
import type { UnknownRecord } from "../types.js";
import { dispatchLockPath, spawnsDir, workspaceId } from "./paths.js";
import { readReceipt, writeReceipt, type DelegationReceipt, type ExecutionMode } from "./receipt.js";
import { auditCommitOutcomeAsync, auditPreparedCommitAsync, auditWorktreeAsync, type AsyncSafetyOptions, type SafetyOperation } from "./safety.js";
import { writeTaskConclusionByNumber } from "./openspec.js";
import { recordRouteHealth } from "./route-health.js";
import { readRouteSnapshot, type ExecutableRoute } from "./routes.js";
import { cliProfileForHost, configuredCodingModelsForHost, loadConfig } from "./config.js";
import { parseHostId, type HostId } from "./hosts.js";
import {
  BATON_DISPATCH_RESERVATION_SCHEMA,
  withDispatchReservationEnvelope,
  type DispatchReservationIdentity,
} from "./dispatch-reservation.js";
import { withActivationLock, withActivationLockAsync, resolveActivation, type ActivationLockOptions } from "./activation.js";
import {
  availabilityForRoute,
  claimRouteProbe,
  isConfirmedQuotaExhaustion,
  markRouteAvailable,
  markRouteExhausted,
} from "./model-availability.js";
import { withOwnedLock, withOwnedLockAsync, type OwnedLock, type OwnedLockOptions } from "./owned-lock.js";
import { resolveAgentTreeCapacity, type EffectiveAgentTreeCapacity } from "./agent-tree-capacity.js";

export const TERMINAL_TICKET_STATUSES = new Set<TicketStatus>(["completed", "errored", "timed_out", "closed"]);
export const DEFAULT_AGENT_PROBE_INTERVAL_MS = 60_000;

function requireCurrentTicket(ticket: SpawnTicket): SpawnTicket {
  ticket = normalizeSpawnTicket(ticket);
  const objectValue = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const current = ticket.schema_version === 8
    && objectValue(ticket.work_unit)
    && objectValue(ticket.coordination)
    && Object.hasOwn(ticket, "progress")
    && Object.hasOwn(ticket, "liveness")
    && Object.hasOwn(ticket, "service_tier")
    && Object.hasOwn(ticket, "selection");
  if (!current) {
    throw new DispatchError(
      `ticket ${ticket.id || "<unknown>"} is not a current-format spawn ticket`,
      "TICKET_FORMAT_UNSUPPORTED",
      { ticketId: ticket.id },
    );
  }
  return ticket;
}

function requireSessionTicket(ticket: SpawnTicket, env: NodeJS.ProcessEnv): SpawnTicket {
  ticket = requireCurrentTicket(ticket);
  validateSpawnSessionScope(ticket, env);
  return ticket;
}

/** A bound agent keeps consuming a host thread until close_agent is confirmed. */
function holdsHostSlot(ticket: SpawnTicket): boolean {
  if (ticket.status === "dispatching") return true;
  if (!ticket.execution_handle) return false;
  if (ticket.status === "running") return true;
  return TERMINAL_TICKET_STATUSES.has(ticket.status)
    && !ticket.slot_released_at;
}

interface DispatchErrorExtras extends UnknownRecord {
  ticketId?: string;
  currentStatus?: TicketStatus;
  nextStatus?: TicketStatus;
}

export class DispatchError extends Error {
  readonly code: string;
  readonly ticketId?: string;
  readonly currentStatus?: TicketStatus;
  readonly nextStatus?: TicketStatus;
  readonly compatibility_blockers?: CompatibilityBlocker[];

  constructor(message: string, code = "DISPATCH_ERROR", extras: DispatchErrorExtras = {}) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    Object.assign(this, extras);
  }
}

export interface CompatibilityBlocker {
  readonly code: "UNATTRIBUTED_ACTIVE_RECORD";
  readonly file: string;
  readonly ticket_id: string | null;
  readonly status: string | null;
  readonly host: string | null;
  readonly reason: string;
}

const SESSION_UID_PATTERN = /^[0-9a-f]{64}$/;

function rawRecordHoldsSlot(value: Record<string, unknown>): boolean {
  const status = value.status;
  if (status === "dispatching" || status === "running") return true;
  return (status === "completed" || status === "errored" || status === "timed_out" || status === "closed")
    && value.execution_handle != null
    && !value.slot_released_at;
}

/** Find legacy/current records which hold a slot but cannot be assigned safely. */
export function dispatchCompatibilityBlockers(cwd: string, env: NodeJS.ProcessEnv = process.env): CompatibilityBlocker[] {
  const dir = spawnsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  const blockers: CompatibilityBlocker[] = [];
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".json"))) {
    const file = path.join(dir, name);
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (SESSION_UID_PATTERN.test(String(record.session_uid || "")) || !rawRecordHoldsSlot(record)) continue;
    blockers.push({
      code: "UNATTRIBUTED_ACTIVE_RECORD",
      file: path.relative(cwd, file).replaceAll("\\", "/"),
      ticket_id: typeof record.id === "string" ? record.id : null,
      status: typeof record.status === "string" ? record.status : null,
      host: typeof record.target_host === "string" ? record.target_host : typeof record.host === "string" ? record.host : null,
      reason: "active record has no valid root-agent-tree session_uid; reconciliation is required",
    });
  }
  return blockers;
}

/** Host-reported terminal failure, kept as structured evidence when the safety gate overrides it. */
type TerminalDispatchStatus = "completed" | "errored" | "timed_out" | "closed";

interface HostTerminalError {
  status: Exclude<TerminalDispatchStatus, "completed">;
  code: string;
  message: string;
}

interface ScopeRejection extends TicketError {
  host_error?: HostTerminalError;
}

function updateRouteHealth(cwd: string, ticket: SpawnTicket, status: TerminalDispatchStatus, error: HostTerminalError | null, at: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!ticket.route_id) return;
  const host = ticket.host || ticket.dispatch_host || ticket.target_host || ticket.selection?.host;
  if (!host) return;
  recordRouteHealth(cwd, {
    routeId: ticket.route_id,
    profile: ticket.reasoning_effort,
    host: String(host),
    taskText: ticket.prompt,
    terminalStatus: status,
    errorCode: error?.code || null,
    message: error?.message || null,
    now: new Date(at),
    env,
  });
}

type TimeInput = Date | string | number | (() => Date | string | number) | undefined;

function instant(now?: TimeInput): Date {
  const value = typeof now === "function" ? now() : now;
  const date = value == null ? new Date() : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new DispatchError("invalid dispatch timestamp", "INVALID_TIME");
  return date;
}

function history(ticket: SpawnTicket, event: string, at: string, detail: UnknownRecord = {}): void {
  if (!Array.isArray(ticket.history)) ticket.history = [];
  ticket.history.push({ event, at, ...detail });
  ticket.updated_at = at;
}

interface TransitionOptions {
  at: string;
  event?: string;
  detail?: UnknownRecord;
}

function transition(ticket: SpawnTicket, expected: TicketStatus | TicketStatus[], next: TicketStatus, { at, event = next, detail = {} }: TransitionOptions): SpawnTicket {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(ticket.status)) {
    throw new DispatchError(
      `invalid ticket transition ${ticket.id}: ${ticket.status} -> ${next}`,
      "INVALID_TICKET_TRANSITION",
      { ticketId: ticket.id, currentStatus: ticket.status, nextStatus: next },
    );
  }
  ticket.status = next;
  history(ticket, event, at, detail);
  return ticket;
}

function fifoTickets(cwd: string, env?: NodeJS.ProcessEnv): SpawnTicket[] {
  const uid = sessionUid(env);
  // Filter the immutable tree key before validating the remaining lifecycle
  // shape.  A malformed record belonging to another root must not prevent
  // this tree from selecting/refilling its own queue; workspace-wide safety
  // scans deliberately use their own unfiltered inventory.
  return listSpawns(cwd, env).filter((ticket) => ticket.session_uid === uid).map(requireCurrentTicket).sort((a, b) => {
    const time = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    // Descendants can be materialized in the same timestamp.  Their
    // session-local ordinal is the durable enqueue order; ticket ids are only
    // an opaque final tie-breaker (their prefix is not queue priority).
    return time || (Number(a.session_ordinal) - Number(b.session_ordinal)) || String(a.id).localeCompare(String(b.id));
  });
}

function lockPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return dispatchLockPath(cwd, env);
}

function dispatchLockError(error: unknown): never {
  if (error instanceof Error && "code" in error && error.code === "LOCK_BUSY") {
    throw new DispatchError("another dispatcher holds the project lock", "DISPATCH_LOCKED");
  }
  throw error;
}

export type DispatchLockOptions = Omit<OwnedLockOptions, "operation"> & { env?: NodeJS.ProcessEnv };
type ReserveActivationLockOptions = Omit<ActivationLockOptions, "host" | "scope" | "operation">;

/** Serialize a synchronous dispatch operation using the shared owned-lock primitive. */
export function withDispatchLock<T>(cwd: string, fn: () => T, options: DispatchLockOptions = {}): T {
  let acquired = false;
  const { env = process.env, ...lockOptions } = options;
  try {
    return withOwnedLock(lockPath(cwd, env), () => {
      acquired = true;
      return fn();
    }, { ...lockOptions, operation: "dispatch" });
  } catch (error) {
    if (acquired) throw error;
    return dispatchLockError(error);
  }
}

/** Await-safe dispatch transaction; ownership and lease refresh span all awaited work. */
export async function withDispatchLockAsync<T>(
  cwd: string,
  fn: (lock: OwnedLock) => Promise<T>,
  options: DispatchLockOptions = {},
): Promise<T> {
  let acquired = false;
  const { env = process.env, ...lockOptions } = options;
  try {
    return await withOwnedLockAsync(lockPath(cwd, env), (lock) => {
      acquired = true;
      return fn(lock);
    }, { ...lockOptions, operation: "dispatch" });
  } catch (error) {
    if (acquired) throw error;
    return dispatchLockError(error);
  }
}

function withLock<T>(cwd: string, fn: () => T, env: NodeJS.ProcessEnv = process.env): T {
  return withDispatchLock(cwd, fn, { env });
}

function capacityValue(capacity: unknown): number {
  const value = Number(capacity);
  if (!Number.isInteger(value) || value < 1) throw new DispatchError("capacity must be a positive integer", "INVALID_CAPACITY");
  return value;
}

export interface DispatchSpec {
  ticket_id: string;
  reservation: DispatchReservationIdentity;
  target_host: string;
  route_id: string;
  model: string;
  reasoning_effort: string | null;
  service_tier: string | null;
  fork_context: false;
  read_only: boolean;
  mode: ExecutionMode;
  receipt_id: string;
  write_allowlist: string[];
  allowed_operations: string[];
  commit_authorization: {
    expected_head: string;
    expected_tree: string;
    staged_paths: string[];
  } | null;
  description: string;
  prompt: string;
  work_unit: SpawnTicket["work_unit"];
  coordination: SpawnTicket["coordination"];
  attempt: number;
  max_attempts: number;
  selection: NonNullable<SpawnTicket["selection"]>;
}

function publicDispatchSpec(
  ticket: SpawnTicket & { route_id: string; receipt_id: string; reservation_id: string },
  receipt: DelegationReceipt,
  env: NodeJS.ProcessEnv = process.env,
): DispatchSpec {
  const reservation: DispatchReservationIdentity = {
    schema: BATON_DISPATCH_RESERVATION_SCHEMA,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: ticketTargetHost(ticket, env),
  };
  return {
    ticket_id: ticket.id,
    reservation,
    target_host: ticketTargetHost(ticket, env),
    route_id: ticket.route_id,
    model: ticket.route_id,
    reasoning_effort: ticket.reasoning_effort || null,
    service_tier: ticket.service_tier || null,
    fork_context: false,
    read_only: ticket.read_only,
    mode: ticket.mode,
    receipt_id: ticket.receipt_id,
    write_allowlist: receipt.scope.write_allowlist,
    allowed_operations: receipt.scope.allowed_operations,
    commit_authorization: receipt.commit_baseline ? {
      expected_head: receipt.commit_baseline.head,
      expected_tree: receipt.commit_baseline.staged_tree,
      staged_paths: receipt.commit_baseline.staged_paths,
    } : null,
    description: withDispatchReservationEnvelope(ticket.description, reservation),
    prompt: withDispatchReservationEnvelope(ticket.prompt, reservation),
    work_unit: ticket.work_unit,
    coordination: ticket.coordination,
    attempt: ticket.attempt,
    max_attempts: ticket.max_attempts,
    selection: ticket.selection!,
  };
}

function receiptModeMatches(ticket: SpawnTicket, receipt: DelegationReceipt): boolean {
  if (receipt.schema_version !== 4
    || receipt.execution.mode !== ticket.mode
    || receipt.execution.fork_context !== false
    || receipt.execution.max_depth !== 1
    || ticket.read_only !== (ticket.mode === "read-only")
    || (ticket.service_tier || null) !== (receipt.route.service_tier || null)
    || receipt.git_policy.worker_may_stage !== false
    || receipt.git_policy.worker_may_branch !== false
    || receipt.git_policy.worker_may_rebase !== false
    || receipt.git_policy.staging_owner !== "parent") return false;
  if (ticket.mode === "read-only") {
    return !receipt.baseline
      && !receipt.commit_baseline
      && receipt.git_policy.worker_may_commit === false
      && receipt.scope.write_allowlist.length === 0
      && receipt.scope.allowed_operations.length === 1
      && receipt.scope.allowed_operations[0] === "read"
      && receipt.scope.side_effects.length === 0;
  }
  if (ticket.mode === "write") {
    return Boolean(receipt.baseline)
      && !receipt.commit_baseline
      && receipt.git_policy.worker_may_commit === false
      && receipt.scope.write_allowlist.length > 0
      && receipt.scope.allowed_operations.length > 0
      && !receipt.scope.allowed_operations.includes("read")
      && !receipt.scope.allowed_operations.includes("commit")
      && receipt.scope.side_effects.length === 1
      && receipt.scope.side_effects[0] === "filesystem-write";
  }
  return !receipt.baseline
    && Boolean(receipt.commit_baseline)
    && receipt.git_policy.worker_may_commit === true
    && receipt.scope.allowed_operations.length === 1
    && receipt.scope.allowed_operations[0] === "commit"
    && receipt.scope.side_effects.length === 1
    && receipt.scope.side_effects[0] === "git-commit"
    && JSON.stringify(receipt.scope.write_allowlist) === JSON.stringify(receipt.commit_baseline!.staged_paths);
}

async function rejectUndispatchable(cwd: string, ticket: SpawnTicket, at: string, host: HostId, env: NodeJS.ProcessEnv = process.env, safetyOptions: AsyncSafetyOptions = {}): Promise<{ ticket_id: string; code: string; message: string } | null> {
  let code = null;
  let message = null;
  let capturedHost: HostId | null = null;
  try {
    capturedHost = ticketTargetHost(ticket, env);
  } catch (error) {
    if (error instanceof DispatchError) {
      code = error.code;
      message = error.message;
    } else {
      code = "INVALID_HOST";
      message = `ticket ${ticket.id} has an invalid target host`;
    }
  }
  if (code) {
    // Preserve the host resolution error below.
  } else if (capturedHost !== host) {
    code = "HOST_MISMATCH";
    message = `ticket ${ticket.id} targets ${capturedHost}, not ${host}`;
  } else if (!ticket.route_id) {
    code = "NO_EXECUTABLE_ROUTE";
    message = `ticket ${ticket.id} has no executable route for this host`;
  } else if (ticket.fork_context !== false) {
    code = "FULL_CONTEXT_NOT_ALLOWED";
    message = `ticket ${ticket.id} must use fork_context=false`;
  } else if (ticket.work_unit.kind === "deliberative" && ticket.coordination.mode !== "checkpointed") {
    code = "COORDINATION_REQUIRED";
    message = `ticket ${ticket.id} is deliberative and requires checkpointed coordination`;
  } else if (Number(ticket.attempt || 0) >= Number(ticket.max_attempts || 1)) {
    code = "ATTEMPT_BUDGET_EXHAUSTED";
    message = `ticket ${ticket.id} exhausted its attempt budget`;
  } else if (!ticket.selection || !["user", "ops-config", "baton-recommendation"].includes(ticket.selection.confirmed_by) || ticket.selection.selected_model_id !== ticket.model_id) {
    code = "MODEL_SELECTION_NOT_CONFIRMED";
    message = `ticket ${ticket.id} has no valid Baton-recommended or ops-config model selection`;
  } else {
    const availability = availabilityForRoute(cwd, { host, routeId: ticket.route_id }, at, env);
    if ((availability.status === "exhausted" || availability.status === "probe_due") && !availability.probe_available) {
      code = "MODEL_QUOTA_EXHAUSTED";
      message = `ticket ${ticket.id} route ${ticket.route_id} is unavailable until ${availability.reset_at || availability.next_probe_at || "a later probe"}`;
    }
  }
  if (!code && ticket.route_id && ticket.selection && ticket.selection.selected_model_id === ticket.model_id) {
    const catalog = readRouteSnapshot(cwd, { host, env });
    const route = catalog?.routes.find((item) => !item.disabled && item.route_id === ticket.route_id);
    if (!catalog) {
      code = "ROUTE_SNAPSHOT_REQUIRED";
      message = `ticket ${ticket.id} requires a CLI model catalog captured by baton config`;
    } else {
      const config = loadConfig(cwd, { env });
      // Validate the ticket's captured host profile; never borrow another CLI.
      const profileHost = capturedHost!;
      const profile = cliProfileForHost(config, profileHost);
      if (!profile.enabled || catalog.cli !== profileHost) {
        code = "CLI_CONFIG_DISABLED";
        message = `ticket ${ticket.id} requires the ${profileHost} configuration to be enabled`;
      } else if (!configuredCodingModelsForHost(config, profileHost).includes(ticket.route_id)) {
        code = "CLI_MODEL_NOT_CONFIGURED";
        message = `ticket ${ticket.id} model ${ticket.route_id} is not in cli.${profileHost}.coding_models`;
      }
    }
    if (!code && !route) {
      code = "CLI_MODEL_UNAVAILABLE";
      message = `ticket ${ticket.id} model ${ticket.route_id} is absent from the active CLI model catalog`;
    } else if (!code && ticket.reasoning_effort && !route!.reasoning_efforts.includes(ticket.reasoning_effort)) {
      code = "CLI_REASONING_EFFORT_UNAVAILABLE";
      message = `ticket ${ticket.id} reasoning effort ${ticket.reasoning_effort} was not returned for ${ticket.route_id}`;
    } else if (!code && ticket.service_tier
      && !route!.service_tiers.includes(ticket.service_tier)
      && !route!.additional_speed_tiers.includes(ticket.service_tier)) {
      code = "CLI_SERVICE_TIER_UNAVAILABLE";
      message = `ticket ${ticket.id} service tier ${ticket.service_tier} was not returned for ${ticket.route_id}`;
    }
  }
  if (!code && !ticket.receipt_id) {
    code = "RECEIPT_REQUIRED";
    message = `ticket ${ticket.id} has no Delegation Receipt`;
  } else if (!code) {
    let receipt: DelegationReceipt;
    try {
      receipt = readReceipt(cwd, ticket.receipt_id, env);
      const expectedReceiptHost = ticket.target_host || ticket.dispatch_host || ticket.host;
      if (receipt.ticket_id !== ticket.id
        || (expectedReceiptHost ? receipt.host !== expectedReceiptHost : Boolean(receipt.host && receipt.host !== host))
        || receipt.route.route_id !== ticket.route_id
        || !receiptModeMatches(ticket, receipt)
        || !receipt.selection
        || receipt.selection.approval_id !== ticket.selection!.approval_id
        || receipt.selection.selected_model_id !== ticket.model_id) {
        code = "RECEIPT_MISMATCH";
        message = `ticket ${ticket.id} does not match its Delegation Receipt`;
      }
    } catch (error) {
      code = "RECEIPT_INVALID";
      message = error instanceof Error ? error.message : String(error);
    }
    if (!code && ticket.mode === "commit-only") {
      const verdict = await auditPreparedCommitAsync(cwd, receipt!.commit_baseline!, safetyOptions);
      if (!verdict.accepted) {
        code = "COMMIT_BASELINE_STALE";
        message = verdict.violations.map((item) => item.code).join(", ");
      }
    }
  }
  if (!code) return null;
  transition(ticket, "queued", "errored", { at, event: "dispatch_blocked", detail: { error_code: code } });
  ticket.error = { code, message };
  ticket.finished_at = at;
  writeSpawn(cwd, ticket, env);
  return { ticket_id: ticket.id, code, message };
}

interface ReserveOptions {
  capacity?: number;
  limit?: number;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
  /** Internal await-safety injection surface; not part of CLI syntax. */
  safety?: AsyncSafetyOptions;
  activationLock?: ReserveActivationLockOptions;
  dispatchLock?: DispatchLockOptions;
}

function requireHost(host: string, env: NodeJS.ProcessEnv = process.env): HostId {
  try {
    return parseHostId(host, env);
  } catch (error) {
    throw new DispatchError(error instanceof Error ? error.message : String(error), "INVALID_HOST");
  }
}

function hostReportedLimit(host: HostId | undefined, env: NodeJS.ProcessEnv): number | undefined {
  if (!host) return undefined;
  const value = getCliAdapter(host, env).host.maxConcurrent(env);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

function treeConfiguredPolicy(
  config: ReturnType<typeof loadConfig> | undefined,
  host: HostId | undefined,
  hostLimit: number | undefined,
): number | undefined {
  if (!config || !host) return undefined;
  const profileLimit = cliProfileForHost(config, host).max_concurrent;
  if (profileLimit !== undefined) return profileLimit;
  // Director 4 is only the fallback when the CLI/host did not report a limit.
  return hostLimit === undefined ? config.director.max_concurrent : undefined;
}

function resolvedCapacity(cwd: string, host: HostId | undefined, env: NodeJS.ProcessEnv, operationLimit?: number): EffectiveAgentTreeCapacity {
  const adapter = host ? getCliAdapter(host, env) : undefined;
  let config;
  try {
    config = loadConfig(cwd, { env });
  } catch {
    // Direct library callers and pre-init diagnostics may provide an explicit
    // operation limit; the host resolver remains authoritative when config is
    // unavailable.
  }
  const hostLimit = hostReportedLimit(host, env);
  return resolveAgentTreeCapacity({
    host: adapter?.host,
    hostLimit,
    configuredPolicy: treeConfiguredPolicy(config, host, hostLimit),
    currentOperationLimit: operationLimit,
    session: sessionUid(env),
    env,
  });
}

function requiredCapacity(value: EffectiveAgentTreeCapacity): number {
  if (value.capacity == null) throw new DispatchError("capacity is unknown", "CAPACITY_UNKNOWN");
  return value.capacity;
}

/** Resolve the host captured by a ticket. Hostless tickets are not attributed. */
function ticketTargetHost(ticket: SpawnTicket, env: NodeJS.ProcessEnv = process.env): HostId {
  const captured = ticket.target_host || ticket.dispatch_host || ticket.host || ticket.selection?.host;
  if (captured) return requireHost(String(captured), env);
  throw new DispatchError(`ticket ${ticket.id} has no captured host`, "HOST_REQUIRED", { ticketId: ticket.id });
}

function ticketMatchesHost(ticket: SpawnTicket, host: HostId, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return ticketTargetHost(ticket, env) === host;
  } catch {
    return false;
  }
}

/**
 * Return only tickets owned by this root tree and targeting this host.
 *
 * Capacity is a property of the pair (host, session_uid), not of every
 * ticket in the workspace.  Keep the session check here next to the host
 * check so active-slot callers cannot accidentally widen their accounting by
 * reusing a workspace-wide ticket list.
 */
function ticketsInDispatchScope(tickets: SpawnTicket[], host: HostId, env: NodeJS.ProcessEnv = process.env): SpawnTicket[] {
  const uid = sessionUid(env);
  return tickets.filter((ticket) => ticket.session_uid === uid && ticketMatchesHost(ticket, host, env));
}

/**
 * A dispatching ticket reserves a slot before binding; a bound running ticket
 * keeps it; and every terminal ticket keeps it until release is confirmed.
 */
function activeTicketsInDispatchScope(tickets: SpawnTicket[], host: HostId, env: NodeJS.ProcessEnv = process.env): SpawnTicket[] {
  return ticketsInDispatchScope(tickets, host, env).filter(holdsHostSlot);
}

export async function reserveNext(cwd: string, { capacity, limit = Number.MAX_SAFE_INTEGER, host, now, env = process.env, safety, activationLock = {}, dispatchLock = {} }: ReserveOptions) {
  // Establish the root-agent-tree scope before acquiring either mutation
  // lock.  A missing BATON_SESSION_ID must not create a reservation or a
  // lifecycle lock as a side effect of a failed capacity-sensitive call.
  sessionUid(env);
  if (!host) throw new DispatchError("host is required", "HOST_REQUIRED");
  const targetHost = requireHost(host, env);
  const compatibilityBlockers = dispatchCompatibilityBlockers(cwd, env);
  if (compatibilityBlockers.length) {
    throw new DispatchError(
      "cannot reserve dispatches while unattributed active records require reconciliation",
      "COMPATIBILITY_BLOCKED",
      { compatibility_blockers: compatibilityBlockers },
    );
  }
  const capacityResolution = resolvedCapacity(cwd, targetHost, env, capacity);
  const max = requiredCapacity(capacityResolution);
  const safetyOptions = safety || {};
  return withActivationLockAsync(cwd, env, async () => {
    const maxTake = Math.max(0, Math.floor(Number(limit) || 0));
    return withDispatchLockAsync(cwd, async () => {
    const at = instant(now).toISOString();
    const tickets = fifoTickets(cwd, env);
    const activeTickets = activeTicketsInDispatchScope(tickets, targetHost, env);
    const active = activeTickets.length;
    let available = Math.max(0, max - active);
    const reserved: DispatchSpec[] = [];
    const blocked: Array<{ ticket_id: string; code: string; message: string }> = [];
    let activationChecked = false;
    const ensureActivation = (): void => {
      if (activationChecked) return;
      activationChecked = true;
      const activation = resolveActivation(cwd, { env, host: targetHost });
      if (!activation.valid) {
        throw new DispatchError(
          `cannot reserve dispatches while activation is invalid: ${activation.reason || "unknown"}`,
          "ACTIVATION_INVALID",
        );
      }
      if (!activation.effective_enabled) {
        throw new DispatchError(
          `cannot reserve dispatches while ${targetHost} activation is disabled: ${activation.reason || "unknown"}`,
          "ACTIVATION_DISABLED",
        );
      }
    };
    for (const ticket of tickets) {
      if (ticket.status !== "queued" || available <= 0 || reserved.length >= maxTake) continue;
      requireCurrentTicket(ticket);
      let ticketHost: HostId;
      try {
        ticketHost = ticketTargetHost(ticket, env);
      } catch (error) {
        blocked.push({
          ticket_id: ticket.id,
          code: error instanceof DispatchError ? error.code : "HOST_REQUIRED",
          message: error instanceof Error ? error.message : `ticket ${ticket.id} has no captured host`,
        });
        continue;
      }
      if (ticketHost !== targetHost) {
        blocked.push({ ticket_id: ticket.id, code: "HOST_MISMATCH", message: `ticket ${ticket.id} targets ${ticketHost}, not ${targetHost}` });
        continue;
      }
      ensureActivation();
      const rejected = await rejectUndispatchable(cwd, ticket, at, targetHost, env, safetyOptions);
      if (rejected) {
        blocked.push(rejected);
        if (rejected.code === "MODEL_QUOTA_EXHAUSTED") {
          await createQuotaSuccessor(cwd, ticket, at, env, safetyOptions);
          writeSpawn(cwd, ticket, env);
        }
        continue;
      }
      const availability = availabilityForRoute(cwd, { host: targetHost, routeId: ticket.route_id! }, at, env);
      if ((availability.status === "exhausted" || availability.status === "probe_due") && availability.probe_available) {
        const nextAttempt = Number(ticket.attempt || 0) + 1;
        const probe = claimRouteProbe(cwd, { host: targetHost, routeId: ticket.route_id! }, {
          owner: `${workspaceId(cwd)}:${ticket.id}:attempt-${nextAttempt}`,
          now: at,
          env,
        });
        if (!probe.claimed) {
          const probeRejected = {
            ticket_id: ticket.id,
            code: "MODEL_QUOTA_EXHAUSTED",
            message: `ticket ${ticket.id} route ${ticket.route_id} probe lease is owned by another dispatcher`,
          };
          blocked.push(probeRejected);
          transition(ticket, "queued", "errored", { at, event: "dispatch_blocked", detail: { error_code: probeRejected.code } });
          ticket.error = { code: probeRejected.code, message: probeRejected.message };
          ticket.finished_at = at;
          await createQuotaSuccessor(cwd, ticket, at, env, safetyOptions);
          writeSpawn(cwd, ticket, env);
          continue;
        }
      }
      ticket.dispatch_host = targetHost;
      ticket.dispatch_requested_at = at;
      ticket.attempt = Number(ticket.attempt || 0) + 1;
      ticket.reservation_id = crypto.randomUUID();
      transition(ticket, "queued", "dispatching", {
        at,
        event: "dispatch_reserved",
        detail: { host: targetHost, reservation_id: ticket.reservation_id, attempt: ticket.attempt },
      });
      ticket.error = null;
      writeSpawn(cwd, ticket, env);
      const receipt = readReceipt(cwd, ticket.receipt_id!, env);
      reserved.push(publicDispatchSpec(ticket as SpawnTicket & { route_id: string; receipt_id: string; reservation_id: string }, receipt, env));
      available -= 1;
    }
      return { reserved, blocked, snapshot: dispatchSnapshot(cwd, { host: targetHost, env, capacityResolution }) };
    }, { ...dispatchLock, env });
  }, { ...activationLock, host: targetHost, scope: "both", operation: "dispatch-reservation" });
}

interface BindOptions {
  /** Native execution handle returned by the serving host. */
  executionHandle?: NativeExecutionHandle;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
}

const AGENT_PROBE_STATES = new Set<AgentProbeState>(["pending_init", "running", "interrupted", "shutdown", "not_found"]);
const AGENT_PROBE_ACTIVITIES = new Set<AgentProbeActivity>(["status", "output", "heartbeat"]);
const LIVE_AGENT_PROBE_STATES = new Set<AgentProbeState>(["pending_init", "running"]);

function updateTicketLiveness(
  ticket: SpawnTicket,
  handle: NativeExecutionHandle,
  state: AgentProbeState,
  activity: AgentProbeActivity,
  at: string,
): void {
  ticket.liveness = {
    sequence: Number(ticket.liveness?.sequence || 0) + 1,
    execution_handle: handle,
    state,
    activity,
    observed_at: at,
  };
}

function currentHandleForTicket(ticket: SpawnTicket): NativeExecutionHandle | null {
  return ticket.execution_handle;
}

export function bindAgent(cwd: string, id: string, {
  executionHandle,
  host,
  now,
  env = process.env,
}: BindOptions): SpawnTicket {
  sessionUid(env);
  host = requireHost(host, env);
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    const targetHost = ticketTargetHost(ticket, env);
    if (targetHost !== host || (ticket.dispatch_host && ticket.dispatch_host !== host)) {
      throw new DispatchError(`ticket ${id} targets ${targetHost}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (ticket.status !== "dispatching") {
      throw new DispatchError(
        `invalid ticket transition ${ticket.id}: ${ticket.status} -> running`,
        "INVALID_TICKET_TRANSITION",
        { ticketId: id, currentStatus: ticket.status, nextStatus: "running" },
      );
    }
    const handle = executionHandle || null;
    if (!handle || !handle.value.trim()) throw new DispatchError(`ticket ${id} has no native execution handle`, "EXECUTION_HANDLE_REQUIRED", { ticketId: id });
    const expectedKind = getCliAdapter(host, env).host.executionHandleKind;
    if (handle.kind !== expectedKind) throw new DispatchError(`ticket ${id} requires handle kind ${expectedKind}`, "EXECUTION_HANDLE_KIND_MISMATCH", { ticketId: id });
    const detail: UnknownRecord = { host, execution_handle: handle };
    transition(ticket, "dispatching", "running", { at, event: "agent_bound", detail });
    ticket.execution_handle = handle;
    ticket.host = host;
    ticket.started_at = at;
    updateTicketLiveness(ticket, handle, "running", "status", at);
    if (ticket.route_id) {
      try {
        markRouteAvailable(cwd, { host, routeId: ticket.route_id }, { now: at, env });
      } catch (error) {
        throw new DispatchError(
          `model availability persistence failed: ${error instanceof Error ? error.message : String(error)}`,
          "MODEL_AVAILABILITY_WRITE_FAILED",
          { ticketId: id },
        );
      }
    }
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}

interface DeferOptions {
  code?: string;
  message?: string;
  observedCapacity?: number | null;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
}

/**
 * Host concurrency rejection is backpressure, not a worker/route failure.
 * Return the same ticket to FIFO without consuming an attempt.
 */
export function deferDispatch(cwd: string, id: string, {
  code = "AGENT_LIMIT_REACHED",
  message = "host has no free subagent thread",
  observedCapacity = null,
  host,
  now,
  env = process.env,
}: DeferOptions = {}): SpawnTicket {
  sessionUid(env);
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    // Resolve the captured host before clearing reservation metadata.  A
    // legacy/current ticket may carry only dispatch_host while dispatching;
    // clearing it first would make observed-capacity bookkeeping fail after
    // the ticket had already been persisted back to the queue.
    const targetHost = ticketTargetHost(ticket, env);
    if (host && targetHost !== requireHost(host, env)) {
      throw new DispatchError(`ticket ${id} targets ${targetHost}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (ticket.execution_handle) throw new DispatchError(`ticket ${id} is already bound`, "EXECUTION_HANDLE_ALREADY_BOUND", { ticketId: id });
    transition(ticket, "dispatching", "queued", {
      at,
      event: "dispatch_deferred",
      detail: { error_code: String(code), message: String(message) },
    });
    ticket.attempt = Math.max(0, Number(ticket.attempt || 0) - 1);
    ticket.error = null;
    delete ticket.reservation_id;
    delete ticket.dispatch_host;
    delete ticket.dispatch_requested_at;
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}

const PROGRESS_PHASES = new Set<TicketProgressPhase>(["starting", "working", "waiting", "blocked", "checkpoint"]);

interface ProbeOptions {
  executionHandle?: NativeExecutionHandle;
  state: AgentProbeState;
  activity?: AgentProbeActivity;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
}

/**
 * Persist the host runtime's current view of a bound agent. This is a liveness
 * signal only: it never changes business progress or ticket terminal state.
 */
export function reportAgentProbe(cwd: string, id: string, {
  executionHandle,
  state,
  activity = "status",
  host,
  now,
  env = process.env,
}: ProbeOptions): SpawnTicket {
  sessionUid(env);
  if (!AGENT_PROBE_STATES.has(state)) throw new DispatchError(`invalid agent probe state: ${state}`, "INVALID_AGENT_PROBE_STATE", { ticketId: id });
  if (!AGENT_PROBE_ACTIVITIES.has(activity)) throw new DispatchError(`invalid agent probe activity: ${activity}`, "INVALID_AGENT_PROBE_ACTIVITY", { ticketId: id });
  if (!LIVE_AGENT_PROBE_STATES.has(state) && activity !== "status") {
    throw new DispatchError(`agent probe state ${state} cannot report ${activity} activity`, "INVALID_AGENT_PROBE_ACTIVITY", { ticketId: id });
  }
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    if (host && ticketTargetHost(ticket, env) !== requireHost(host, env)) {
      throw new DispatchError(`ticket ${id} targets ${ticketTargetHost(ticket, env)}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (ticket.status !== "running") {
      throw new DispatchError(`ticket ${id} is not running`, "PROBE_REQUIRES_RUNNING", { ticketId: id, currentStatus: ticket.status });
    }
    const requested = executionHandle || null;
    const bound = currentHandleForTicket(ticket);
    if (!requested) throw new DispatchError("execution handle is required", "EXECUTION_HANDLE_REQUIRED", { ticketId: id });
    if (requested.kind !== getCliAdapter(requireHost(host || ticketTargetHost(ticket, env), env), env).host.executionHandleKind) {
      throw new DispatchError("execution handle kind does not match adapter", "EXECUTION_HANDLE_KIND_MISMATCH", { ticketId: id });
    }
    if (!bound || bound.kind !== requested.kind || bound.value !== requested.value) {
      throw new DispatchError(`ticket ${id} is bound to ${bound?.value || "no handle"}, not ${requested.value}`, "EXECUTION_HANDLE_MISMATCH", { ticketId: id });
    }
    updateTicketLiveness(ticket, bound, state, activity, at);
    if (state === "running") {
      const availability = availabilityOutcome(cwd, ticket, at, { success: true, env });
      if (availability) ticket.quota_diagnostic = availability;
    }
    history(ticket, "agent_probe", at, {
      sequence: ticket.liveness!.sequence,
      execution_handle: bound,
      state,
      activity,
    });
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}

interface ProgressOptions {
  phase: TicketProgressPhase;
  summary: string;
  nextStep?: string | null;
  blocker?: string | null;
  needsDirector?: boolean;
  now?: TimeInput;
  host?: string;
  env?: NodeJS.ProcessEnv;
}

export function reportAgentProgress(cwd: string, id: string, {
  phase,
  summary,
  nextStep = null,
  blocker = null,
  needsDirector = false,
  host,
  now,
  env = process.env,
}: ProgressOptions): SpawnTicket {
  sessionUid(env);
  if (!PROGRESS_PHASES.has(phase)) throw new DispatchError(`invalid progress phase: ${phase}`, "INVALID_PROGRESS_PHASE", { ticketId: id });
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    if (host && ticketTargetHost(ticket, env) !== requireHost(host, env)) {
      throw new DispatchError(`ticket ${id} targets ${ticketTargetHost(ticket, env)}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (ticket.status !== "running") {
      throw new DispatchError(`ticket ${id} is not running`, "PROGRESS_REQUIRES_RUNNING", { ticketId: id, currentStatus: ticket.status });
    }
    const clean = sanitizeProgress(summary);
    if (!clean.ok) throw new DispatchError("error" in clean ? clean.error : "invalid progress", "HYGIENE", { ticketId: id });
    const cleanOptional = (value: string | null): string | null => {
      if (!value) return null;
      const result = sanitizeProgress(value);
      if (!result.ok) throw new DispatchError("error" in result ? result.error : "invalid progress", "HYGIENE", { ticketId: id });
      return result.conclusion;
    };
    ticket.progress = {
      sequence: Number(ticket.progress?.sequence || 0) + 1,
      phase,
      summary: clean.conclusion,
      next_step: cleanOptional(nextStep),
      blocker: cleanOptional(blocker),
      needs_director: Boolean(needsDirector),
      reported_at: at,
    };
    const handle = currentHandleForTicket(ticket);
    if (handle) updateTicketLiveness(ticket, handle, "running", "output", at);
    history(ticket, "agent_progress", at, {
      sequence: ticket.progress.sequence,
      phase,
      needs_director: ticket.progress.needs_director,
      liveness_sequence: ticket.liveness?.sequence || null,
    });
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}

function relativeLedgerPath(cwd: string, tasksPath: unknown): string | null {
  if (typeof tasksPath !== "string" || !tasksPath) return null;
  const relative = path.relative(cwd, tasksPath).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return relative;
}

function peerWriteAllowlists(cwd: string, ticket: SpawnTicket, env: NodeJS.ProcessEnv = process.env): string[][] {
  const lists: string[][] = [];
  const ledger = new Set<string>();
  const ownLedger = relativeLedgerPath(cwd, ticket.openspec?.tasks_path);
  if (ownLedger) ledger.add(ownLedger);
  for (const other of listSpawns(cwd, env).map(requireCurrentTicket)) {
    const otherLedger = relativeLedgerPath(cwd, other.openspec?.tasks_path);
    if (otherLedger) ledger.add(otherLedger);
    if (other.id === ticket.id || other.mode !== "write" || !other.receipt_id) continue;
    const overlapping = Boolean(other.started_at)
      || other.status === "dispatching"
      || other.status === "running"
      || other.status === "completed";
    if (!overlapping) continue;
    try {
      const allowlist = readReceipt(cwd, other.receipt_id, env).scope.write_allowlist;
      if (allowlist.length) lists.push(allowlist);
    } catch {
      continue;
    }
  }
  if (ledger.size) lists.push([...ledger]);
  return lists;
}

interface FinishOptions {
  status: "completed" | "errored" | "timed_out" | "closed";
  conclusion?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  remainingPercent?: number | null;
  resetAt?: string | null;
  probeSequence?: number | null;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
  /** Internal await-safety injection surface; not part of CLI syntax. */
  safety?: AsyncSafetyOptions;
  dispatchLock?: DispatchLockOptions;
}

function availabilityOutcome(
  cwd: string,
  ticket: SpawnTicket,
  at: string,
  outcome: { errorCode?: string | null; message?: string | null; remainingPercent?: number | null; resetAt?: string | null; success?: boolean; env?: NodeJS.ProcessEnv },
): UnknownRecord | null {
  if (!ticket.route_id) return null;
  let host: HostId;
  try {
    host = ticketTargetHost(ticket, outcome.env);
  } catch {
    return null;
  }
  try {
    const positiveRemaining = typeof outcome.remainingPercent === "number"
      && Number.isFinite(outcome.remainingPercent)
      && outcome.remainingPercent > 0;
    if (isConfirmedQuotaExhaustion(outcome) && !positiveRemaining) {
      const record = markRouteExhausted(cwd, { host, routeId: ticket.route_id }, {
        reason: outcome.errorCode || "QUOTA_EXHAUSTED",
        resetAt: outcome.resetAt || null,
        now: at,
        env: outcome.env,
      });
      return {
        status: record.status,
        reason: record.reason,
        reset_at: record.reset_at,
        next_probe_at: record.next_probe_at,
        remaining_percent: outcome.remainingPercent ?? null,
      };
    }
    if (outcome.success || positiveRemaining) {
      const record = markRouteAvailable(cwd, { host, routeId: ticket.route_id }, { now: at, env: outcome.env });
      return { status: record.status, reason: null, reset_at: null, next_probe_at: null };
    }
    return null;
  } catch (error) {
    const durable = isConfirmedQuotaExhaustion(outcome)
      || (typeof outcome.remainingPercent === "number" && outcome.remainingPercent <= 0)
      || outcome.success === true
      || (typeof outcome.remainingPercent === "number" && outcome.remainingPercent > 0);
    if (durable) {
      throw new DispatchError(
        `model availability persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        "MODEL_AVAILABILITY_WRITE_FAILED",
        { ticketId: ticket.id },
      );
    }
    return null;
  }
}

function successorRouteForTicket(cwd: string, ticket: SpawnTicket, at: string, env: NodeJS.ProcessEnv = process.env): { route: ExecutableRoute; routeId: string } | null {
  if (!ticket.route_id || ticket.mode !== "write" || !ticket.receipt_id) return null;
  const receipt = readReceipt(cwd, ticket.receipt_id, env);
  if (!receipt.baseline) return null;
  const host = ticketTargetHost(ticket, env);
  const config = loadConfig(cwd, { env });
  const configured = configuredCodingModelsForHost(config, host);
  const currentIndex = configured.indexOf(ticket.route_id);
  if (currentIndex < 0) return null;
  const snapshot = readRouteSnapshot(cwd, { host, env });
  if (!snapshot) return null;
  for (const routeId of configured.slice(currentIndex + 1)) {
    const route = snapshot.routes.find((item) => !item.disabled && item.route_id === routeId);
    if (!route) continue;
    const requiredEffort = ticket.routing_requirements?.required_reasoning_effort || ticket.reasoning_effort || null;
    if (requiredEffort && route.reasoning_efforts.length > 0 && !route.reasoning_efforts.includes(requiredEffort)) continue;
    const estimatedContext = Number(ticket.routing_requirements?.estimated_context_tokens);
    if (Number.isFinite(estimatedContext) && estimatedContext > 0 && route.context_window !== null && route.context_window < estimatedContext) continue;
    const availability = availabilityForRoute(cwd, { host, routeId }, at, env);
    if ((availability.status === "exhausted" || availability.status === "probe_due") && !availability.probe_available) continue;
    return { route, routeId };
  }
  return null;
}

/**
 * Allocate a successor ordinal in the originating session without clobbering
 * another ticket that was already materialized in the same wave.
 */
function nextSuccessorOrdinal(cwd: string, ticket: SpawnTicket, env: NodeJS.ProcessEnv): number {
  const occupied = new Set(
    listSpawns(cwd, env)
      .filter((item) => item.session_uid === ticket.session_uid)
      .map((item) => item.session_ordinal),
  );
  let ordinal = ticket.session_ordinal + 1;
  while (occupied.has(ordinal)) ordinal += 1;
  return ordinal;
}

async function createQuotaSuccessor(cwd: string, ticket: SpawnTicket, at: string, env: NodeJS.ProcessEnv = process.env, safetyOptions: AsyncSafetyOptions = {}): Promise<string | null> {
  if (ticket.mode !== "write" || !ticket.receipt_id) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const receipt = readReceipt(cwd, ticket.receipt_id, env);
  if (!receipt.baseline) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const noMutation = await auditWorktreeAsync(cwd, receipt.baseline, { write_allowlist: [], allowed_operations: [] }, safetyOptions);
  if (!noMutation.accepted) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const candidate = successorRouteForTicket(cwd, ticket, at, env);
  if (!candidate) {
    ticket.successor_reason = "NO_SUCCESSOR_ROUTE";
    return null;
  }
  // Successors belong to the originating session even if the environment
  // changed while reconciliation was running.
  const successorOrdinal = nextSuccessorOrdinal(cwd, ticket, env);
  const successorId = sessionTicketId("spn", ticket.session_uid, successorOrdinal);
  const route = candidate.route;
  const reasoningEffort = ticket.reasoning_effort && route.reasoning_efforts.includes(ticket.reasoning_effort)
    ? ticket.reasoning_effort
    : route.default_reasoning_effort;
  const serviceTier = ticket.service_tier
    && (route.service_tiers.includes(ticket.service_tier) || route.additional_speed_tiers.includes(ticket.service_tier))
    ? ticket.service_tier
    : route.default_service_tier;
  const selection = ticket.selection ? {
    ...structuredClone(ticket.selection),
    approval_id: `successor-${successorId}`,
    approved_at: at,
    confirmed_by: "baton-recommendation" as const,
    catalog_fingerprint: readRouteSnapshot(cwd, { host: ticketTargetHost(ticket, env), env })?.fingerprint || ticket.selection.catalog_fingerprint,
    recommended_model_id: route.route_id,
    selected_model_id: route.route_id,
    service_tier: serviceTier,
    changed_by_user: false,
  } : null;
  if (!selection) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const successor = structuredClone(ticket);
  successor.id = successorId;
  successor.session_uid = ticket.session_uid;
  successor.session_ordinal = successorOrdinal;
  successor.model_id = route.route_id;
  successor.route_id = route.route_id;
  successor.reasoning_effort = reasoningEffort;
  successor.service_tier = serviceTier;
  successor.selection = selection;
  successor.status = "queued";
  successor.attempt = 0;
  successor.reservation_id = undefined;
  successor.dispatch_host = undefined;
  successor.dispatch_requested_at = undefined;
  successor.started_at = undefined;
  successor.finished_at = undefined;
  successor.slot_released_at = undefined;
  successor.execution_handle = null;
  successor.host = null;
  successor.error = null;
  successor.conclusion = null;
  successor.progress = null;
  successor.liveness = null;
  successor.successor_from_ticket_id = ticket.id;
  successor.successor_reason = "QUOTA_EXHAUSTED";
  successor.successor_id = undefined;
  // Keep the originating availability observation as lineage evidence. The
  // successor still gets its own route checks; this field is never reused as
  // the new route's availability decision.
  successor.quota_diagnostic = ticket.quota_diagnostic
    ? structuredClone(ticket.quota_diagnostic)
    : undefined;
  successor.safety_verdict = undefined;
  successor.routing_requirements = ticket.routing_requirements ? structuredClone(ticket.routing_requirements) : undefined;
  successor.receipt_id = `rcpt-${successorId}-a1`;
  successor.created_at = at;
  successor.updated_at = at;
  successor.history = [
    { event: "ticket_queued", at },
    { event: "successor_created", at, from_ticket_id: ticket.id, reason: "QUOTA_EXHAUSTED" },
  ];
  const successorReceipt = structuredClone(receipt);
  successorReceipt.issued_at = at;
  successorReceipt.receipt_id = successor.receipt_id;
  successorReceipt.ticket_id = successor.id;
  successorReceipt.route = {
    ...successorReceipt.route,
    card_id: route.route_id,
    route_id: route.route_id,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    provider: route.provider,
  };
  successorReceipt.selection = selection;
  writeReceipt(cwd, successorReceipt, env);
  writeSpawn(cwd, successor, env);
  ticket.successor_id = successor.id;
  ticket.successor_reason = "QUOTA_EXHAUSTED_SUCCESSOR_CREATED";
  return successor.id;
}

export async function finishAgent(cwd: string, id: string, {
  status,
  conclusion = null,
  errorCode = null,
  errorMessage = null,
  remainingPercent = null,
  resetAt = null,
  probeSequence = null,
  host,
  now,
  env = process.env,
  safety,
  dispatchLock = {},
}: FinishOptions): Promise<SpawnTicket> {
  sessionUid(env);
  const terminal = String(status || "").trim();
  if (!TERMINAL_TICKET_STATUSES.has(terminal as TicketStatus)) throw new DispatchError(`invalid terminal status: ${terminal}`, "INVALID_TERMINAL_STATUS", { ticketId: id });
  const safetyOptions = safety || {};
  return withDispatchLockAsync(cwd, async () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    if (host && ticketTargetHost(ticket, env) !== requireHost(host, env)) {
      throw new DispatchError(`ticket ${id} targets ${ticketTargetHost(ticket, env)}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (TERMINAL_TICKET_STATUSES.has(ticket.status)) {
      throw new DispatchError(`ticket ${id} is already terminal: ${ticket.status}`, "TICKET_ALREADY_TERMINAL", { ticketId: id });
    }
    if (terminal === "timed_out") {
      const expectedSequence = Number(probeSequence);
      const probe = ticket.liveness;
      if (ticket.status !== "running"
        || !ticket.execution_handle
        || !Number.isInteger(expectedSequence)
        || expectedSequence < 1
        || !probe
        || probe.sequence !== expectedSequence
        || probe.execution_handle.kind !== ticket.execution_handle.kind
        || probe.execution_handle.value !== ticket.execution_handle.value
        || probe.state !== "not_found") {
        throw new DispatchError(
          `ticket ${id} timeout requires its latest exact-handle host probe to be not_found; elapsed wait time is never timeout evidence`,
          "TIMEOUT_REQUIRES_NOT_FOUND_PROBE",
          { ticketId: id, currentStatus: ticket.status },
        );
      }
    }
    const expected: TicketStatus | TicketStatus[] = terminal === "completed" ? "running" : ["dispatching", "running"];
    if (terminal === "completed" && !ticket.execution_handle) throw new DispatchError(`ticket ${id} has no bound execution handle`, "EXECUTION_HANDLE_REQUIRED", { ticketId: id });
    let hostError: HostTerminalError | null = null;
    if (terminal !== "completed") {
      const code = String(errorCode || (terminal === "timed_out" ? "AGENT_TIMEOUT" : terminal === "closed" ? "AGENT_CLOSED" : "AGENT_ERROR"));
      const defaultMessage = terminal === "timed_out"
        ? `host probe ${ticket.liveness!.sequence} reported execution handle ${ticket.execution_handle?.value || "<none>"} not_found`
        : code;
      hostError = { status: terminal as HostTerminalError["status"], code, message: String(errorMessage || defaultMessage) };
    }
    // Every terminal path with authorized side effects runs its parent Git safety audit before release.
    if (ticket.mode === "write") {
      if (!ticket.receipt_id) throw new DispatchError(`ticket ${id} has no Receipt`, "RECEIPT_REQUIRED", { ticketId: id });
      const receipt = readReceipt(cwd, ticket.receipt_id, env);
      if (!receipt.baseline) throw new DispatchError(`ticket ${id} has no Git baseline`, "BASELINE_REQUIRED", { ticketId: id });
      const allowedOperations = receipt.scope.allowed_operations.filter((item): item is SafetyOperation =>
        ["write", "create", "delete", "rename", "chmod"].includes(item));
      const verdict = await auditWorktreeAsync(cwd, receipt.baseline, {
        write_allowlist: receipt.scope.write_allowlist,
        allowed_operations: allowedOperations,
        peer_write_allowlists: peerWriteAllowlists(cwd, ticket, env),
      }, safetyOptions);
      ticket.safety_verdict = verdict as unknown as UnknownRecord;
      if (!verdict.accepted) {
        transition(ticket, expected, "errored", {
          at,
          event: "safety_gate_rejected",
          detail: {
            error_code: "WRITE_SCOPE_VIOLATION",
            ...(hostError ? { host_status: hostError.status, host_error_code: hostError.code } : {}),
          },
        });
        const rejection: ScopeRejection = {
          code: "WRITE_SCOPE_VIOLATION",
          message: verdict.violations.map((item) => item.code + ":" + (item.path || "repository")).join(", "),
        };
        if (hostError) rejection.host_error = hostError;
        ticket.error = rejection;
        ticket.conclusion = null;
        ticket.finished_at = at;
        const availability = availabilityOutcome(cwd, ticket, at, {
          errorCode: hostError?.code,
          message: hostError?.message,
          success: false,
          env,
        });
        if (availability) ticket.quota_diagnostic = availability;
        if (hostError && isConfirmedQuotaExhaustion({ errorCode: hostError.code, message: hostError.message })) {
          ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
        }
        writeSpawn(cwd, ticket, env);
        if (hostError) updateRouteHealth(cwd, ticket, hostError.status, hostError, at, env);
        return ticket;
      }
    }
    if (ticket.mode === "commit-only") {
      if (!ticket.receipt_id) throw new DispatchError(`ticket ${id} has no Receipt`, "RECEIPT_REQUIRED", { ticketId: id });
      const receipt = readReceipt(cwd, ticket.receipt_id, env);
      if (!receipt.commit_baseline) throw new DispatchError(`ticket ${id} has no commit baseline`, "COMMIT_BASELINE_REQUIRED", { ticketId: id });
      const verdict = await auditCommitOutcomeAsync(cwd, receipt.commit_baseline, { ...safetyOptions, requireCommit: terminal === "completed" });
      ticket.safety_verdict = verdict as unknown as UnknownRecord;
      if (!verdict.accepted) {
        transition(ticket, expected, "errored", {
          at,
          event: "commit_safety_gate_rejected",
          detail: {
            error_code: "COMMIT_SCOPE_VIOLATION",
            ...(hostError ? { host_status: hostError.status, host_error_code: hostError.code } : {}),
          },
        });
        const rejection: ScopeRejection = {
          code: "COMMIT_SCOPE_VIOLATION",
          message: verdict.violations.map((item) => `${item.code}:repository`).join(", "),
        };
        if (hostError) rejection.host_error = hostError;
        ticket.error = rejection;
        ticket.conclusion = null;
        ticket.finished_at = at;
        const availability = availabilityOutcome(cwd, ticket, at, {
          errorCode: hostError?.code,
          message: hostError?.message,
          success: false,
          env,
        });
        if (availability) ticket.quota_diagnostic = availability;
        if (hostError && isConfirmedQuotaExhaustion({ errorCode: hostError.code, message: hostError.message })) {
          ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
        }
        writeSpawn(cwd, ticket, env);
        if (hostError) updateRouteHealth(cwd, ticket, hostError.status, hostError, at, env);
        return ticket;
      }
    }
    if (terminal === "completed") {
      const clean = sanitizeConclusion(conclusion);
      if (!clean.ok) throw new DispatchError("error" in clean ? clean.error : "invalid conclusion", "HYGIENE", { ticketId: id });
      if (ticket.openspec && typeof ticket.openspec.tasks_path === "string" && typeof ticket.openspec.number === "string") {
        const current = fs.readFileSync(ticket.openspec.tasks_path, "utf8");
        const updated = writeTaskConclusionByNumber(current, ticket.openspec.number, clean.conclusion);
        fs.writeFileSync(ticket.openspec.tasks_path, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
      }
      transition(ticket, expected, terminal as TicketStatus, { at, event: "agent_completed" });
      ticket.conclusion = clean.conclusion;
      ticket.error = null;
    } else {
      if (!hostError) throw new DispatchError("invalid terminal status: " + terminal, "INVALID_TERMINAL_STATUS", { ticketId: id });
      transition(ticket, expected, terminal as TicketStatus, { at, event: "agent_" + terminal, detail: { error_code: hostError.code } });
      ticket.error = { code: hostError.code, message: hostError.message };
      if (conclusion) {
        const clean = sanitizeConclusion(conclusion);
        if (clean.ok) ticket.conclusion = clean.conclusion;
      }
    }
    ticket.finished_at = at;
    const availability = availabilityOutcome(cwd, ticket, at, {
      errorCode: hostError?.code,
      message: hostError?.message,
      remainingPercent,
      resetAt,
      success: terminal === "completed",
      env,
    });
    if (availability) ticket.quota_diagnostic = availability;
    if (terminal !== "completed" && hostError && isConfirmedQuotaExhaustion({
      errorCode: hostError.code,
      message: hostError.message,
      remainingPercent,
    })) {
      // availabilityOutcome either durably records the route state or throws
      // MODEL_AVAILABILITY_WRITE_FAILED. Never create a successor from an
      // unpersisted quota decision.
      await createQuotaSuccessor(cwd, ticket, at, env, safetyOptions);
    }
    writeSpawn(cwd, ticket, env);
    updateRouteHealth(cwd, ticket, terminal as TerminalDispatchStatus, hostError, at, env);
    return ticket;
  }, { ...dispatchLock, env });
}

interface ReleaseOptions {
  executionHandle?: NativeExecutionHandle | null;
  host?: string;
  now?: TimeInput;
  env?: NodeJS.ProcessEnv;
}

/** Confirm that the host has closed the bound agent thread and released its slot. */
export function releaseAgent(cwd: string, id: string, {
  executionHandle = null,
  host,
  now,
  env = process.env,
}: ReleaseOptions = {}): SpawnTicket {
  sessionUid(env);
  return withLock(cwd, () => {
    const at = instant(now).toISOString();
    const ticket = requireSessionTicket(readSpawn(cwd, id, env), env);
    if (host && ticketTargetHost(ticket, env) !== requireHost(host, env)) {
      throw new DispatchError(`ticket ${id} targets ${ticketTargetHost(ticket, env)}, not ${host}`, "HOST_MISMATCH", { ticketId: id });
    }
    if (!TERMINAL_TICKET_STATUSES.has(ticket.status)) {
      throw new DispatchError(`ticket ${id} is not terminal`, "RELEASE_REQUIRES_TERMINAL", { ticketId: id, currentStatus: ticket.status });
    }
    if (!ticket.execution_handle) {
      throw new DispatchError(`ticket ${id} has no bound execution handle`, "EXECUTION_HANDLE_REQUIRED", { ticketId: id });
    }
    const requestedHandle = executionHandle || null;
    if (requestedHandle && requestedHandle.kind !== getCliAdapter(requireHost(host || ticketTargetHost(ticket, env), env), env).host.executionHandleKind) {
      throw new DispatchError("execution handle kind does not match adapter", "EXECUTION_HANDLE_KIND_MISMATCH", { ticketId: id });
    }
    if (requestedHandle
      && (requestedHandle.kind !== ticket.execution_handle.kind || requestedHandle.value !== ticket.execution_handle.value)) {
      throw new DispatchError(`ticket ${id} is bound to ${ticket.execution_handle.value}, not ${requestedHandle.value}`, "EXECUTION_HANDLE_MISMATCH", { ticketId: id });
    }
    if (ticket.slot_released_at) {
      // Native release confirmation may be retried after a transport timeout.
      // The first confirmation already returned this tree-local slot, so a
      // repeated confirmation must be a no-op rather than a second lifecycle
      // mutation or a second release event.
      return ticket;
    }
    ticket.slot_released_at = at;
    history(ticket, "agent_slot_released", at, {
      execution_handle: ticket.execution_handle,
    });
    writeSpawn(cwd, ticket, env);
    return ticket;
  }, env);
}

interface RecoverOptions { staleMs?: number; host?: string; now?: TimeInput; env?: NodeJS.ProcessEnv }

export function recoverDispatches(cwd: string, { staleMs = 60_000, host, now, env = process.env }: RecoverOptions = {}) {
  sessionUid(env);
  const threshold = Number(staleMs);
  if (!Number.isFinite(threshold) || threshold < 0) throw new DispatchError("staleMs must be non-negative", "INVALID_STALE_MS");
  return withLock(cwd, () => {
    const current = instant(now);
    const at = current.toISOString();
    const expired: string[] = [];
    const resumable: Array<{ ticket_id: string; execution_handle: NativeExecutionHandle; host: string | null }> = [];
    const needs_close: Array<{ ticket_id: string; execution_handle: NativeExecutionHandle; host: string | null }> = [];
    const targetHost = host ? requireHost(host, env) : undefined;
    for (const ticket of fifoTickets(cwd, env)) {
      if (targetHost && !ticketMatchesHost(ticket, targetHost, env)) continue;
      if (ticket.status === "running" && ticket.execution_handle) {
        resumable.push({ ticket_id: ticket.id, execution_handle: ticket.execution_handle, host: ticket.host || ticket.dispatch_host || null });
        continue;
      }
      if (TERMINAL_TICKET_STATUSES.has(ticket.status) && holdsHostSlot(ticket) && ticket.execution_handle) {
        needs_close.push({ ticket_id: ticket.id, execution_handle: ticket.execution_handle, host: ticket.host || ticket.dispatch_host || null });
        continue;
      }
      if (ticket.status !== "dispatching" || ticket.execution_handle) continue;
      const requested = Date.parse(ticket.dispatch_requested_at || ticket.updated_at || ticket.created_at || "");
      if (!Number.isFinite(requested) || current.getTime() - requested < threshold) continue;
      transition(ticket, "dispatching", "errored", { at, event: "dispatch_lease_expired", detail: { error_code: "DISPATCH_LEASE_EXPIRED" } });
      ticket.error = { code: "DISPATCH_LEASE_EXPIRED", message: "host did not bind an agent before the dispatch lease expired" };
      ticket.finished_at = at;
      writeSpawn(cwd, ticket, env);
      expired.push(ticket.id);
    }
    return { expired, resumable, needs_close };
  }, env);
}

export function dispatchSnapshot(cwd: string, { capacity, host, now, env = process.env, capacityResolution }: { capacity?: number; host?: string; now?: TimeInput; env?: NodeJS.ProcessEnv; capacityResolution?: EffectiveAgentTreeCapacity } = {}) {
  sessionUid(env);
  const targetHost = host ? requireHost(host, env) : undefined;
  // Legacy dispatch-<host>.json files remain rollback residue only. Capacity
  // is resolved by the current caller and is never remembered here.
  const resolved = capacityResolution || resolvedCapacity(cwd, targetHost, env, capacity);
  const compatibilityBlockers = dispatchCompatibilityBlockers(cwd, env);
  const max = requiredCapacity(resolved);
  const allTickets = fifoTickets(cwd, env);
  const tickets = targetHost ? ticketsInDispatchScope(allTickets, targetHost, env) : allTickets;
  const counts: Partial<Record<TicketStatus, number>> = {};
  for (const ticket of tickets) counts[ticket.status] = (counts[ticket.status] || 0) + 1;
  const active = targetHost
    ? activeTicketsInDispatchScope(allTickets, targetHost, env)
    : tickets.filter(holdsHostSlot);
  const currentMs = instant(now).getTime();
  const progressDue = tickets.filter((ticket) => {
    if (ticket.status !== "running" || ticket.coordination?.mode !== "checkpointed") return false;
    const interval = Number(ticket.coordination.progress_interval_ms || 0);
    if (interval <= 0) return false;
    const last = Date.parse(ticket.progress?.reported_at || ticket.started_at || ticket.updated_at || ticket.created_at || "");
    return Number.isFinite(last) && currentMs - last >= interval;
  }).map((ticket) => ticket.id);
  const probeDue = tickets.filter((ticket) => {
    if (ticket.status !== "running") return false;
    if (ticket.liveness && !LIVE_AGENT_PROBE_STATES.has(ticket.liveness.state)) return false;
    const last = Date.parse(ticket.liveness?.observed_at || ticket.started_at || ticket.updated_at || ticket.created_at || "");
    return !Number.isFinite(last) || currentMs - last >= DEFAULT_AGENT_PROBE_INTERVAL_MS;
  }).map((ticket) => ticket.id);
  return {
    host: targetHost || null,
    session_uid: resolved.session_uid,
    capacity: max,
    capacity_sources: resolved.capacity_sources,
    active: active.length,
    available: Math.max(0, max - active.length),
    compatibility_blockers: compatibilityBlockers,
    counts,
    queued: tickets.filter((ticket) => ticket.status === "queued").map((ticket) => ticket.id),
    dispatching: tickets.filter((ticket) => ticket.status === "dispatching").map((ticket) => ticket.id),
    running: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({
      ticket_id: ticket.id,
      execution_handle: ticket.execution_handle,
      host: ticket.host || ticket.dispatch_host || null,
    })),
    running_progress: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({
      ticket_id: ticket.id,
      task_kind: ticket.work_unit?.kind || null,
      coordination: ticket.coordination?.mode || null,
      progress: ticket.progress || null,
    })),
    progress_due: progressDue,
    running_liveness: tickets.filter((ticket) => ticket.status === "running").map((ticket) => ({
      ticket_id: ticket.id,
      liveness: ticket.liveness || null,
    })),
    probe_due: probeDue,
    awaiting_release: tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status) && holdsHostSlot(ticket))
      .map((ticket) => ({
        ticket_id: ticket.id,
        execution_handle: ticket.execution_handle,
        status: ticket.status,
      })),
    terminal: tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status)).map((ticket) => ({ ticket_id: ticket.id, status: ticket.status, error: ticket.error || null })),
  };
}

/**
 * Build capacity diagnostics for every valid root tree in the workspace.
 *
 * This is intentionally separate from dispatchSnapshot: general `baton
 * status` is a workspace inventory command, while reservation and dispatch
 * status are current-tree operations.  The inventory is grouped by the
 * complete (host, session_uid) key and never computes a workspace-wide
 * availability value.
 */
export function dispatchWorkspaceCapacitySnapshots(
  cwd: string,
  { host, now, env = process.env }: { host?: string; now?: TimeInput; env?: NodeJS.ProcessEnv } = {},
) {
  sessionUid(env);
  const targetHost = host ? requireHost(host, env) : undefined;
  const allTickets = listSpawns(cwd, env).map(normalizeSpawnTicket);
  let config;
  try {
    config = loadConfig(cwd, { env });
  } catch {
    // A status inventory can still report adapter-derived capacity before
    // project configuration is available.
  }
  const groups = new Map<string, { host: HostId; session_uid: string; tickets: SpawnTicket[] }>();
  for (const ticket of allTickets) {
    if (!/^[0-9a-f]{64}$/.test(ticket.session_uid)) continue;
    let ticketHost: HostId;
    try {
      ticketHost = ticketTargetHost(ticket, env);
    } catch {
      continue;
    }
    if (targetHost && ticketHost !== targetHost) continue;
    const key = `${ticketHost}\u0000${ticket.session_uid}`;
    const group = groups.get(key) || { host: ticketHost, session_uid: ticket.session_uid, tickets: [] };
    group.tickets.push(ticket);
    groups.set(key, group);
  }
  const currentMs = instant(now).getTime();
  return [...groups.values()].sort((a, b) => a.host.localeCompare(b.host) || a.session_uid.localeCompare(b.session_uid)).map((group) => {
    const adapter = getCliAdapter(group.host, env);
    const hostLimit = hostReportedLimit(group.host, env);
    const resolved = resolveAgentTreeCapacity({
      host: adapter?.host,
      hostLimit,
      configuredPolicy: treeConfiguredPolicy(config, group.host, hostLimit),
      session: group.session_uid,
      env,
    });
    const active = group.tickets.filter(holdsHostSlot);
    const counts: Partial<Record<TicketStatus, number>> = {};
    for (const ticket of group.tickets) counts[ticket.status] = (counts[ticket.status] || 0) + 1;
    const progressDue = group.tickets.filter((ticket) => {
      if (ticket.status !== "running" || ticket.coordination?.mode !== "checkpointed") return false;
      const interval = Number(ticket.coordination.progress_interval_ms || 0);
      const last = Date.parse(ticket.progress?.reported_at || ticket.started_at || ticket.updated_at || ticket.created_at || "");
      return interval > 0 && Number.isFinite(last) && currentMs - last >= interval;
    }).map((ticket) => ticket.id);
    return {
      host: group.host,
      session_uid: group.session_uid,
      capacity: resolved.capacity,
      capacity_sources: resolved.capacity_sources,
      active: active.length,
      available: resolved.capacity == null ? null : Math.max(0, resolved.capacity - active.length),
      counts,
      tickets: group.tickets.map((ticket) => ticket.id),
      queued: group.tickets.filter((ticket) => ticket.status === "queued").map((ticket) => ticket.id),
      dispatching: group.tickets.filter((ticket) => ticket.status === "dispatching").map((ticket) => ticket.id),
      running: group.tickets.filter((ticket) => ticket.status === "running").map((ticket) => ticket.id),
      awaiting_release: group.tickets.filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status) && holdsHostSlot(ticket)).map((ticket) => ticket.id),
      progress_due: progressDue,
    };
  });
}
