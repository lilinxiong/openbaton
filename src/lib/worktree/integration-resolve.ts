import {
  ChangeBundleManifest,
  ChangeBundleOperation,
  IntegrationConflict
} from "./execution-types.js";
import {
  GitTreeChangeFact,
  consumeGitBinaryPaths,
  consumeGitRawTreeChanges,
  streamGitSafetyFact
} from "../git/safety-facts.js";
import {
  GitProcessOptions,
  collectGitScalar
} from "../git/safety-process.js";
import { identity } from "./integration-queue.js";
import {
  GIT_OBJECT,
  fingerprintWorktreeRuntimeRecord
} from "./execution-validation.js";
import { withOwnedLockAsync } from "../owned-lock.js";
import {
  persistIntegrationRecord,
  readPersistedIntegrationRecord
} from "../worktree-execution.js";
import { ensureWorktreeApplicationState } from "./integration-apply.js";
import { sha } from "../rolling/run-store.js";
import {
  integrationDestinationLockPath,
  integrationQueueLockPath
} from "../paths.js";
import {
  destinationIdentity,
  integrationId,
  readyBundle,
  resolveOperationKey,
  sign,
  signResolution,
  timestamp
} from "./integration-queue.js";
import {
  ResolveWorktreeIntegrationInput,
  ResolveWorktreeIntegrationResult,
  WorktreeIntegrationError
} from "../worktree-integration.js";
import fs from "node:fs";
/**
 * Conflict resolution acceptance for integrations. Split from
 * worktree-integration.ts.
 */

const OPERATION_ORDER: readonly ChangeBundleOperation[] = ["write", "create", "delete", "rename", "copy", "chmod"];

export function operationsForChange(change: GitTreeChangeFact): ChangeBundleOperation[] {
  const operations = new Set<ChangeBundleOperation>([change.operation]);
  if (change.old_mode !== change.new_mode && change.status !== "A" && change.status !== "D") operations.add("chmod");
  return OPERATION_ORDER.filter((operation) => operations.has(operation));
}

export async function auditResolutionTree(
  root: string,
  beforeTree: string,
  resolvedTree: string,
  bundle: ChangeBundleManifest,
  conflicts: readonly IntegrationConflict[],
  spawn?: GitProcessOptions["spawn"],
): Promise<{ operations: ChangeBundleOperation[]; changed_paths: string[]; non_text_facts: Record<string, unknown> }> {
  const changes = await streamGitSafetyFact(
    root,
    ["diff-tree", "--no-commit-id", "-r", "--raw", "-z", "--no-abbrev", "-M", "-C", "--find-copies-harder", beforeTree, resolvedTree],
    consumeGitRawTreeChanges,
    spawn,
  );
  const binaryPaths = await streamGitSafetyFact(
    root,
    ["diff-tree", "--no-commit-id", "-r", "--numstat", "-z", "--no-renames", beforeTree, resolvedTree],
    consumeGitBinaryPaths,
    spawn,
  );
  const authorized = new Set([...bundle.changed_paths, ...conflicts.map((conflict) => conflict.path)]);
  const changedPaths = new Set<string>();
  const operations = new Set<ChangeBundleOperation>();
  for (const change of changes) {
    const paths = [change.original_path, change.path].filter((value): value is string => Boolean(value));
    for (const pathName of paths) {
      changedPaths.add(pathName);
      if (!authorized.has(pathName)) {
        throw new WorktreeIntegrationError(
          `parent resolution changed unauthorized path ${pathName}`,
          "INTEGRATION_RESOLUTION_INVALID",
          { path: pathName },
        );
      }
    }
    for (const operation of operationsForChange(change)) operations.add(operation);
  }
  return {
    operations: OPERATION_ORDER.filter((operation) => operations.has(operation)),
    changed_paths: [...changedPaths].sort(),
    non_text_facts: {
      raw_changes: changes,
      binary_paths: binaryPaths,
      mode_changes: changes.filter((change) => change.old_mode !== change.new_mode)
        .map((change) => ({ path: change.path, old_mode: change.old_mode, new_mode: change.new_mode })),
      symlink_paths: changes.filter((change) => change.old_mode === "120000" || change.new_mode === "120000").map((change) => change.path).sort(),
      gitlink_paths: changes.filter((change) => change.old_mode === "160000" || change.new_mode === "160000").map((change) => change.path).sort(),
    },
  };
}

