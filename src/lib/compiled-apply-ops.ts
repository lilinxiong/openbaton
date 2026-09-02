import { ApplyExecutionPlan } from "./apply-plan.js";
import {
  OpenSpecApplyInstructions,
  resolveOpenSpecApplyInstructions
} from "./openspec.js";
import { ApplySourceCaptureRequest } from "./apply-source.js";
import { HostId } from "./hosts.js";
import {
  CompiledApplyIngestionResult,
  ingestInitialApplyExecutionPlan,
  ingestSuccessorApplyExecutionPlan,
  materializeCompiledApplyFrontier
} from "./compiled-apply.js";
import {
  CompiledApplyCliError,
  CompiledApplyCliResult
} from "./compiled-apply-cli.js";
import {
  compactFrontier,
  openSpecSummary,
  routingInputs,
  runWithFacts
} from "./compiled-apply-status.js";
import {
  ApplyRunState,
  readApplyRun
} from "./apply-run.js";
import {
  canonicalChange,
  coded,
  planUnitReads,
  requirePlan,
  requireSession,
  resolveInvocationPath,
  samePath,
  text
} from "./compiled-apply-shared.js";
import path from "node:path";
import { acceptApplyGate, deriveApplyTaskEligibility, reconcileApplyRun, type ApplyTaskEligibility } from "./apply-reconcile.js";
import { openspecCliAvailable } from "./openspec.js";
import type { CompiledApplyInvocation } from "../cli.js";
/**
 * Plan/accept-gate/reconcile operations for the compiled-apply CLI handler.
 * Split from compiled-apply-cli.ts.
 */

export function sourceRequest(
  cwd: string,
  plan: ApplyExecutionPlan,
  instructions: OpenSpecApplyInstructions,
): ApplySourceCaptureRequest {
  const contextFiles = instructions.contextFiles.map((file) => ({
    ...(file.artifact ? { artifact: file.artifact } : {}),
    path: file.path,
    sha256: file.sha256,
  }));
  const sourceRoot = path.resolve(plan.source_snapshot.repo_root);
  const currentRoot = path.resolve(cwd);
  if (sourceRoot !== currentRoot) {
    throw new CompiledApplyCliError(
      "APPLY_PLAN_REPOSITORY_MISMATCH",
      `APPLY_PLAN_REPOSITORY_MISMATCH: plan repo_root ${sourceRoot} does not match invocation root ${currentRoot}`,
    );
  }
  const selected = new Set(plan.selected_tasks);
  const pending = new Set(instructions.pendingTaskNumbers);
  const missing = [...selected].filter((task) => !pending.has(task)).sort();
  if (missing.length) {
    throw new CompiledApplyCliError(
      "APPLY_PLAN_TASK_NOT_PENDING",
      `APPLY_PLAN_TASK_NOT_PENDING: selected tasks are no longer pending: ${missing.join(", ")}`,
    );
  }
  if (plan.source_snapshot.tasks_path && !samePath(plan.source_snapshot.tasks_path, instructions.taskLedger.path, cwd)) {
    throw new CompiledApplyCliError(
      "APPLY_PLAN_TASK_LEDGER_MISMATCH",
      "APPLY_PLAN_TASK_LEDGER_MISMATCH: plan task ledger differs from OpenSpec instructions",
    );
  }
  return {
    repo_root: sourceRoot,
    open_spec: {
      context_files: contextFiles,
      context_file_hashes: Object.fromEntries(Object.entries(instructions.contextFileHashes).sort(([a], [b]) => a.localeCompare(b))),
      selected_task_snapshot_fingerprint: instructions.selectedTaskSnapshotFingerprint,
      selected_task_numbers: [...instructions.selectedTaskNumbers].sort(),
      selected_tasks: instructions.selectedTasks,
      task_ledger: instructions.taskLedger,
      task_ledger_identity: instructions.taskLedgerIdentity,
    tasks_path: resolveInvocationPath(cwd, instructions.taskLedger.path),
      schema: instructions.schema,
      change_name: instructions.changeName,
    },
    units: plan.units.map((unit) => ({
      id: unit.id,
      read_paths: planUnitReads(unit),
      write_paths: [...(unit.write_paths || [])],
    })),
  };
}

export function resolveInstructions(cwd: string, plan: ApplyExecutionPlan, requestedChange: string | null, env: NodeJS.ProcessEnv = process.env): OpenSpecApplyInstructions {
  const planChange = text(plan.identity.change_id);
  if (!planChange) throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: plan identity.change_id is empty");
  if (requestedChange && canonicalChange(requestedChange) !== canonicalChange(planChange)) {
    throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: requested change does not match plan identity");
  }
  try {
    const cli = openspecCliAvailable(env);
    if (!cli) throw new CompiledApplyCliError("APPLY_INSTRUCTIONS_FAILED", "APPLY_INSTRUCTIONS_FAILED: OpenSpec CLI is not available");
    const instructions = resolveOpenSpecApplyInstructions(cwd, planChange, { cli });
    if (canonicalChange(instructions.changeName) !== canonicalChange(planChange)) {
      throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: OpenSpec returned a different change");
    }
    return instructions;
  } catch (error) {
    if (error instanceof CompiledApplyCliError) throw error;
    throw coded(error, "APPLY_INSTRUCTIONS_FAILED");
  }
}


