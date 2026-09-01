import { normalizeRollingUnitLineage, type RollingUnitLineage } from "./receipt.js";
import {
  extractExactExecutionRootIdentity,
  sameExactExecutionRootIdentity,
  type ExactExecutionRootIdentity,
} from "../adapters/contract.js";
import type { WorktreeExecutionMode } from "./rolling-plan.js";
import { renderWorktreeWorkerPolicy } from "./prompt.js";

export type WorkUnitKind = "concrete" | "deliberative";
export type CoordinationMode = "terminal-only" | "checkpointed";
export type CompiledWorkUnitMode = "patch-only" | "verification-only";
export type WorkUnitOperation = "write" | "create" | "delete" | "rename" | "chmod";

export interface WorkUnitContract {
  schema_version: 1 | 2 | 3;
  kind: WorkUnitKind;
  objective: string;
  deliverable: string;
  done_when: string;
}

/** A rolling unit contract carries only the immutable unit-version boundary. */
export interface RollingWorkUnitContract extends WorkUnitContract, Partial<ExactExecutionRootIdentity> {
  schema_version: 3;
  kind: "concrete";
  mode: CompiledWorkUnitMode;
  rolling_unit_lineage: RollingUnitLineage;
  read_context: readonly string[];
  write_paths: readonly string[];
  allowed_operations: readonly WorkUnitOperation[];
  completion_criteria: readonly string[];
  permitted_validation: readonly string[];
  coordination: "terminal-only";
  /** Omitted only for legacy rolling contracts. */
  worktree_mode?: WorktreeExecutionMode;
}

/**
 * A director-compiled execution contract.  Compiled contracts are immutable
 * snapshots: a worker may consume them, but cannot change the plan or scope
 * it was given.
 */
export interface CompiledWorkUnitContract extends WorkUnitContract {
  schema_version: 2;
  mode: CompiledWorkUnitMode;
  run_id: string;
  plan_revision: string;
  plan_fingerprint: string;
  unit_id: string;
  task_refs: readonly string[];
  satisfied_dependencies: readonly string[];
  read_context: readonly string[];
  write_paths: readonly string[];
  allowed_operations: readonly WorkUnitOperation[];
  patch_recipe: string;
  completion_criteria: readonly string[];
  permitted_validation: readonly string[];
  coordination: "terminal-only";
}

export interface CoordinationPolicy {
  mode: CoordinationMode;
  progress_interval_ms: number | null;
}

export interface CompileWorkUnitOptions {
  kind?: WorkUnitKind;
  deliverable?: string | null;
  doneWhen?: string | null;
  /** Set this to compile a bounded patch or verification contract. */
  mode?: CompiledWorkUnitMode;
  executionMode?: CompiledWorkUnitMode;
  execution_mode?: CompiledWorkUnitMode;
  runId?: string;
  run_id?: string;
  planRevision?: string | number;
  plan_revision?: string | number;
  planFingerprint?: string;
  plan_fingerprint?: string;
  unitId?: string;
  unit_id?: string;
  taskRefs?: readonly string[];
  task_refs?: readonly string[];
  satisfiedDependencies?: readonly string[];
  satisfied_dependencies?: readonly string[];
  readContext?: readonly string[];
  read_context?: readonly string[];
  writePaths?: readonly string[];
  write_paths?: readonly string[];
  allowedOperations?: readonly WorkUnitOperation[];
  allowed_operations?: readonly WorkUnitOperation[];
  patchRecipe?: string;
  patch_recipe?: string;
  completionCriteria?: readonly string[];
  completion_criteria?: readonly string[];
  permittedValidation?: readonly string[];
  permitted_validation?: readonly string[];
  rollingUnitLineage?: unknown;
  rolling_unit_lineage?: unknown;
  worktreeMode?: WorktreeExecutionMode;
  worktree_mode?: WorktreeExecutionMode;
  repositoryId?: string;
  repository_id?: string;
  gitCommonDirIdentity?: string;
  git_common_dir_identity?: string;
  executionRoot?: string;
  execution_root?: string;
  baseTree?: string;
  base_tree?: string;
  worktreeRecordId?: string;
  worktree_record_id?: string;
}

