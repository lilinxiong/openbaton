import { availabilityForRoute } from "./model-availability.js";
import { RollingExecutionRun } from "./rolling-run.js";
import { collectRollingUnitVersions } from "./rolling-dispatch-state.js";
import { readPersistedWorktreeRecord } from "./worktree-execution.js";
import { UnitVersion } from "./rolling-plan.js";
import {
  RollingControlContext,
  RollingControlError
} from "./rolling-control.js";
import { refillRollingCapacity } from "./rolling-dispatch.js";
import { selectRollingFrontier } from "./rolling-dispatch-selection.js";
import { resolveWorktreeTopology } from "./worktree-topology.js";
import { setupDetachedWorktree } from "./worktree-setup.js";
import { worktreeExecutionRootPath } from "./paths.js";
import fs from "node:fs";
import { getCliAdapter } from "../adapters/registry.js";
import type { WorktreeRecord } from "./worktree-execution-types.js";
/**
 * Frontier worktree preparation for rolling control. Split from
 * rolling-control.ts.
 */

export function routeAvailability(cwd: string, host: string, cards: readonly { route_id?: string }[], env?: NodeJS.ProcessEnv): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const routeId of [...new Set(cards.map((card) => card.route_id).filter((value): value is string => Boolean(value)))]) {
    result[routeId] = availabilityForRoute(cwd, { host, routeId }, undefined, env);
  }
  return result;
}

export function persistedRollingWorktreeRecords(
  cwd: string,
  run: RollingExecutionRun,
  env?: NodeJS.ProcessEnv,
): Record<string, WorktreeRecord> {
  const records: Record<string, WorktreeRecord> = {};
  const units = collectRollingUnitVersions(run.accepted_deltas);
  const attempts = run.accepted_deltas.flatMap((delta) => delta.retry_attempts || []);
  for (const [ref, unit] of units) {
    if (unit.worktree_mode !== "isolated-worktree") continue;
    const attempt = Math.max(1, ...attempts
      .filter((item) => item.unit_key === unit.unit_key && item.unit_version === unit.version)
      .map((item) => item.attempt));
    try {
      records[ref] = readPersistedWorktreeRecord(cwd, run.identity.run_id, unit.unit_key, `attempt-${attempt}`, env);
    } catch {
      // Keep the identity absent. The exact-root blueprint boundary emits the
      // stable fail-closed diagnostic and never accepts caller self-attestation.
    }
  }
  return records;
}

export function worktreeAttempt(run: RollingExecutionRun, unit: UnitVersion): number {
  return Math.max(1, ...run.accepted_deltas.flatMap((delta) => delta.retry_attempts || [])
    .filter((item) => item.unit_key === unit.unit_key && item.unit_version === unit.version)
    .map((item) => item.attempt));
}

export function schedulingExecutionRoots(records: Readonly<Record<string, WorktreeRecord>>): Record<string, { repository_id: string; execution_root: string; base_tree: string }> {
  return Object.fromEntries(Object.entries(records).map(([ref, record]) => [ref, {
    repository_id: record.repository_id,
    execution_root: record.execution_root,
    base_tree: record.base_tree,
  }]));
}

export async function prepareRollingFrontierWorktrees(
  context: RollingControlContext & { run_id: string },
  run: RollingExecutionRun,
  refillInput: Parameters<typeof refillRollingCapacity>[0],
): Promise<void> {
  const records = persistedRollingWorktreeRecords(context.cwd, run, context.env);
  const selection = selectRollingFrontier({
    ...refillInput,
    execution_roots_by_unit: schedulingExecutionRoots(records),
  });
  const units = collectRollingUnitVersions(run.accepted_deltas);
  const targets = selection.frontier
    .map((ref) => ({ ref, unit: units.get(ref) }))
    .filter((entry): entry is { ref: string; unit: UnitVersion } => entry.unit?.execution_mode === "patch-only" && entry.unit.worktree_mode === "isolated-worktree");
  if (!targets.length) return;

  const adapter = getCliAdapter(run.identity.host, context.env || process.env);
  if (adapter.host.exactExecutionRoot !== true) {
    throw new RollingControlError(
      `adapter ${run.identity.host} cannot guarantee exact execution-root dispatch`,
      "ADAPTER_EXACT_ROOT_UNSUPPORTED",
    );
  }

  // Prepare only the selected capacity frontier. A large change therefore
  // reaches its first useful mutation without creating every future root.
  const callerRoot = fs.realpathSync(context.cwd);
  for (const { ref, unit } of targets) {
    if (records[ref]) continue;
    const topology = resolveWorktreeTopology(callerRoot, unit.write_paths || []);
    if (topology.requires_repository_decomposition || topology.repositories.length !== 1) {
      throw new RollingControlError(
        `isolated unit ${ref} must be decomposed into one repository-local unit before setup`,
        "REPOSITORY_LOCAL_PARTS_REQUIRED",
      );
    }
    const repository = topology.repositories[0]!;
    if (fs.realpathSync(repository.repository_root) !== callerRoot) {
      throw new RollingControlError(
        `isolated unit ${ref} is owned by ${repository.repository_root}; run it from that repository root`,
        "WORKTREE_REPOSITORY_ROOT_MISMATCH",
      );
    }
    const attemptId = `attempt-${worktreeAttempt(run, unit)}`;
    try {
      await setupDetachedWorktree({
        repository_root: repository.repository_root,
        repository_id: repository.repository_id,
        git_common_dir: repository.git_common_dir,
        git_common_dir_identity: repository.git_common_dir_identity,
        execution_root: worktreeExecutionRootPath(callerRoot, run.identity.run_id, unit.unit_key, attemptId, context.env),
        run_id: run.identity.run_id,
        unit_key: unit.unit_key,
        unit_version: unit.version,
        attempt_id: attemptId,
        ...(selection.inherited_base_trees[ref] ? { base: selection.inherited_base_trees[ref] } : {}),
        env: context.env,
        created_at: context.now,
      });
    } catch (cause) {
      const coded = cause as { code?: unknown; message?: unknown };
      throw new RollingControlError(
        typeof coded.message === "string" ? coded.message : `isolated worktree setup failed for ${ref}`,
        typeof coded.code === "string" ? coded.code : "WORKTREE_SETUP_FAILED",
      );
    }
  }
}