/** Audit and freeze one parent-authored conflict result without changing the bundle or caller. */
export async function resolveWorktreeIntegration(input: ResolveWorktreeIntegrationInput): Promise<ResolveWorktreeIntegrationResult> {
  const root = fs.realpathSync(input.repository_root);
  identity(input.run_id, "run_id");
  identity(input.bundle_id, "bundle_id");
  if (!/^[0-9a-f]{64}$/u.test(input.repository_id) || !GIT_OBJECT.test(input.resolved_tree)) {
    throw new WorktreeIntegrationError("resolution repository or tree identity is invalid", "INTEGRATION_INPUT_INVALID");
  }
  const conclusion = input.conclusion.trim();
  if (!conclusion || conclusion.length > 1000) {
    throw new WorktreeIntegrationError("resolution conclusion must contain 1-1000 characters", "INTEGRATION_INPUT_INVALID");
  }
  const operationKey = resolveOperationKey({ ...input, conclusion });
  identity(operationKey, "idempotency_key");
  const bundle = readyBundle(root, input);
  return withOwnedLockAsync(
    integrationDestinationLockPath(root, bundle.repository_id, input.env),
    () => withOwnedLockAsync(
      integrationQueueLockPath(root, input.run_id, bundle.repository_id, input.env),
      async () => {
        const actualIdentity = await destinationIdentity(root, input.spawn);
        if (actualIdentity.repository_id !== input.repository_id
          || actualIdentity.git_common_dir_identity !== bundle.git_common_dir_identity) {
          throw new WorktreeIntegrationError("resolution destination identity differs from the bundle", "INTEGRATION_IDENTITY_MISMATCH");
        }
        const id = integrationId(input.run_id, bundle.repository_id, bundle.bundle_id);
        let record = readPersistedIntegrationRecord(root, input.run_id, bundle.repository_id, id, input.env);
        if (record.state === "integrated" && record.resolution && record.idempotency_keys.includes(operationKey)) {
          if (record.resolution.resolved_tree !== input.resolved_tree || record.resolution.conclusion !== conclusion) {
            throw new WorktreeIntegrationError("resolution replay differs from the frozen result", "INTEGRATION_STATE_INVALID");
          }
          ensureWorktreeApplicationState(root, bundle, record, input.env);
          return { record, bundle, resolution: record.resolution, replayed: true };
        }
        if (record.state !== "awaiting_parent_resolution" || record.conflicts.length === 0) {
          throw new WorktreeIntegrationError(`integration cannot resolve from state ${record.state}`, "INTEGRATION_STATE_INVALID");
        }
        const resolvedTree = await collectGitScalar({ cwd: root, args: ["rev-parse", `${input.resolved_tree}^{tree}`], spawn: input.spawn });
        const audit = await auditResolutionTree(root, record.before_tree, resolvedTree, bundle, record.conflicts, input.spawn);
        const conflictFingerprint = sha(fingerprintWorktreeRuntimeRecord(record.conflicts));
        const resolution = signResolution({
          schema_version: 1,
          resolution_id: `resolution-${sha(`${record.integration_id}\u0000${conflictFingerprint}\u0000${resolvedTree}`)}`,
          integration_id: record.integration_id,
          bundle_id: bundle.bundle_id,
          before_tree: record.before_tree,
          bundle_result_tree: bundle.result_tree,
          resolved_tree: resolvedTree,
          conflict_fingerprint: conflictFingerprint,
          conclusion,
          operations: audit.operations,
          changed_paths: audit.changed_paths,
          non_text_facts: audit.non_text_facts,
          submitted_at: timestamp(input.at),
        });
        record = persistIntegrationRecord(root, sign({
          ...record,
          revision: record.revision + 1,
          state: "integrated",
          after_tree: resolvedTree,
          resolution_id: resolution.resolution_id,
          resolution,
          idempotency_keys: [...record.idempotency_keys, operationKey],
          updated_at: resolution.submitted_at,
        }), input.env);
        ensureWorktreeApplicationState(root, bundle, record, input.env);
        return { record, bundle, resolution, replayed: false };
      },
      { operation: "worktree-integration-resolve-run-queue" },
    ),
    { operation: "worktree-integration-resolve-destination" },
  );
}