export interface CompileCompiledWorkUnitOptions extends Omit<CompileWorkUnitOptions, "kind" | "mode" | "executionMode" | "execution_mode"> {
  mode: CompiledWorkUnitMode;
  executionMode?: CompiledWorkUnitMode;
  execution_mode?: CompiledWorkUnitMode;
  objective?: string;
  description?: string;
}

export interface CompileRollingWorkUnitOptions extends Omit<CompileWorkUnitOptions, "kind" | "mode" | "executionMode" | "execution_mode"> {
  mode: CompiledWorkUnitMode;
  executionMode?: CompiledWorkUnitMode;
  execution_mode?: CompiledWorkUnitMode;
  objective?: string;
  description?: string;
  done_when?: string;
}

function nonEmpty(value: unknown, field: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`compiled work unit ${field} is required`);
  return result;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`compiled work unit ${field} must be an array`);
  return value.map((entry) => nonEmpty(entry, `${field} entries`));
}

function optionalStrings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  return strings(value, field);
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function compileCompiledWorkUnit(
  description: unknown,
  options: CompileCompiledWorkUnitOptions,
): CompiledWorkUnitContract {
  const mode = options.mode;
  if (mode !== "patch-only" && mode !== "verification-only") {
    throw new Error("compiled work unit mode is required and must be patch-only or verification-only");
  }

  const writePaths = optionalStrings(options.write_paths ?? options.writePaths, "write_paths");
  const allowedOperations = optionalStrings(options.allowed_operations ?? options.allowedOperations, "allowed_operations") as WorkUnitOperation[];
  const validOperations = new Set<WorkUnitOperation>(["write", "create", "delete", "rename", "chmod"]);
  if (allowedOperations.some((operation) => !validOperations.has(operation))) {
    throw new Error("compiled work unit allowed_operations contains an unsupported operation");
  }
  if (mode === "patch-only" && (!writePaths.length || !allowedOperations.length)) {
    throw new Error("patch-only work unit requires non-empty write_paths and allowed_operations");
  }
  if (mode === "verification-only" && (writePaths.length || allowedOperations.length)) {
    throw new Error("verification-only work unit forbids write_paths and allowed_operations");
  }

  const objective = nonEmpty(description ?? options.objective, "objective");
  const taskRefs = strings(options.task_refs ?? options.taskRefs, "task_refs");
  const readContext = strings(options.read_context ?? options.readContext, "read_context");
  const completionCriteria = strings(options.completion_criteria ?? options.completionCriteria, "completion_criteria");
  const permittedValidation = strings(options.permitted_validation ?? options.permittedValidation, "permitted_validation");
  const contract: CompiledWorkUnitContract = {
    schema_version: 2,
    kind: "concrete",
    objective,
    deliverable: nonEmpty(options.deliverable, "deliverable"),
    done_when: nonEmpty(options.doneWhen, "done_when"),
    mode,
    run_id: nonEmpty(options.run_id ?? options.runId, "run_id"),
    plan_revision: nonEmpty(options.plan_revision ?? options.planRevision, "plan_revision"),
    plan_fingerprint: nonEmpty(options.plan_fingerprint ?? options.planFingerprint, "plan_fingerprint"),
    unit_id: nonEmpty(options.unit_id ?? options.unitId, "unit_id"),
    task_refs: taskRefs,
    satisfied_dependencies: optionalStrings(options.satisfied_dependencies ?? options.satisfiedDependencies, "satisfied_dependencies"),
    read_context: readContext,
    write_paths: writePaths,
    allowed_operations: allowedOperations,
    patch_recipe: nonEmpty(options.patch_recipe ?? options.patchRecipe, "patch_recipe"),
    completion_criteria: completionCriteria,
    permitted_validation: permittedValidation,
    coordination: "terminal-only",
  };
  return freezeDeep(contract);
}

