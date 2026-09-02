import {
  ChangeBundleManifest,
  IntegrationConflict,
  IntegrationRecord
} from "./worktree-execution-types.js";
import {
  ApplyWorktreeIntegrationInput,
  ApplyWorktreeIntegrationResult,
  WorktreeIntegrationError
} from "./worktree-integration.js";
import { GIT_OBJECT } from "./worktree-execution-validation.js";
import { identity } from "./worktree-integration-queue.js";
import { withOwnedLockAsync } from "./owned-lock.js";
import {
  integrationDestinationLockPath,
  integrationQueueLockPath
} from "./paths.js";
import {
  applyOperationKey,
  captureBeginAuthorization,
  destinationIdentity,
  integrationId,
  readyBundle,
  sign,
  signApplication,
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
  GitSafetyError,
  collectGitScalar,
  runGitProcess
} from "./git-safety-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Bundle tree merge and application. Split from worktree-integration.ts.
 */

export interface MergeStageFact { path: string; mode: string; object: string; stage: 1 | 2 | 3 }

export function conflictKind(types: readonly string[], facts: readonly MergeStageFact[]): IntegrationConflict["kind"] {
  const normalized = types.map((value) => value.toLowerCase());
  const stages = new Set(facts.map((fact) => fact.stage));
  const modes = new Set(facts.map((fact) => fact.mode));
  if (facts.some((fact) => fact.mode === "160000") || normalized.some((value) => value.includes("submodule"))) return "gitlink";
  if (facts.some((fact) => fact.mode === "120000")) return "symlink";
  if (normalized.some((value) => value.includes("binary"))) return "binary";
  if (normalized.some((value) => value.includes("rename"))) return "rename";
  if (normalized.some((value) => value.includes("add/add")) || (!stages.has(1) && stages.has(2) && stages.has(3))) return "add_add";
  if (normalized.some((value) => value.includes("modify/delete") || value.includes("delete/modify"))
    || (stages.has(1) && (!stages.has(2) || !stages.has(3)))) return "delete_modify";
  if (modes.size > 1) return "mode";
  return "content";
}

export function classifyConflict(pathName: string, facts: readonly MergeStageFact[], types: readonly string[]): IntegrationConflict {
  const stableTypes = [...new Set(types)].sort();
  const stages = [...facts]
    .sort((left, right) => left.stage - right.stage)
    .map((fact) => `${fact.stage}:${fact.mode}:${fact.object}`)
    .join(",");
  const detail = `${stableTypes.length ? `types=${stableTypes.join("|")};` : ""}stages=${stages}`;
  return { path: pathName, kind: conflictKind(stableTypes, facts), detail };
}

export function parseConflictTypes(fields: readonly string[], start: number, knownPaths: ReadonlySet<string>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let index = start;
  let records = 0;
  while (index < fields.length && fields[index] !== "") {
    const countRaw = fields[index++]!;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(countRaw)) {
      throw new WorktreeIntegrationError("merge-tree returned malformed structured conflict messages", "INTEGRATION_APPLICATION_FAILED");
    }
    const count = Number(countRaw);
    if (!Number.isSafeInteger(count) || count > 4096 || index + count + 2 > fields.length) {
      throw new WorktreeIntegrationError("merge-tree conflict message path count is invalid", "INTEGRATION_APPLICATION_FAILED");
    }
    const paths = fields.slice(index, index + count);
    index += count;
    const type = fields[index++]!;
    index += 1; // Free-form message is intentionally ignored.
    records += 1;
    if (records > 8192) {
      throw new WorktreeIntegrationError("merge conflict message count exceeds the bounded integration payload", "INTEGRATION_APPLICATION_FAILED");
    }
    if (type === "Auto-merging") continue;
    for (const pathName of paths) {
      if (!knownPaths.has(pathName)) continue;
      const values = result.get(pathName) ?? [];
      values.push(type);
      result.set(pathName, values);
    }
  }
  return result;
}

