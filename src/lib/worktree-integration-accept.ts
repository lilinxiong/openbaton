import {
  ChangeBundleManifest,
  IntegrationBeginAuthorization,
  IntegrationRecord
} from "./worktree-execution-types.js";
import { readRollingExecutionRun } from "./rolling-run.js";
import {
  AcceptWorktreeIntegrationInput,
  AcceptWorktreeIntegrationResult,
  WorktreeIntegrationError
} from "./worktree-integration.js";
import { acceptRollingGate } from "./rolling-control.js";
import { identity } from "./worktree-integration-queue.js";
import { withOwnedLockAsync } from "./owned-lock.js";
import {
  integrationDestinationLockPath,
  integrationQueueLockPath
} from "./paths.js";
import {
  acceptOperationKey,
  captureBeginAuthorization,
  destinationIdentity,
  integrationId,
  readyBundle,
  sign,
  signAcceptance,
  timestamp
} from "./worktree-integration-queue.js";
import {
  persistIntegrationRecord,
  readPersistedIntegrationRecord,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord
} from "./worktree-execution.js";
import {
  GitProcessOptions,
  runGitProcess
} from "./git-safety-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Final acceptance of integrated trees into the caller worktree. Split from
 * worktree-integration.ts.
 */

export function sameCallerControl(left: IntegrationBeginAuthorization, right: IntegrationBeginAuthorization): boolean {
  return left.head === right.head
    && left.head_tree === right.head_tree
    && left.branch_ref === right.branch_ref
    && left.refs_digest === right.refs_digest
    && left.reflog.count === right.reflog.count
    && left.reflog.checksum === right.reflog.checksum
    && left.staged_tree === right.staged_tree
    && left.index_control.algorithm === right.index_control.algorithm
    && left.index_control.checksum === right.index_control.checksum
    && left.index_control.entry_count === right.index_control.entry_count
    && left.git_operation === right.git_operation;
}

