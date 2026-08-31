import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { receiptsDir } from "./paths.js";
import type { ModelCard, ModelSelectionApproval } from "../types.js";
import { validateIndexControlBaselineMetadata, type CommitBaseline, type GitBaseline, type SafetyOperation } from "./safety.js";

export type ReceiptOperation = "read" | "commit" | SafetyOperation;
export type ExecutionMode = "read-only" | "write" | "commit-only";
export type CompiledApplyMode = "patch-only" | "verification-only";

/** Immutable identity carried from a compiled apply unit into its artifacts. */
export interface CompiledApplyLineage {
  run_id: string;
  plan_revision: string;
  plan_fingerprint: string;
  unit_id: string;
  task_refs: readonly string[];
  mode: CompiledApplyMode;
}

export type CompiledApplyLineageInput = {
  run_id?: unknown;
  plan_revision?: unknown;
  plan_fingerprint?: unknown;
  unit_id?: unknown;
  task_refs?: unknown;
  mode?: unknown;
};

function freezeLineage<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeLineage(child);
    Object.freeze(value);
  }
  return value;
}

/** Purely normalize and validate the six-field compiled-apply identity. */
export function normalizeCompiledApplyLineage(value: unknown): CompiledApplyLineage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReceiptError("compiled apply lineage must be an object", "COMPILED_LINEAGE_MALFORMED");
  }
  const input = value as CompiledApplyLineageInput;
  const keys = Object.keys(input as object);
  const allowed = ["run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "mode"];
  if (keys.some((key) => !allowed.includes(key))) {
    throw new ReceiptError("compiled apply lineage contains an unknown field", "COMPILED_LINEAGE_UNKNOWN_FIELD");
  }
  const required = (name: string): string => {
    const raw = input[name as keyof CompiledApplyLineageInput];
    if (typeof raw !== "string" || !raw.trim()) {
      throw new ReceiptError(`compiled apply lineage ${name} is required`, "COMPILED_LINEAGE_PARTIAL");
    }
    return raw.trim();
  };
  for (const field of ["run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "mode"] as const) {
    if (!(field in input)) throw new ReceiptError(`compiled apply lineage ${field} is required`, "COMPILED_LINEAGE_PARTIAL");
  }
  if (!Array.isArray(input.task_refs) || input.task_refs.length === 0
    || input.task_refs.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ReceiptError("compiled apply lineage task_refs is invalid", "COMPILED_LINEAGE_PARTIAL");
  }
  const taskRefs = input.task_refs.map((item) => (item as string).trim());
  if (new Set(taskRefs).size !== taskRefs.length) {
    throw new ReceiptError("compiled apply lineage task_refs contains duplicates", "COMPILED_LINEAGE_DUPLICATE_TASK");
  }
  if (input.mode !== "patch-only" && input.mode !== "verification-only") {
    throw new ReceiptError("compiled apply lineage mode is invalid", "COMPILED_LINEAGE_UNKNOWN_MODE");
  }
  return freezeLineage({
    run_id: required("run_id"),
    plan_revision: required("plan_revision"),
    plan_fingerprint: required("plan_fingerprint"),
    unit_id: required("unit_id"),
    task_refs: taskRefs,
    mode: input.mode,
  });
}

export function validateCompiledApplyLineage(value: unknown): string | null {
  try { normalizeCompiledApplyLineage(value); return null; } catch (error) {
    return error instanceof ReceiptError ? error.code : "COMPILED_LINEAGE_MALFORMED";
  }
}

export const assertValidCompiledApplyLineage = normalizeCompiledApplyLineage;

export interface DelegationReceipt {
  schema_version: 4;
  /** Host profile that owns this receipt; local-only receipts may omit it. */
  host?: string;
  receipt_id: string;
  ticket_id: string;
  issued_at: string;
  route: {
    card_id: string;
    route_id: string | null;
    reasoning_effort: string | null;
    service_tier: string | null;
    provider: string | null;
  };
  execution: {
    mode: ExecutionMode;
    fork_context: false;
    max_depth: 1;
  };
  scope: {
    write_allowlist: string[];
    allowed_operations: ReceiptOperation[];
    side_effects: string[];
  };
  retry: {
    max_attempts: number;
  };
  git_policy: {
    worker_may_stage: false;
    worker_may_commit: boolean;
    worker_may_branch: false;
    worker_may_rebase: false;
    staging_owner: "parent";
  };
  baseline: GitBaseline | null;
  commit_baseline: CommitBaseline | null;
  selection: ModelSelectionApproval | null;
  /** Omitted on legacy/manual receipts; never synthesized while reading them. */
  compiled_apply_lineage?: CompiledApplyLineage;
}

export class ReceiptError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ReceiptError";
    this.code = code;
  }
}

