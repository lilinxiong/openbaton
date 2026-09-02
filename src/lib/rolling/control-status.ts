import {
  ROLLING_CONTROL_SCHEMA_VERSION,
  ROLLING_RECONCILIATION_DOCUMENT_KIND,
  RollingControlContext,
  RollingControlError,
  RollingControlStatus,
  RollingTaskControlState,
  RollingTaskControlStatus,
  allGates,
  allUnits,
  executionFacts,
  sourceFromRun
} from "../rolling-control.js";
import {
  RollingAcceptanceProjection,
  deriveRollingAcceptance
} from "./acceptance.js";
import { deriveRollingLifecycle } from "./lifecycle-derive.js";
import { RollingTaskLifecycle } from "../rolling-lifecycle.js";
import { synchronizeRollingTicketFacts } from "./control-tickets.js";
import { recoverWorktreeRun } from "../worktree-lifecycle.js";
import { rollingTaskSourceRegistry } from "./control-manifest.js";
import {
  RollingExecutionRun,
  RollingFact
} from "../rolling-run.js";
/**
 * Rolling control status projection and formatting. Split from
 * rolling-control.ts.
 */

export function taskRefs(run: RollingExecutionRun, taskKey: string): { units: string[]; gates: string[] } {
  const units = new Set<string>();
  const gates = new Set<string>();
  const supersededUnits = new Set<string>();
  const supersededGates = new Set<string>();
  for (const delta of run.accepted_deltas) {
    for (const supersession of delta.supersessions || []) {
      if (supersession.owner === "unit_version") supersededUnits.add(supersession.previous);
      if (supersession.owner === "gate_version") supersededGates.add(supersession.previous);
    }
    for (const coverage of delta.task_coverage || []) {
      if (coverage.task_key !== taskKey) continue;
      for (const ref of coverage.unit_versions || []) units.add(ref);
      for (const ref of coverage.gate_versions || []) gates.add(ref);
    }
  }
  return {
    units: [...units].filter((ref) => !supersededUnits.has(ref)).sort(),
    gates: [...gates].filter((ref) => !supersededGates.has(ref)).sort(),
  };
}

export function reconciliationFacts(run: RollingExecutionRun): RollingFact[] {
  return run.facts.filter((fact) => fact.kind === ROLLING_RECONCILIATION_DOCUMENT_KIND);
}

export function lifecycleWithAcceptance(run: RollingExecutionRun, acceptance: RollingAcceptanceProjection) {
  return deriveRollingLifecycle({
    manifest_entries: run.manifest_entries,
    accepted_deltas: run.accepted_deltas,
    seals: run.seals,
    unit_states: acceptance.units,
    gate_states: acceptance.gates,
    facts: reconciliationFacts(run),
  });
}

export function taskControlState(lifecycle: RollingTaskLifecycle, refs: { units: string[]; gates: string[] }, acceptance: RollingAcceptanceProjection): RollingTaskControlState {
  if (lifecycle.reconciled) return "reconciled";
  if (lifecycle.sealed) return "sealed";
  const unitStates = refs.units.map((ref) => acceptance.units[ref]?.state || "queued");
  const gateStates = refs.gates.map((ref) => acceptance.gates[ref]?.state || "pending");
  if (unitStates.includes("terminal-unreleased")) return "terminal-unreleased";
  if (unitStates.some((state) => state === "running" || state === "reserved")) return "active";
  if (unitStates.includes("failed") || gateStates.includes("failed") || lifecycle.state === "blocked") return "blocked";
  if (refs.units.length + refs.gates.length === 0) return "unplanned";
  if (refs.units.every((ref) => acceptance.units[ref]?.accepted) && refs.gates.every((ref) => acceptance.gates[ref]?.accepted)) return "accepted";
  return "planned";
}

export function nextAction(state: RollingTaskControlState, runId: string, taskKey: string): string | null {
  if (state === "unplanned") return `baton run ${runId} --append-plan <delta.json> --dispatch`;
  if (state === "planned") return `baton run ${runId} --status`;
  if (state === "active") return "await native completion";
  if (state === "terminal-unreleased") return "baton dispatch release <ticket> --host <host>";
  if (state === "blocked") return `baton run ${runId} --append-plan <successor-delta.json> --dispatch`;
  if (state === "accepted") return `baton run ${runId} --seal-task ${taskKey} --seal-file <seal.json>`;
  if (state === "sealed") return `baton run ${runId} --reconcile --task ${taskKey}`;
  return null;
}


