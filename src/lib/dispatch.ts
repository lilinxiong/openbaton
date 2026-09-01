import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
import {
  extractExactExecutionRootIdentity,
  sameExactExecutionRootIdentity,
  type ExactExecutionRootIdentity,
  type NativeExecutionHandleKind,
} from "../adapters/contract.js";
import { getCliAdapter } from "../adapters/index.js";
import type { UnknownRecord } from "../types.js";
import { dispatchLockPath, spawnsDir, workspaceId, WORKTREE_RECORD_NAME } from "./paths.js";
import { resolveOwningRepository, resolveWorktreeTopology } from "./worktree-topology.js";
import {
  parseWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type WorktreeRecord,
} from "./worktree-execution.js";
import {
  assertValidTicketReceiptLineage,
  normalizeCompiledApplyLineage,
  normalizeRollingUnitLineage,
  readReceipt,
  writeReceipt,
  type CompiledApplyLineage,
  type DelegationReceipt,
  type ExecutionMode,
  type RollingUnitLineage,
} from "./receipt.js";
import { auditCommitOutcomeAsync, auditPreparedCommitAsync, auditWorktreeAsync, type AsyncSafetyOptions, type SafetyOperation } from "./safety.js";
import { writeTaskConclusionByNumber } from "./openspec.js";
import { recordRouteHealth } from "./route-health.js";
import { readRouteSnapshot, type ExecutableRoute } from "./routes.js";
import { deriveMinimumModelRequirements } from "./selection.js";
import { cliProfileForHost, configuredCodingModelsForHost, loadConfig } from "./config.js";
import { parseHostId, type HostId } from "./hosts.js";
import {
  BATON_DISPATCH_RESERVATION_SCHEMA,
  withDispatchReservationEnvelope,
  type DispatchReservationIdentity,
} from "./dispatch-reservation.js";
import { withActivationLockAsync, type ActivationLockOptions } from "./activation.js";
import {
  availabilityForRoute,
  claimRouteProbe,
  isExplicitRateLimit,
  isConfirmedQuotaExhaustion,
  markRouteAvailable,
  markRouteExhausted,
} from "./model-availability.js";
import { withOwnedLock, withOwnedLockAsync, type OwnedLock, type OwnedLockOptions } from "./owned-lock.js";
import { resolveAgentTreeCapacity, type EffectiveAgentTreeCapacity } from "./agent-tree-capacity.js";
import {
  readApplyRun,
  readApplyRunPlanBody,
  type ApplyRunState,
  type ApplyRunTicketFact,
} from "./apply-run.js";
import { acceptApplyUnit, type ApplyAcceptanceResult } from "./apply-reconcile.js";
import type { ApplyExecutionPlan, ApplyPlanUnit } from "./apply-plan.js";

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

export interface DispatchSpec extends Partial<ExactExecutionRootIdentity> {
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
  rolling_unit_lineage?: RollingUnitLineage;
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
  const exactRoot = extractExactExecutionRootIdentity(ticket);
  const reservation: DispatchReservationIdentity = {
    schema: BATON_DISPATCH_RESERVATION_SCHEMA,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: ticketTargetHost(ticket, env),
    ...(exactRoot || {}),
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
    ...(ticket.rolling_unit_lineage ? { rolling_unit_lineage: ticket.rolling_unit_lineage } : {}),
    coordination: ticket.coordination,
    attempt: ticket.attempt,
    max_attempts: ticket.max_attempts,
    selection: ticket.selection!,
    ...(exactRoot || {}),
  };
}

function isolatedTicketIdentity(ticket: SpawnTicket): ExactExecutionRootIdentity | null {
  const mode = ticket.rolling_unit_lineage?.worktree_mode;
  const identity = extractExactExecutionRootIdentity(ticket);
  if (mode !== "isolated-worktree") {
    if (identity) throw new DispatchError(`ticket ${ticket.id} cannot carry exact-root identity in ${mode || "legacy"} mode`, "ISOLATED_EXECUTION_IDENTITY_FORBIDDEN", { ticketId: ticket.id });
    return null;
  }
  if (!identity) throw new DispatchError(`ticket ${ticket.id} has no complete exact-root identity`, "ISOLATED_EXECUTION_IDENTITY_PARTIAL", { ticketId: ticket.id });
  return identity;
}

function requireExactRootAdapter(ticket: SpawnTicket, host: HostId, env: NodeJS.ProcessEnv): ExactExecutionRootIdentity | null {
  const identity = isolatedTicketIdentity(ticket);
  if (identity && getCliAdapter(host, env).host.exactExecutionRoot !== true) {
    throw new DispatchError(`adapter ${host} cannot guarantee exact execution-root dispatch`, "ADAPTER_EXACT_ROOT_UNSUPPORTED", { ticketId: ticket.id });
  }
  return identity;
}

/** Last physical gate before a public spawn request is returned or a handle is bound. */
const EXACT_ROOT_GIT_MAX_BUFFER = 256 * 1024;