export function stablePlanResult(input: CompiledApplyInvocation, host: HostId, result: CompiledApplyIngestionResult, frontier: Record<string, unknown> | null): CompiledApplyCliResult {
  return {
    code: result.mode === "initial" ? "COMPILED_APPLY_INITIAL_PERSISTED" : "COMPILED_APPLY_SUCCESSOR_PERSISTED",
    operation: "plan",
    mode: result.mode,
    run_id: result.run.run_id,
    change: result.run.change,
    host: result.run.host,
    session_uid: result.run.session_uid,
    revision: result.run.current_revision,
    fingerprint: result.run.current_fingerprint,
    identity: { run_id: result.run.run_id, change: result.run.change, host: result.run.host, session_uid: result.run.session_uid, revision: result.run.current_revision, fingerprint: result.run.current_fingerprint },
    source: openSpecSummary(result.source),
    persisted: { code: result.mode === "initial" ? "RUN_INITIAL_PERSISTED" : "RUN_SUCCESSOR_PERSISTED", run_id: result.run.run_id, revision: result.run.current_revision, fingerprint: result.run.current_fingerprint },
    parent: result.mode === "successor" ? { revision: result.run.revisions.at(-1)?.parent_revision || null, fingerprint: result.run.revisions.at(-1)?.parent_fingerprint || null } : null,
    frontier,
    run: result.run,
    plan: { plan_id: result.plan.identity.plan_id, change_id: result.plan.identity.change_id, selected_tasks: [...result.plan.selected_tasks], unit_ids: result.plan.units.map((unit) => unit.id).sort() },
    requested_dispatch: input.dispatch,
    selected_host: host,
  };
}

export async function persistPlan(input: CompiledApplyInvocation, host: HostId): Promise<CompiledApplyCliResult> {
  const plan = requirePlan(input);
  let validated: ApplyExecutionPlan;
  try {
    // Keep validation in the ingestion boundary, but fail with a stable CLI
    // code before resolving OpenSpec when the JSON shape is plainly invalid.
    validated = (await import("./apply-plan.js")).assertValidApplyExecutionPlan(plan);
  } catch (error) {
    throw coded(error, "INVALID_PLAN");
  }
  const instructions = resolveInstructions(input.cwd, validated, input.change, input.env);
  const source = sourceRequest(input.cwd, validated, instructions);
  if (input.mode === "successor") {
    const runId = text(input.run || input.run_id);
    if (runId && validated.identity.plan_id !== runId) {
      throw new CompiledApplyCliError(
        "RUN_ID_MISMATCH",
        "RUN_ID_MISMATCH: successor plan identity.plan_id does not match --run",
      );
    }
    const parent = text(validated.revision_lineage?.parent);
    if (!parent) {
      throw new CompiledApplyCliError(
        "RUN_PARENT_MISMATCH",
        "RUN_PARENT_MISMATCH: successor plan must declare revision_lineage.parent",
      );
    }
    let current: ApplyRunState;
    try {
      current = readApplyRun(input.cwd, runId || "", { env: input.env });
    } catch (error) {
      throw coded(error, "RUN_NOT_FOUND");
    }
    if (parent !== current.current_revision) {
      throw new CompiledApplyCliError(
        "RUN_PARENT_MISMATCH",
        `RUN_PARENT_MISMATCH: successor parent ${parent} does not match current revision ${current.current_revision}`,
      );
    }
    // The parent fingerprint is deliberately read from the current run, not
    // trusted from plan JSON.  appendApplyRun receives and checks this exact
    // value under its lock, so a stale concurrent successor cannot advance the
    // run even when its revision number happens to match.
  }
  let persisted: CompiledApplyIngestionResult;
  try {
    persisted = input.mode === "successor"
      ? await ingestSuccessorApplyExecutionPlan({ cwd: input.cwd, env: input.env, host, runId: input.run || input.run_id || undefined, change: validated.identity.change_id, plan: validated, sourceRequest: source })
      : await ingestInitialApplyExecutionPlan({ cwd: input.cwd, env: input.env, host, runId: validated.identity.plan_id, change: validated.identity.change_id, plan: validated, sourceRequest: source });
  } catch (error) {
    throw coded(error, input.mode === "successor" ? "RUN_SUCCESSOR_REJECTED" : "RUN_INITIAL_REJECTED");
  }
  let frontier: Record<string, unknown> | null = null;
  if (input.dispatch) {
    try {
      const route = routingInputs(input.cwd, host, input.env);
      const result = await materializeCompiledApplyFrontier({ cwd: input.cwd, env: input.env, host, runId: persisted.run.run_id, capacity: route.capacity, cards: route.cards, automaticCards: route.automaticCards, codingModels: route.codingModels });
      frontier = compactFrontier(result);
    } catch (error) {
      throw coded(error, "COMPILED_APPLY_FRONTIER_FAILED");
    }
  }
  return stablePlanResult(input, host, persisted, frontier);
}

