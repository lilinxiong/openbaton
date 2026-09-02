/** Parent-owned acceptance and OpenSpec reconciliation for compiled applies. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readApplyRun,
  readApplyRunPlanBody,
  normalizeApplyRunState,
  type ApplyRunItemState,
  type ApplyRunState,
} from "./run.js";
import type { ApplyExecutionPlan, ApplyPlanParentGate, ApplyPlanTaskMapping } from "../apply-plan.js";
import {
  OpenSpecError,
  parseTasks,
  readTaskLedgerIdentity,
  writeTaskConclusions,
  type OpenSpecTask,
} from "../openspec.js";
import { readReceipt, type DelegationReceipt, type CompiledApplyLineage } from "../receipt.js";
import { listSpawns, type SpawnTicket } from "../spawn.js";
import { applyRunStateLockPath, compiledApplyRunStatePath } from "../paths.js";
import { writeJsonAtomic } from "../json-utils.js";
import { wildcardStaticPrefix } from "../wildcard.js";

export type ApplyReconcileErrorCode =
  | "RUN_STATE_LOCK_BUSY" | "RUN_STATE_INVALID" | "RUN_NOT_FOUND"
  | "UNIT_NOT_FOUND" | "GATE_NOT_FOUND" | "UNIT_NOT_ACCEPTED"
  | "UNIT_LINEAGE_MISMATCH" | "UNIT_TERMINAL_REQUIRED" | "SAFETY_NOT_ACCEPTED"
  | "PLAN_INSUFFICIENT" | "GATE_DEPENDENCY_BLOCKED" | "GATE_IDENTITY_MISMATCH"
  | "TASK_LEDGER_MISSING" | "TASK_LEDGER_CHANGED" | "TASK_NOT_PENDING"
  | "TASK_ID_AMBIGUOUS" | "TASK_ID_NOT_FOUND" | "TASK_COVERAGE_INCOMPLETE"
  | "TASK_COVERAGE_AMBIGUOUS" | "TASK_WRITEBACK_FAILED";

export class ApplyReconcileError extends Error {
  readonly code: ApplyReconcileErrorCode | string;
  constructor(message: string, code: ApplyReconcileErrorCode | string) { super(message); this.name = "ApplyReconcileError"; this.code = code; }
}

export interface ApplyUnitAcceptanceInput {
  cwd: string; runId: string; unitId: string; host?: string; env?: NodeJS.ProcessEnv;
  ticketId?: string; receiptId?: string; revision?: string; fingerprint?: string;
  taskRefs?: readonly string[]; mode?: "patch-only" | "verification-only";
  terminalStatus?: string; safetyVerdict?: unknown; result?: string;
  ticket?: Partial<SpawnTicket>; receipt?: DelegationReceipt;
}

export interface ApplyAcceptanceResult {
  accepted: boolean; id: string; kind: "unit" | "gate"; run_id: string;
  revision: string; fingerprint: string; ticket_id?: string; receipt_id?: string;
  evidence: string; code?: string;
}

export interface ApplyGateAcceptanceInput {
  cwd: string; runId: string; gateId: string; host?: string; env?: NodeJS.ProcessEnv;
  revision?: string; fingerprint?: string; evidence: string;
}

export interface ApplyTaskEligibility {
  task_id: string; eligible: boolean; required_unit_ids: string[]; required_gate_ids: string[];
  accepted_unit_ids: string[]; accepted_gate_ids: string[]; reasons: string[];
}

export interface ApplyReconcileInput {
  cwd: string; runId: string; host?: string; env?: NodeJS.ProcessEnv;
  tasksPath?: string; task?: string; taskNumber?: string;
  expectedLedgerIdentity?: string; expectedLedgerSha256?: string;
  conclusions?: ReadonlyMap<string, string> | Record<string, string>;
  evidence?: string;
}

export interface ApplyReconcileResult {
  run_id: string; reconciled: boolean; task_ids: string[];
  eligibility: ApplyTaskEligibility[]; ledger: ReturnType<typeof readTaskLedgerIdentity>;
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function stable(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item); }
function sanitizeEvidence(value: unknown, limit = 240): string {
  return text(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}
function itemAccepted(item: ApplyRunItemState | undefined): boolean { return item?.status === "accepted" || item?.status === "reconciled"; }
function itemFailed(item: ApplyRunItemState | undefined): boolean { return item?.status === "failed" || item?.status === "blocked" || item?.status === "terminal-unreleased"; }
function stateFile(cwd: string, runId: string, env?: NodeJS.ProcessEnv): string { return compiledApplyRunStatePath(cwd, runId, env); }
function atomicJson(file: string, value: unknown): void { writeJsonAtomic(file, value); }
function withLock<T>(file: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const start = Date.now();
  while (true) {
    try { const fd = fs.openSync(file, "wx", 0o600); try { return fn(); } finally { try { fs.closeSync(fd); } catch { /* noop */ } try { fs.unlinkSync(file); } catch { /* noop */ } } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (Date.now() - start > 5000) throw new ApplyReconcileError("run or ledger lock is busy", "RUN_STATE_LOCK_BUSY"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
}
function readState(cwd: string, runId: string, env?: NodeJS.ProcessEnv): ApplyRunState {
  try { return readApplyRun(cwd, runId, { env }); } catch (error) { if (error instanceof Error && "code" in error) throw error; throw new ApplyReconcileError(`cannot read apply run ${runId}`, "RUN_NOT_FOUND"); }
}
function current(cwd: string, runId: string, env?: NodeJS.ProcessEnv): { state: ApplyRunState; plan: ApplyExecutionPlan } {
  const state = readState(cwd, runId, env);
  return { state, plan: readApplyRunPlanBody(cwd, runId, state.current_revision, env) };
}
function expectedLineage(input: ApplyUnitAcceptanceInput, state: ApplyRunState, plan: ApplyExecutionPlan, unitId: string): CompiledApplyLineage {
  const unit = plan.units.find((item) => item.id === unitId);
  if (!unit) throw new ApplyReconcileError(`unknown unit ${unitId}`, "UNIT_NOT_FOUND");
  const taskRefs = [...unit.task_ids].sort();
  return { run_id: state.run_id, plan_revision: state.current_revision, plan_fingerprint: state.current_fingerprint, unit_id: unitId, task_refs: taskRefs, mode: unit.mode };
}
function sameLineage(actual: unknown, expected: CompiledApplyLineage): boolean { return stable(actual) === stable(expected); }
function safetyAccepted(value: unknown): boolean { return record(value) && value.accepted === true && Array.isArray(value.violations) && value.violations.length === 0; }
function verificationOnlyReadOnly(ticket: Partial<SpawnTicket>, receipt: DelegationReceipt): boolean {
  return ticket.mode === "read-only"
    && ticket.read_only === true
    && receipt.execution?.mode === "read-only"
    && receipt.baseline === null
    && receipt.commit_baseline === null
    && Array.isArray(receipt.scope?.write_allowlist)
    && receipt.scope.write_allowlist.length === 0
    && Array.isArray(receipt.scope?.allowed_operations)
    && receipt.scope.allowed_operations.length === 1
    && receipt.scope.allowed_operations[0] === "read";
}
function terminalSuccess(ticket: Partial<SpawnTicket> | undefined, input: ApplyUnitAcceptanceInput): boolean {
  return (ticket?.status === "completed" || input.terminalStatus === "completed") && !String(ticket?.error?.code || "").trim();
}
function ownsTaskLedger(cwd: string, value: string, ledger: string): boolean {
  const normalizedLedger = path.resolve(cwd, ledger).replaceAll("\\", "/").toLowerCase();
  return value.split(/\s*->\s*/u).some((part) => {
    const declared = part.replaceAll("\\", "/").toLowerCase();
    const normalized = path.resolve(cwd, part).replaceAll("\\", "/").toLowerCase();
    const scope = wildcardStaticPrefix(normalized);
    return normalized === normalizedLedger
      || Boolean(scope && normalizedLedger.startsWith(`${scope}/`))
      || declared === "tasks.md"
      || declared.endsWith("/tasks.md")
      || declared.includes("/openspec/changes/");
  });
}
function taskLedgerPath(state: ApplyRunState, supplied: string | undefined, cwd: string, plan: ApplyExecutionPlan): string {
  if (supplied) return path.resolve(cwd, supplied);
  const snapshot = plan.source_snapshot as ApplyExecutionPlan["source_snapshot"] & Record<string, unknown>;
  const declared = typeof snapshot.tasks_path === "string" && snapshot.tasks_path.trim()
    ? snapshot.tasks_path
    : path.join("openspec", "changes", state.change, "tasks.md");
  return path.resolve(cwd, declared);
}