function verifyExactExecutionRoot(
  cwd: string,
  ticket: SpawnTicket,
  receipt: DelegationReceipt,
  host: HostId,
  env: NodeJS.ProcessEnv,
  requireClean = true,
): WorktreeRecord | null {
  const identity = requireExactRootAdapter(ticket, host, env);
  if (!identity) return null;
  let root: string;
  try { root = fs.realpathSync(identity.execution_root); }
  catch (cause) { throw new DispatchError(`execution root is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, "EXECUTION_ROOT_DRIFT", { ticketId: ticket.id }); }
  if (fs.lstatSync(identity.execution_root).isSymbolicLink()
    || root === fs.realpathSync(cwd)
    || !fs.statSync(root).isDirectory()) {
    throw new DispatchError(`ticket ${ticket.id} execution root was rewritten or aliases the caller checkout`, "EXECUTION_ROOT_REWRITE", { ticketId: ticket.id });
  }
  const recordFile = path.join(path.dirname(root), WORKTREE_RECORD_NAME);
  let record: WorktreeRecord;
  try { record = parseWorktreeRecord(fs.readFileSync(recordFile, "utf8")); }
  catch (cause) { throw new DispatchError(`ticket ${ticket.id} worktree record is unavailable or invalid: ${cause instanceof Error ? cause.message : String(cause)}`, "WORKTREE_RECORD_DRIFT", { ticketId: ticket.id }); }
  const lineage = ticket.rolling_unit_lineage!;
  if (record.record_id !== identity.worktree_record_id
    || record.execution_mode !== "isolated-worktree"
    || record.repository_id !== identity.repository_id
    || record.git_common_dir_identity !== identity.git_common_dir_identity
    || record.execution_root !== identity.execution_root
    || record.base_tree !== identity.base_tree
    || record.run_id !== lineage.run_id
    || record.unit_key !== lineage.unit_key
    || record.unit_version !== lineage.unit_version
    || record.setup_state !== "verified"
    || record.lifecycle_state !== "preparing") {
    throw new DispatchError(`ticket ${ticket.id} worktree record lineage drifted before native spawn`, "WORKTREE_RECORD_DRIFT", { ticketId: ticket.id });
  }
  let owner;
  try { owner = resolveOwningRepository(root, ".").repository; }
  catch (cause) { throw new DispatchError(`ticket ${ticket.id} execution-root repository cannot be verified: ${cause instanceof Error ? cause.message : String(cause)}`, "EXECUTION_ROOT_REPOSITORY_DRIFT", { ticketId: ticket.id }); }
  if (owner.repository_root !== root
    || owner.repository_id !== identity.repository_id
    || owner.git_common_dir_identity !== identity.git_common_dir_identity
    || owner.git_common_dir !== record.git_common_dir) {
    throw new DispatchError(`ticket ${ticket.id} execution-root repository identity drifted`, "EXECUTION_ROOT_REPOSITORY_DRIFT", { ticketId: ticket.id });
  }
  try {
    const git = (args: string[]) => execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      maxBuffer: EXACT_ROOT_GIT_MAX_BUFFER,
    }).trim();
    if (git(["rev-parse", "HEAD^{tree}"]) !== identity.base_tree
      || git(["write-tree"]) !== identity.base_tree
      || (requireClean && git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "")) {
      throw new Error("immutable base tree or worktree content changed");
    }
  } catch (cause) {
    throw new DispatchError(`ticket ${ticket.id} execution-root base drifted: ${cause instanceof Error ? cause.message : String(cause)}`, "EXECUTION_ROOT_BASE_DRIFT", { ticketId: ticket.id });
  }
  try {
    const topology = receipt.scope.write_allowlist.length
      ? resolveWorktreeTopology(root, receipt.scope.write_allowlist)
      : null;
    if (topology && (topology.repositories.length !== 1
      || topology.repositories[0]!.repository_id !== identity.repository_id
      || topology.repositories[0]!.repository_root !== root)) {
      throw new Error("scope resolves outside the isolated repository root");
    }
  } catch (cause) {
    throw new DispatchError(`ticket ${ticket.id} scope escapes its execution root: ${cause instanceof Error ? cause.message : String(cause)}`, "EXECUTION_ROOT_SCOPE_ESCAPE", { ticketId: ticket.id });
  }
  return record;
}

function transitionExactRootRecord(
  _cwd: string,
  ticket: SpawnTicket,
  key: string,
  toState: "worker_active" | "terminal_awaiting_audit" | "rejected",
  at: string,
  nativeHandle: string | null,
  retentionReasons: Array<"live_native_handle" | "terminal_unreleased_ticket" | "pending_audit" | "rejected_result_evidence">,
  env: NodeJS.ProcessEnv,
): void {
  const identity = isolatedTicketIdentity(ticket);
  if (!identity) return;
  const record = parseWorktreeRecord(fs.readFileSync(path.join(path.dirname(identity.execution_root), WORKTREE_RECORD_NAME), "utf8"));
  transitionPersistedWorktreeRecord(record.repository_root, record.run_id, record.unit_key, record.attempt_id, {
    idempotency_key: key,
    phase: "native_execution",
    to_state: toState,
    recorded_at: at,
    native_handle: nativeHandle,
    retention_reasons: retentionReasons,
  }, env);
}

function retainTerminalExactRoot(ticket: SpawnTicket, at: string, env: NodeJS.ProcessEnv): void {
  if (!isolatedTicketIdentity(ticket)) return;
  if (!ticket.execution_handle) {
    transitionExactRootRecord("", ticket, `native-aborted-${ticket.id}-${ticket.attempt}`, "rejected", at,
      null, ["rejected_result_evidence"], env);
    return;
  }
  transitionExactRootRecord("", ticket, `native-terminal-${ticket.id}-${ticket.attempt}`, "terminal_awaiting_audit", at,
    `${ticket.execution_handle.kind}:${ticket.execution_handle.value}`,
    ["pending_audit", "terminal_unreleased_ticket"], env);
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

function isRollingDispatchTicket(ticket: SpawnTicket): boolean {
  const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
  return ticket.rolling_unit_lineage !== undefined || unit?.schema_version === 3;
}

/**
 * Validate the artifact-local identity of a rolling dispatch.  Rolling
 * lifecycle authorization is intentionally anchored only in the immutable
 * ticket, schema-3 work unit, and Receipt; rolling-run state and append
 * progress are not consulted here.
 */
function validateRollingDispatchArtifacts(
  cwd: string,
  ticket: SpawnTicket,
  host: HostId,
  env: NodeJS.ProcessEnv,
  receiptOverride?: DelegationReceipt,
): DelegationReceipt | null {
  if (!isRollingDispatchTicket(ticket)) return null;
  try {
    requireExactRootAdapter(ticket, host, env);
    const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
    if (!unit || unit.schema_version !== 3 || !unit.rolling_unit_lineage) {
      throw new DispatchError(`ticket ${ticket.id} requires a schema-3 rolling work unit`, "ROLLING_LINEAGE_MISMATCH", { ticketId: ticket.id });
    }
    if (!ticket.rolling_unit_lineage) {
      throw new DispatchError(`ticket ${ticket.id} requires rolling unit lineage`, "ROLLING_LINEAGE_MISMATCH", { ticketId: ticket.id });
    }
    if (!ticket.receipt_id) {
      throw new DispatchError(`ticket ${ticket.id} has no Receipt`, "RECEIPT_REQUIRED", { ticketId: ticket.id });
    }
    const receipt = receiptOverride || readReceipt(cwd, ticket.receipt_id, env);
    const ticketLineage = normalizeRollingUnitLineage(ticket.rolling_unit_lineage);
    const workUnitLineage = normalizeRollingUnitLineage(unit.rolling_unit_lineage);
    const receiptLineage = receipt.rolling_unit_lineage === undefined
      ? null
      : normalizeRollingUnitLineage(receipt.rolling_unit_lineage);
    const serialized = JSON.stringify(ticketLineage);
    if (serialized !== JSON.stringify(workUnitLineage)
      || receiptLineage === null
      || serialized !== JSON.stringify(receiptLineage)) {
      throw new DispatchError(`ticket ${ticket.id} rolling unit lineage does not match its work unit and Receipt`, "ROLLING_LINEAGE_MISMATCH", { ticketId: ticket.id });
    }
    const expectedReceiptHost = ticket.target_host || ticket.dispatch_host || ticket.host;
    if (receipt.ticket_id !== ticket.id
      || receipt.receipt_id !== ticket.receipt_id
      || (expectedReceiptHost ? receipt.host !== expectedReceiptHost : Boolean(receipt.host && receipt.host !== host))
      || receipt.route.route_id !== ticket.route_id
      || !receiptModeMatches(ticket, receipt)
      || !receipt.selection
      || !ticket.selection
      || receipt.selection.approval_id !== ticket.selection.approval_id
      || receipt.selection.selected_model_id !== ticket.model_id
      || receipt.selection.host !== host
      || ticket.selection.host !== host) {
      throw new DispatchError(`ticket ${ticket.id} does not match its rolling Delegation Receipt`, "RECEIPT_MISMATCH", { ticketId: ticket.id });
    }
    // Keep the existing generic lineage checks as part of the rolling edge;
    // this also covers route/model/service-tier and execution-mode identity.
    assertValidTicketReceiptLineage({
      ...ticket,
      target_host: ticket.target_host || host,
    }, receipt);
    return receipt;
  } catch (error) {
    if (error instanceof DispatchError) throw error;
    const code = error instanceof Error && "code" in error
      ? String((error as Error & { code?: unknown }).code || "ROLLING_LINEAGE_MISMATCH")
      : "ROLLING_LINEAGE_MISMATCH";
    throw new DispatchError(
      error instanceof Error ? error.message : String(error),
      code,
      { ticketId: ticket.id },
    );
  }
}

async function rejectUndispatchable(
  cwd: string,
  ticket: SpawnTicket,
  at: string,
  host: HostId,
  env: NodeJS.ProcessEnv = process.env,
  safetyOptions: AsyncSafetyOptions = {},
  preflightError: unknown = null,
): Promise<{ ticket_id: string; code: string; message: string } | null> {
  let code: string | null = preflightError instanceof DispatchError
    ? preflightError.code
    : preflightError instanceof Error && "code" in preflightError
      ? String((preflightError as Error & { code?: unknown }).code || "ROLLING_LINEAGE_MISMATCH")
      : preflightError === null
        ? null
        : "ROLLING_LINEAGE_MISMATCH";
  let message: string | null = preflightError === null
    ? null
    : preflightError instanceof Error
      ? preflightError.message
      : String(preflightError);
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
      code = availability.evidence_kind === "rate_limit" ? "MODEL_RATE_LIMITED" : "MODEL_QUOTA_EXHAUSTED";
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
      if (catalog.cli !== profileHost) {
        code = "CLI_CATALOG_HOST_MISMATCH";
        message = `ticket ${ticket.id} requires a ${profileHost} catalog snapshot`;
      } else {
        const configured = configuredCodingModelsForHost(config, profileHost);
        const configuredRoute = isCompiledApplyTicket(ticket)
          ? configured.some((item) => item === ticket.route_id
            || item === ticket.model_id
            || routeVariantBase(item).base === ticket.route_id)
          : configured.includes(ticket.route_id);
        if (!configuredRoute) {
          code = "CLI_MODEL_NOT_CONFIGURED";
          message = `ticket ${ticket.id} model ${ticket.route_id} is not in cli.${profileHost}.coding_models`;
        }
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
  if (!code && isCompiledApplyTicket(ticket)) {
    try {
      const compiled = validateCompiledTicket(cwd, ticket, host, env);
      if (compiled) {
        const readiness = compiledUnitReady(compiled);
        if (!readiness.ready) {
          code = readiness.code || "COMPILED_DEPENDENCY_BLOCKED";
          message = readiness.message || `ticket ${ticket.id} is not ready in its compiled ApplyRun`;
        }
      }
    } catch (error) {
      code = error instanceof DispatchError ? error.code : "COMPILED_LINEAGE_MISMATCH";
      message = error instanceof Error ? error.message : String(error);
    }
  }
  if (!code) return null;
  const finalMessage = message || `ticket ${ticket.id} cannot be dispatched`;
  transition(ticket, "queued", "errored", { at, event: "dispatch_blocked", detail: { error_code: code } });
  ticket.error = { code, message: finalMessage };
  ticket.finished_at = at;
  writeSpawn(cwd, ticket, env);
  return { ticket_id: ticket.id, code, message: finalMessage };
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
  return resolveAgentTreeCapacity({
    host: adapter?.host,
    config,
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

interface CompiledApplyContext {
  lineage: CompiledApplyLineage;
  state: ApplyRunState;
  plan: ApplyExecutionPlan;
  unit: ApplyPlanUnit;
  receipt: DelegationReceipt;
  /** A successor is allowed to continue after a quota-only predecessor. */
  quotaSuccessor?: boolean;
}

/** Stable comparison for immutable compiled protocol fields. */
function stableCompiledValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCompiledValue).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableCompiledValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortedCompiledStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean).sort();
}

function sameCompiledStrings(left: unknown, right: unknown): boolean {
  return stableCompiledValue(sortedCompiledStrings(left)) === stableCompiledValue(sortedCompiledStrings(right));
}

function isCompiledApplyTicket(ticket: SpawnTicket): boolean {
  const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
  return ticket.compiled_apply_lineage !== undefined || unit?.schema_version === 2;
}

function compiledApplyError(ticket: SpawnTicket, message: string, code = "COMPILED_LINEAGE_MISMATCH"): DispatchError {
  return new DispatchError(`ticket ${ticket.id} compiled apply contract is invalid: ${message}`, code, { ticketId: ticket.id });
}

function compiledLineageForTicket(ticket: SpawnTicket): CompiledApplyLineage | null {
  if (!isCompiledApplyTicket(ticket)) return null;
  const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
  if (!unit || unit.schema_version !== 2 || ticket.compiled_apply_lineage === undefined) {
    throw compiledApplyError(ticket, "schema-v2 work unit and compiled_apply_lineage are both required");
  }
  try {
    const lineage = normalizeCompiledApplyLineage(ticket.compiled_apply_lineage);
    for (const field of ["run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "mode"] as const) {
      if (stableCompiledValue(lineage[field]) !== stableCompiledValue(unit[field])) {
        throw compiledApplyError(ticket, `work-unit lineage mismatch in ${field}`);
      }
    }
    if (unit.kind !== "concrete" || ticket.coordination?.mode !== "terminal-only") {
      throw compiledApplyError(ticket, "compiled units must be concrete terminal-only workers");
    }
    return lineage;
  } catch (error) {
    if (error instanceof DispatchError) throw error;
    throw compiledApplyError(ticket, error instanceof Error ? error.message : String(error));
  }
}

function compiledTicketFacts(cwd: string, runId: string, env: NodeJS.ProcessEnv): ApplyRunTicketFact[] {
  const facts: ApplyRunTicketFact[] = [];
  const candidates = listSpawns(cwd, env);
  const supersededTicketIds = new Set(
    candidates
      .filter((candidate) => {
        if (!candidate.successor_id || candidate.successor_reason !== "QUOTA_EXHAUSTED_SUCCESSOR_CREATED") return false;
        const successor = candidates.find((item) => item.id === candidate.successor_id);
        if (!successor || successor.successor_from_ticket_id !== candidate.id) return false;
        try {
          const left = normalizeCompiledApplyLineage(candidate.compiled_apply_lineage);
          const right = normalizeCompiledApplyLineage(successor.compiled_apply_lineage);
          return left.run_id === right.run_id && left.unit_id === right.unit_id;
        } catch {
          return false;
        }
      })
      .map((candidate) => candidate.id),
  );
  for (const candidate of candidates) {
    // A quota successor replaces the failed predecessor for ApplyRun state
    // reconstruction. Keeping both facts would rank the predecessor's
    // failure above the successor's later acceptance and make a successfully
    // retried unit appear failed again.
    if (supersededTicketIds.has(candidate.id)) continue;
    const rawLineage = candidate.compiled_apply_lineage;
    if (rawLineage === undefined) continue;
    let lineage: CompiledApplyLineage;
    try {
      lineage = normalizeCompiledApplyLineage(rawLineage);
    } catch {
      continue;
    }
    if (lineage.run_id !== runId) continue;
    const status = candidate.status === "done" ? "completed" : candidate.status;
    if (!(status === "queued" || status === "dispatching" || status === "running"
      || status === "completed" || status === "errored" || status === "timed_out" || status === "closed")) continue;
    facts.push({
      ticket_id: candidate.id,
      status,
      run_id: lineage.run_id,
      host: candidate.host || candidate.dispatch_host || candidate.target_host || candidate.selection?.host || undefined,
      session_uid: candidate.session_uid,
      unit_ids: [lineage.unit_id],
      task_ids: [...lineage.task_refs],
      model_id: candidate.model_id || undefined,
      receipt_id: candidate.receipt_id || undefined,
      result: candidate.conclusion || undefined,
      slot_released_at: candidate.slot_released_at || null,
    });
  }
  return facts;
}

function acceptedApplyRunState(value: unknown): boolean {
  return value === "accepted" || value === "reconciled";
}

function compiledUnitReady(context: CompiledApplyContext): { ready: boolean; code?: string; message?: string } {
  const current = context.state.unit_state[context.unit.id];
  if (!current) return { ready: false, code: "COMPILED_UNIT_NOT_FOUND", message: `run has no unit ${context.unit.id}` };
  if (current.status === "accepted" || current.status === "reconciled") {
    return { ready: false, code: "COMPILED_UNIT_ALREADY_ACCEPTED", message: `unit ${context.unit.id} is already accepted` };
  }
  if (current.status === "superseded" || current.superseded) {
    return { ready: false, code: "COMPILED_UNIT_SUPERSEDED", message: `unit ${context.unit.id} was superseded` };
  }
  if ((current.status === "blocked" || current.status === "failed") && !context.quotaSuccessor) {
    return { ready: false, code: "COMPILED_UNIT_BLOCKED", message: `unit ${context.unit.id} is blocked and requires semantic replanning` };
  }
  const acceptedUnit = (id: string) => acceptedApplyRunState(context.state.unit_state[id]?.status);
  const acceptedGate = (id: string) => acceptedApplyRunState(context.state.gate_state[id]?.status);
  for (const dependency of context.unit.depends_on || []) {
    if (!acceptedUnit(dependency)) {
      return { ready: false, code: "COMPILED_DEPENDENCY_BLOCKED", message: `unit ${context.unit.id} waits for unit ${dependency}` };
    }
  }
  for (const gateId of context.unit.parent_gate_ids || []) {
    if (!acceptedGate(gateId)) {
      return { ready: false, code: "COMPILED_GATE_BLOCKED", message: `unit ${context.unit.id} waits for gate ${gateId}` };
    }
  }
  return { ready: true };
}

/**
 * Validate the complete immutable edge between a compiled ticket, its
 * schema-v2 work unit, Receipt, and the current ApplyRun revision. This is
 * deliberately called again at bind/finish: a reservation is not a license
 * to use a ticket whose on-disk contract was edited while it was pending.
 */
function validateCompiledTicket(
  cwd: string,
  ticket: SpawnTicket,
  host: HostId,
  env: NodeJS.ProcessEnv,
  receiptOverride?: DelegationReceipt,
): CompiledApplyContext | null {
  const lineage = compiledLineageForTicket(ticket);
  if (!lineage) return null;
  const quotaSuccessor = Boolean(ticket.successor_from_ticket_id && ticket.successor_reason === "QUOTA_EXHAUSTED");
  let state: ApplyRunState;
  let plan: ApplyExecutionPlan;
  try {
    // ApplyRun freezes one execution ticket per materialized unit. A quota
    // successor retries that immutable unit only after clean reconciliation;
    // exclude the failed predecessor facts while validating the successor so
    // the run reader does not mistake the retry for lineage tampering.
    const predecessorTicketId = quotaSuccessor ? ticket.successor_from_ticket_id : undefined;
    const facts = compiledTicketFacts(cwd, lineage.run_id, env).filter((fact) => fact.ticket_id !== ticket.id
      && fact.ticket_id !== predecessorTicketId);
    // The in-memory ticket can be a successor candidate or a just-terminal
    // result which has not been persisted yet. Include it only when it is a
    // valid current-format status so ApplyRun can reconstruct lifecycle state.
    const status = ticket.status === "done" ? "completed" : ticket.status;
    if (!quotaSuccessor && (status === "queued" || status === "dispatching" || status === "running"
      || status === "completed" || status === "errored" || status === "timed_out" || status === "closed")) {
      facts.push({
        ticket_id: ticket.id,
        status,
        run_id: lineage.run_id,
        host: ticket.host || ticket.dispatch_host || ticket.target_host || ticket.selection?.host || host,
        session_uid: ticket.session_uid,
        unit_ids: [lineage.unit_id],
        task_ids: [...lineage.task_refs],
        model_id: ticket.model_id,
        receipt_id: ticket.receipt_id || undefined,
        result: ticket.conclusion || undefined,
        slot_released_at: ticket.slot_released_at || null,
      });
    }
    state = readApplyRun(cwd, lineage.run_id, { env, ticket_facts: facts });
    plan = readApplyRunPlanBody(cwd, lineage.run_id, state.current_revision, env);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code || "") : "";
    if (code === "RUN_FILE_MISSING" || code === "RUN_NOT_FOUND") throw compiledApplyError(ticket, "ApplyRun is missing", "COMPILED_RUN_NOT_FOUND");
    throw compiledApplyError(ticket, error instanceof Error ? error.message : String(error));
  }
  if (state.run_id !== lineage.run_id
    || state.session_uid !== ticket.session_uid
    || state.host !== host
    || state.current_revision !== lineage.plan_revision
    || state.current_fingerprint !== lineage.plan_fingerprint) {
    throw compiledApplyError(ticket, "ticket lineage does not match the current ApplyRun revision");
  }
  const unit = plan.units.find((candidate) => candidate.id === lineage.unit_id);
  if (!unit) throw compiledApplyError(ticket, `run plan has no unit ${lineage.unit_id}`);
  if (unit.mode !== lineage.mode || !sameCompiledStrings(unit.task_ids, lineage.task_refs)) {
    throw compiledApplyError(ticket, "ticket task references or execution mode do not match the run plan");
  }
  const workUnit = ticket.work_unit as unknown as Record<string, unknown>;
  const expectedObjective = String(unit.description || unit.id).trim();
  if (String(workUnit.objective || "").trim() !== expectedObjective) {
    throw compiledApplyError(ticket, "work-unit objective does not match the run plan");
  }
  if (String(workUnit.deliverable || "").trim() !== expectedObjective
    || String(workUnit.done_when || "").trim() !== expectedObjective) {
    throw compiledApplyError(ticket, "work-unit deliverable or completion condition does not match the run plan");
  }
  const expectedDependencies = [...(unit.depends_on || []), ...(unit.parent_gate_ids || [])];
  if (!sameCompiledStrings(workUnit.satisfied_dependencies, expectedDependencies)) {
    throw compiledApplyError(ticket, "work-unit satisfied dependencies do not match the run plan");
  }
  const planRecord = unit as unknown as Record<string, unknown>;
  const expectedReadContext = Array.isArray(planRecord.read_context)
    ? planRecord.read_context
    : Array.isArray(planRecord.readContext)
      ? planRecord.readContext
      : Array.isArray(planRecord.read_paths)
        ? planRecord.read_paths
        : Array.isArray(planRecord.readPaths)
          ? planRecord.readPaths
          : [];
  if (!sameCompiledStrings(workUnit.read_context, expectedReadContext)) {
    throw compiledApplyError(ticket, "work-unit read context does not match the run plan", "COMPILED_SCOPE_MISMATCH");
  }
  if (!sameCompiledStrings(workUnit.write_paths, unit.write_paths || [])) {
    throw compiledApplyError(ticket, "work-unit write scope does not match the run plan", "COMPILED_SCOPE_MISMATCH");
  }
  if (!sameCompiledStrings(workUnit.allowed_operations, unit.allowed_operations || [])) {
    throw compiledApplyError(ticket, "work-unit operations do not match the run plan", "COMPILED_SCOPE_MISMATCH");
  }
  const expectedPatchRecipe = String(unit.patch || unit.prompt || expectedObjective).trim();
  if (String(workUnit.patch_recipe || "").trim() !== expectedPatchRecipe) {
    throw compiledApplyError(ticket, "work-unit patch recipe does not match the run plan");
  }
  const expectedCompletion = lineage.mode === "verification-only"
    ? (unit.verification || ["validation completed"])
    : [unit.description || "patch completed"];
  if (!sameCompiledStrings(workUnit.completion_criteria, expectedCompletion)
    || !sameCompiledStrings(workUnit.permitted_validation, unit.verification || ["read"])) {
    throw compiledApplyError(ticket, "work-unit completion or validation contract does not match the run plan");
  }
  if (workUnit.coordination !== "terminal-only") {
    throw compiledApplyError(ticket, "compiled work units must use terminal-only coordination");
  }
  const expectedMode: ExecutionMode = lineage.mode === "patch-only" ? "write" : "read-only";
  if (ticket.mode !== expectedMode || ticket.read_only !== (expectedMode === "read-only")) {
    throw compiledApplyError(ticket, `ticket execution mode must be ${expectedMode}`, "COMPILED_EXECUTION_MODE_MISMATCH");
  }
  if (!ticket.receipt_id) throw compiledApplyError(ticket, "compiled ticket requires a Receipt", "RECEIPT_REQUIRED");
  let receipt: DelegationReceipt;
  try {
    receipt = receiptOverride || readReceipt(cwd, ticket.receipt_id, env);
    assertValidTicketReceiptLineage({
      ...ticket,
      target_host: ticket.target_host || host,
    }, receipt);
  } catch (error) {
    if (error instanceof DispatchError) throw error;
    throw compiledApplyError(ticket, error instanceof Error ? error.message : String(error));
  }
  if (receipt.ticket_id !== ticket.id || receipt.receipt_id !== ticket.receipt_id) {
    throw compiledApplyError(ticket, "Receipt ticket identity does not match", "COMPILED_RECEIPT_MISMATCH");
  }
  const catalog = readRouteSnapshot(cwd, { host, env });
  const catalogRoute = catalog?.routes.find((candidate) => candidate.route_id === ticket.route_id);
  if (!catalog || !catalogRoute || catalogRoute.disabled || (receipt.route.provider || null) !== (catalogRoute.provider || null)) {
    throw compiledApplyError(ticket, "captured route is absent, disabled, or owned by another provider", "COMPILED_ROUTE_MISMATCH");
  }
  if (receipt.host !== host || ticket.selection?.host !== host
    || !ticket.selection
    || !receipt.selection
    || stableCompiledValue(ticket.selection) !== stableCompiledValue(receipt.selection)
    || ticket.selection.selected_model_id !== ticket.model_id
    || ticket.selection.selected_model_id !== receipt.route.card_id
    || ticket.route_id !== receipt.route.route_id
    || (ticket.reasoning_effort || null) !== (receipt.route.reasoning_effort || null)
    || (ticket.service_tier || null) !== (receipt.route.service_tier || null)) {
    throw compiledApplyError(ticket, "selection, host, route, or model does not match the Receipt", "COMPILED_ROUTE_MISMATCH");
  }
  if (lineage.mode === "patch-only") {
    if (receipt.execution.mode !== "write"
      || !receipt.baseline
      || !sameCompiledStrings(receipt.scope.write_allowlist, unit.write_paths || [])
      || !sameCompiledStrings(receipt.scope.allowed_operations.filter((item) => item !== "read" && item !== "commit"), unit.allowed_operations || [])
      || receipt.scope.allowed_operations.includes("read")
      || receipt.scope.allowed_operations.includes("commit")) {
      throw compiledApplyError(ticket, "Receipt write scope or operations do not match the run plan", "COMPILED_SCOPE_MISMATCH");
    }
  } else if (receipt.execution.mode !== "read-only"
    || receipt.baseline !== null
    || receipt.commit_baseline !== null
    || receipt.scope.write_allowlist.length !== 0
    || stableCompiledValue(receipt.scope.allowed_operations) !== stableCompiledValue(["read"])) {
    throw compiledApplyError(ticket, "verification-only Receipt carries write authority", "COMPILED_SCOPE_MISMATCH");
  }
  return { lineage, state, plan, unit, receipt, quotaSuccessor };
}

function rejectCompiledTicketValidation(cwd: string, ticket: SpawnTicket, error: unknown, at: string, env: NodeJS.ProcessEnv): never {
  const failure = error instanceof DispatchError
    ? error
    : new DispatchError(error instanceof Error ? error.message : String(error), "COMPILED_TICKET_INVALID", { ticketId: ticket.id });
  if (ticket.status === "dispatching" || ticket.status === "running") {
    transition(ticket, ["dispatching", "running"], "errored", {
      at,
      event: "compiled_validation_failed",
      detail: { error_code: failure.code },
    });
    ticket.error = { code: failure.code, message: failure.message };
    ticket.conclusion = null;
    ticket.finished_at = at;
    ticket.compiled_acceptance = { accepted: false, code: failure.code, evidence: failure.message };
    ticket.slot_released_at = at;
    history(ticket, "agent_slot_released", at, {
      ...(ticket.execution_handle ? { execution_handle: ticket.execution_handle } : {}),
      reason: "compiled_validation_failed",
    });
    writeSpawn(cwd, ticket, env);
  }
  throw failure;
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

/** A synthetic route has no durable callability evidence yet. Keep one native
 * launch in flight so a cold route cannot fan out before its first result. */
function hasPendingSyntheticRouteProbe(tickets: SpawnTicket[], host: HostId, routeId: string, env: NodeJS.ProcessEnv): boolean {
  return ticketsInDispatchScope(tickets, host, env).some((ticket) =>
    ticket.route_id === routeId && ticket.status === "dispatching" && !ticket.execution_handle);
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
      // A rolling ticket must be authorized from its immutable artifact edge
      // before any reservation fields or status are changed.
      let rollingReceipt: DelegationReceipt | null = null;
      try {
        rollingReceipt = validateRollingDispatchArtifacts(cwd, ticket, targetHost, env);
      } catch (error) {
        const rejected = await rejectUndispatchable(cwd, ticket, at, targetHost, env, safetyOptions, error);
        if (rejected) blocked.push(rejected);
        continue;
      }
      let compiledContext: CompiledApplyContext | null = null;
      // Dependency/gate backpressure is not a terminal ticket failure. Keep
      // the compiled unit queued so an independent frontier can continue and
      // a later acceptance can make it eligible without changing its scope.
      if (isCompiledApplyTicket(ticket)) {
        try {
          compiledContext = validateCompiledTicket(cwd, ticket, targetHost, env);
          if (compiledContext) {
            const readiness = compiledUnitReady(compiledContext);
            if (!readiness.ready) {
              blocked.push({
                ticket_id: ticket.id,
                code: readiness.code || "COMPILED_DEPENDENCY_BLOCKED",
                message: readiness.message || `ticket ${ticket.id} is not ready in its compiled ApplyRun`,
              });
              continue;
            }
          }
        } catch {
          // The full contract error is persisted by rejectUndispatchable
          // below; only dependency/gate backpressure is deliberately kept in
          // the queue here.
        }
      }
      const rejected = await rejectUndispatchable(cwd, ticket, at, targetHost, env, safetyOptions);
      if (rejected) {
        blocked.push(rejected);
        let successorId: string | null = null;
        if (rejected.code === "MODEL_QUOTA_EXHAUSTED" || rejected.code === "MODEL_RATE_LIMITED"
          || isSessionUncallable({ errorCode: ticket.error?.code, message: ticket.error?.message })) {
          successorId = await createQuotaSuccessor(cwd, ticket, at, env, safetyOptions, compiledContext);
        }
        if (compiledContext) {
          ticket.compiled_acceptance = successorId
            ? { accepted: false, code: "SUCCESSOR_CREATED", evidence: `successor ${successorId}` }
            : acceptCompiledTerminal(cwd, ticket, compiledContext, at, ticket.error?.message || rejected.message, env);
        }
        writeSpawn(cwd, ticket, env);
        continue;
      }
      const availability = availabilityForRoute(cwd, { host: targetHost, routeId: ticket.route_id! }, at, env);
      if (!availability.evidence_present && hasPendingSyntheticRouteProbe(tickets, targetHost, ticket.route_id!, env)) {
        const probePending = {
          ticket_id: ticket.id,
          code: "ROUTE_PROBE_PENDING",
          message: `ticket ${ticket.id} route ${ticket.route_id} is awaiting the first native probe result`,
        };
        blocked.push(probePending);
        continue;
      }
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
      try {
        if (rollingReceipt) verifyExactExecutionRoot(cwd, ticket, rollingReceipt, targetHost, env, true);
      } catch (error) {
        const rejected = await rejectUndispatchable(cwd, ticket, at, targetHost, env, safetyOptions, error);
        if (rejected) blocked.push(rejected);
        continue;
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

/**
 * Probe/release callers may rely on the complete handle persisted at bind.
 * When they repeat any exact-root field, however, the repetition must remain
 * complete and identical so a partial or rewritten lineage cannot be hidden.
 */
function assertOptionalExactRootAcknowledgement(
  ticketId: string,
  operation: "probe" | "release",
  requested: NativeExecutionHandle,
  bound: NativeExecutionHandle,
): void {
  let repeated: ExactExecutionRootIdentity | undefined;
  try { repeated = extractExactExecutionRootIdentity(requested); }
  catch {
    throw new DispatchError(
      `ticket ${ticketId} ${operation} handle has a partial exact-root acknowledgement`,
      "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH",
      { ticketId },
    );
  }
  if (repeated && !sameExactExecutionRootIdentity(repeated, bound)) {
    throw new DispatchError(
      `ticket ${ticketId} ${operation} handle exact-root acknowledgement does not match`,
      "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH",
      { ticketId },
    );
  }
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
    // Re-read the immutable rolling authorization after reservation and
    // before attaching a native handle or changing lifecycle state.
    const rollingReceipt = validateRollingDispatchArtifacts(cwd, ticket, targetHost, env);
    if (isCompiledApplyTicket(ticket)) {
      try { validateCompiledTicket(cwd, ticket, targetHost, env); }
      catch (error) { rejectCompiledTicketValidation(cwd, ticket, error, at, env); }
    }
    const handle = executionHandle || null;
    if (!handle || !handle.value.trim()) throw new DispatchError(`ticket ${id} has no native execution handle`, "EXECUTION_HANDLE_REQUIRED", { ticketId: id });
    const expectedKind = getCliAdapter(host, env).host.executionHandleKind;
    if (handle.kind !== expectedKind) throw new DispatchError(`ticket ${id} requires handle kind ${expectedKind}`, "EXECUTION_HANDLE_KIND_MISMATCH", { ticketId: id });
    const exactRoot = requireExactRootAdapter(ticket, host, env);
    let acknowledgedRoot: ExactExecutionRootIdentity | undefined;
    try { acknowledgedRoot = extractExactExecutionRootIdentity(handle); }
    catch { throw new DispatchError(`ticket ${id} native handle has a partial exact-root acknowledgement`, "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH", { ticketId: id }); }
    if (exactRoot && (!acknowledgedRoot || !sameExactExecutionRootIdentity(exactRoot, acknowledgedRoot))) {
      throw new DispatchError(`ticket ${id} native handle did not acknowledge the identical execution root`, "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH", { ticketId: id });
    }
    if (!exactRoot && acknowledgedRoot) {
      throw new DispatchError(`ticket ${id} shared execution cannot bind an isolated-root handle`, "ISOLATED_EXECUTION_IDENTITY_FORBIDDEN", { ticketId: id });
    }
    if (rollingReceipt) verifyExactExecutionRoot(cwd, ticket, rollingReceipt, host, env, false);
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
    transitionExactRootRecord(cwd, ticket, `native-bind-${ticket.reservation_id || ticket.attempt}`, "worker_active", at, `${handle.kind}:${handle.value}`, ["live_native_handle"], env);
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
    assertOptionalExactRootAcknowledgement(id, "probe", requested, bound);
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
    // A terminal ticket without a native handle never acquired a host slot
    // or workspace write scope. Do not let its historical ledger path keep
    // blocking later workers after normalization has marked it released.
    const terminalWithoutNativeHandle = TERMINAL_TICKET_STATUSES.has(other.status) && !other.execution_handle;
    if (otherLedger && !terminalWithoutNativeHandle) ledger.add(otherLedger);
    if (other.id === ticket.id || other.mode !== "write" || !other.receipt_id) continue;
    const overlapping = !terminalWithoutNativeHandle && (Boolean(other.started_at)
      || other.status === "dispatching"
      || other.status === "running"
      || other.status === "completed");
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

interface PlanInsufficientEvidence {
  code: "PLAN_INSUFFICIENT";
  file: string;
  symbol: string;
  missing_decision: string;
}

function sanitizedPlanEvidence(value: unknown, limit = 240): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** Parse only the worker's structured insufficiency result. */
function planInsufficientEvidence(value: unknown): PlanInsufficientEvidence | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (String(record.code || "").trim().toUpperCase() !== "PLAN_INSUFFICIENT") return null;
  return {
    code: "PLAN_INSUFFICIENT",
    file: sanitizedPlanEvidence(record.file),
    symbol: sanitizedPlanEvidence(record.symbol),
    missing_decision: sanitizedPlanEvidence(record.missing_decision ?? record.missingDecision),
  };
}

function attachPlanInsufficientEvidence(ticket: SpawnTicket, evidence: PlanInsufficientEvidence, at: string): void {
  // These fields are deliberately diagnostic-only. They are not fed back into
  // the plan or used to widen the worker's scope.
  ticket.plan_insufficient_evidence = structuredClone(evidence);
  ticket.semantic_replan_reason = "PLAN_INSUFFICIENT";
  ticket.replan_reason = "PLAN_INSUFFICIENT";
  ticket.successor_reason = "PLAN_INSUFFICIENT";
  ticket.replan_required = true;
  history(ticket, "semantic_replan_required", at, { reason: "PLAN_INSUFFICIENT", evidence: structuredClone(evidence) });
}

function compiledSafetyVerdict(ticket: SpawnTicket): UnknownRecord | undefined {
  return ticket.safety_verdict;
}

function acceptCompiledTerminal(
  cwd: string,
  ticket: SpawnTicket,
  context: CompiledApplyContext | null,
  at: string,
  result: string | null,
  env: NodeJS.ProcessEnv,
): ApplyAcceptanceResult | null {
  if (!context) return null;
  const acceptance = acceptApplyUnit({
    cwd,
    env,
    runId: context.lineage.run_id,
    unitId: context.lineage.unit_id,
    host: context.state.host,
    ticketId: ticket.id,
    receiptId: ticket.receipt_id || undefined,
    revision: context.lineage.plan_revision,
    fingerprint: context.lineage.plan_fingerprint,
    taskRefs: context.lineage.task_refs,
    mode: context.lineage.mode,
    terminalStatus: ticket.status,
    safetyVerdict: compiledSafetyVerdict(ticket),
    result: result || ticket.conclusion || undefined,
    ticket,
    receipt: context.receipt,
  });
  if (!acceptance.accepted && acceptance.code === "PLAN_INSUFFICIENT") {
    ticket.semantic_replan_reason = "PLAN_INSUFFICIENT";
    ticket.replan_reason = "PLAN_INSUFFICIENT";
    ticket.replan_required = true;
    if (!ticket.plan_insufficient_evidence) {
      ticket.successor_reason = "PLAN_INSUFFICIENT";
      history(ticket, "semantic_replan_required", at, { reason: "PLAN_INSUFFICIENT", evidence: acceptance.evidence });
    }
  }
  return acceptance;
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
        evidenceKind: "quota",
        resetAt: outcome.resetAt || null,
        now: at,
        env: outcome.env,
      });
      return {
        status: record.status,
        reason: record.reason,
        evidence_kind: record.evidence_kind,
        reset_at: record.reset_at,
        next_probe_at: record.next_probe_at,
        remaining_percent: outcome.remainingPercent ?? null,
      };
    }
    if (isExplicitRateLimit(outcome)) {
      const record = markRouteExhausted(cwd, { host, routeId: ticket.route_id }, {
        reason: outcome.errorCode || "RATE_LIMITED",
        evidenceKind: "rate_limit",
        resetAt: outcome.resetAt || null,
        now: at,
        env: outcome.env,
      });
      return {
        status: record.status,
        reason: record.reason,
        evidence_kind: record.evidence_kind,
        reset_at: record.reset_at,
        next_probe_at: record.next_probe_at,
        remaining_percent: outcome.remainingPercent ?? null,
      };
    }
    if (isSessionUncallable(outcome)) {
      const record = markRouteExhausted(cwd, { host, routeId: ticket.route_id }, {
        reason: outcome.errorCode || "MODEL_SESSION_UNCALLABLE",
        evidenceKind: "session_uncallable",
        resetAt: null,
        now: at,
        env: outcome.env,
      });
      return {
        status: record.status,
        reason: record.reason,
        evidence_kind: record.evidence_kind,
        reset_at: record.reset_at,
        next_probe_at: record.next_probe_at,
        remaining_percent: outcome.remainingPercent ?? null,
      };
    }
    if (outcome.success || positiveRemaining) {
      const record = markRouteAvailable(cwd, { host, routeId: ticket.route_id }, { now: at, env: outcome.env });
      return { status: record.status, reason: null, evidence_kind: record.evidence_kind, reset_at: null, next_probe_at: null };
    }
    return null;
  } catch (error) {
    const durable = isConfirmedQuotaExhaustion(outcome)
      || isExplicitRateLimit(outcome)
      || isSessionUncallable(outcome)
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

/** Exact native callability failures are session-local route evidence. */
function isSessionUncallable(input: { errorCode?: string | null; message?: string | null }): boolean {
  const code = String(input.errorCode || "").trim().toUpperCase();
  if (/^(?:MODEL|ROUTE|NATIVE|EXECUTION)_(?:UNCALLABLE|UNAVAILABLE|UNREACHABLE|NOT_CALLABLE|NOT_AVAILABLE)$/.test(code)) return true;
  if (["MODEL_NOT_FOUND", "SESSION_UNCALLABLE", "CLI_UNCALLABLE"].includes(code)) return true;
  return /(?:model|route|native|session|cli).*(?:uncallable|not callable|unavailable|unreachable)/i.test(String(input.message || ""));
}

interface SuccessorRouteCandidate {
  route: ExecutableRoute;
  routeId: string;
  reasoning_effort: string | null;
  exclusions: Array<{ model_id: string; route_id: string; codes: string[]; reasons: string[] }>;
}

function compiledRoutingRequirements(ticket: SpawnTicket, context?: CompiledApplyContext | null): Record<string, unknown> {
  const ticketRequirements = ticket.routing_requirements as unknown as Record<string, unknown> | undefined;
  const unitRequirements = context?.unit as unknown as Record<string, unknown> | undefined;
  const prompt = String(context?.unit.prompt || context?.unit.description || ticket.prompt || ticket.description || "").trim();
  let derived: Record<string, unknown> = {};
  if (context) {
    try {
      // Compiled materialization derives this same minimum contract during
      // selection. Re-derive it for a native successor because the selected
      // model is the only field allowed to change across a retry. Legacy
      // tickets retain their historical route-only successor behavior.
      derived = deriveMinimumModelRequirements(prompt, {
        native_execution: true,
        tool: true,
      }) as unknown as Record<string, unknown>;
    } catch {
      // An older compiled record may not carry enough task text to derive
      // requirements. Its persisted ticket requirements remain authoritative.
    }
  }
  return {
    ...derived,
    ...(unitRequirements?.minimum_requirements && typeof unitRequirements.minimum_requirements === "object"
      ? unitRequirements.minimum_requirements as Record<string, unknown> : {}),
    ...(ticketRequirements || {}),
  };
}

function routeVariantBase(routeId: string): { base: string; effort: string | null } {
  const at = routeId.lastIndexOf("@");
  return at > 0 ? { base: routeId.slice(0, at), effort: routeId.slice(at + 1) || null } : { base: routeId, effort: null };
}

const SUCCESSOR_EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

function successorEffort(value: unknown): string | null {
  const normalized = String(value || "").trim().toLowerCase().replaceAll(/[_ ]+/g, "-");
  return Object.hasOwn(SUCCESSOR_EFFORT_RANK, normalized) ? normalized : null;
}

function lowestSupportedEffort(values: string[], minimumRank: number): string | null {
  return values
    .map((value) => successorEffort(value))
    .filter((value): value is string => Boolean(value) && SUCCESSOR_EFFORT_RANK[value] >= minimumRank)
    .sort((left, right) => SUCCESSOR_EFFORT_RANK[left] - SUCCESSOR_EFFORT_RANK[right])[0] || null;
}

function successorCapability(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase().replaceAll(/[_ ]+/g, "-");
  if (["native", "native-exec", "execution-handle", "native-child"].includes(normalized)) return "native-execution";
  if (["tool", "tools", "tooling", "function-calling"].includes(normalized)) return "tool-use";
  if (["readonly", "read"].includes(normalized)) return "read-only";
  if (["commit", "commitonly"].includes(normalized)) return "commit-only";
  return normalized;
}

function routeCapabilitySets(route: ExecutableRoute): { supported: Set<string>; unsupported: Set<string>; known: boolean } {
  const record = route as unknown as Record<string, unknown>;
  const supported = new Set<string>();
  const unsupported = new Set<string>();
  let known = false;
  const addList = (value: unknown) => {
    if (!Array.isArray(value)) return;
    known = true;
    for (const item of value) {
      const itemRecord = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
      const capability = successorCapability(itemRecord?.id || itemRecord?.name || itemRecord?.capability || itemRecord?.kind || item);
      if (!capability) continue;
      if (itemRecord && (itemRecord.supported === false || itemRecord.available === false || itemRecord.enabled === false)) unsupported.add(capability);
      else supported.add(capability);
    }
  };
  const addObject = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    known = true;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const capability = successorCapability(key);
      if (!capability) continue;
      if (item === true || (item && typeof item === "object" && (item as Record<string, unknown>).supported === true)) supported.add(capability);
      else if (item === false || (item && typeof item === "object" && ((item as Record<string, unknown>).supported === false || (item as Record<string, unknown>).available === false))) unsupported.add(capability);
    }
  };
  addList(record.execution_capabilities ?? record.executionCapabilities);
  addList(record.capabilities);
  addList(record.tools ?? record.supported_tools ?? record.supportedTools);
  addObject(record.capabilities);
  addObject(record.execution_capabilities ?? record.executionCapabilities);
  addObject(record.execution);
  addObject(record.supports);
  const native = record.supports_native_execution ?? record.supportsNativeExecution ?? record.supports_native ?? record.supportsNative;
  if (native === true) supported.add("native-execution");
  if (native === false) unsupported.add("native-execution");
  const tool = record.supports_tool_use ?? record.supportsToolUse ?? record.supports_tools ?? record.supportsTools
    ?? record.supports_tool ?? record.supportsTool ?? record.tool_use ?? record.toolUse ?? record.tool;
  if (tool === true) supported.add("tool-use");
  if (tool === false) unsupported.add("tool-use");
  if (route.native === true) supported.add("native-execution");
  return { supported, unsupported, known };
}

function providerQuotaExhausted(snapshot: { provider_quotas?: Array<{ provider: string; windows: Array<{ remaining_percent: number }> }> }, provider: string | null): boolean {
  if (!provider) return false;
  const quota = snapshot.provider_quotas?.find((item) => item.provider === provider);
  return Boolean(quota?.windows?.some((window) => Number.isFinite(window.remaining_percent) && window.remaining_percent <= 0));
}

function successorRouteForTicket(cwd: string, ticket: SpawnTicket, at: string, env: NodeJS.ProcessEnv = process.env, context?: CompiledApplyContext | null): SuccessorRouteCandidate | null {
  const compiled = isCompiledApplyTicket(ticket);
  if (!ticket.route_id || (!compiled && ticket.mode !== "write") || !ticket.receipt_id) return null;
  const receipt = readReceipt(cwd, ticket.receipt_id, env);
  if (ticket.mode === "write" && !receipt.baseline) return null;
  if (compiled && ticket.mode === "read-only" && receipt.baseline !== null) return null;
  const host = ticketTargetHost(ticket, env);
  const config = loadConfig(cwd, { env });
  const configured = [...configuredCodingModelsForHost(config, host)];
  const currentIndex = configured.findIndex((item) => item === ticket.route_id || routeVariantBase(item).base === ticket.route_id);
  const exclusions: SuccessorRouteCandidate["exclusions"] = [];
  if (currentIndex < 0) {
    for (const configuredId of configured) {
      exclusions.push({ model_id: configuredId, route_id: routeVariantBase(configuredId).base, codes: ["CURRENT_ROUTE_NOT_CONFIGURED"], reasons: ["the failed ticket route is not in the configured coding route order"] });
    }
    (ticket as unknown as UnknownRecord).successor_exclusion_matrix = exclusions;
    return null;
  }
  const snapshot = readRouteSnapshot(cwd, { host, env });
  const requirements = compiledRoutingRequirements(ticket, context);
  const requiredEffort = String(requirements.required_reasoning_effort
    || requirements.requiredReasoningEffort
    || requirements.reasoning_effort
    || requirements.reasoning
    || ticket.reasoning_effort
    || "").trim() || null;
  const requiredEffortValue = successorEffort(requiredEffort);
  const requiredEffortRank = requiredEffortValue ? SUCCESSOR_EFFORT_RANK[requiredEffortValue] : 0;
  const estimatedContext = Number(requirements.estimated_context_tokens
    ?? requirements.estimatedContextTokens
    ?? requirements.estimated_context
    ?? requirements.context_tokens);
  const requiredCapabilities = (requirements.required_execution_capabilities
    || requirements.requiredExecutionCapabilities
    || requirements.execution_capabilities
    || requirements.executionCapabilities);
  const requiredCapabilityNames = Array.isArray(requiredCapabilities)
    ? requiredCapabilities.map(String).map((item) => item.trim().toLowerCase().replaceAll(/[_ ]+/g, "-")).filter(Boolean)
    : [];
  const configuredLater = configured.slice(currentIndex + 1);
  if (!snapshot) {
    for (const routeId of configured) exclusions.push({ model_id: routeId, route_id: routeVariantBase(routeId).base, codes: ["ROUTE_ABSENT_FROM_ACTIVE_CATALOG"], reasons: ["active CLI catalog snapshot is missing"] });
    (ticket as unknown as UnknownRecord).successor_exclusion_matrix = exclusions;
    return null;
  }
  // Keep the failed/current route and every earlier configured route in the
  // diagnostic matrix as well. The successor scan below then appends each
  // later candidate in the exact user-configured order.
  for (let index = 0; index <= currentIndex; index += 1) {
    const configuredId = configured[index]!;
    const variant = routeVariantBase(configuredId);
    const route = snapshot.routes.find((item) => item.route_id === configuredId || item.route_id === variant.base);
    if (index < currentIndex) {
      exclusions.push({ model_id: configuredId, route_id: variant.base, codes: ["HIGHER_PRIORITY_ROUTE_FAILED"], reasons: ["a higher-priority configured route was selected before this retry"] });
      continue;
    }
    const availability = route ? availabilityForRoute(cwd, { host, routeId: route.route_id }, at, env) : null;
    const failedCode = !route
      ? "ROUTE_ABSENT_FROM_ACTIVE_CATALOG"
      : isSessionUncallable({ errorCode: ticket.error?.code, message: ticket.error?.message })
        ? "CURRENT_SESSION_UNCALLABLE"
        : availability?.evidence_kind === "rate_limit"
          ? "CURRENT_SESSION_RATE_LIMITED"
          : availability?.status === "exhausted" || availability?.status === "probe_due"
            ? "CURRENT_SESSION_QUOTA_EXHAUSTED"
          : "NATIVE_ROUTE_FAILURE";
    exclusions.push({
      model_id: configuredId,
      route_id: variant.base,
      codes: [failedCode],
      reasons: [!route ? "route is absent from the active CLI catalog" : ticket.error?.message || "the selected route failed at the native execution surface"],
    });
  }
  for (const configuredId of configuredLater) {
    const variant = routeVariantBase(configuredId);
    const route = snapshot.routes.find((item) => item.route_id === configuredId || item.route_id === variant.base);
    const modelId = configuredId;
    const codes: string[] = [];
    const reasons: string[] = [];
    if (!route) {
      codes.push("ROUTE_ABSENT_FROM_ACTIVE_CATALOG"); reasons.push("route is absent from the active CLI catalog");
    } else if (route.disabled) {
      codes.push("ROUTE_DISABLED"); reasons.push("route is disabled in the active CLI catalog");
    } else {
      const supportedEfforts = route.reasoning_efforts.map((item) => successorEffort(item) || String(item).trim().toLowerCase());
      // An unqualified route may advertise a lower default while still
      // supporting the captured minimum. Preserve that captured requirement
      // for the successor instead of rejecting the route because its default
      // is lower.
      const capturedMinimumEffort = requiredEffortValue && supportedEfforts.length > 0
        ? lowestSupportedEffort(supportedEfforts, requiredEffortRank)
        : null;
      const candidateEffort = successorEffort(variant.effort)
        || capturedMinimumEffort
        || successorEffort(route.default_reasoning_effort)
        || successorEffort(ticket.reasoning_effort);
      const candidateEffortRank = candidateEffort ? SUCCESSOR_EFFORT_RANK[candidateEffort] || 0 : 0;
      const exactVariantUnsupported = Boolean(variant.effort && supportedEfforts.length && !supportedEfforts.includes(variant.effort.toLowerCase()));
      const unsupportedDefault = Boolean(requiredEffort && !variant.effort && supportedEfforts.length
        && (!candidateEffort || !supportedEfforts.includes(candidateEffort)));
      const belowMinimum = Boolean(requiredEffort && (
        (candidateEffort && candidateEffortRank < requiredEffortRank)
        || (!candidateEffort && supportedEfforts.length && !supportedEfforts.some((item) => (SUCCESSOR_EFFORT_RANK[item] || 0) >= requiredEffortRank))
      ));
      if (exactVariantUnsupported || belowMinimum || Boolean(requiredEffort && !requiredEffortValue
        && variant.effort && variant.effort !== requiredEffort) || unsupportedDefault) {
        const label = variant.effort ? "configured" : "required";
        const effort = variant.effort || requiredEffortValue || requiredEffort;
        codes.push("REASONING_CAPABILITY_INSUFFICIENT"); reasons.push(`${label} reasoning effort ${effort} is not supported`);
      }
      if (Number.isFinite(estimatedContext) && estimatedContext > 0 && route.context_window !== null && route.context_window < estimatedContext) {
        codes.push("CONTEXT_WINDOW_INSUFFICIENT"); reasons.push(`context window ${route.context_window} is smaller than ${estimatedContext}`);
      }
      const capabilities = routeCapabilitySets(route);
      for (const rawCapability of requiredCapabilityNames) {
        const capability = successorCapability(rawCapability);
        if (!capability) continue;
        if (capabilities.unsupported.has(capability)
          || (capabilities.known && !capabilities.supported.has(capability))
          || (capability === "native-execution" && route.native !== true)) {
          codes.push("REQUIRED_EXECUTION_CAPABILITY_UNSUPPORTED"); reasons.push(`${capability} is not supported by the route`);
        }
      }
      if (providerQuotaExhausted(snapshot, route.provider)) {
        codes.push("QUOTA_POOL_EXHAUSTED"); reasons.push(`${route.provider || "provider"} quota pool is exhausted`);
      }
      const availability = availabilityForRoute(cwd, { host, routeId: route.route_id }, at, env);
      if ((availability.status === "exhausted" || availability.status === "probe_due") && !availability.probe_available) {
        const uncallable = isSessionUncallable({ errorCode: availability.reason, message: availability.reason });
        codes.push(uncallable
          ? "CURRENT_SESSION_UNCALLABLE"
          : availability.evidence_kind === "rate_limit" ? "CURRENT_SESSION_RATE_LIMITED" : "CURRENT_SESSION_QUOTA_EXHAUSTED");
        reasons.push(availability.reason || "route is unavailable in the current Baton session");
      }
    }
    if (codes.length) {
      exclusions.push({ model_id: modelId, route_id: variant.base, codes: [...new Set(codes)], reasons: [...new Set(reasons)] });
      continue;
    }
    exclusions.push({ model_id: modelId, route_id: variant.base, codes: ["AVAILABLE"], reasons: ["later configured route satisfies the captured requirements"] });
    (ticket as unknown as UnknownRecord).successor_exclusion_matrix = exclusions;
    const selectedEffort = successorEffort(variant.effort)
      || (requiredEffortValue && route.reasoning_efforts.length > 0
        ? lowestSupportedEffort(route.reasoning_efforts, requiredEffortRank)
        : null)
      || successorEffort(route.default_reasoning_effort)
      || successorEffort(ticket.reasoning_effort);
    return { route, routeId: configuredId, reasoning_effort: selectedEffort, exclusions };
  }
  (ticket as unknown as UnknownRecord).successor_exclusion_matrix = exclusions;
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

async function createQuotaSuccessor(cwd: string, ticket: SpawnTicket, at: string, env: NodeJS.ProcessEnv = process.env, safetyOptions: AsyncSafetyOptions = {}, compiledContext?: CompiledApplyContext | null): Promise<string | null> {
  const compiled = isCompiledApplyTicket(ticket);
  if ((!compiled && ticket.mode !== "write") || !ticket.receipt_id) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const receipt = readReceipt(cwd, ticket.receipt_id, env);
  if (ticket.mode === "write" && !receipt.baseline) {
    ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
    return null;
  }
  const candidate = successorRouteForTicket(cwd, ticket, at, env, compiledContext);
  if (ticket.mode === "write") {
    const noMutation = await auditWorktreeAsync(cwd, receipt.baseline!, { write_allowlist: [], allowed_operations: [] }, safetyOptions);
    if (!noMutation.accepted) {
      ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
      (ticket as unknown as UnknownRecord).successor_safety_verdict = noMutation as unknown as UnknownRecord;
      const matrix = candidate?.exclusions || ((ticket as unknown as UnknownRecord).successor_exclusion_matrix as SuccessorRouteCandidate["exclusions"] | undefined) || [];
      (ticket as unknown as UnknownRecord).successor_exclusion_matrix = matrix.map((entry) => ({
        ...entry,
        codes: [...new Set([...entry.codes, "SAFETY_RECONCILIATION_UNRESOLVED"])],
        reasons: [...entry.reasons, "authorized partial-write safety reconciliation was not accepted"],
      }));
      return null;
    }
  }
  if (!candidate) {
    ticket.successor_reason = "NO_SUCCESSOR_ROUTE";
    return null;
  }
  if (compiled) {
    try {
      // A successor is still a queued unit, but the effective host capacity
      // is an authorization requirement and must be known again at retry
      // time. Do not mint a successor from a stale/unknown capacity view.
      requiredCapacity(resolvedCapacity(cwd, ticketTargetHost(ticket, env), env));
    } catch (error) {
      ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
      (ticket as unknown as UnknownRecord).successor_exclusion_matrix = candidate.exclusions.map((entry) => ({
        ...entry,
        codes: [...new Set([...entry.codes, "CAPACITY_UNAVAILABLE"])],
        reasons: [...entry.reasons, error instanceof Error ? error.message : "effective host capacity is unavailable"],
      }));
      return null;
    }
  }
  // Successors belong to the originating session even if the environment
  // changed while reconciliation was running.
  const successorOrdinal = nextSuccessorOrdinal(cwd, ticket, env);
  const successorId = sessionTicketId("spn", ticket.session_uid, successorOrdinal);
  const route = candidate.route;
  const candidateVariant = routeVariantBase(candidate.routeId);
  const reasoningEffort = candidate.reasoning_effort
    || candidateVariant.effort
    || (ticket.reasoning_effort && route.reasoning_efforts.includes(ticket.reasoning_effort) ? ticket.reasoning_effort : route.default_reasoning_effort);
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
    recommended_model_id: candidate.routeId,
    selected_model_id: candidate.routeId,
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
  successor.model_id = candidate.routeId;
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
    card_id: candidate.routeId,
    route_id: route.route_id,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    provider: route.provider,
  };
  successorReceipt.selection = selection;
  if (compiled) {
    // The candidate is a new authorization edge, not an implicit fallback.
    // Re-run the complete ticket/Receipt/run validation before either
    // successor artifact is persisted.
    try {
      validateCompiledTicket(cwd, successor, ticketTargetHost(successor, env), env, successorReceipt);
    } catch (error) {
      const code = error instanceof DispatchError ? error.code : "SUCCESSOR_VALIDATION_FAILED";
      const message = error instanceof Error ? error.message : "successor authorization validation failed";
      ticket.successor_reason = "SUCCESSOR_REQUIRES_RECONCILIATION";
      (ticket as unknown as UnknownRecord).successor_exclusion_matrix = candidate.exclusions.map((entry) => (
        entry.model_id === candidate.routeId
          ? {
            ...entry,
            codes: [...new Set([...entry.codes.filter((item) => item !== "AVAILABLE"), code])],
            reasons: [...new Set([...entry.reasons, message])],
          }
          : entry
      ));
      return null;
    }
  }
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
  if (terminal === "errored") {
    if (typeof errorCode !== "string" || !errorCode.trim()) {
      throw new DispatchError(`ticket ${id} failure requires an explicit error code`, "ERROR_CODE_REQUIRED", { ticketId: id });
    }
    if (typeof errorMessage !== "string" || !errorMessage.trim()) {
      throw new DispatchError(`ticket ${id} failure requires a raw error message`, "ERROR_MESSAGE_REQUIRED", { ticketId: id });
    }
  }
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
    validateRollingDispatchArtifacts(cwd, ticket, ticketTargetHost(ticket, env), env);
    let compiledContext: CompiledApplyContext | null = null;
    if (isCompiledApplyTicket(ticket)) {
      try { compiledContext = validateCompiledTicket(cwd, ticket, ticketTargetHost(ticket, env), env); }
      catch (error) { rejectCompiledTicketValidation(cwd, ticket, error, at, env); }
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
      const isolatedIdentity = isolatedTicketIdentity(ticket);
      const verdict = await auditWorktreeAsync(isolatedIdentity?.execution_root || cwd, receipt.baseline, {
        write_allowlist: receipt.scope.write_allowlist,
        allowed_operations: allowedOperations,
        peer_write_allowlists: peerWriteAllowlists(cwd, ticket, env),
        ...(isolatedIdentity ? { shared_refs: "parent-owned" as const } : {}),
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
        if (!ticket.execution_handle && !ticket.slot_released_at) ticket.slot_released_at = at;
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
        if (compiledContext) {
          const acceptance = acceptCompiledTerminal(cwd, ticket, compiledContext, at, ticket.error.message, env);
          ticket.compiled_acceptance = acceptance;
        }
        writeSpawn(cwd, ticket, env);
        retainTerminalExactRoot(ticket, at, env);
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
        if (!ticket.execution_handle && !ticket.slot_released_at) ticket.slot_released_at = at;
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
        if (compiledContext) {
          const acceptance = acceptCompiledTerminal(cwd, ticket, compiledContext, at, ticket.error.message, env);
          ticket.compiled_acceptance = acceptance;
        }
        writeSpawn(cwd, ticket, env);
        retainTerminalExactRoot(ticket, at, env);
        if (hostError) updateRouteHealth(cwd, ticket, hostError.status, hostError, at, env);
        return ticket;
      }
    }
    const structuredInsufficiency = compiledContext
      ? planInsufficientEvidence(conclusion) || planInsufficientEvidence(errorMessage)
      : null;
    if (terminal === "completed") {
      const insufficient = structuredInsufficiency;
      const clean = sanitizeConclusion(conclusion);
      if (!clean.ok) throw new DispatchError("error" in clean ? clean.error : "invalid conclusion", "HYGIENE", { ticketId: id });
      // Compiled units report only to the parent acceptance API. Manual
      // OpenSpec tickets retain the historical one-ticket writeback path.
      if (!compiledContext && ticket.openspec && typeof ticket.openspec.tasks_path === "string" && typeof ticket.openspec.number === "string") {
        const current = fs.readFileSync(ticket.openspec.tasks_path, "utf8");
        const updated = writeTaskConclusionByNumber(current, ticket.openspec.number, clean.conclusion);
        fs.writeFileSync(ticket.openspec.tasks_path, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
      }
      transition(ticket, expected, terminal as TicketStatus, { at, event: "agent_completed" });
      ticket.conclusion = clean.conclusion;
      ticket.error = null;
      if (insufficient) {
        attachPlanInsufficientEvidence(ticket, insufficient, at);
        ticket.error = { code: "PLAN_INSUFFICIENT", message: JSON.stringify(insufficient) };
      }
    } else {
      if (!hostError) throw new DispatchError("invalid terminal status: " + terminal, "INVALID_TERMINAL_STATUS", { ticketId: id });
      const insufficient = structuredInsufficiency;
      transition(ticket, expected, terminal as TicketStatus, { at, event: "agent_" + terminal, detail: { error_code: hostError.code } });
      ticket.error = { code: hostError.code, message: hostError.message };
      if (conclusion) {
        const clean = sanitizeConclusion(conclusion);
        if (clean.ok) ticket.conclusion = clean.conclusion;
      }
      if (insufficient) {
        attachPlanInsufficientEvidence(ticket, insufficient, at);
        ticket.plan_insufficient_host_error = structuredClone(hostError);
        ticket.error = { code: "PLAN_INSUFFICIENT", message: JSON.stringify(insufficient) };
      }
    }
    ticket.finished_at = at;
    // Keep the returned terminal ticket consistent with spawn normalization:
    // a pre-bind failure has no native slot to await or release.
    if (!ticket.execution_handle && !ticket.slot_released_at) ticket.slot_released_at = at;
    const availability = availabilityOutcome(cwd, ticket, at, {
      errorCode: hostError?.code,
      message: hostError?.message,
      remainingPercent,
      resetAt,
      success: terminal === "completed",
      env,
    });
    if (availability) ticket.quota_diagnostic = availability;
    let successorId: string | null = null;
    if (terminal !== "completed" && hostError && !structuredInsufficiency && (isConfirmedQuotaExhaustion({
      errorCode: hostError.code,
      message: hostError.message,
      remainingPercent,
    }) || isExplicitRateLimit({ errorCode: hostError.code, message: hostError.message })
      || isSessionUncallable({ errorCode: hostError?.code, message: hostError?.message }))) {
      // availabilityOutcome either durably records the route state or throws
      // MODEL_AVAILABILITY_WRITE_FAILED. Never create a successor from an
      // unpersisted quota decision.
      successorId = await createQuotaSuccessor(cwd, ticket, at, env, safetyOptions, compiledContext);
    }
    if (compiledContext) {
      if (terminal !== "completed" && successorId) {
        ticket.compiled_acceptance = { accepted: false, code: "SUCCESSOR_CREATED", evidence: `successor ${successorId}` };
      } else {
        const acceptance = acceptCompiledTerminal(cwd, ticket, compiledContext, at, ticket.conclusion, env);
        ticket.compiled_acceptance = acceptance;
      }
    }
    writeSpawn(cwd, ticket, env);
    retainTerminalExactRoot(ticket, at, env);
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
    if (ticket.slot_released_at) {
      // Native release confirmation may be retried after a transport timeout.
      // A handle is not required once the ticket is already known released,
      // including terminal tickets that never acquired one.
      return ticket;
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
    if (requestedHandle) assertOptionalExactRootAcknowledgement(id, "release", requestedHandle, ticket.execution_handle);
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
    const resolved = resolveAgentTreeCapacity({
      host: adapter?.host,
      config,
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
