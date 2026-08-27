import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { receiptsDir } from "./paths.js";
import type { ModelCard, ModelSelectionApproval } from "../types.js";
import { validateIndexControlBaselineMetadata, type CommitBaseline, type GitBaseline, type SafetyOperation } from "./safety.js";

export type ReceiptOperation = "read" | "commit" | SafetyOperation;
export type ExecutionMode = "read-only" | "write" | "commit-only";

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
}: {
  ticketId: string;
  card: ModelCard;
  issuedAt?: Date | string | number;
  maxAttempts?: number;
  selection?: ModelSelectionApproval | null;
  host?: string | null;
}): DelegationReceipt {
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
  };
}

export function buildWriteReceipt({
  base,
  baseline,
  writeAllowlist,
  allowedOperations,
}: {
  base: DelegationReceipt;
  baseline: GitBaseline;
  writeAllowlist: string[];
  allowedOperations: SafetyOperation[];
}): DelegationReceipt {
  if (!writeAllowlist.length) throw new ReceiptError("write Receipt requires a non-empty allowlist", "WRITE_ALLOWLIST_REQUIRED");
  if (!allowedOperations.length) throw new ReceiptError("write Receipt requires allowed operations", "WRITE_OPERATIONS_REQUIRED");
  const baselineError = validateIndexControlBaselineMetadata(baseline);
  if (baselineError) throw new ReceiptError("write baseline index-control metadata is invalid", baselineError);
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
  };
}

export function buildCommitReceipt({
  base,
  baseline,
}: {
  base: DelegationReceipt;
  baseline: CommitBaseline;
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
    || !receipt.scope || !receipt.retry || !receipt.git_policy
    || !Array.isArray(receipt.scope.write_allowlist)
    || !Array.isArray(receipt.scope.allowed_operations)
    || !Array.isArray(receipt.scope.side_effects)
    || !Number.isSafeInteger(receipt.retry.max_attempts) || receipt.retry.max_attempts < 1
    || Object.keys(receipt.retry).length !== 1) {
    throw new ReceiptError("Receipt schema is invalid", "RECEIPT_SCHEMA_INVALID");
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
  if (receipt.execution.mode === "write" && (!receipt.baseline || receipt.commit_baseline !== null)) {
    throw new ReceiptError("write Receipt must carry only a Git baseline", "RECEIPT_SCHEMA_INVALID");
  }
  if (receipt.execution.mode === "commit-only" && (!receipt.commit_baseline || receipt.baseline !== null)) {
    throw new ReceiptError("commit-only Receipt must carry only a commit baseline", "RECEIPT_SCHEMA_INVALID");
  }
}

export function writeReceipt(cwd: string, receipt: DelegationReceipt, env?: NodeJS.ProcessEnv): DelegationReceipt {
  validateReceiptBaselines(receipt);
  const dir = receiptsDir(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = receiptPath(cwd, receipt.receipt_id, env);
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") === content) return receipt;
    throw new ReceiptError(`receipt is immutable: ${receipt.receipt_id}`, "RECEIPT_IMMUTABLE");
  }
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return receipt;
}

export function readReceipt(cwd: string, receiptId: string, env?: NodeJS.ProcessEnv): DelegationReceipt {
  const file = receiptPath(cwd, receiptId, env);
  if (!fs.existsSync(file)) throw new ReceiptError(`receipt not found: ${receiptId}`, "RECEIPT_NOT_FOUND");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8")) as DelegationReceipt;
  validateReceiptBaselines(receipt);
  return receipt;
}