export function compileRollingWorkUnit(
  description: unknown,
  options?: CompileRollingWorkUnitOptions,
): RollingWorkUnitContract {
  const objectInput = options === undefined && description && typeof description === "object"
    ? description as Record<string, unknown>
    : undefined;
  if (objectInput) {
    const allowedObjectFields = [
      "schema_version", "kind", "objective", "deliverable", "done_when", "mode",
      "rolling_unit_lineage", "read_context", "write_paths", "allowed_operations",
      "completion_criteria", "permitted_validation", "coordination", "worktree_mode",
      "repository_id", "git_common_dir_identity", "execution_root", "base_tree", "worktree_record_id",
    ];
    if (Object.keys(objectInput).some((key) => !allowedObjectFields.includes(key))) {
      throw new Error("rolling work unit contains an unknown field");
    }
    if (objectInput.schema_version !== 3) {
      throw new Error("rolling work unit schema_version must be 3");
    }
    if (objectInput.kind !== "concrete") {
      throw new Error("rolling work unit kind must be concrete");
    }
    if (objectInput.coordination !== "terminal-only") {
      throw new Error("rolling work unit coordination must be terminal-only");
    }
  }
  const source = options ?? objectInput ?? {};
  const mode = source.mode ?? source.execution_mode ?? source.executionMode;
  if (mode !== "patch-only" && mode !== "verification-only") {
    throw new Error("rolling work unit mode is required and must be patch-only or verification-only");
  }
  const rollingInput = source.rolling_unit_lineage ?? source.rollingUnitLineage;
  if (rollingInput === undefined || rollingInput === null) {
    throw new Error("rolling work unit rolling_unit_lineage is required");
  }
  const rollingLineage = normalizeRollingUnitLineage(rollingInput);
  if (rollingLineage.mode !== mode) {
    throw new Error("rolling work unit mode must equal rolling unit lineage mode");
  }
  const suppliedWorktreeMode = source.worktree_mode ?? source.worktreeMode ?? rollingLineage.worktree_mode;
  if (suppliedWorktreeMode !== rollingLineage.worktree_mode) {
    throw new Error("rolling work unit worktree_mode must equal rolling unit lineage worktree_mode");
  }
  const worktreeMode = rollingLineage.worktree_mode;
  let sourceExactRoot: ExactExecutionRootIdentity | undefined;
  try {
    sourceExactRoot = extractExactExecutionRootIdentity(Object.fromEntries(Object.entries({
      repository_id: source.repository_id ?? source.repositoryId,
      git_common_dir_identity: source.git_common_dir_identity ?? source.gitCommonDirIdentity,
      execution_root: source.execution_root ?? source.executionRoot,
      base_tree: source.base_tree ?? source.baseTree,
      worktree_record_id: source.worktree_record_id ?? source.worktreeRecordId,
    }).filter(([, value]) => value !== undefined)));
  } catch {
    throw new Error("rolling work unit exact-root identity is partial or invalid");
  }
  const lineageExactRoot = extractExactExecutionRootIdentity(rollingLineage);
  if (objectInput && (sourceExactRoot === undefined) !== (lineageExactRoot === undefined)) {
    throw new Error("rolling work unit exact-root identity mismatch");
  }
  if (sourceExactRoot && !sameExactExecutionRootIdentity(sourceExactRoot, lineageExactRoot)) {
    throw new Error("rolling work unit exact-root identity mismatch");
  }
  const exactRoot = sourceExactRoot ?? lineageExactRoot;
  const writePaths = optionalStrings(source.write_paths ?? source.writePaths, "write_paths");
  const allowedOperations = optionalStrings(source.allowed_operations ?? source.allowedOperations, "allowed_operations") as WorkUnitOperation[];
  const validOperations = new Set<WorkUnitOperation>(["write", "create", "delete", "rename", "chmod"]);
  if (allowedOperations.some((operation) => !validOperations.has(operation))) {
    throw new Error("rolling work unit allowed_operations contains an unsupported operation");
  }
  if (mode === "patch-only" && (!writePaths.length || !allowedOperations.length)) {
    throw new Error("patch-only rolling work unit requires non-empty write_paths and allowed_operations");
  }
  if (mode === "verification-only" && (writePaths.length || allowedOperations.length)) {
    throw new Error("verification-only rolling work unit forbids write_paths and allowed_operations");
  }
  const objective = nonEmpty(options ? description : source.objective ?? source.description, "objective");
  const contract: RollingWorkUnitContract = {
    schema_version: 3,
    kind: "concrete",
    objective,
    deliverable: nonEmpty(source.deliverable, "deliverable"),
    done_when: nonEmpty(source.done_when ?? source.doneWhen, "done_when"),
    mode,
    rolling_unit_lineage: rollingLineage,
    read_context: strings(source.read_context ?? source.readContext, "read_context"),
    write_paths: writePaths,
    allowed_operations: allowedOperations,
    completion_criteria: strings(source.completion_criteria ?? source.completionCriteria, "completion_criteria"),
    permitted_validation: strings(source.permitted_validation ?? source.permittedValidation, "permitted_validation"),
    coordination: "terminal-only",
    ...(worktreeMode === undefined ? {} : { worktree_mode: worktreeMode }),
    ...(exactRoot || {}),
  };
  return freezeDeep(contract);
}

