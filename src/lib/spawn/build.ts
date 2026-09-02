/**
 * Ticket construction and standalone planning. Split from spawn.ts.
 */
import type { UnknownRecord } from "../../types.js";
import type { ModelSelectionApproval } from "../../types.js";
import {
  DelegationReceipt,
  buildReadOnlyReceipt,
  normalizeCompiledApplyLineage,
  normalizeRollingUnitLineage,
  writeReceipt
} from "../receipt.js";
import {
  RollingWorkUnitContract,
  buildWorkerPrompt,
  compileRollingWorkUnit,
  compileWorkUnit,
  coordinationFor,
  type WorkUnitKind
} from "../work-unit.js";
import { sessionScope } from "../session-scope.js";
import {
  nextSpawnId,
  sessionTicketId,
  validateSpawnSessionScope,
  writeSpawn
} from "./store.js";
import type { SpawnTicket } from "../spawn.js";
import { matchModelCard, requireCardId } from "../cards.js";
import { extractExactExecutionRootIdentity } from "../../adapters/contract.js";
import type { ModelCard } from "../../types.js";


export interface BuildSpawnTicketOptions {
  id?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  description: string;
  prompt: string;
  modelId: string;
  routeId?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  source?: string;
  openspec?: UnknownRecord | null;
  taskKind: WorkUnitKind;
  deliverable?: string | null;
  doneWhen?: string | null;
  selection?: ModelSelectionApproval | null;
  targetHost?: string | null;
  now?: Date | string | number;
  /** A director-compiled apply identity. Snake/camel aliases are accepted at the boundary. */
  compiledApplyLineage?: unknown;
  compiled_apply_lineage?: unknown;
  compiledLineage?: unknown;
  compiled_lineage?: unknown;
  mode?: "patch-only" | "verification-only";
  executionMode?: "patch-only" | "verification-only";
  execution_mode?: "patch-only" | "verification-only";
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
  allowedOperations?: readonly ("write" | "create" | "delete" | "rename" | "chmod")[];
  allowed_operations?: readonly ("write" | "create" | "delete" | "rename" | "chmod")[];
  patchRecipe?: string;
  patch_recipe?: string;
  completionCriteria?: readonly string[];
  completion_criteria?: readonly string[];
  permittedValidation?: readonly string[];
  permitted_validation?: readonly string[];
  compiledWorkUnit?: unknown;
  compiled_work_unit?: unknown;
  /** A rolling unit identity. Snake/camel aliases are accepted at the boundary. */
  rollingUnitLineage?: unknown;
  rolling_unit_lineage?: unknown;
  rollingWorkUnit?: unknown;
  rolling_work_unit?: unknown;
}

export function boundaryPair(primary: unknown, alias: unknown, name: string): unknown {
  if (primary !== undefined && alias !== undefined && JSON.stringify(primary) !== JSON.stringify(alias)) {
    throw new Error(`${name} aliases do not match`);
  }
  return primary !== undefined ? primary : alias;
}