export function buildReadOnlyReceipt({
  ticketId,
  card,
  issuedAt = new Date(),
  maxAttempts = 1,
  selection = null,
  host = selection?.host || null,
  compiledApplyLineage,
  compiled_apply_lineage,
  compiledLineage,
  compiled_lineage,
}: {
  ticketId: string;
  card: ModelCard;
  issuedAt?: Date | string | number;
  maxAttempts?: number;
  selection?: ModelSelectionApproval | null;
  host?: string | null;
  compiledApplyLineage?: unknown;
  compiled_apply_lineage?: unknown;
  compiledLineage?: unknown;
  compiled_lineage?: unknown;
}): DelegationReceipt {
  const lineageInput = compiledApplyLineage ?? compiled_apply_lineage ?? compiledLineage ?? compiled_lineage;
  const lineage = lineageInput === undefined || lineageInput === null
    ? undefined
    : normalizeCompiledApplyLineage(lineageInput);
  const timestamp = (issuedAt instanceof Date ? issuedAt : new Date(issuedAt)).toISOString();
  const attempts = Math.max(1, Math.floor(maxAttempts));
  return {
    schema_version: 4,
    ...(host ? { host } : {}),
    receipt_id: `rcpt-${ticketId}-a1`,
    ticket_id: ticketId,
    issued_at: timestamp,
    route: {
      card_id: card.id,
      route_id: card.route_id || null,
      reasoning_effort: card.reasoning_effort || null,
      service_tier: selection?.service_tier || null,
      provider: card.provider || null,
    },
    execution: { mode: "read-only", fork_context: false, max_depth: 1 },
    scope: { write_allowlist: [], allowed_operations: ["read"], side_effects: [] },
    retry: { max_attempts: attempts },
    git_policy: {
      worker_may_stage: false,
      worker_may_commit: false,
      worker_may_branch: false,
      worker_may_rebase: false,
      staging_owner: "parent",
    },
    baseline: null,
    commit_baseline: null,
    selection: selection ? structuredClone(selection) : null,
    ...(lineage ? { compiled_apply_lineage: lineage } : {}),
  };
}

export function buildWriteReceipt({
  base,
  baseline,
  writeAllowlist,
  allowedOperations,
  compiledApplyLineage,
  compiled_apply_lineage,
  compiledLineage,
  compiled_lineage,
}: {
  base: DelegationReceipt;
  baseline: GitBaseline;
  writeAllowlist: string[];
  allowedOperations: SafetyOperation[];
  compiledApplyLineage?: unknown;
  compiled_apply_lineage?: unknown;
  compiledLineage?: unknown;
  compiled_lineage?: unknown;
}): DelegationReceipt {
  if (!writeAllowlist.length) throw new ReceiptError("write Receipt requires a non-empty allowlist", "WRITE_ALLOWLIST_REQUIRED");
  if (!allowedOperations.length) throw new ReceiptError("write Receipt requires allowed operations", "WRITE_OPERATIONS_REQUIRED");
  const baselineError = validateIndexControlBaselineMetadata(baseline);
  if (baselineError) throw new ReceiptError("write baseline index-control metadata is invalid", baselineError);
  const suppliedLineage = compiledApplyLineage ?? compiled_apply_lineage ?? compiledLineage ?? compiled_lineage;
  const lineage = suppliedLineage === undefined
    ? base.compiled_apply_lineage
    : normalizeCompiledApplyLineage(suppliedLineage);
  if (lineage && lineage.mode !== "patch-only") {
    throw new ReceiptError("verification-only lineage cannot authorize writes", "COMPILED_LINEAGE_EXECUTION_MODE_MISMATCH");
  }
  return {
    ...structuredClone(base),
    execution: { ...base.execution, mode: "write" },
    scope: {
      write_allowlist: [...writeAllowlist],
      allowed_operations: [...allowedOperations],
      side_effects: ["filesystem-write"],
    },
    baseline,
    commit_baseline: null,
    ...(lineage ? { compiled_apply_lineage: lineage } : {}),
  };
}