function acceptedLedgerSha256(plan: ApplyExecutionPlan): string | undefined {
  // `source_snapshot.fingerprint` is the aggregate compiled-source
  // fingerprint and must never be compared with the raw tasks.md digest.
  // Ledger hashes are accepted only through an explicitly named field in a
  // richer, forward-compatible snapshot shape.
  const snapshot = plan.source_snapshot as ApplyExecutionPlan["source_snapshot"] & Record<string, unknown>;
  const nested = snapshot.task_ledger;
  const candidates = [
    snapshot.task_ledger_sha256,
    snapshot.taskLedgerSha256,
    snapshot.ledger_sha256,
    snapshot.ledgerSha256,
    record(nested) ? nested.sha256 : undefined,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}
function mappings(plan: ApplyExecutionPlan): Map<string, { units: string[]; gates: string[] }> {
  const result = new Map<string, { units: string[]; gates: string[] }>();
  if (plan.task_mappings) {
    for (const mapping of plan.task_mappings as ApplyPlanTaskMapping[]) {
      if (result.has(mapping.task_id)) throw new ApplyReconcileError(`task mapping is ambiguous: ${mapping.task_id}`, "TASK_COVERAGE_AMBIGUOUS");
      result.set(mapping.task_id, { units: [...mapping.unit_ids].sort(), gates: [...(mapping.gate_ids || [])].sort() });
    }
  } else {
    for (const unit of plan.units) for (const task of unit.task_ids) (result.get(task) || (result.set(task, { units: [], gates: [] }), result.get(task)!)).units.push(unit.id);
    for (const gate of plan.parent_gates || []) for (const task of gate.task_ids || []) (result.get(task) || (result.set(task, { units: [], gates: [] }), result.get(task)!)).gates.push(gate.id);
    for (const value of result.values()) { value.units = [...new Set(value.units)].sort(); value.gates = [...new Set(value.gates)].sort(); }
  }
  return result;
}
function taskEligibility(state: ApplyRunState, plan: ApplyExecutionPlan, tasks: OpenSpecTask[], only?: string): ApplyTaskEligibility[] {
  const byNumber = new Map<string, OpenSpecTask>();
  for (const task of tasks) { if (!task.number) continue; if (byNumber.has(task.number)) throw new ApplyReconcileError(`task number is ambiguous: ${task.number}`, "TASK_ID_AMBIGUOUS"); byNumber.set(task.number, task); }
  const map = mappings(plan); const selected = only ? [only] : [...state.selected_tasks];
  return selected.map((taskId) => {
    const source = byNumber.get(taskId); const mapping = map.get(taskId); const reasons: string[] = [];
    if (!source) reasons.push("TASK_ID_NOT_FOUND"); else if (source.status !== "pending") reasons.push("TASK_NOT_PENDING");
    if (!mapping || (mapping.units.length === 0 && mapping.gates.length === 0)) reasons.push("TASK_COVERAGE_INCOMPLETE");
    const acceptedUnits = (mapping?.units || []).filter((id) => itemAccepted(state.unit_state[id]));
    const acceptedGates = (mapping?.gates || []).filter((id) => itemAccepted(state.gate_state[id]));
    if ((mapping?.units || []).some((id) => itemFailed(state.unit_state[id]))) reasons.push("UNIT_FAILED_OR_BLOCKED");
    if ((mapping?.gates || []).some((id) => itemFailed(state.gate_state[id]))) reasons.push("GATE_FAILED_OR_BLOCKED");
    if (acceptedUnits.length !== (mapping?.units || []).length) reasons.push("UNIT_NOT_ACCEPTED");
    if (acceptedGates.length !== (mapping?.gates || []).length) reasons.push("GATE_NOT_ACCEPTED");
    return { task_id: taskId, eligible: reasons.length === 0, required_unit_ids: [...(mapping?.units || [])], required_gate_ids: [...(mapping?.gates || [])], accepted_unit_ids: acceptedUnits, accepted_gate_ids: acceptedGates, reasons: [...new Set(reasons)] };
  });
}

/** Record a terminal unit only when its exact ticket/Receipt lineage and safety verdict agree. */
export function acceptApplyUnit(input: ApplyUnitAcceptanceInput): ApplyAcceptanceResult {
  const env = input.env || process.env;
  return withLock(applyRunStateLockPath(input.cwd, env), () => {
    const { state, plan } = current(input.cwd, input.runId, env); const expected = expectedLineage(input, state, plan, input.unitId);
    if ((input.revision !== undefined && input.revision !== expected.plan_revision)
      || (input.fingerprint !== undefined && input.fingerprint !== expected.plan_fingerprint)
      || (input.taskRefs !== undefined && stable([...input.taskRefs].slice().sort()) !== stable(expected.task_refs))
      || (input.mode !== undefined && input.mode !== expected.mode)) {
      throw new ApplyReconcileError("unit acceptance identity does not match current run revision", "UNIT_LINEAGE_MISMATCH");
    }
    const unitState = state.unit_state[input.unitId]; if (!unitState) throw new ApplyReconcileError(`unknown unit ${input.unitId}`, "UNIT_NOT_FOUND");
    const ticket = input.ticket || (input.ticketId ? listSpawns(input.cwd, env).find((item) => item.id === input.ticketId) : undefined);
    const ticketId = input.ticketId || ticket?.id || unitState.frozen_execution_facts?.ticket_id;
    const receiptId = input.receiptId || ticket?.receipt_id || unitState.frozen_execution_facts?.receipt_id;
    const receipt = input.receipt || (receiptId ? readReceipt(input.cwd, receiptId, env) : undefined);
    if (!ticketId || !receiptId || !ticket || !receipt) throw new ApplyReconcileError("compiled unit requires ticket and Receipt evidence", "UNIT_LINEAGE_MISMATCH");
    const ledger = taskLedgerPath(state, undefined, input.cwd, plan);
    const unit = plan.units.find((item) => item.id === input.unitId)!;
    if ((unit.write_paths || []).some((item) => ownsTaskLedger(input.cwd, item, ledger))
      || (receipt.scope?.write_allowlist || []).some((item) => ownsTaskLedger(input.cwd, item, ledger))) {
      throw new ApplyReconcileError("compiled worker may not own the OpenSpec task ledger", "SAFETY_NOT_ACCEPTED");
    }
    const actualLineage = ticket.compiled_apply_lineage; const receiptLineage = receipt?.compiled_apply_lineage;
    if (ticket.id !== ticketId || ticket.receipt_id !== receiptId
      || !sameLineage(actualLineage, expected) || !sameLineage(receiptLineage, expected)
      || receipt.ticket_id !== ticketId || receipt.receipt_id !== receiptId) {
      throw new ApplyReconcileError("unit ticket/Receipt lineage does not match current run revision", "UNIT_LINEAGE_MISMATCH");
    }
    const resultText = input.result || text(ticket.conclusion) || "terminal success";
    const insufficient = /PLAN_INSUFFICIENT/i.test(resultText) || /PLAN_INSUFFICIENT/i.test(text(ticket.error?.code));
    if (insufficient || !terminalSuccess(ticket, input)) {
      unitState.status = "blocked"; atomicJson(stateFile(input.cwd, input.runId, env), state);
      return { accepted: false, id: input.unitId, kind: "unit", run_id: state.run_id, revision: state.current_revision, fingerprint: state.current_fingerprint, ticket_id: ticketId, receipt_id: receiptId, evidence: sanitizeEvidence(resultText), code: insufficient ? "PLAN_INSUFFICIENT" : "UNIT_TERMINAL_REQUIRED" };
    }
    if (expected.mode === "verification-only") {
      if (!verificationOnlyReadOnly(ticket, receipt)) {
        unitState.status = "blocked"; atomicJson(stateFile(input.cwd, input.runId, env), state);
        return { accepted: false, id: input.unitId, kind: "unit", run_id: state.run_id, revision: state.current_revision, fingerprint: state.current_fingerprint, ticket_id: ticketId, receipt_id: receiptId, evidence: sanitizeEvidence(resultText), code: "SAFETY_NOT_ACCEPTED" };
      }
    } else {
      const verdict = input.safetyVerdict ?? ticket.safety_verdict;
      if (!safetyAccepted(verdict)) {
        unitState.status = "blocked"; atomicJson(stateFile(input.cwd, input.runId, env), state);
        return { accepted: false, id: input.unitId, kind: "unit", run_id: state.run_id, revision: state.current_revision, fingerprint: state.current_fingerprint, ticket_id: ticketId, receipt_id: receiptId, evidence: sanitizeEvidence(resultText), code: "SAFETY_NOT_ACCEPTED" };
      }
    }
    if (unitState.status === "accepted" || unitState.status === "reconciled") return { accepted: true, id: input.unitId, kind: "unit", run_id: state.run_id, revision: state.current_revision, fingerprint: state.current_fingerprint, ticket_id: ticketId, receipt_id: receiptId, evidence: sanitizeEvidence(resultText) };
    unitState.status = "accepted"; unitState.ticket_ids = [...new Set([...unitState.ticket_ids, ticketId])].sort(); unitState.frozen_execution_facts = { ticket_id: ticketId, receipt_id: receiptId, ...(ticket.model_id ? { model_id: ticket.model_id } : {}), ...(resultText ? { result: resultText } : {}) };
    atomicJson(stateFile(input.cwd, input.runId, env), state);
    return { accepted: true, id: input.unitId, kind: "unit", run_id: state.run_id, revision: state.current_revision, fingerprint: state.current_fingerprint, ticket_id: ticketId, receipt_id: receiptId, evidence: sanitizeEvidence(resultText) };
  });
}

/** Accept a parent-owned gate after checking stable identity and dependencies. */
export function acceptApplyGate(input: ApplyGateAcceptanceInput): ApplyAcceptanceResult {
  const env = input.env || process.env;
  return withLock(applyRunStateLockPath(input.cwd, env), () => {
    const { state, plan } = current(input.cwd, input.runId, env); const gate = (plan.parent_gates || []).find((item) => item.id === input.gateId);
    if (!gate) throw new ApplyReconcileError(`unknown gate ${input.gateId}`, "GATE_NOT_FOUND");
    if (input.revision && input.revision !== state.current_revision || input.fingerprint && input.fingerprint !== state.current_fingerprint) throw new ApplyReconcileError("gate identity does not match current run revision", "GATE_IDENTITY_MISMATCH");
    const required = [...(gate.unit_ids || []), ...(gate.depends_on || [])];
    if (required.some((id) => !itemAccepted(state.unit_state[id]) && !itemAccepted(state.gate_state[id]))) throw new ApplyReconcileError("gate dependencies are not accepted", "GATE_DEPENDENCY_BLOCKED");
    const evidence = sanitizeEvidence(input.evidence); if (!evidence) throw new ApplyReconcileError("gate evidence is empty", "GATE_IDENTITY_MISMATCH");
    const item = state.gate_state[input.gateId]; if (!item) throw new ApplyReconcileError(`unknown gate ${input.gateId}`, "GATE_NOT_FOUND");
    if (item.status === "accepted" || item.status === "reconciled") return { accepted: true, id: input.gateId, kind: "gate", run_id: state.run_id, revision: state.current_revision, fingerprint: state.current_fingerprint, evidence };
    item.status = "accepted"; item.frozen_plan_facts = stable({ run_id: state.run_id, revision: state.current_revision, fingerprint: state.current_fingerprint, gate_id: input.gateId, evidence }); item.frozen_execution_facts = { ticket_id: `gate:${input.gateId}`, result: evidence };
    atomicJson(stateFile(input.cwd, input.runId, env), state);
    return { accepted: true, id: input.gateId, kind: "gate", run_id: state.run_id, revision: state.current_revision, fingerprint: state.current_fingerprint, evidence };
  });
}

export function deriveApplyTaskEligibility(input: { cwd: string; runId: string; env?: NodeJS.ProcessEnv; tasksPath?: string; task?: string; taskNumber?: string }): ApplyTaskEligibility[] {
  const env = input.env || process.env; const { state, plan } = current(input.cwd, input.runId, env); const file = taskLedgerPath(state, input.tasksPath, input.cwd, plan);
  if (!fs.existsSync(file)) throw new ApplyReconcileError(`task ledger not found: ${file}`, "TASK_LEDGER_MISSING");
  const parsed = parseTasks(fs.readFileSync(file, "utf8")); return taskEligibility(state, plan, parsed, input.task || input.taskNumber);
}

/** Reconcile all eligible tasks (or one stable task number) under one ledger lock. */
export function reconcileApplyRun(input: ApplyReconcileInput): ApplyReconcileResult {
  const env = input.env || process.env;
  return withLock(applyRunStateLockPath(input.cwd, env), () => {
    const { state, plan } = current(input.cwd, input.runId, env); const file = taskLedgerPath(state, input.tasksPath, input.cwd, plan);
    if (!fs.existsSync(file)) throw new ApplyReconcileError(`task ledger not found: ${file}`, "TASK_LEDGER_MISSING");
    const ledgerLock = `${file}.baton.lock`;
    return withLock(ledgerLock, () => {
      const before = readTaskLedgerIdentity(file);
      if (input.expectedLedgerIdentity && input.expectedLedgerIdentity !== before.identity || input.expectedLedgerSha256 && input.expectedLedgerSha256 !== before.sha256) throw new ApplyReconcileError("task ledger changed during reconciliation", "TASK_LEDGER_CHANGED");
      const snapshotLedgerSha256 = acceptedLedgerSha256(plan);
      if (snapshotLedgerSha256 && snapshotLedgerSha256 !== before.sha256) {
        throw new ApplyReconcileError("task ledger no longer matches the compiled source snapshot", "TASK_LEDGER_CHANGED");
      }
      const parsed = parseTasks(fs.readFileSync(file, "utf8")); const target = input.task || input.taskNumber;
      const eligibility = taskEligibility(state, plan, parsed, target); const eligible = eligibility.filter((item) => item.eligible);
      if (target && !eligibility.some((item) => item.task_id === target)) throw new ApplyReconcileError(`task number not found: ${target}`, "TASK_ID_NOT_FOUND");
      const already = eligibility.filter((item) => !item.eligible
        && (state.reconciled || itemAccepted(state.task_state[item.task_id]))
        && parsed.find((task) => task.number === item.task_id)?.status === "done").map((item) => item.task_id);
      const selected = eligible.map((item) => item.task_id); if (!selected.length) return { run_id: state.run_id, reconciled: already.length > 0, task_ids: already, eligibility, ledger: before };
      const provided = input.conclusions instanceof Map ? input.conclusions : new Map(Object.entries(input.conclusions || {}));
      const conclusions = new Map<string, string>(); for (const id of selected) conclusions.set(id, sanitizeEvidence(provided.get(id) || input.evidence || `accepted run ${state.run_id} revision ${state.current_revision}`));
      const currentBeforeWrite = readTaskLedgerIdentity(file);
      if (currentBeforeWrite.sha256 !== before.sha256) throw new ApplyReconcileError("task ledger changed during reconciliation", "TASK_LEDGER_CHANGED");
      const source = fs.readFileSync(file, "utf8"); const updated = writeTaskConclusions(source, conclusions); const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try { fs.writeFileSync(temp, updated, { encoding: "utf8", mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); } finally { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ } }
      for (const id of selected) { const item = state.task_state[id] || { status: "undispatched", ticket_ids: [], frozen_plan_facts: null, frozen_execution_facts: null, superseded: false }; item.status = "reconciled"; item.frozen_execution_facts = { ticket_id: `task:${id}`, result: conclusions.get(id)! }; state.task_state[id] = item; }
      state.reconciled = state.selected_tasks.every((id) => state.task_state[id]?.status === "reconciled"); atomicJson(stateFile(input.cwd, input.runId, env), normalizeApplyRunState(state));
      return { run_id: state.run_id, reconciled: true, task_ids: selected, eligibility, ledger: readTaskLedgerIdentity(file) };
    });
  });
}
