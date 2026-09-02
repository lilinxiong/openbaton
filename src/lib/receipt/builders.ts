import {
  DelegationReceipt,
  RollingUnitLineage
} from "../receipt.js";
import {
  CommitBaseline,
  GitBaseline,
  SafetyOperation,
  validateIndexControlBaselineMetadata
} from "../safety.js";
import {
  ReceiptError,
  normalizeCompiledApplyLineage,
  normalizeRollingUnitLineage
} from "./lineage.js";
import { extractExactExecutionRootIdentity, sameExactExecutionRootIdentity, type ExactExecutionRootIdentity } from "../../adapters/contract.js";
import type { ModelCard, ModelSelectionApproval } from "../../types.js";
/**
 * Receipt builders (read-only / write / commit). Split from receipt.ts.
 */

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
  rollingUnitLineage,
  rolling_unit_lineage,
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
  rollingUnitLineage?: unknown;
  rolling_unit_lineage?: unknown;
}): DelegationReceipt {
  const lineageInput = compiledApplyLineage ?? compiled_apply_lineage ?? compiledLineage ?? compiled_lineage;
  const lineage = lineageInput === undefined || lineageInput === null
    ? undefined
    : normalizeCompiledApplyLineage(lineageInput);
  const rollingInputs = [rollingUnitLineage, rolling_unit_lineage].filter((value) => value !== undefined && value !== null);
  if (lineage && rollingInputs.length) {
    throw new ReceiptError("compiled and rolling lineages are mutually exclusive", "RECEIPT_LINEAGE_MUTUALLY_EXCLUSIVE");
  }
  const rollingLineage = rollingInputs.length ? normalizeRollingUnitLineage(rollingInputs[0]) : undefined;
  if (rollingInputs.length > 1 && JSON.stringify(rollingLineage) !== JSON.stringify(normalizeRollingUnitLineage(rollingInputs[1]))) {
    throw new ReceiptError("rolling lineage aliases do not match", "ROLLING_LINEAGE_MISMATCH");
  }
  const timestamp = (issuedAt instanceof Date ? issuedAt : new Date(issuedAt)).toISOString();
  const attempts = Math.max(1, Math.floor(maxAttempts));
  const exactRoot = rollingLineage ? extractExactExecutionRootIdentity(rollingLineage) : undefined;
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
    ...(rollingLineage ? { rolling_unit_lineage: rollingLineage } : {}),
    ...(exactRoot || {}),
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
  rollingUnitLineage,
  rolling_unit_lineage,
}: {
  base: DelegationReceipt;
  baseline: GitBaseline;
  writeAllowlist: string[];
  allowedOperations: SafetyOperation[];
  compiledApplyLineage?: unknown;
  compiled_apply_lineage?: unknown;
  compiledLineage?: unknown;
  compiled_lineage?: unknown;
  rollingUnitLineage?: unknown;
  rolling_unit_lineage?: unknown;
}): DelegationReceipt {
  if (!writeAllowlist.length) throw new ReceiptError("write Receipt requires a non-empty allowlist", "WRITE_ALLOWLIST_REQUIRED");
  if (!allowedOperations.length) throw new ReceiptError("write Receipt requires allowed operations", "WRITE_OPERATIONS_REQUIRED");
  const baselineError = validateIndexControlBaselineMetadata(baseline);
  if (baselineError) throw new ReceiptError("write baseline index-control metadata is invalid", baselineError);
  const suppliedLineage = compiledApplyLineage ?? compiled_apply_lineage ?? compiledLineage ?? compiled_lineage;
  const lineage = suppliedLineage === undefined
    ? base.compiled_apply_lineage
    : normalizeCompiledApplyLineage(suppliedLineage);
  if (base.compiled_apply_lineage !== undefined && base.rolling_unit_lineage !== undefined) {
    throw new ReceiptError("compiled and rolling lineages are mutually exclusive", "RECEIPT_LINEAGE_MUTUALLY_EXCLUSIVE");
  }
  const rollingInputs = [rollingUnitLineage, rolling_unit_lineage].filter((value) => value !== undefined && value !== null);
  let suppliedRollingLineage: RollingUnitLineage | undefined;
  if (rollingInputs.length) {
    suppliedRollingLineage = normalizeRollingUnitLineage(rollingInputs[0]);
    if (rollingInputs.length > 1
      && JSON.stringify(suppliedRollingLineage) !== JSON.stringify(normalizeRollingUnitLineage(rollingInputs[1]))) {
      throw new ReceiptError("rolling lineage aliases do not match", "ROLLING_LINEAGE_MISMATCH");
    }
  }
  if ((lineage && (base.rolling_unit_lineage !== undefined || suppliedRollingLineage !== undefined))
    || (base.compiled_apply_lineage !== undefined && suppliedRollingLineage !== undefined)) {
    throw new ReceiptError("compiled and rolling lineages are mutually exclusive", "RECEIPT_LINEAGE_MUTUALLY_EXCLUSIVE");
  }
  let rollingLineage = base.rolling_unit_lineage;
  if (suppliedRollingLineage !== undefined) {
    if (base.rolling_unit_lineage !== undefined) {
      if (JSON.stringify(suppliedRollingLineage) !== JSON.stringify(base.rolling_unit_lineage)) {
        throw new ReceiptError("supplied rolling lineage does not match the base lineage", "ROLLING_LINEAGE_MISMATCH");
      }
    } else {
      rollingLineage = suppliedRollingLineage;
    }
  }
  if (lineage && lineage.mode !== "patch-only") {
    throw new ReceiptError("verification-only lineage cannot authorize writes", "COMPILED_LINEAGE_EXECUTION_MODE_MISMATCH");
  }
  if (rollingLineage && rollingLineage.mode !== "patch-only") {
    throw new ReceiptError("verification-only rolling lineage cannot authorize writes", "ROLLING_LINEAGE_EXECUTION_MODE_MISMATCH");
  }
  const exactRoot = rollingLineage ? extractExactExecutionRootIdentity(rollingLineage) : undefined;
  let baseExactRoot: ExactExecutionRootIdentity | undefined;
  try {
    baseExactRoot = extractExactExecutionRootIdentity(base);
  } catch (error) {
    throw new ReceiptError("base Receipt exact-root identity is partial or invalid",
      error instanceof Error && error.message.includes("PARTIAL")
        ? "ISOLATED_EXECUTION_IDENTITY_PARTIAL"
        : "ISOLATED_EXECUTION_IDENTITY_INVALID");
  }
  const baseRollingExactRoot = base.rolling_unit_lineage
    ? extractExactExecutionRootIdentity(normalizeRollingUnitLineage(base.rolling_unit_lineage))
    : undefined;
  if ((baseExactRoot === undefined) !== (baseRollingExactRoot === undefined)
    || (baseExactRoot && !sameExactExecutionRootIdentity(baseExactRoot, baseRollingExactRoot))) {
    throw new ReceiptError("base Receipt exact-root identity does not match rolling lineage", "ISOLATED_EXECUTION_IDENTITY_MISMATCH");
  }
  if (baseExactRoot && exactRoot && !sameExactExecutionRootIdentity(baseExactRoot, exactRoot)) {
    throw new ReceiptError("supplied rolling exact-root identity does not match the base Receipt", "ISOLATED_EXECUTION_IDENTITY_MISMATCH");
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
    ...(rollingLineage ? { rolling_unit_lineage: rollingLineage } : {}),
    ...(exactRoot || {}),
  };
}

export function buildCommitReceipt({
  base,
  baseline,
  compiledApplyLineage,
  compiled_apply_lineage,
  compiledLineage,
  compiled_lineage,
  rollingUnitLineage,
  rolling_unit_lineage,
}: {
  base: DelegationReceipt;
  baseline: CommitBaseline;
  compiledApplyLineage?: unknown;
  compiled_apply_lineage?: unknown;
  compiledLineage?: unknown;
  compiled_lineage?: unknown;
  rollingUnitLineage?: unknown;
  rolling_unit_lineage?: unknown;
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
  if (base.rolling_unit_lineage !== undefined || rollingUnitLineage !== undefined || rolling_unit_lineage !== undefined) {
    throw new ReceiptError("rolling unit lineage cannot authorize commit-only execution", "ROLLING_LINEAGE_EXECUTION_MODE_MISMATCH");
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