export function buildCommitReceipt({
  base,
  baseline,
  compiledApplyLineage,
  compiled_apply_lineage,
  compiledLineage,
  compiled_lineage,
}: {
  base: DelegationReceipt;
  baseline: CommitBaseline;
  compiledApplyLineage?: unknown;
  compiled_apply_lineage?: unknown;
  compiledLineage?: unknown;
  compiled_lineage?: unknown;
}): DelegationReceipt {
  const baselineError = validateIndexControlBaselineMetadata({
    index_control_algorithm: baseline.staged_index_control_algorithm,
    index_control_checksum: baseline.staged_index_control_checksum,
    index_control_entry_count: baseline.staged_index_control_entry_count,
  }, "staged_index_control");
  if (baselineError) throw new ReceiptError("commit baseline index-control metadata is invalid", baselineError);
  if (!baseline.staged_paths.length) {
    throw new ReceiptError("commit-only Receipt requires staged paths", "STAGED_DIFF_REQUIRED");
  }
  const suppliedLineage = compiledApplyLineage ?? compiled_apply_lineage ?? compiledLineage ?? compiled_lineage;
  const lineage = suppliedLineage === undefined
    ? base.compiled_apply_lineage
    : normalizeCompiledApplyLineage(suppliedLineage);
  if (lineage) {
    throw new ReceiptError("compiled apply lineage cannot authorize commit-only execution", "COMPILED_LINEAGE_EXECUTION_MODE_MISMATCH");
  }
  return {
    ...structuredClone(base),
    execution: { ...base.execution, mode: "commit-only" },
    scope: {
      write_allowlist: [...baseline.staged_paths],
      allowed_operations: ["commit"],
      side_effects: ["git-commit"],
    },
    git_policy: {
      worker_may_stage: false,
      worker_may_commit: true,
      worker_may_branch: false,
      worker_may_rebase: false,
      staging_owner: "parent",
    },
    baseline: null,
    commit_baseline: structuredClone(baseline),
  };
}

function receiptPath(cwd: string, receiptId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(receiptsDir(cwd, env), `${receiptId}.json`);
}