/** Compile either the legacy schema-1 unit or a versioned bounded unit. */
export function compileWorkUnit(
  description: unknown,
  options?: CompileWorkUnitOptions,
): WorkUnitContract | CompiledWorkUnitContract | RollingWorkUnitContract {
  // Accepting the object form keeps the compiled contract useful to callers
  // that already have a single plan record to pass around.
  if (options === undefined && description && typeof description === "object") {
    const input = description as CompileCompiledWorkUnitOptions & { schema_version?: unknown };
    if (input.schema_version === 3) return compileRollingWorkUnit(input);
    if (input.mode || input.executionMode || input.execution_mode) {
      return compileCompiledWorkUnit(input.objective ?? input.description, {
        ...input,
        mode: input.mode ?? input.executionMode ?? input.execution_mode!,
      });
    }
  }
  const objective = String(description || "").trim();
  if (!objective) throw new Error("work unit objective is required");
  const kind = options?.kind;
  if (options?.mode || options?.executionMode || options?.execution_mode) {
    return compileCompiledWorkUnit(objective, {
      ...options,
      mode: options.mode ?? options.executionMode ?? options.execution_mode!,
    });
  }
  if (kind !== "concrete" && kind !== "deliberative") {
    throw new Error("work unit kind is required and must be concrete or deliberative");
  }
  const deliverable = options?.deliverable || null;
  const doneWhen = options?.doneWhen || null;
  return {
    schema_version: 1,
    kind,
    objective,
    deliverable: String(deliverable || "").trim() || (kind === "concrete"
      ? "the requested bounded result plus concise verification evidence"
      : "an evidence-backed recommendation or decision input"),
    done_when: String(doneWhen || "").trim() || (kind === "concrete"
      ? "the requested result is produced and the relevant verification boundary is reported"
      : "the question is resolved, or a blocker/decision is returned to the director"),
  };
}

export function compilePatchOnlyWorkUnit(
  description: string,
  options: Omit<CompileCompiledWorkUnitOptions, "mode">,
): CompiledWorkUnitContract {
  return compileCompiledWorkUnit(description, { ...options, mode: "patch-only" });
}

export function compileVerificationOnlyWorkUnit(
  description: string,
  options: Omit<CompileCompiledWorkUnitOptions, "mode">,
): CompiledWorkUnitContract {
  return compileCompiledWorkUnit(description, { ...options, mode: "verification-only" });
}

export function coordinationFor(unit: WorkUnitContract): CoordinationPolicy {
  if ("mode" in unit) return { mode: "terminal-only", progress_interval_ms: null };
  return unit.kind === "deliberative"
    ? { mode: "checkpointed", progress_interval_ms: 60_000 }
    : { mode: "terminal-only", progress_interval_ms: null };
}