export async function statusRollingControl(context: RollingControlContext & { run_id: string }): Promise<RollingControlStatus> {
  const recovered = synchronizeRollingTicketFacts(context);
  const run = recovered.run;
  const worktreeRecovery = await recoverWorktreeRun({ cwd: context.cwd, env: context.env, run_id: context.run_id, tickets: recovered.tickets, at: context.now });
  const source = sourceFromRun(run);
  const sourceDiagnostics = await rollingTaskSourceRegistry(context.cwd, source).diagnostics(source);
  const acceptance = deriveRollingAcceptance({ units: allUnits(run), gates: allGates(run), facts: executionFacts(run) });
  const lifecycle = lifecycleWithAcceptance(run, acceptance);
  const ticketByTask = new Map<string, Set<string>>();
  for (const ticket of recovered.tickets) {
    for (const taskKey of ticket.rolling_unit_lineage?.task_keys || []) {
      const ids = ticketByTask.get(taskKey) || new Set<string>();
      ids.add(ticket.id);
      ticketByTask.set(taskKey, ids);
    }
  }
  const tasks = run.manifest_entries.map((entry) => {
    const localLifecycle = lifecycle.task_lifecycle[entry.task_key];
    const refs = taskRefs(run, entry.task_key);
    if (!localLifecycle) throw new RollingControlError(`rolling lifecycle omitted manifest task ${entry.task_key}`, "ROLLING_STATE_CORRUPT");
    const state = taskControlState(localLifecycle, refs, acceptance);
    const blockers = [
      ...localLifecycle.blockers,
      ...refs.units.flatMap((ref) => acceptance.units[ref]?.blockers || []),
      ...refs.gates.flatMap((ref) => acceptance.gates[ref]?.blockers || []),
    ].map((item) => ({ code: item.code, message: item.message, ...(item.refs?.length ? { refs: [...item.refs] } : {}) }));
    return {
      task_key: entry.task_key,
      display_id: entry.display_id,
      title: entry.title,
      state,
      source_state: entry.source_state,
      unit_versions: refs.units,
      gate_versions: refs.gates,
      unit_states: Object.fromEntries(refs.units.map((ref) => [ref, acceptance.units[ref]?.state || "queued"])),
      gate_states: Object.fromEntries(refs.gates.map((ref) => [ref, acceptance.gates[ref]?.state || "pending"])),
      ticket_ids: [...(ticketByTask.get(entry.task_key) || [])].sort(),
      blockers,
      next_legal_action: nextAction(state, context.run_id, entry.task_key),
    } satisfies RollingTaskControlStatus;
  });
  const task_status = Object.fromEntries(tasks.map((task) => [task.task_key, task]));
  const state = tasks.length > 0 && tasks.every((task) => task.state === "reconciled")
    ? "reconciled"
    : tasks.length > 0 && tasks.every((task) => task.state === "sealed" || task.state === "reconciled")
      ? "sealed"
      : tasks.some((task) => task.state === "blocked" || task.state === "terminal-unreleased")
        ? "blocked"
        : "open";
  const firstAction = tasks.map((task) => task.next_legal_action).find((value): value is string => Boolean(value)) || null;
  return {
    schema_version: ROLLING_CONTROL_SCHEMA_VERSION,
    code: "ROLLING_RUN_STATUS",
    run_id: context.run_id,
    host: run.identity.host,
    session_uid: run.identity.session_uid,
    adapter: run.identity.adapter,
    source_kind: run.identity.source_kind,
    append_sequence: run.append_sequence,
    state,
    next_legal_action: firstAction,
    tasks,
    task_status,
    acceptance,
    tickets: recovered.tickets.map((ticket) => ({
      ticket_id: ticket.id,
      unit_ref: `${ticket.rolling_unit_lineage!.unit_key}@${ticket.rolling_unit_lineage!.unit_version}`,
      status: ticket.status,
      released: Boolean(ticket.slot_released_at),
      execution_root: ticket.rolling_unit_lineage!.execution_root || null,
      progress: ticket.progress,
      liveness: ticket.liveness,
    })),
    isolation: worktreeRecovery.status,
    recovery: { appended_execution_facts: recovered.appended, repaired_worktree_record_ids: worktreeRecovery.repaired_record_ids, source_diagnostics: sourceDiagnostics.diagnostics },
  };
}


export function formatRollingControlStatus(status: RollingControlStatus): string {
  const lines = [
    `rolling run ${status.run_id}  ${status.state}`,
    `  host ${status.host}  append ${status.append_sequence}  session ${status.session_uid}`,
  ];
  const tickets = new Map(status.tickets.map((ticket) => [ticket.ticket_id, ticket]));
  for (const task of status.tasks) {
    lines.push(`  ${task.display_id}  ${task.state}  ${task.title}`);
    if (task.ticket_ids.length) lines.push(`    tickets ${task.ticket_ids.join(", ")}`);
    for (const ticketId of task.ticket_ids) {
      const progress = tickets.get(ticketId)?.progress;
      if (progress) lines.push(`    progress ${progress.phase}: ${progress.summary}`);
    }
    if (task.next_legal_action) lines.push(`    next ${task.next_legal_action}`);
    for (const blocker of task.blockers.slice(0, 3)) lines.push(`    blocked ${blocker.code}: ${blocker.message}`);
  }
  for (const isolation of status.isolation.units) {
    lines.push(`  isolation ${isolation.unit_ref}/${isolation.attempt_id}  ${isolation.lifecycle_state}  ${isolation.native_liveness}`);
    lines.push(`    root ${isolation.execution_root}  base ${isolation.base_tree}`);
    if (isolation.diff.total_changed_paths) lines.push(`    diff ${isolation.diff.total_changed_paths} paths +${isolation.diff.additions} -${isolation.diff.deletions}${isolation.diff.truncated ? " (bounded)" : ""}: ${isolation.diff.changed_paths.join(", ")}`);
    if (isolation.bundle) lines.push(`    bundle ${isolation.bundle.bundle_id}  ${isolation.bundle.state}`);
    if (isolation.integration) lines.push(`    integration ${isolation.integration.integration_id}  ${isolation.integration.state}  queue ${isolation.integration.queue_position}`);
    if (isolation.retention_reasons.length) lines.push(`    retained ${isolation.retention_reasons.join(", ")}`);
    lines.push(`    cleanup ${isolation.cleanup.status}`);
  }
  for (const diagnostic of status.isolation.orphan_diagnostics.slice(0, 5)) lines.push(`  isolation warning ${diagnostic.code}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
  if (status.next_legal_action) lines.push(`  next ${status.next_legal_action}`);
  return `${lines.join("\n")}\n`;
}