export function buildSpawnTicket({
  id: requestedId,
  cwd,
  env,
  description,
  prompt,
  modelId,
  routeId = null,
  reasoningEffort = null,
  serviceTier = null,
  source = "standalone",
  openspec = null,
  taskKind,
  deliverable = null,
  doneWhen = null,
  selection = null,
  targetHost = selection?.host || null,
  now = new Date(),
  compiledApplyLineage,
  compiled_apply_lineage,
  compiledLineage,
  compiled_lineage,
  mode: compiledMode,
  executionMode,
  execution_mode,
  runId,
  run_id,
  planRevision,
  plan_revision,
  planFingerprint,
  plan_fingerprint,
  unitId,
  unit_id,
  taskRefs,
  task_refs,
  satisfiedDependencies,
  satisfied_dependencies,
  readContext,
  read_context,
  writePaths,
  write_paths,
  allowedOperations,
  allowed_operations,
  patchRecipe,
  patch_recipe,
  completionCriteria,
  completion_criteria,
  permittedValidation,
  permitted_validation,
  compiledWorkUnit,
  compiled_work_unit,
  rollingUnitLineage,
  rolling_unit_lineage,
  rollingWorkUnit,
  rolling_work_unit,
}: BuildSpawnTicketOptions): SpawnTicket {
  const scope = sessionScope(env);
  const uid = scope.session_uid;
  const id = requestedId || (cwd ? nextSpawnId(cwd, "spn", env) : "");
  const idMatch = id.match(/^(spn|os)-([0-9a-f]{64})-(\d+)$/);
  const sessionOrdinal = idMatch && idMatch[2] === uid ? Number(idMatch[3]) : 0;
  const canonicalId = idMatch && sessionOrdinal > 0 ? sessionTicketId(idMatch[1], idMatch[2], sessionOrdinal) : null;
  if (!sessionOrdinal || canonicalId !== id) throw new Error("ticket id must use the current session uid and padded ordinal");
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const suppliedWorkUnit = compiledWorkUnit ?? compiled_work_unit;
  const suppliedRollingLineage = boundaryPair(rollingUnitLineage, rolling_unit_lineage, "rolling unit lineage");
  const suppliedRollingWorkUnit = boundaryPair(rollingWorkUnit, rolling_work_unit, "rolling work unit");
  const hasRollingInput = suppliedRollingLineage !== undefined || suppliedRollingWorkUnit !== undefined;
  const hasCompiledInput = compiledApplyLineage !== undefined
    || compiled_apply_lineage !== undefined
    || compiledLineage !== undefined
    || compiled_lineage !== undefined
    || compiledWorkUnit !== undefined
    || compiled_work_unit !== undefined
    || compiledMode !== undefined
    || executionMode !== undefined
    || execution_mode !== undefined
    || runId !== undefined
    || run_id !== undefined
    || planRevision !== undefined
    || plan_revision !== undefined
    || planFingerprint !== undefined
    || plan_fingerprint !== undefined
    || unitId !== undefined
    || unit_id !== undefined
    || taskRefs !== undefined
    || task_refs !== undefined
    || satisfiedDependencies !== undefined
    || satisfied_dependencies !== undefined
    || patchRecipe !== undefined
    || patch_recipe !== undefined;
  if (hasRollingInput && hasCompiledInput) {
    throw new Error("compiled and rolling work-unit inputs are mutually exclusive");
  }
  const suppliedLineage = compiledApplyLineage ?? compiled_apply_lineage ?? compiledLineage ?? compiled_lineage
    ?? (suppliedWorkUnit && typeof suppliedWorkUnit === "object" ? {
      run_id: (suppliedWorkUnit as Record<string, unknown>).run_id,
      plan_revision: (suppliedWorkUnit as Record<string, unknown>).plan_revision,
      plan_fingerprint: (suppliedWorkUnit as Record<string, unknown>).plan_fingerprint,
      unit_id: (suppliedWorkUnit as Record<string, unknown>).unit_id,
      task_refs: (suppliedWorkUnit as Record<string, unknown>).task_refs,
      mode: (suppliedWorkUnit as Record<string, unknown>).mode,
    } : undefined);
  const inferredMode = compiledMode ?? executionMode ?? execution_mode;
  const lineage = suppliedLineage === undefined && inferredMode === undefined
    ? undefined
    : normalizeCompiledApplyLineage(suppliedLineage ?? {
      run_id: run_id ?? runId,
      plan_revision: plan_revision ?? planRevision,
      plan_fingerprint: plan_fingerprint ?? planFingerprint,
      unit_id: unit_id ?? unitId,
      task_refs: task_refs ?? taskRefs,
      mode: inferredMode,
    });
  const requestedRollingLineage = suppliedRollingLineage === undefined
    ? undefined
    : normalizeRollingUnitLineage(suppliedRollingLineage);
  const workUnit = suppliedRollingWorkUnit !== undefined
    ? compileRollingWorkUnit(suppliedRollingWorkUnit)
    : requestedRollingLineage
    ? compileRollingWorkUnit(description, {
      mode: requestedRollingLineage!.mode,
      rolling_unit_lineage: requestedRollingLineage,
      deliverable: deliverable || description,
      doneWhen: doneWhen || description,
      read_context: read_context ?? readContext ?? [],
      write_paths: write_paths ?? writePaths ?? [],
      allowed_operations: allowed_operations ?? allowedOperations ?? [],
      completion_criteria: completion_criteria ?? completionCriteria ?? [description],
      permitted_validation: permitted_validation ?? permittedValidation ?? ["read"],
    })
    : suppliedWorkUnit
    ? compileWorkUnit(suppliedWorkUnit)
    : lineage
    ? compileWorkUnit(description, {
      kind: "concrete",
      deliverable: deliverable || description,
      doneWhen: doneWhen || description,
      mode: lineage.mode,
      run_id: lineage.run_id,
      plan_revision: lineage.plan_revision,
      plan_fingerprint: lineage.plan_fingerprint,
      unit_id: lineage.unit_id,
      task_refs: lineage.task_refs,
      satisfied_dependencies: satisfied_dependencies ?? satisfiedDependencies ?? [],
      read_context: read_context ?? readContext ?? [],
      write_paths: write_paths ?? writePaths ?? [],
      allowed_operations: allowed_operations ?? allowedOperations ?? [],
      patch_recipe: patch_recipe ?? patchRecipe ?? description,
      completion_criteria: completion_criteria ?? completionCriteria ?? [description],
      permitted_validation: permitted_validation ?? permittedValidation ?? ["read"],
    })
    : compileWorkUnit(description, { kind: taskKind, deliverable, doneWhen });
  const rollingLineage = requestedRollingLineage
    ?? (workUnit.schema_version === 3 ? (workUnit as RollingWorkUnitContract).rolling_unit_lineage : undefined);
  if (lineage && workUnit.schema_version === 2) {
    for (const field of ["run_id", "plan_revision", "plan_fingerprint", "unit_id", "task_refs", "mode"] as const) {
      if (JSON.stringify(lineage[field]) !== JSON.stringify(workUnit[field])) throw new Error(`compiled work unit lineage mismatch: ${field}`);
    }
  }
  if (rollingLineage && workUnit.schema_version === 3
    && JSON.stringify(rollingLineage) !== JSON.stringify((workUnit as RollingWorkUnitContract).rolling_unit_lineage)) {
    throw new Error("rolling work unit lineage mismatch");
  }
  const coordination = coordinationFor(workUnit);
  const exactRoot = workUnit.schema_version === 3
    ? extractExactExecutionRootIdentity(workUnit)
    : undefined;
  return {
    schema_version: 8,
    id,
    session_uid: uid,
    session_ordinal: sessionOrdinal,
    description,
    prompt: buildWorkerPrompt(prompt, workUnit, coordination),
    work_unit: workUnit,
    coordination,
    progress: null,
    liveness: null,
    model_id: modelId,
    route_id: routeId,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    fork_context: false,
    mode: "read-only",
    read_only: true,
    source,
    openspec,
    queue: "enqueue",
    status: "queued",
    attempt: 0,
    max_attempts: 1,
    execution_handle: null,
    host: null,
    ...(targetHost ? { target_host: targetHost } : {}),
    error: null,
    conclusion: null,
    receipt_id: null,
    selection: selection ? structuredClone(selection) : null,
    created_at: createdAt,
    updated_at: createdAt,
    history: [{ event: "ticket_queued", at: createdAt }],
    ...(lineage ? { compiled_apply_lineage: lineage } : {}),
    ...(rollingLineage ? { rolling_unit_lineage: rollingLineage } : {}),
    ...(exactRoot || {}),
  };
}

