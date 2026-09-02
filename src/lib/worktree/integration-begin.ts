import { identity } from "./integration-queue.js";
import {
  activeDestinationIntegrations,
  activeHead,
  beginOperationKey,
  captureBeginAuthorization,
  destinationIdentity,
  enqueueLocked,
  ensureWorktreeIntegrating,
  integrationId,
  listIntegrationQueue,
  readyBundle,
  semanticOperationKey,
  sign,
  timestamp
} from "./integration-queue.js";
import { GIT_OBJECT } from "./execution-validation.js";
import { withOwnedLockAsync } from "../owned-lock.js";
import { persistIntegrationRecord } from "../worktree-execution.js";
import {
  integrationDestinationLockPath,
  integrationQueueLockPath
} from "../paths.js";
import {
  BeginWorktreeIntegrationInput,
  BeginWorktreeIntegrationResult,
  WorktreeIntegrationError
} from "../worktree-integration.js";
import fs from "node:fs";
/**
 * Begin-integration authorization and execution. Split from
 * worktree-integration.ts.
 */

export async function beginWorktreeIntegration(input: BeginWorktreeIntegrationInput): Promise<BeginWorktreeIntegrationResult> {
  const root = fs.realpathSync(input.repository_root);
  identity(input.run_id, "run_id");
  identity(input.bundle_id, "bundle_id");
  if (!/^[0-9a-f]{64}$/u.test(input.repository_id || "")) {
    throw new WorktreeIntegrationError("repository_id must be sha256", "INTEGRATION_INPUT_INVALID");
  }
  identity(semanticOperationKey(input), "idempotency_key");
  if (!GIT_OBJECT.test(input.expected_before_tree)) {
    throw new WorktreeIntegrationError("expected_before_tree must be a Git object id", "INTEGRATION_INPUT_INVALID");
  }
  if (input.order_override !== undefined && (!Number.isSafeInteger(input.order_override) || input.order_override < 0)) {
    throw new WorktreeIntegrationError("order_override must be a non-negative integer", "INTEGRATION_INPUT_INVALID");
  }
  const bundle = readyBundle(root, input);
  return await withOwnedLockAsync(
    integrationDestinationLockPath(root, bundle.repository_id, input.env),
    async () => {
      const currentId = integrationId(input.run_id, bundle.repository_id, bundle.bundle_id);
      const destinationOwner = activeDestinationIntegrations(root, bundle.repository_id, input.env)
        .find((record) => record.integration_id !== currentId || record.run_id !== input.run_id);
      if (destinationOwner) {
        throw new WorktreeIntegrationError(
          "another rolling run already owns this repository destination",
          "INTEGRATION_QUEUE_BLOCKED",
          {
            blocking_run_id: destinationOwner.run_id,
            blocking_integration_id: destinationOwner.integration_id,
            queue_position: destinationOwner.queue_position,
          },
        );
      }
      return await withOwnedLockAsync(
        integrationQueueLockPath(root, input.run_id, bundle.repository_id, input.env),
        async () => {
      const actualIdentity = await destinationIdentity(root, input.spawn);
      if (actualIdentity.repository_id !== input.repository_id
        || actualIdentity.repository_id !== bundle.repository_id
        || actualIdentity.git_common_dir_identity !== bundle.git_common_dir_identity) {
        throw new WorktreeIntegrationError("destination repository identity differs from the ChangeBundle", "INTEGRATION_IDENTITY_MISMATCH");
      }
      const authorization = await captureBeginAuthorization(
        root,
        input.expected_before_tree,
        input.order_override,
        input.spawn,
      );
      if (authorization.git_operation !== null) {
        throw new WorktreeIntegrationError(
          "destination is already inside another Git operation",
          "INTEGRATION_STATE_INVALID",
          { git_operation: authorization.git_operation },
        );
      }

      const existingQueue = listIntegrationQueue(root, input.run_id, bundle.repository_id, input.env);
      const active = existingQueue.find((record) => record.state === "integrating" || record.state === "awaiting_parent_resolution");
      if (active && active.integration_id !== currentId) {
        throw new WorktreeIntegrationError(
          "another integration is already active for this run and repository",
          "INTEGRATION_QUEUE_BLOCKED",
          { blocking_integration_id: active.integration_id, queue_position: active.queue_position },
        );
      }

      const queued = enqueueLocked(root, input, bundle, authorization);
      const current = queued.record;
      const beginKey = beginOperationKey(input);
      if (current.state === "integrating" && current.idempotency_keys.includes(beginKey)) {
        if (current.authorization?.fingerprint !== authorization.fingerprint) {
          throw new WorktreeIntegrationError("replayed begin facts differ from the persisted authorization", "INTEGRATION_STATE_INVALID");
        }
        ensureWorktreeIntegrating(root, bundle, current, current.updated_at, input.env);
        return { ...queued, bundle, replayed: true };
      }
      if (current.state !== "queued") {
        throw new WorktreeIntegrationError(`integration cannot begin from state ${current.state}`, "INTEGRATION_STATE_INVALID");
      }
      const queue = listIntegrationQueue(root, input.run_id, bundle.repository_id, input.env);
      const head = activeHead(queue);
      if (!head || head.integration_id !== current.integration_id) {
        throw new WorktreeIntegrationError(
          "another repository integration must finish before this bundle can begin",
          "INTEGRATION_QUEUE_BLOCKED",
          head ? { blocking_integration_id: head.integration_id, queue_position: head.queue_position } : undefined,
        );
      }
      const updatedAt = timestamp(input.at);
      const record = persistIntegrationRecord(root, sign({
        ...current,
        revision: current.revision + 1,
        state: "integrating",
        before_tree: input.expected_before_tree,
        authorization,
        idempotency_keys: [...current.idempotency_keys, beginKey],
        updated_at: updatedAt,
      }), input.env);

      // The integration record is the recovery source of truth. If the process
      // stops after this point, replay repairs the worktree lifecycle without
      // ever applying the bundle twice.
      ensureWorktreeIntegrating(root, bundle, record, updatedAt, input.env);

      return {
        record,
        queue: listIntegrationQueue(root, input.run_id, bundle.repository_id, input.env),
        bundle,
        replayed: false,
      };
        },
        { operation: "worktree-integration-begin-run-queue" },
      );
    },
    { operation: "worktree-integration-begin-destination" },
  );
}