function validateReceiptBaselines(receipt: DelegationReceipt): void {
  if (!receipt || typeof receipt !== "object" || receipt.schema_version !== 4
    || typeof receipt.receipt_id !== "string" || typeof receipt.ticket_id !== "string"
    || typeof receipt.issued_at !== "string" || !receipt.route || !receipt.execution
    || !receipt.route || !receipt.execution || !receipt.scope || !receipt.retry || !receipt.git_policy
    || !Array.isArray(receipt.scope.write_allowlist)
    || !Array.isArray(receipt.scope.allowed_operations)
    || !Array.isArray(receipt.scope.side_effects)
    || !Number.isSafeInteger(receipt.retry.max_attempts) || receipt.retry.max_attempts < 1
    || Object.keys(receipt.retry).length !== 1) {
    throw new ReceiptError("Receipt schema is invalid", "RECEIPT_SCHEMA_INVALID");
  }
  if (receipt.host !== undefined && (typeof receipt.host !== "string" || !receipt.host.trim())) {
    throw new ReceiptError("Receipt host is invalid", "RECEIPT_SCHEMA_INVALID");
  }
  if (typeof receipt.route.card_id !== "string" || !receipt.route.card_id.trim()
    || (receipt.route.route_id !== null && (typeof receipt.route.route_id !== "string" || !receipt.route.route_id.trim()))
    || (receipt.route.reasoning_effort !== null && (typeof receipt.route.reasoning_effort !== "string" || !receipt.route.reasoning_effort.trim()))
    || (receipt.route.service_tier !== null && (typeof receipt.route.service_tier !== "string" || !receipt.route.service_tier.trim()))
    || (receipt.route.provider !== null && (typeof receipt.route.provider !== "string" || !receipt.route.provider.trim()))) {
    throw new ReceiptError("Receipt route is invalid", "RECEIPT_SCHEMA_INVALID");
  }
  if (receipt.execution.fork_context !== false || receipt.execution.max_depth !== 1
    || !["read-only", "write", "commit-only"].includes(receipt.execution.mode)) {
    throw new ReceiptError("Receipt execution is invalid", "RECEIPT_SCHEMA_INVALID");
  }
  const lineage = receipt.compiled_apply_lineage;
  if (lineage !== undefined) {
    const normalized = normalizeCompiledApplyLineage(lineage);
    if (JSON.stringify(normalized) !== JSON.stringify(lineage)) {
      throw new ReceiptError("Receipt compiled apply lineage is not normalized", "COMPILED_LINEAGE_MALFORMED");
    }
    if (lineage.mode === "verification-only" && receipt.execution.mode !== "read-only") {
      throw new ReceiptError("verification-only lineage requires read-only execution", "COMPILED_LINEAGE_EXECUTION_MODE_MISMATCH");
    }
    if (lineage.mode === "patch-only" && receipt.execution.mode !== "write") {
      throw new ReceiptError("patch-only lineage requires write execution", "COMPILED_LINEAGE_EXECUTION_MODE_MISMATCH");
    }
  }
  const baselineError = receipt.baseline
    ? validateIndexControlBaselineMetadata(receipt.baseline)
    : receipt.commit_baseline
      ? validateIndexControlBaselineMetadata({
        index_control_algorithm: receipt.commit_baseline.staged_index_control_algorithm,
        index_control_checksum: receipt.commit_baseline.staged_index_control_checksum,
        index_control_entry_count: receipt.commit_baseline.staged_index_control_entry_count,
      }, "staged_index_control")
      : null;
  if (baselineError) throw new ReceiptError("Receipt index-control metadata is invalid", baselineError);
  if (receipt.execution.mode === "read-only" && (receipt.baseline !== null || receipt.commit_baseline !== null)) {
    throw new ReceiptError("read-only Receipt must not carry a baseline", "RECEIPT_SCHEMA_INVALID");
  }
  if (receipt.execution.mode === "read-only" && (receipt.scope.write_allowlist.length
    || receipt.scope.allowed_operations.length !== 1 || receipt.scope.allowed_operations[0] !== "read"
    || receipt.scope.side_effects.length || receipt.git_policy.worker_may_commit !== false)) {
    throw new ReceiptError("read-only Receipt must not carry write authorization", "RECEIPT_SCHEMA_INVALID");
  }
  if (receipt.execution.mode === "write" && (!receipt.scope.write_allowlist.length
    || !receipt.scope.allowed_operations.length || receipt.scope.allowed_operations.includes("read")
    || receipt.scope.side_effects.length !== 1 || receipt.scope.side_effects[0] !== "filesystem-write"
    || receipt.git_policy.worker_may_commit !== false)) {
    throw new ReceiptError("write Receipt authorization is invalid", "RECEIPT_SCHEMA_INVALID");
  }
  if (receipt.execution.mode === "write" && (!receipt.baseline || receipt.commit_baseline !== null)) {
    throw new ReceiptError("write Receipt must carry only a Git baseline", "RECEIPT_SCHEMA_INVALID");
  }
  if (receipt.execution.mode === "commit-only" && (!receipt.commit_baseline || receipt.baseline !== null)) {
    throw new ReceiptError("commit-only Receipt must carry only a commit baseline", "RECEIPT_SCHEMA_INVALID");
  }
}

