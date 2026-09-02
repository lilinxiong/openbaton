import {
  CompiledApplyLineage,
  DelegationReceipt,
  ExecutionMode,
  assertValidTicketReceiptLineage,
  readReceipt
} from "./receipt.js";
import {
  ApplyRunState,
  ApplyRunTicketFact,
  readApplyRun,
  readApplyRunPlanBody
} from "./apply-run.js";
import { canonicalizeJson } from "./json-utils.js";
import { SpawnTicket } from "./spawn.js";
import {
  DispatchError,
  transition
} from "./dispatch-core.js";
import { normalizeCompiledApplyLineage } from "./receipt-lineage.js";
import {
  listSpawns,
  writeSpawn
} from "./spawn-store.js";
import { HostId } from "./hosts.js";
import { readRouteSnapshot } from "./routes.js";
import {
  ApplyExecutionPlan,
  ApplyPlanUnit
} from "./apply-plan.js";
import { history } from "./dispatch-core.js";
/**
 * Compiled-apply ticket validation for dispatch. Split from dispatch.ts.
 */

export interface CompiledApplyContext {
  lineage: CompiledApplyLineage;
  state: ApplyRunState;
  plan: ApplyExecutionPlan;
  unit: ApplyPlanUnit;
  receipt: DelegationReceipt;
  /** A successor is allowed to continue after a quota-only predecessor. */
  quotaSuccessor?: boolean;
}

export function sortedCompiledStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean).sort();
}

export function sameCompiledStrings(left: unknown, right: unknown): boolean {
  return canonicalizeJson(sortedCompiledStrings(left)) === canonicalizeJson(sortedCompiledStrings(right));
}

export function isCompiledApplyTicket(ticket: SpawnTicket): boolean {
  const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
  return ticket.compiled_apply_lineage !== undefined || unit?.schema_version === 2;
}

export function compiledApplyError(ticket: SpawnTicket, message: string, code = "COMPILED_LINEAGE_MISMATCH"): DispatchError {
  return new DispatchError(`ticket ${ticket.id} compiled apply contract is invalid: ${message}`, code, { ticketId: ticket.id });
}

export function compiledLineageForTicket(ticket: SpawnTicket): CompiledApplyLineage | null {
  if (!isCompiledApplyTicket(ticket)) return null;
  const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
  if (!unit || unit.schema_version !== 2 || ticket.compiled_apply_lineage === undefined) {
    throw compiledApplyError(ticket, "schema-v2 work unit and compiled_apply_lineage are both required");
  }
  try {
    const lineage = normalizeCompiledApplyLineage(ticket.compiled_apply_lineage);
    for (const field of ["run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "mode"] as const) {
      if (canonicalizeJson(lineage[field]) !== canonicalizeJson(unit[field])) {
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

export function compiledTicketFacts(cwd: string, runId: string, env: NodeJS.ProcessEnv): ApplyRunTicketFact[] {
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

export function acceptedApplyRunState(value: unknown): boolean {
  return value === "accepted" || value === "reconciled";
}

export function compiledUnitReady(context: CompiledApplyContext): { ready: boolean; code?: string; message?: string } {
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
export function validateCompiledTicket(
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
    || canonicalizeJson(ticket.selection) !== canonicalizeJson(receipt.selection)
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
    || canonicalizeJson(receipt.scope.allowed_operations) !== canonicalizeJson(["read"])) {
    throw compiledApplyError(ticket, "verification-only Receipt carries write authority", "COMPILED_SCOPE_MISMATCH");
  }
  return { lineage, state, plan, unit, receipt, quotaSuccessor };
}

export function rejectCompiledTicketValidation(cwd: string, ticket: SpawnTicket, error: unknown, at: string, env: NodeJS.ProcessEnv): never {
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