export function acceptGateResult(input: CompiledApplyInvocation, host: HostId): CompiledApplyCliResult {
  const runId = text(input.run || input.run_id);
  if (!runId || !input.accept_gate) throw new CompiledApplyCliError("GATE_IDENTITY_MISMATCH", "GATE_IDENTITY_MISMATCH: run and gate are required");
  const { state } = runWithFacts(input.cwd, runId, input.env);
  const sessionUid = requireSession(input.env);
  if (state.host !== host) throw new CompiledApplyCliError("RUN_HOST_MISMATCH", "RUN_HOST_MISMATCH: run host differs from requested host");
  if (state.session_uid !== sessionUid) throw new CompiledApplyCliError("SESSION_SCOPE_MISMATCH", "SESSION_SCOPE_MISMATCH: run belongs to another Baton session");
  if (input.change && canonicalChange(input.change) !== canonicalChange(state.change)) throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: requested change differs from run");
  const evidence = text(input.text).replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 240);
  if (!evidence) throw new CompiledApplyCliError("GATE_IDENTITY_MISMATCH", "GATE_IDENTITY_MISMATCH: gate evidence is empty");
  let accepted: ReturnType<typeof acceptApplyGate>;
  try {
    accepted = acceptApplyGate({ cwd: input.cwd, env: input.env, host, runId, gateId: input.accept_gate, revision: state.current_revision, fingerprint: state.current_fingerprint, evidence });
  } catch (error) {
    throw coded(error, "GATE_ACCEPT_REJECTED");
  }
  return {
    code: "COMPILED_APPLY_GATE_ACCEPTED",
    operation: "accept-gate",
    mode: "accept-gate",
    run_id: accepted.run_id,
    change: state.change,
    host: state.host,
    session_uid: state.session_uid,
    revision: accepted.revision,
    fingerprint: accepted.fingerprint,
    gate: { id: accepted.id, accepted: accepted.accepted, evidence: accepted.evidence, code: accepted.code || null },
    identity: { run_id: accepted.run_id, gate_id: accepted.id, revision: accepted.revision, fingerprint: accepted.fingerprint },
    requested_dispatch: false,
  };
}

export function reconcileResult(input: CompiledApplyInvocation, host: HostId): CompiledApplyCliResult {
  const runId = text(input.run || input.run_id);
  if (!runId) throw new CompiledApplyCliError("RUN_ID_MISMATCH", "RUN_ID_MISMATCH: --run is required");
  const { state, plan } = runWithFacts(input.cwd, runId, input.env);
  const sessionUid = requireSession(input.env);
  if (state.host !== host) throw new CompiledApplyCliError("RUN_HOST_MISMATCH", "RUN_HOST_MISMATCH: run host differs from requested host");
  if (state.session_uid !== sessionUid) throw new CompiledApplyCliError("SESSION_SCOPE_MISMATCH", "SESSION_SCOPE_MISMATCH: run belongs to another Baton session");
  if (input.change && canonicalChange(input.change) !== canonicalChange(state.change)) throw new CompiledApplyCliError("RUN_CHANGE_MISMATCH", "RUN_CHANGE_MISMATCH: requested change differs from run");
  const tasksPath = plan.source_snapshot.tasks_path
    ? resolveInvocationPath(input.cwd, plan.source_snapshot.tasks_path)
    : path.join(input.cwd, "openspec", "changes", state.change, "tasks.md");
  let eligibility: ApplyTaskEligibility[];
  try {
    eligibility = deriveApplyTaskEligibility({ cwd: input.cwd, env: input.env, runId, tasksPath, task: input.task || undefined });
  } catch (error) {
    throw coded(error, "RECONCILE_ELIGIBILITY_FAILED");
  }
  let reconciled;
  const evidence = `reconciled run ${runId} revision ${state.current_revision}`;
  try {
    reconciled = reconcileApplyRun({ cwd: input.cwd, env: input.env, runId, tasksPath, task: input.task || undefined, evidence });
  } catch (error) {
    throw coded(error, "RECONCILE_FAILED");
  }
  const conclusions = Object.fromEntries(reconciled.task_ids.map((task) => [task, evidence]));
  return {
    code: "COMPILED_APPLY_RECONCILED",
    operation: "reconcile",
    mode: "reconcile",
    run_id: reconciled.run_id,
    change: state.change,
    host: state.host,
    session_uid: state.session_uid,
    revision: state.current_revision,
    fingerprint: state.current_fingerprint,
    reconciled: reconciled.reconciled,
    task_ids: [...reconciled.task_ids].sort(),
    eligibility,
    conclusions,
    ledger: reconciled.ledger,
    identity: { run_id: state.run_id, change: state.change, host: state.host, session_uid: state.session_uid, revision: state.current_revision, fingerprint: state.current_fingerprint },
  };
}

/** Execute one parsed compiled-apply invocation using production APIs. */
