import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { receiptsDir } from "./paths.js";
import type { ModelCard, ModelSelectionApproval } from "../types.js";
import { validateIndexControlBaselineMetadata, type CommitBaseline, type GitBaseline, type SafetyOperation } from "./safety.js";
import {
  extractExactExecutionRootIdentity,
  sameExactExecutionRootIdentity,
  type ExactExecutionRootIdentity,
} from "../adapters/contract.js";
import type { WorktreeExecutionMode } from "./rolling-plan.js";
import { readJsonFile } from "./json-utils.js";
import {
  ReceiptError,
  normalizeCompiledApplyLineage,
  normalizeRollingUnitLineage
} from "./receipt/lineage.js";

export type ReceiptOperation = "read" | "commit" | SafetyOperation;
export type ExecutionMode = "read-only" | "write" | "commit-only";
export type CompiledApplyMode = "patch-only" | "verification-only";

/** Immutable identity carried from a rolling unit version into its artifacts. */
export interface RollingUnitLineage extends Partial<ExactExecutionRootIdentity> {
  schema_version: 1;
  run_id: string;
  unit_key: string;
  unit_version: number;
  unit_fingerprint: string;
  task_keys: readonly string[];
  mode: CompiledApplyMode;
  /** Omitted only for legacy rolling artifacts. */
  worktree_mode?: WorktreeExecutionMode;
}

/** Immutable identity carried from a compiled apply unit into its artifacts. */
export interface CompiledApplyLineage {
  run_id: string;
  plan_revision: string;
  plan_fingerprint: string;
  unit_id: string;
  task_refs: readonly string[];
  mode: CompiledApplyMode;
}


export interface DelegationReceipt extends Partial<ExactExecutionRootIdentity> {
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
  /** Omitted on legacy/manual receipts; immutable identity for rolling units. */
  rolling_unit_lineage?: RollingUnitLineage;
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
  const rollingLineage = receipt.rolling_unit_lineage;
  if (lineage !== undefined && rollingLineage !== undefined) {
    throw new ReceiptError("compiled and rolling lineages are mutually exclusive", "RECEIPT_LINEAGE_MUTUALLY_EXCLUSIVE");
  }
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
  if (rollingLineage !== undefined) {
    const normalized = normalizeRollingUnitLineage(rollingLineage);
    if (JSON.stringify(normalized) !== JSON.stringify(rollingLineage)) {
      throw new ReceiptError("Receipt rolling unit lineage is not normalized", "ROLLING_LINEAGE_MALFORMED");
    }
    if (rollingLineage.mode === "verification-only" && receipt.execution.mode !== "read-only") {
      throw new ReceiptError("verification-only rolling lineage requires read-only execution", "ROLLING_LINEAGE_EXECUTION_MODE_MISMATCH");
    }
    if (rollingLineage.mode === "patch-only" && receipt.execution.mode !== "write") {
      throw new ReceiptError("patch-only rolling lineage requires write execution", "ROLLING_LINEAGE_EXECUTION_MODE_MISMATCH");
    }
  }
  let receiptExactRoot: ExactExecutionRootIdentity | undefined;
  try {
    receiptExactRoot = extractExactExecutionRootIdentity(receipt);
  } catch (error) {
    throw new ReceiptError("Receipt exact-root identity is partial or invalid",
      error instanceof Error && error.message.includes("PARTIAL")
        ? "ISOLATED_EXECUTION_IDENTITY_PARTIAL"
        : "ISOLATED_EXECUTION_IDENTITY_INVALID");
  }
  const rollingExactRoot = rollingLineage ? extractExactExecutionRootIdentity(rollingLineage) : undefined;
  if ((receiptExactRoot === undefined) !== (rollingExactRoot === undefined)
    || (receiptExactRoot && !sameExactExecutionRootIdentity(receiptExactRoot, rollingExactRoot))) {
    throw new ReceiptError("Receipt exact-root identity does not match rolling lineage", "ISOLATED_EXECUTION_IDENTITY_MISMATCH");
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
    rolling_unit_lineage?: unknown;
  } & Partial<ExactExecutionRootIdentity>,
  receipt: DelegationReceipt,
): string | null {
  try {
    if ((ticket.compiled_apply_lineage !== undefined && ticket.rolling_unit_lineage !== undefined)
      || (receipt.compiled_apply_lineage !== undefined && receipt.rolling_unit_lineage !== undefined)) {
      return "RECEIPT_LINEAGE_MUTUALLY_EXCLUSIVE";
    }
    validateReceiptBaselines(receipt);
    if (ticket.id !== receipt.ticket_id) return "COMPILED_LINEAGE_TICKET_ID_MISMATCH";
    const ticketLineage = ticket.compiled_apply_lineage;
    const receiptLineage = receipt.compiled_apply_lineage;
    if ((ticketLineage === undefined) !== (receiptLineage === undefined)) return "COMPILED_LINEAGE_MISMATCH";
    if (ticketLineage !== undefined && JSON.stringify(normalizeCompiledApplyLineage(ticketLineage)) !== JSON.stringify(receiptLineage)) return "COMPILED_LINEAGE_MISMATCH";
    const ticketRollingLineage = ticket.rolling_unit_lineage;
    const receiptRollingLineage = receipt.rolling_unit_lineage;
    if ((ticketRollingLineage === undefined) !== (receiptRollingLineage === undefined)) return "ROLLING_LINEAGE_MISMATCH";
    if (ticketRollingLineage !== undefined && JSON.stringify(normalizeRollingUnitLineage(ticketRollingLineage)) !== JSON.stringify(receiptRollingLineage)) return "ROLLING_LINEAGE_MISMATCH";
    let ticketExactRoot: ExactExecutionRootIdentity | undefined;
    try {
      ticketExactRoot = extractExactExecutionRootIdentity(ticket);
    } catch (error) {
      return error instanceof Error && error.message.includes("PARTIAL")
        ? "ISOLATED_EXECUTION_IDENTITY_PARTIAL"
        : "ISOLATED_EXECUTION_IDENTITY_INVALID";
    }
    const receiptExactRoot = extractExactExecutionRootIdentity(receipt);
    if ((ticketExactRoot === undefined) !== (receiptExactRoot === undefined)
      || (ticketExactRoot && !sameExactExecutionRootIdentity(ticketExactRoot, receiptExactRoot))) {
      return "ISOLATED_EXECUTION_IDENTITY_MISMATCH";
    }
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
  if (receipt.compiled_apply_lineage !== undefined && receipt.rolling_unit_lineage !== undefined) {
    throw new ReceiptError("compiled and rolling lineages are mutually exclusive", "RECEIPT_LINEAGE_MUTUALLY_EXCLUSIVE");
  }
  if (receipt.compiled_apply_lineage !== undefined) {
    receipt.compiled_apply_lineage = normalizeCompiledApplyLineage(receipt.compiled_apply_lineage);
  }
  if (receipt.rolling_unit_lineage !== undefined) {
    receipt.rolling_unit_lineage = normalizeRollingUnitLineage(receipt.rolling_unit_lineage);
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
  const receipt = normalizeReceipt(readJsonFile(file));
  if (receipt.receipt_id !== receiptId) {
    throw new ReceiptError(`Receipt id does not match its path: ${receiptId}`, "RECEIPT_ID_MISMATCH");
  }
  return receipt;
}

export * from "./receipt/lineage.js";
export * from "./receipt/builders.js";