export function buildWorkerPrompt(basePrompt: string, unit: WorkUnitContract, coordination: CoordinationPolicy): string {
  const patchInstructions = String(basePrompt || unit.objective);
  const lines = [
    patchInstructions.trim(),
    "",
    "[Baton work unit]",
    `kind: ${unit.kind}`,
    `deliverable: ${unit.deliverable}`,
    `done when: ${unit.done_when}`,
  ];
  if (coordination.mode === "checkpointed") {
    lines.push(
      "coordination: checkpointed",
      "Send a brief progress update when the phase changes and before any long wait.",
      "Use only: phase, current result, next step, blocker/decision needed. Do not send tool logs or hidden reasoning.",
    );
  } else {
    lines.push("coordination: terminal-only; return one short conclusion when complete.");
  }
  if (unit.schema_version === 3 && "rolling_unit_lineage" in unit) {
    const rolling = unit as RollingWorkUnitContract;
    lines.push(
      "",
      "[Baton rolling execution contract]",
      `schema_version: ${rolling.schema_version}`,
      `kind: ${rolling.kind}`,
      `objective: ${rolling.objective}`,
      `deliverable: ${rolling.deliverable}`,
      `done_when: ${rolling.done_when}`,
      `mode: ${rolling.mode}`,
      `rolling_unit_lineage: ${JSON.stringify(rolling.rolling_unit_lineage)}`,
      `read_context: ${rolling.read_context.join(", ")}`,
      `write_paths: ${rolling.write_paths.join(", ")}`,
      `allowed_operations: ${rolling.allowed_operations.join(", ")}`,
      `completion_criteria: ${rolling.completion_criteria.join("; ")}`,
      `permitted_validation: ${rolling.permitted_validation.join("; ")}`,
      `coordination: ${rolling.coordination}`,
      "",
      "Imperative policy:",
      "Follow the contract exactly. Do not spawn child agents, change the plan, stage, commit, branch, rebase, or modify OpenSpec, Receipt, dispatch, or CLI artifacts.",
      rolling.mode === "patch-only"
        ? "Write only the exact write_paths, and use only the listed allowed_operations; do not write any other path."
        : "Perform verification only; do not write, create, delete, rename, chmod, stage, commit, or otherwise mutate any file.",
      "If the contract or a required decision is missing, stop. Return exactly one structured JSON object with code PLAN_INSUFFICIENT and string fields file, symbol, and missing_decision: {\"code\":\"PLAN_INSUFFICIENT\",\"file\":\"...\",\"symbol\":\"...\",\"missing_decision\":\"...\"}.",
    );
    if (rolling.worktree_mode === "isolated-worktree" || rolling.worktree_mode === "shared-worktree") {
      lines.push(
        "",
        renderWorktreeWorkerPolicy({
          worktree_mode: rolling.worktree_mode,
          repository_id: rolling.repository_id,
          git_common_dir_identity: rolling.git_common_dir_identity,
          execution_root: rolling.execution_root,
          base_tree: rolling.base_tree,
          worktree_record_id: rolling.worktree_record_id,
          patch_instructions: patchInstructions,
          permitted_validation: rolling.permitted_validation,
        }),
      );
    }
  } else if ("mode" in unit) {
    const compiled = unit as CompiledWorkUnitContract;
    lines.push(
      "",
      "[Baton compiled execution contract]",
      `schema_version: ${compiled.schema_version}`,
      `objective: ${compiled.objective}`,
      `deliverable: ${compiled.deliverable}`,
      `done_when: ${compiled.done_when}`,
      `mode: ${compiled.mode}`,
      `run_id: ${compiled.run_id}`,
      `plan_revision: ${compiled.plan_revision}`,
      `plan_fingerprint: ${compiled.plan_fingerprint}`,
      `unit_id: ${compiled.unit_id}`,
      `task_refs: ${compiled.task_refs.join(", ")}`,
      `satisfied_dependencies: ${compiled.satisfied_dependencies.join(", ")}`,
      `read_context: ${compiled.read_context.join(", ")}`,
      `write_paths: ${compiled.write_paths.join(", ")}`,
      `allowed_operations: ${compiled.allowed_operations.join(", ")}`,
      `patch_recipe: ${compiled.patch_recipe}`,
      `completion_criteria: ${compiled.completion_criteria.join("; ")}`,
      `permitted_validation: ${compiled.permitted_validation.join("; ")}`,
      `coordination: ${compiled.coordination}`,
      "",
      "Imperative policy:",
      "Follow the contract exactly. Do not spawn child agents, change the plan, stage, commit, branch, rebase, or modify OpenSpec, Receipt, dispatch, or CLI artifacts.",
      compiled.mode === "patch-only"
        ? "Write only the exact write_paths, and use only the listed allowed_operations; do not write any other path."
        : "Perform verification only; do not write, create, delete, rename, chmod, stage, commit, or otherwise mutate any file.",
      "If the recipe or a required decision is missing, stop. Return exactly one structured JSON object with code PLAN_INSUFFICIENT and string fields file, symbol, and missing_decision: {\"code\":\"PLAN_INSUFFICIENT\",\"file\":\"...\",\"symbol\":\"...\",\"missing_decision\":\"...\"}.",
    );
  } else {
    lines.push("Do not spawn child agents.");
  }
  return lines.join("\n");
}