export async function mergeBundleTrees(
  root: string,
  beforeTree: string,
  bundle: ChangeBundleManifest,
  spawn?: GitProcessOptions["spawn"],
): Promise<{ after_tree?: string; conflicts: IntegrationConflict[] }> {
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-apply-"));
  const gitEnv = {
    GIT_INDEX_FILE: path.join(context, "index"),
    GIT_WORK_TREE: context,
    GIT_AUTHOR_NAME: "OpenBaton",
    GIT_AUTHOR_EMAIL: "baton@invalid.local",
    GIT_COMMITTER_NAME: "OpenBaton",
    GIT_COMMITTER_EMAIL: "baton@invalid.local",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const commit = (tree: string, parent?: string) => collectGitScalar({
    cwd: root,
    args: ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `baton integration ${tree}`],
    env: gitEnv,
    spawn,
  });
  try {
    const base = await commit(bundle.base_tree);
    const ours = await commit(beforeTree, base);
    const theirs = await commit(bundle.result_tree, base);
    let output = Buffer.alloc(0);
    let conflicted = false;
    try {
      await runGitProcess({
        cwd: root,
        args: ["merge-tree", "--write-tree", "-z", ours, theirs],
        env: gitEnv,
        spawn,
        onStdout(chunk) {
          if (output.length + chunk.length > 4 * 1024 * 1024) {
            throw new WorktreeIntegrationError("merge conflict facts exceed the bounded integration payload", "INTEGRATION_APPLICATION_FAILED");
          }
          output = Buffer.concat([output, chunk]);
        },
      });
    } catch (cause) {
      if (cause instanceof GitSafetyError && cause.exitCode === 1) conflicted = true;
      else throw cause;
    }
    const fields = output.toString("utf8").split("\0");
    const tree = fields.shift() ?? "";
    if (!GIT_OBJECT.test(tree)) {
      throw new WorktreeIntegrationError("merge-tree did not return an exact result tree", "INTEGRATION_APPLICATION_FAILED");
    }
    if (!conflicted) return { after_tree: tree, conflicts: [] };
    const byPath = new Map<string, MergeStageFact[]>();
    let fieldIndex = 0;
    for (; fieldIndex < fields.length; fieldIndex += 1) {
      const field = fields[fieldIndex]!;
      if (field === "") {
        fieldIndex += 1;
        break;
      }
      const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t(.+)$/u.exec(field);
      if (!match) {
        throw new WorktreeIntegrationError("merge-tree returned malformed unmerged stage facts", "INTEGRATION_APPLICATION_FAILED");
      }
      const fact: MergeStageFact = {
        mode: match[1]!,
        object: match[2]!,
        stage: Number(match[3]) as 1 | 2 | 3,
        path: match[4]!,
      };
      const pathFacts = byPath.get(fact.path) ?? [];
      pathFacts.push(fact);
      byPath.set(fact.path, pathFacts);
      if (byPath.size > 4096) {
        throw new WorktreeIntegrationError("merge conflict path count exceeds the bounded integration payload", "INTEGRATION_APPLICATION_FAILED");
      }
    }
    if (byPath.size === 0) {
      throw new WorktreeIntegrationError("conflicted merge omitted unmerged stage facts", "INTEGRATION_APPLICATION_FAILED");
    }
    const typesByPath = parseConflictTypes(fields, fieldIndex, new Set(byPath.keys()));
    return {
      conflicts: [...byPath.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([pathName, facts]) => classifyConflict(pathName, facts, typesByPath.get(pathName) ?? [])),
    };
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

export function ensureWorktreeApplicationState(
  root: string,
  bundle: ChangeBundleManifest,
  record: IntegrationRecord,
  env?: NodeJS.ProcessEnv,
): void {
  const expected = record.state === "integrated" ? "integrated" : "awaiting_parent_resolution";
  const worktree = readPersistedWorktreeRecord(root, bundle.run_id, bundle.unit_key, bundle.attempt_id, env);
  if (worktree.lifecycle_state === "integrating"
    || (expected === "integrated" && worktree.lifecycle_state === "awaiting_parent_resolution")) {
    const resolving = worktree.lifecycle_state === "awaiting_parent_resolution";
    transitionPersistedWorktreeRecord(root, bundle.run_id, bundle.unit_key, bundle.attempt_id, {
      idempotency_key: `${resolving ? "integration-resolve" : "integration-apply"}:${record.integration_id}`,
      phase: expected === "integrated" ? "integration" : "conflict",
      to_state: expected,
      integration_id: record.integration_id,
      retention_reasons: expected === "integrated" ? ["downstream_base_dependency"] : ["unresolved_conflict"],
      recorded_at: record.updated_at,
    }, env);
  } else if (worktree.lifecycle_state !== expected || worktree.integration_id !== record.integration_id) {
    throw new WorktreeIntegrationError("worktree lifecycle does not match the applied integration", "INTEGRATION_STATE_INVALID");
  }
}

/** Apply an admitted bundle only through isolated Git object plumbing. */

export async function applyWorktreeIntegration(input: ApplyWorktreeIntegrationInput): Promise<ApplyWorktreeIntegrationResult> {
  const root = fs.realpathSync(input.repository_root);
  identity(input.run_id, "run_id");
  identity(input.bundle_id, "bundle_id");
  if (!/^[0-9a-f]{64}$/u.test(input.repository_id)) {
    throw new WorktreeIntegrationError("repository_id must be sha256", "INTEGRATION_INPUT_INVALID");
  }
  const applyKey = applyOperationKey(input);
  identity(applyKey, "idempotency_key");
  const bundle = readyBundle(root, input);
  return withOwnedLockAsync(
    integrationDestinationLockPath(root, bundle.repository_id, input.env),
    () => withOwnedLockAsync(
      integrationQueueLockPath(root, input.run_id, bundle.repository_id, input.env),
      async () => {
        const actualIdentity = await destinationIdentity(root, input.spawn);
        if (actualIdentity.repository_id !== input.repository_id
          || actualIdentity.repository_id !== bundle.repository_id
          || actualIdentity.git_common_dir_identity !== bundle.git_common_dir_identity) {
          throw new WorktreeIntegrationError("destination repository identity differs from the ChangeBundle", "INTEGRATION_IDENTITY_MISMATCH");
        }
        const id = integrationId(input.run_id, bundle.repository_id, bundle.bundle_id);
        let record = readPersistedIntegrationRecord(root, input.run_id, bundle.repository_id, id, input.env);
        const expectedApplication = signApplication({
          schema_version: 1,
          idempotency_key: applyKey,
          context: "baton-temporary-object-merge",
          before_tree: record.before_tree,
          bundle_base_tree: bundle.base_tree,
          bundle_result_tree: bundle.result_tree,
          prepared_at: record.application?.prepared_at ?? timestamp(input.at),
        });
        if (record.application && record.application.fingerprint !== expectedApplication.fingerprint) {
          throw new WorktreeIntegrationError("integration apply was replayed with different immutable inputs", "INTEGRATION_STATE_INVALID");
        }
        if ((record.state === "integrated" || record.state === "awaiting_parent_resolution")
          && record.idempotency_keys.includes(applyKey) && record.application) {
          ensureWorktreeApplicationState(root, bundle, record, input.env);
          return { record, bundle, replayed: true };
        }
        if (record.state !== "integrating" || !record.authorization) {
          throw new WorktreeIntegrationError(`integration cannot apply from state ${record.state}`, "INTEGRATION_STATE_INVALID");
        }
        if (!record.application) {
          record = persistIntegrationRecord(root, sign({
            ...record,
            revision: record.revision + 1,
            application: expectedApplication,
            idempotency_keys: [...record.idempotency_keys, applyKey],
            updated_at: expectedApplication.prepared_at,
          }), input.env);
        } else if (!record.idempotency_keys.includes(applyKey)) {
          throw new WorktreeIntegrationError("persisted application is missing its idempotency key", "INTEGRATION_STATE_INVALID");
        }

        const before = await captureBeginAuthorization(
          root,
          record.before_tree,
          record.authorization.parent_order_override ?? undefined,
          input.spawn,
        );
        if (before.fingerprint !== record.authorization.fingerprint) {
          throw new WorktreeIntegrationError("caller control facts differ from begin authorization", "INTEGRATION_DESTINATION_BASELINE_MISMATCH");
        }
        const merged = await mergeBundleTrees(root, record.before_tree, bundle, input.spawn);
        const after = await captureBeginAuthorization(
          root,
          record.before_tree,
          record.authorization.parent_order_override ?? undefined,
          input.spawn,
        );
        if (after.fingerprint !== record.authorization.fingerprint) {
          throw new WorktreeIntegrationError("caller control facts changed during isolated bundle application", "INTEGRATION_DESTINATION_BASELINE_MISMATCH");
        }
        const updatedAt = timestamp(input.at);
        record = persistIntegrationRecord(root, sign({
          ...record,
          revision: record.revision + 1,
          state: merged.after_tree ? "integrated" : "awaiting_parent_resolution",
          ...(merged.after_tree ? { after_tree: merged.after_tree } : {}),
          conflicts: merged.conflicts,
          idempotency_keys: [...record.idempotency_keys, `complete:${applyKey}`],
          updated_at: updatedAt,
        }), input.env);
        ensureWorktreeApplicationState(root, bundle, record, input.env);
        return { record, bundle, replayed: false };
      },
      { operation: "worktree-integration-apply-run-queue" },
    ),
    { operation: "worktree-integration-apply-destination" },
  );
}