/** Compare an artifact pair without reading or mutating either artifact. */
export function validateTicketReceiptLineage(
  ticket: {
    id: string;
    model_id: string;
    route_id: string | null;
    service_tier?: string | null;
    host?: string | null;
    target_host?: string;
    mode: ExecutionMode;
    read_only: boolean;
    compiled_apply_lineage?: unknown;
  },
  receipt: DelegationReceipt,
): string | null {
  try {
    validateReceiptBaselines(receipt);
    if (ticket.id !== receipt.ticket_id) return "COMPILED_LINEAGE_TICKET_ID_MISMATCH";
    const ticketLineage = ticket.compiled_apply_lineage;
    const receiptLineage = receipt.compiled_apply_lineage;
    if ((ticketLineage === undefined) !== (receiptLineage === undefined)) return "COMPILED_LINEAGE_MISMATCH";
    if (ticketLineage !== undefined && JSON.stringify(normalizeCompiledApplyLineage(ticketLineage)) !== JSON.stringify(receiptLineage)) return "COMPILED_LINEAGE_MISMATCH";
    if ((ticket.host || ticket.target_host || null) !== (receipt.host || null)) return "COMPILED_LINEAGE_HOST_MISMATCH";
    if (ticket.model_id !== receipt.route.card_id || (ticket.route_id || null) !== (receipt.route.route_id || null)) return "COMPILED_LINEAGE_ROUTE_MODEL_MISMATCH";
    if ((ticket.service_tier || null) !== (receipt.route.service_tier || null)) return "COMPILED_LINEAGE_ROUTE_MODEL_MISMATCH";
    if (ticket.mode !== receipt.execution.mode || ticket.read_only !== (ticket.mode === "read-only")) return "COMPILED_LINEAGE_EXECUTION_MODE_MISMATCH";
    return null;
  } catch (error) {
    return error instanceof ReceiptError ? error.code : "COMPILED_LINEAGE_MALFORMED";
  }
}

/** Pure receipt normalization used by both persistence and reads. */
export function normalizeReceipt(value: unknown): DelegationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReceiptError("Receipt schema is invalid", "RECEIPT_SCHEMA_INVALID");
  }
  const receipt = structuredClone(value) as DelegationReceipt;
  if (receipt.compiled_apply_lineage !== undefined) {
    receipt.compiled_apply_lineage = normalizeCompiledApplyLineage(receipt.compiled_apply_lineage);
  }
  validateReceiptBaselines(receipt);
  return receipt;
}

export function validateReceiptLineage(value: unknown): string | null {
  try { normalizeReceipt(value); return null; } catch (error) {
    return error instanceof ReceiptError ? error.code : "RECEIPT_SCHEMA_INVALID";
  }
}

export function assertValidTicketReceiptLineage(ticket: Parameters<typeof validateTicketReceiptLineage>[0], receipt: DelegationReceipt): void {
  const error = validateTicketReceiptLineage(ticket, receipt);
  if (error) throw new ReceiptError(`ticket and Receipt lineage mismatch: ${error}`, error);
}

export function writeReceipt(cwd: string, receipt: DelegationReceipt, env?: NodeJS.ProcessEnv): DelegationReceipt {
  const normalized = normalizeReceipt(receipt);
  const dir = receiptsDir(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = receiptPath(cwd, normalized.receipt_id, env);
  const content = `${JSON.stringify(normalized, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") === content) return normalized;
    throw new ReceiptError(`receipt is immutable: ${normalized.receipt_id}`, "RECEIPT_IMMUTABLE");
  }
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return normalized;
}

export function readReceipt(cwd: string, receiptId: string, env?: NodeJS.ProcessEnv): DelegationReceipt {
  const file = receiptPath(cwd, receiptId, env);
  if (!fs.existsSync(file)) throw new ReceiptError(`receipt not found: ${receiptId}`, "RECEIPT_NOT_FOUND");
  const receipt = normalizeReceipt(JSON.parse(fs.readFileSync(file, "utf8")));
  if (receipt.receipt_id !== receiptId) {
    throw new ReceiptError(`Receipt id does not match its path: ${receiptId}`, "RECEIPT_ID_MISMATCH");
  }
  return receipt;
}