export async function applyAcceptedTree(
  root: string,
  beforeTree: string,
  afterTree: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<void> {
  if (beforeTree === afterTree) return;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-accept-"));
  const patchFile = path.join(temporary, "accepted.patch");
  const descriptor = fs.openSync(patchFile, "wx", 0o600);
  try {
    await runGitProcess({
      cwd: root,
      args: ["diff-tree", "--no-commit-id", "-r", "-p", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "-M", "-C", beforeTree, afterTree],
      spawn,
      onStdout(chunk) { fs.writeSync(descriptor, chunk); },
    });
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    await runGitProcess({ cwd: root, args: ["apply", "--check", "--whitespace=nowarn", patchFile], spawn });
    await runGitProcess({ cwd: root, args: ["apply", "--whitespace=nowarn", patchFile], spawn });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function integrationGateRefs(run: ReturnType<typeof readRollingExecutionRun>, bundle: ChangeBundleManifest): string[] {
  const target = `${bundle.unit_key}@${bundle.unit_version}`;
  const superseded = new Set(run.accepted_deltas.flatMap((delta) => (delta.supersessions || [])
    .filter((item) => item.owner === "gate_version").map((item) => item.previous)));
  const gates = run.accepted_deltas.flatMap((delta) => delta.gate_versions || [])
    .filter((gate) => !superseded.has(`${gate.gate_key}@${gate.version}`));
  const units = run.accepted_deltas.flatMap((delta) => delta.unit_versions || [])
    .filter((unit) => `${unit.unit_key}@${unit.version}` === target);
  if (units.length !== 1) throw new WorktreeIntegrationError(`accepted rolling unit ${target} is missing or ambiguous`, "INTEGRATION_QUEUE_LINEAGE_MISSING");
  return gates
    .filter((gate) => gate.type === "integration-acceptance"
      && (gate.depends_on || []).some((reference) => reference === target || reference === bundle.unit_key))
    .map((gate) => `${gate.gate_key}@${gate.version}`)
    .sort();
}

export async function acceptIntegrationGates(
  root: string,
  record: IntegrationRecord,
  bundle: ChangeBundleManifest,
  conclusion: string,
  env?: NodeJS.ProcessEnv,
  at?: string | number | Date,
): Promise<string[]> {
  const run = readRollingExecutionRun(root, bundle.run_id, { env });
  const refs = integrationGateRefs(run, bundle);
  const evidence = `integration ${record.integration_id} accepted at ${record.after_tree}: ${conclusion}`;
  for (const gateRef of refs) {
    await acceptRollingGate({ cwd: root, env, run_id: bundle.run_id, gate_ref: gateRef, evidence, result_tree: record.after_tree, dispatch: false, now: at });
  }
  return refs;
}

export function ensureWorktreeAcceptedState(
  root: string,
  bundle: ChangeBundleManifest,
  record: IntegrationRecord,
  env?: NodeJS.ProcessEnv,
): void {
  const worktree = readPersistedWorktreeRecord(root, bundle.run_id, bundle.unit_key, bundle.attempt_id, env);
  if (worktree.lifecycle_state === "integrated") {
    transitionPersistedWorktreeRecord(root, bundle.run_id, bundle.unit_key, bundle.attempt_id, {
      idempotency_key: `integration-accept:${record.integration_id}`,
      phase: "acceptance",
      to_state: "accepted",
      integration_id: record.integration_id,
      retention_reasons: ["downstream_base_dependency"],
      recorded_at: record.updated_at,
    }, env);
  } else if (worktree.lifecycle_state !== "accepted" || worktree.integration_id !== record.integration_id) {
    throw new WorktreeIntegrationError("worktree lifecycle does not match accepted integration", "INTEGRATION_STATE_INVALID");
  }
}

/** Apply the frozen result to the caller, then accept its rolling integration gates. */
export async function acceptWorktreeIntegration(input: AcceptWorktreeIntegrationInput): Promise<AcceptWorktreeIntegrationResult> {
  const root = fs.realpathSync(input.repository_root);
  identity(input.run_id, "run_id");
  identity(input.bundle_id, "bundle_id");
  if (!/^[0-9a-f]{64}$/u.test(input.repository_id)) throw new WorktreeIntegrationError("repository_id must be sha256", "INTEGRATION_INPUT_INVALID");
  const conclusion = input.conclusion.trim();
  if (!conclusion || conclusion.length > 1000) throw new WorktreeIntegrationError("acceptance conclusion must contain 1-1000 characters", "INTEGRATION_INPUT_INVALID");
  const operationKey = acceptOperationKey({ ...input, conclusion });
  identity(operationKey, "idempotency_key");
  const bundle = readyBundle(root, input);
  const result = await withOwnedLockAsync(
    integrationDestinationLockPath(root, bundle.repository_id, input.env),
    () => withOwnedLockAsync(
      integrationQueueLockPath(root, input.run_id, bundle.repository_id, input.env),
      async (): Promise<{ record: IntegrationRecord; replayed: boolean }> => {
        const actualIdentity = await destinationIdentity(root, input.spawn);
        if (actualIdentity.repository_id !== input.repository_id
          || actualIdentity.git_common_dir_identity !== bundle.git_common_dir_identity) {
          throw new WorktreeIntegrationError("acceptance destination identity differs from the bundle", "INTEGRATION_IDENTITY_MISMATCH");
        }
        const id = integrationId(input.run_id, bundle.repository_id, bundle.bundle_id);
        let record = readPersistedIntegrationRecord(root, input.run_id, bundle.repository_id, id, input.env);
        if (record.state === "accepted" && record.acceptance && record.idempotency_keys.includes(operationKey)) {
          const current = await captureBeginAuthorization(root, record.after_tree!, record.authorization?.parent_order_override ?? undefined, input.spawn);
          if (!record.authorization || !sameCallerControl(record.authorization, current)) throw new WorktreeIntegrationError("caller control facts drifted after accepted integration", "INTEGRATION_DESTINATION_BASELINE_MISMATCH");
          ensureWorktreeAcceptedState(root, bundle, record, input.env);
          return { record, replayed: true };
        }
        if (record.state !== "integrated" || !record.after_tree || !record.authorization) {
          throw new WorktreeIntegrationError(`integration cannot be accepted from state ${record.state}`, "INTEGRATION_STATE_INVALID");
        }
        if (!record.acceptance) {
          const current = await captureBeginAuthorization(root, record.before_tree, record.authorization.parent_order_override ?? undefined, input.spawn);
          if (!sameCallerControl(record.authorization, current)) throw new WorktreeIntegrationError("caller control facts differ from integration authorization", "INTEGRATION_DESTINATION_BASELINE_MISMATCH");
          const acceptance = signAcceptance({
            schema_version: 1,
            idempotency_key: operationKey,
            before_tree: record.before_tree,
            after_tree: record.after_tree,
            integration_fingerprint: record.fingerprint,
            conclusion,
            prepared_at: timestamp(input.at),
          });
          record = persistIntegrationRecord(root, sign({
            ...record,
            revision: record.revision + 1,
            acceptance,
            idempotency_keys: [...record.idempotency_keys, operationKey],
            updated_at: acceptance.prepared_at,
          }), input.env);
        } else if (record.acceptance.idempotency_key !== operationKey || record.acceptance.conclusion !== conclusion) {
          throw new WorktreeIntegrationError("acceptance replay differs from the persisted intent", "INTEGRATION_STATE_INVALID");
        }
        let current: IntegrationBeginAuthorization;
        try {
          current = await captureBeginAuthorization(root, record.before_tree, record.authorization.parent_order_override ?? undefined, input.spawn);
          if (!sameCallerControl(record.authorization, current)) throw new WorktreeIntegrationError("caller control facts differ before final application", "INTEGRATION_DESTINATION_BASELINE_MISMATCH");
          await applyAcceptedTree(root, record.before_tree, record.after_tree, input.spawn);
        } catch (cause) {
          try {
            current = await captureBeginAuthorization(root, record.after_tree, record.authorization.parent_order_override ?? undefined, input.spawn);
            if (!sameCallerControl(record.authorization, current)) throw cause;
          } catch {
            throw cause;
          }
        }
        current = await captureBeginAuthorization(root, record.after_tree, record.authorization.parent_order_override ?? undefined, input.spawn);
        if (!sameCallerControl(record.authorization, current)) throw new WorktreeIntegrationError("caller control facts changed during final application", "INTEGRATION_ACCEPTANCE_FAILED");
        record = persistIntegrationRecord(root, sign({
          ...record,
          revision: record.revision + 1,
          state: "accepted",
          idempotency_keys: [...record.idempotency_keys, `complete:${operationKey}`],
          updated_at: timestamp(input.at),
        }), input.env);
        ensureWorktreeAcceptedState(root, bundle, record, input.env);
        return { record, replayed: false };
      },
      { operation: "worktree-integration-accept-run-queue" },
    ),
    { operation: "worktree-integration-accept-destination" },
  );
  const acceptedGateRefs = await acceptIntegrationGates(root, result.record, bundle, conclusion, input.env, input.at);
  return { record: result.record, bundle, replayed: result.replayed, accepted_gate_refs: acceptedGateRefs };
}