/**
 * Card-route one standalone unit. Queue instead of refusing.
 */
export interface PlanStandaloneOptions {
  description: string;
  prompt?: string | null;
  cards: ModelCard[];
  explicitModel?: string | null;
  queue?: unknown;
  cwd: string;
  taskKind: WorkUnitKind;
  deliverable?: string | null;
  doneWhen?: string | null;
  selectionApproval?: ModelSelectionApproval | null;
  host?: string | null;
  forceDelegate?: boolean;
  env?: NodeJS.ProcessEnv;
  id?: string;
}

export type StandalonePlan =
  | { director_local: true; reason: string; description: string }
  | { director_local: false; ticket: SpawnTicket; receipt: DelegationReceipt; queue: { running: number; queued: number } };

export function planStandaloneSpawn({ description, prompt = null, cards, explicitModel, queue, cwd, taskKind, deliverable, doneWhen, selectionApproval = null, host = null, forceDelegate: _forceDelegate = false, env, id: requestedId }: PlanStandaloneOptions): StandalonePlan {
  void queue;
  const card = explicitModel
    ? requireCardId(explicitModel, cards)
    : matchModelCard(description, cards).card;
  const id = requestedId || nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    id,
    cwd,
    env,
    description,
    prompt: prompt || description,
    modelId: card.id,
    routeId: card.route_id || null,
    reasoningEffort: card.reasoning_effort || null,
    serviceTier: selectionApproval?.service_tier || null,
    source: "standalone",
    taskKind,
    deliverable,
    doneWhen,
    selection: selectionApproval,
    targetHost: host || selectionApproval?.host || null,
  });
  const resolvedHost = host || selectionApproval?.host || null;
  const receipt = buildReadOnlyReceipt({ ticketId: id, card, maxAttempts: ticket.max_attempts, issuedAt: ticket.created_at, selection: selectionApproval, host: resolvedHost });
  ticket.receipt_id = receipt.receipt_id;
  return { director_local: false, ticket, receipt, queue: { running: 0, queued: 1 } };
}

export function persistStandalonePlan(cwd: string, planned: StandalonePlan, env?: NodeJS.ProcessEnv): SpawnTicket {
  if (planned.director_local === true) throw new Error("ops dispatch unexpectedly stayed on the director");
  // Validate before writing the Receipt so a cross-session caller leaves no
  // partial lifecycle artifact behind.
  validateSpawnSessionScope(planned.ticket, env);
  writeReceipt(cwd, planned.receipt, env);
  return writeSpawn(cwd, planned.ticket, env);
}
