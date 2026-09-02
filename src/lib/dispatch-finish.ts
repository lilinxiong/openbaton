import {
  NativeExecutionHandle,
  SpawnTicket,
  TicketStatus
} from "./spawn.js";
import {
  listSpawns,
  readSpawn,
  sessionUid,
  writeSpawn
} from "./spawn-store.js";
import { readReceipt } from "./receipt.js";
import {
  AsyncSafetyOptions,
  SafetyOperation
} from "./safety.js";
import {
  DispatchLockOptions,
  withDispatchLockAsync,
  withLock
} from "./dispatch-lock.js";
import { UnknownRecord } from "../types.js";
import {
  CompiledApplyContext,
  isCompiledApplyTicket,
  rejectCompiledTicketValidation,
  validateCompiledTicket
} from "./dispatch-compiled.js";
import { requireHost } from "./dispatch-core.js";
import { validateRollingDispatchArtifacts } from "./dispatch-guard.js";
import {
  HostTerminalError,
  ScopeRejection,
  updateRouteHealth
} from "./dispatch-compat.js";
import {
  isolatedTicketIdentity,
  retainTerminalExactRoot
} from "./dispatch-exact-root.js";
import {
  auditCommitOutcomeAsync,
  auditWorktreeAsync
} from "./safety-audit.js";
import {
  availabilityOutcome,
  createQuotaSuccessor,
  isSessionUncallable
} from "./dispatch-successor.js";
import {
  isConfirmedQuotaExhaustion,
  isExplicitRateLimit
} from "./model-availability.js";
import { sanitizeConclusion } from "./hygiene.js";
import { writeTaskConclusionByNumber } from "./openspec.js";
import { assertOptionalExactRootAcknowledgement } from "./dispatch-signals.js";
import {
  ApplyAcceptanceResult,
  acceptApplyUnit
} from "./apply-reconcile.js";
import {
  DispatchError,
  TERMINAL_TICKET_STATUSES,
  TerminalDispatchStatus,
  TimeInput,
  instant,
  requireCurrentTicket,
  requireSessionTicket,
  ticketTargetHost,
  transition
} from "./dispatch-core.js";
import fs from "node:fs";
import path from "node:path";
import { getCliAdapter } from "../adapters/index.js";
import { history } from "./dispatch-core.js";
/**
 * Terminal finish/release for dispatched agents. Split from dispatch.ts.
 */

export function relativeLedgerPath(cwd: string, tasksPath: unknown): string | null {
  if (typeof tasksPath !== "string" || !tasksPath) return null;
  const relative = path.relative(cwd, tasksPath).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return relative;
}

export function peerWriteAllowlists(cwd: string, ticket: SpawnTicket, env: NodeJS.ProcessEnv = process.env): string[][] {
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

export interface FinishOptions {
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

export interface PlanInsufficientEvidence {
  code: "PLAN_INSUFFICIENT";
  file: string;
  symbol: string;
  missing_decision: string;
}

export function sanitizedPlanEvidence(value: unknown, limit = 240): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** Parse only the worker's structured insufficiency result. */
export function planInsufficientEvidence(value: unknown): PlanInsufficientEvidence | null {
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

export function attachPlanInsufficientEvidence(ticket: SpawnTicket, evidence: PlanInsufficientEvidence, at: string): void {
  // These fields are deliberately diagnostic-only. They are not fed back into
  // the plan or used to widen the worker's scope.
  ticket.plan_insufficient_evidence = structuredClone(evidence);
  ticket.semantic_replan_reason = "PLAN_INSUFFICIENT";
  ticket.replan_reason = "PLAN_INSUFFICIENT";
  ticket.successor_reason = "PLAN_INSUFFICIENT";
  ticket.replan_required = true;
  history(ticket, "semantic_replan_required", at, { reason: "PLAN_INSUFFICIENT", evidence: structuredClone(evidence) });
}

export function compiledSafetyVerdict(ticket: SpawnTicket): UnknownRecord | undefined {
  return ticket.safety_verdict;
}

export function acceptCompiledTerminal(
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

export interface ReleaseOptions {
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
