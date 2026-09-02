import {
  CompiledApplyLineage,
  RollingUnitLineage
} from "./receipt.js";
/**
 * Receipt lineage normalization/validation. Split from receipt.ts (leaf
 * module; also hosts ReceiptError so builders/IO share one definition).
 */
import {
  extractExactExecutionRootIdentity,
  type ExactExecutionRootIdentity,
} from "../adapters/contract.js";
import type { WorktreeExecutionMode } from "./rolling-plan.js";

export type RollingUnitLineageInput = {
  schema_version?: unknown;
  run_id?: unknown;
  unit_key?: unknown;
  unit_version?: unknown;
  unit_fingerprint?: unknown;
  task_keys?: unknown;
  mode?: unknown;
  worktree_mode?: unknown;
  repository_id?: unknown;
  git_common_dir_identity?: unknown;
  execution_root?: unknown;
  base_tree?: unknown;
  worktree_record_id?: unknown;
};


export function isolatedIdentity(value: unknown, mode: unknown, label: string): ExactExecutionRootIdentity | undefined {
  let identity: ExactExecutionRootIdentity | undefined;
  try {
    identity = extractExactExecutionRootIdentity(value);
  } catch (error) {
    const code = error instanceof Error && error.message.includes("PARTIAL")
      ? "ISOLATED_EXECUTION_IDENTITY_PARTIAL"
      : "ISOLATED_EXECUTION_IDENTITY_INVALID";
    throw new ReceiptError(`${label} exact-root identity is invalid`, code);
  }
  if (mode === undefined) {
    if (identity) throw new ReceiptError(`${label} legacy lineage cannot carry exact-root identity`, "ISOLATED_EXECUTION_MODE_REQUIRED");
    return undefined;
  }
  if (mode !== "isolated-worktree" && mode !== "shared-worktree") {
    throw new ReceiptError(`${label} worktree_mode is invalid`, "ISOLATED_EXECUTION_MODE_INVALID");
  }
  if (mode === "isolated-worktree" && !identity) {
    throw new ReceiptError(`${label} isolated lineage requires exact-root identity`, "ISOLATED_EXECUTION_IDENTITY_PARTIAL");
  }
  if (mode === "shared-worktree" && identity) {
    throw new ReceiptError(`${label} shared lineage forbids exact-root identity`, "ISOLATED_EXECUTION_IDENTITY_FORBIDDEN");
  }
  return identity;
}

/** Purely normalize and validate rolling unit identity and optional isolation lineage. */
export function normalizeRollingUnitLineage(value: unknown): RollingUnitLineage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReceiptError("rolling unit lineage must be an object", "ROLLING_LINEAGE_MALFORMED");
  }
  const input = value as RollingUnitLineageInput;
  const baseFields = ["schema_version", "run_id", "unit_key", "unit_version", "unit_fingerprint", "task_keys", "mode"];
  const isolationFields = ["worktree_mode", "repository_id", "git_common_dir_identity", "execution_root", "base_tree", "worktree_record_id"];
  const allowed = [...baseFields, ...isolationFields];
  if (Object.keys(input as object).some((key) => !allowed.includes(key))) {
    throw new ReceiptError("rolling unit lineage contains an unknown field", "ROLLING_LINEAGE_UNKNOWN_FIELD");
  }
  for (const field of baseFields) {
    if (!(field in input)) throw new ReceiptError(`rolling unit lineage ${field} is required`, "ROLLING_LINEAGE_PARTIAL");
  }
  if (input.schema_version !== 1) {
    throw new ReceiptError("rolling unit lineage schema_version must be 1", "ROLLING_LINEAGE_UNKNOWN_SCHEMA");
  }
  const requiredText = (field: "run_id" | "unit_key"): string => {
    const raw = input[field];
    if (typeof raw !== "string" || !raw.trim()) {
      throw new ReceiptError(`rolling unit lineage ${field} is required`, "ROLLING_LINEAGE_PARTIAL");
    }
    return raw.trim();
  };
  if (typeof input.unit_version !== "number" || !Number.isSafeInteger(input.unit_version) || input.unit_version < 1) {
    throw new ReceiptError("rolling unit lineage unit_version must be a positive integer", "ROLLING_LINEAGE_INVALID_VERSION");
  }
  if (typeof input.unit_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(input.unit_fingerprint)) {
    throw new ReceiptError("rolling unit lineage unit_fingerprint must be a lowercase SHA-256 hex string", "ROLLING_LINEAGE_INVALID_FINGERPRINT");
  }
  if (!Array.isArray(input.task_keys) || input.task_keys.length === 0
    || input.task_keys.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ReceiptError("rolling unit lineage task_keys must be non-empty strings", "ROLLING_LINEAGE_INVALID_TASK_KEYS");
  }
  const taskKeys = input.task_keys.map((item) => (item as string).trim());
  if (new Set(taskKeys).size !== taskKeys.length) {
    throw new ReceiptError("rolling unit lineage task_keys contains duplicates", "ROLLING_LINEAGE_DUPLICATE_TASK");
  }
  const sortedTaskKeys = [...taskKeys].sort();
  if (JSON.stringify(taskKeys) !== JSON.stringify(sortedTaskKeys)) {
    throw new ReceiptError("rolling unit lineage task_keys must be lexicographically sorted", "ROLLING_LINEAGE_TASK_KEYS_UNSORTED");
  }
  if (input.mode !== "patch-only" && input.mode !== "verification-only") {
    throw new ReceiptError("rolling unit lineage mode is invalid", "ROLLING_LINEAGE_UNKNOWN_MODE");
  }
  const exactRoot = isolatedIdentity(input, input.worktree_mode, "rolling unit lineage");
  return freezeLineage({
    schema_version: 1,
    run_id: requiredText("run_id"),
    unit_key: requiredText("unit_key"),
    unit_version: input.unit_version,
    unit_fingerprint: input.unit_fingerprint,
    task_keys: taskKeys,
    mode: input.mode,
    ...(input.worktree_mode === undefined ? {} : { worktree_mode: input.worktree_mode as WorktreeExecutionMode }),
    ...(exactRoot || {}),
  });
}

export type CompiledApplyLineageInput = {
  run_id?: unknown;
  plan_revision?: unknown;
  plan_fingerprint?: unknown;
  unit_id?: unknown;
  task_refs?: unknown;
  mode?: unknown;
};

export function freezeLineage<T>(value: T): T {
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


export class ReceiptError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ReceiptError";
    this.code = code;
  }
}
