import {
  ChangeBundleManifest,
  INTEGRATION_RECORD_SCHEMA_VERSION,
  IntegrationAcceptanceIntent,
  IntegrationApplicationIntent,
  IntegrationBeginAuthorization,
  IntegrationQueueOrderProvenance,
  IntegrationRecord,
  IntegrationResolutionResult,
  WorktreeExecutionError
} from "./execution-types.js";
import {
  AcceptWorktreeIntegrationInput,
  ApplyWorktreeIntegrationInput,
  IntegrationQueueInput,
  IntegrationQueueResult,
  ResolveWorktreeIntegrationInput,
  WorktreeIntegrationError
} from "../worktree-integration.js";
import { sha256Hex } from "../json-utils.js";
import { fingerprintWorktreeRuntimeRecord } from "./execution-validation.js";
import { UnitVersion } from "../rolling-plan.js";
import { readRollingExecutionRun } from "../rolling-run.js";
import {
  integrationQueueLockPath,
  integrationRepositoryDir,
  rollingRunsDir
} from "../paths.js";
import { withOwnedLock } from "../owned-lock.js";
import {
  persistIntegrationRecord,
  readPersistedChangeBundleManifest,
  readPersistedIntegrationRecord,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord
} from "../worktree-execution.js";
import {
  StableGitSafetyFacts,
  assertGitSafetyStabilityTokenUnchanged,
  captureStableSafetyFacts,
  fingerprintGitSafetyStabilityToken
} from "../git/safety-facts.js";
import {
  GitProcessOptions,
  collectGitScalar,
  runGitProcess
} from "../git/safety-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Integration queue helpers and enqueue path. Split from
 * worktree-integration.ts.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ACTIVE_STATES = new Set<IntegrationRecord["state"]>([
  "queued",
  "integrating",
  "awaiting_parent_resolution",
]);


export function timestamp(value?: string | number | Date): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new WorktreeIntegrationError("integration timestamp is invalid", "INTEGRATION_INPUT_INVALID");
  }
  return date.toISOString();
}

export function identity(value: string, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new WorktreeIntegrationError(`${label} is invalid`, "INTEGRATION_INPUT_INVALID");
  }
  return value;
}

export function sha(value: string): string {
  return sha256Hex(value);
}

export function integrationId(runId: string, repositoryId: string, bundleId: string): string {
  return `integration-${sha(`${runId}\u0000${repositoryId}\u0000${bundleId}`)}`;
}

export function semanticOperationKey(input: IntegrationQueueInput): string {
  return input.idempotency_key ?? sha(JSON.stringify({
    run_id: input.run_id,
    repository_id: input.repository_id ?? null,
    bundle_id: input.bundle_id,
    expected_before_tree: input.expected_before_tree ?? null,
    order_override: input.order_override ?? null,
  }));
}

export function enqueueOperationKey(input: IntegrationQueueInput): string {
  return `queue:${semanticOperationKey(input)}`;
}

export function beginOperationKey(input: IntegrationQueueInput): string {
  return `begin:${semanticOperationKey(input)}`;
}

export function applyOperationKey(input: ApplyWorktreeIntegrationInput): string {
  return `apply:${input.idempotency_key ?? sha(JSON.stringify({
    run_id: input.run_id,
    repository_id: input.repository_id,
    bundle_id: input.bundle_id,
  }))}`;
}

export function resolveOperationKey(input: ResolveWorktreeIntegrationInput): string {
  return `resolve:${input.idempotency_key ?? sha(JSON.stringify({
    run_id: input.run_id,
    repository_id: input.repository_id,
    bundle_id: input.bundle_id,
    resolved_tree: input.resolved_tree,
    conclusion: input.conclusion.trim(),
  }))}`;
}

export function acceptOperationKey(input: AcceptWorktreeIntegrationInput): string {
  return `accept:${input.idempotency_key ?? sha(JSON.stringify({
    run_id: input.run_id,
    repository_id: input.repository_id,
    bundle_id: input.bundle_id,
    conclusion: input.conclusion.trim(),
  }))}`;
}

export function sign(record: Omit<IntegrationRecord, "fingerprint">): IntegrationRecord {
  const value = { ...record, fingerprint: "" } as IntegrationRecord;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

export function signQueueOrder(order: Omit<IntegrationQueueOrderProvenance, "fingerprint">): IntegrationQueueOrderProvenance {
  const value = { ...order, fingerprint: "" } as IntegrationQueueOrderProvenance;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

export function signApplication(intent: Omit<IntegrationApplicationIntent, "fingerprint">): IntegrationApplicationIntent {
  const value = { ...intent, fingerprint: "" } as IntegrationApplicationIntent;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

export function signResolution(result: Omit<IntegrationResolutionResult, "fingerprint">): IntegrationResolutionResult {
  const value = { ...result, fingerprint: "" } as IntegrationResolutionResult;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

export function signAcceptance(intent: Omit<IntegrationAcceptanceIntent, "fingerprint">): IntegrationAcceptanceIntent {
  const value = { ...intent, fingerprint: "" } as IntegrationAcceptanceIntent;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

export interface AcceptedUnitPosition {
  unit: UnitVersion;
  unit_ref: string;
  accepted_delta_index: number;
  stable_unit_index: number;
}

export function queueOrderForBundle(
  root: string,
  input: IntegrationQueueInput,
  bundle: ChangeBundleManifest,
): IntegrationQueueOrderProvenance {
  let run: ReturnType<typeof readRollingExecutionRun>;
  try { run = readRollingExecutionRun(root, input.run_id, { env: input.env }); }
  catch (cause) {
    throw new WorktreeIntegrationError(
      `persisted rolling run is unavailable for integration ordering: ${(cause as Error).message}`,
      "INTEGRATION_QUEUE_LINEAGE_MISSING",
    );
  }
  const positions: AcceptedUnitPosition[] = [];
  let stableIndex = 0;
  for (const [deltaIndex, delta] of run.accepted_deltas.entries()) {
    for (const unit of delta.unit_versions || []) {
      positions.push({
        unit,
        unit_ref: `${unit.unit_key}@${unit.version}`,
        accepted_delta_index: deltaIndex,
        stable_unit_index: stableIndex,
      });
      stableIndex += 1;
    }
  }
  const targetRef = `${bundle.unit_key}@${bundle.unit_version}`;
  const matches = positions.filter((item) => item.unit_ref === targetRef);
  if (matches.length !== 1 || run.accepted_deltas.some((delta) => (delta.supersessions || []).some(
    (item) => item.owner === "unit_version" && item.previous === targetRef,
  ))) {
    throw new WorktreeIntegrationError(
      `ChangeBundle unit ${targetRef} is missing, ambiguous, or superseded in accepted deltas`,
      "INTEGRATION_QUEUE_LINEAGE_MISSING",
    );
  }
  const exact = new Map(positions.map((item) => [item.unit_ref, item]));
  const activeByKey = new Map<string, AcceptedUnitPosition>();
  for (const item of positions) {
    const current = activeByKey.get(item.unit.unit_key);
    if (!current || item.unit.version > current.unit.version) activeByKey.set(item.unit.unit_key, item);
  }
  const resolve = (ref: string): AcceptedUnitPosition | undefined => ref.includes("@") ? exact.get(ref) : activeByKey.get(ref);
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rank = (item: AcceptedUnitPosition): number => {
    const cached = ranks.get(item.unit_ref);
    if (cached !== undefined) return cached;
    if (visiting.has(item.unit_ref)) {
      throw new WorktreeIntegrationError("accepted unit dependency graph contains a cycle", "INTEGRATION_QUEUE_LINEAGE_MISSING");
    }
    visiting.add(item.unit_ref);
    let value = 0;
    for (const ref of item.unit.depends_on || []) {
      const dependency = resolve(ref);
      if (!dependency) {
        throw new WorktreeIntegrationError(
          `accepted unit ${item.unit_ref} has unknown dependency ${ref}`,
          "INTEGRATION_QUEUE_LINEAGE_MISSING",
        );
      }
      value = Math.max(value, rank(dependency) + 1);
    }
    visiting.delete(item.unit_ref);
    ranks.set(item.unit_ref, value);
    return value;
  };
  const target = matches[0]!;
  const resolvedDependencies = (target.unit.depends_on || []).map((ref) => resolve(ref)?.unit_ref ?? ref);
  return signQueueOrder({
    schema_version: 1,
    source: "rolling-accepted-delta",
    dependency_rank: rank(target),
    accepted_delta_index: target.accepted_delta_index,
    stable_unit_index: target.stable_unit_index,
    unit_ref: target.unit_ref,
    depends_on: resolvedDependencies,
    parent_order_override: input.order_override ?? null,
  });
}

export function missing(error: unknown): boolean {
  return error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_MISSING";
}

export function dirtyFactsFingerprint(facts: StableGitSafetyFacts): string {
  return sha(JSON.stringify({
    dirty_entries: facts.dirtyEntries,
    untracked_exists: facts.untrackedExists,
    mode_changed_paths: [...facts.modeChangedPaths].sort(),
    git_operation: facts.gitOperation,
  }));
}

export async function visibleTree(
  root: string,
  headTree: string,
  indexFile: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile };
  await runGitProcess({ cwd: root, args: ["read-tree", headTree], env, spawn });
  await runGitProcess({ cwd: root, args: ["add", "-A", "--", "."], env, spawn });
  return collectGitScalar({ cwd: root, args: ["write-tree"], env, spawn });
}

export async function captureBeginAuthorization(
  root: string,
  expectedBeforeTree: string,
  orderOverride: number | undefined,
  spawn?: GitProcessOptions["spawn"],
): Promise<IntegrationBeginAuthorization> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-baseline-"));
  try {
    const before = await captureStableSafetyFacts(root, { purpose: "baseline", spawn });
    const headTree = before.commit?.tree
      ?? await collectGitScalar({ cwd: root, args: ["rev-parse", "HEAD^{tree}"], spawn });
    const firstTree = await visibleTree(root, headTree, path.join(temporary, "index-first"), spawn);
    const middle = await captureStableSafetyFacts(root, { purpose: "baseline", spawn });
    assertGitSafetyStabilityTokenUnchanged(before.stabilityToken, middle.stabilityToken);
    const secondTree = await visibleTree(root, headTree, path.join(temporary, "index-second"), spawn);
    const after = await captureStableSafetyFacts(root, { purpose: "baseline", spawn });
    assertGitSafetyStabilityTokenUnchanged(middle.stabilityToken, after.stabilityToken);
    if (firstTree !== secondTree
      || dirtyFactsFingerprint(before) !== dirtyFactsFingerprint(middle)
      || dirtyFactsFingerprint(middle) !== dirtyFactsFingerprint(after)) {
      throw new WorktreeIntegrationError(
        "destination control facts or visible content changed during begin authorization",
        "INTEGRATION_DESTINATION_BASELINE_MISMATCH",
      );
    }
    if (secondTree !== expectedBeforeTree) {
      throw new WorktreeIntegrationError(
        "destination visible tree differs from the expected prior integration tree",
        "INTEGRATION_DESTINATION_BASELINE_MISMATCH",
        { expected: expectedBeforeTree, observed: secondTree },
      );
    }
    const unsigned: Omit<IntegrationBeginAuthorization, "fingerprint"> = {
      schema_version: 1,
      expected_before_tree: expectedBeforeTree,
      observed_before_tree: secondTree,
      head: before.head,
      head_tree: headTree,
      branch_ref: before.branchRef,
      refs_digest: before.stabilityToken.refsDigest,
      reflog: { ...before.reflog },
      staged_tree: before.stagedTree,
      index_control: {
        algorithm: before.indexControl.algorithm,
        checksum: before.indexControl.checksum,
        entry_count: before.indexControl.entryCount,
      },
      control_facts_fingerprint: fingerprintGitSafetyStabilityToken(before.stabilityToken),
      dirty_facts_fingerprint: dirtyFactsFingerprint(before),
      git_operation: before.gitOperation ?? null,
      parent_order_override: orderOverride ?? null,
    };
    const authorization = { ...unsigned, fingerprint: "" } as IntegrationBeginAuthorization;
    authorization.fingerprint = fingerprintWorktreeRuntimeRecord(authorization);
    return authorization;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Read one repository queue in its stable persisted order. */
export function compareIntegrationOrder(left: IntegrationRecord, right: IntegrationRecord): number {
  const leftOrder = left.queue_order;
  const rightOrder = right.queue_order;
  const leftPrimary = leftOrder?.parent_order_override ?? leftOrder?.dependency_rank ?? left.queue_position;
  const rightPrimary = rightOrder?.parent_order_override ?? rightOrder?.dependency_rank ?? right.queue_position;
  const leftOverride = leftOrder?.parent_order_override === null || leftOrder === undefined ? 1 : 0;
  const rightOverride = rightOrder?.parent_order_override === null || rightOrder === undefined ? 1 : 0;
  return leftPrimary - rightPrimary
    || leftOverride - rightOverride
    || (leftOrder?.accepted_delta_index ?? Number.MAX_SAFE_INTEGER) - (rightOrder?.accepted_delta_index ?? Number.MAX_SAFE_INTEGER)
    || (leftOrder?.stable_unit_index ?? left.queue_position) - (rightOrder?.stable_unit_index ?? right.queue_position)
    || (leftOrder?.unit_ref ?? "").localeCompare(rightOrder?.unit_ref ?? "")
    || left.integration_id.localeCompare(right.integration_id);
}

export function listIntegrationQueue(
  repositoryRoot: string,
  runId: string,
  repositoryId: string,
  env?: NodeJS.ProcessEnv,
): IntegrationRecord[] {
  const directory = integrationRepositoryDir(repositoryRoot, runId, repositoryId, env);
  if (!fs.existsSync(directory)) return [];
  const records: IntegrationRecord[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    records.push(readPersistedIntegrationRecord(repositoryRoot, runId, repositoryId, entry.name, env));
  }
  return records.sort(compareIntegrationOrder);
}

export function readyBundle(root: string, input: IntegrationQueueInput): ChangeBundleManifest {
  const bundle = readPersistedChangeBundleManifest(root, input.run_id, input.bundle_id, input.env);
  if (bundle.run_id !== input.run_id || bundle.bundle_id !== input.bundle_id) {
    throw new WorktreeIntegrationError("ChangeBundle run or bundle identity differs from its lookup", "INTEGRATION_IDENTITY_MISMATCH");
  }
  if (bundle.safety_verdict !== "safe" || bundle.state !== "ready_for_integration") {
    throw new WorktreeIntegrationError("ChangeBundle is not ready for integration", "INTEGRATION_BUNDLE_NOT_READY");
  }
  if (input.repository_id !== undefined && input.repository_id !== bundle.repository_id) {
    throw new WorktreeIntegrationError("requested repository identity differs from the ChangeBundle", "INTEGRATION_IDENTITY_MISMATCH");
  }
  return bundle;
}

export function enqueueLocked(
  root: string,
  input: IntegrationQueueInput,
  bundle: ChangeBundleManifest,
  authorization?: IntegrationBeginAuthorization,
): IntegrationQueueResult {
  const id = integrationId(input.run_id, bundle.repository_id, bundle.bundle_id);
  const enqueueKey = enqueueOperationKey(input);
  const queueOrder = queueOrderForBundle(root, input, bundle);
  try {
    const current = readPersistedIntegrationRecord(root, input.run_id, bundle.repository_id, id, input.env);
    if (current.bundle_id !== bundle.bundle_id || current.git_common_dir_identity !== bundle.git_common_dir_identity) {
      throw new WorktreeIntegrationError("persisted integration identity differs from the bundle", "INTEGRATION_IDENTITY_MISMATCH");
    }
    if (!current.idempotency_keys.includes(enqueueKey)
      || current.before_tree !== (input.expected_before_tree ?? bundle.base_tree)
      || (input.order_override !== undefined && current.queue_position !== input.order_override)
      || (current.queue_order !== undefined && current.queue_order.fingerprint !== queueOrder.fingerprint)
      || (authorization !== undefined && current.authorization !== undefined
        && current.authorization.fingerprint !== authorization.fingerprint)) {
      throw new WorktreeIntegrationError("integration enqueue was replayed with another idempotency key", "INTEGRATION_STATE_INVALID");
    }
    return { record: current, queue: listIntegrationQueue(root, input.run_id, bundle.repository_id, input.env), replayed: true };
  } catch (error) {
    if (!missing(error)) throw error;
  }

  const queue = listIntegrationQueue(root, input.run_id, bundle.repository_id, input.env);
  const queuePosition = input.order_override ?? queueOrder.stable_unit_index;
  const deterministicCollision = queue.some((item) => item.queue_order !== undefined
    && item.queue_position === queuePosition
    && item.queue_order.unit_ref !== queueOrder.unit_ref);
  if ((input.order_override !== undefined && queue.some((item) => item.queue_position === queuePosition)) || deterministicCollision) {
    throw new WorktreeIntegrationError(
      `integration queue position ${queuePosition} is already occupied`,
      "INTEGRATION_QUEUE_BLOCKED",
      { queue_position: queuePosition, parent_order_override: input.order_override ?? null },
    );
  }
  const createdAt = timestamp(input.at);
  const record = persistIntegrationRecord(root, sign({
    schema_version: INTEGRATION_RECORD_SCHEMA_VERSION,
    integration_id: id,
    revision: 0,
    run_id: input.run_id,
    repository_id: bundle.repository_id,
    git_common_dir_identity: bundle.git_common_dir_identity,
    bundle_id: bundle.bundle_id,
    queue_position: queuePosition,
    state: "queued",
    before_tree: input.expected_before_tree ?? bundle.base_tree,
    conflicts: [],
    queue_order: queueOrder,
    ...(authorization ? { authorization } : {}),
    idempotency_keys: [enqueueKey],
    created_at: createdAt,
    updated_at: createdAt,
  }), input.env);
  return {
    record,
    queue: [...queue, record].sort(compareIntegrationOrder),
    replayed: false,
  };
}

/** Enqueue one immutable bundle under the run's repository-local lock. */
export function enqueueWorktreeIntegration(input: IntegrationQueueInput): IntegrationQueueResult {
  const root = fs.realpathSync(input.repository_root);
  identity(input.run_id, "run_id");
  identity(input.bundle_id, "bundle_id");
  if (input.repository_id !== undefined && !/^[0-9a-f]{64}$/u.test(input.repository_id)) {
    throw new WorktreeIntegrationError("repository_id must be sha256", "INTEGRATION_INPUT_INVALID");
  }
  if (input.expected_before_tree !== undefined && !GIT_OBJECT.test(input.expected_before_tree)) {
    throw new WorktreeIntegrationError("expected_before_tree must be a Git object id", "INTEGRATION_INPUT_INVALID");
  }
  if (input.order_override !== undefined && (!Number.isSafeInteger(input.order_override) || input.order_override < 0)) {
    throw new WorktreeIntegrationError("order_override must be a non-negative integer", "INTEGRATION_INPUT_INVALID");
  }
  identity(semanticOperationKey(input), "idempotency_key");
  const bundle = readyBundle(root, input);
  return withOwnedLock(
    integrationQueueLockPath(root, input.run_id, bundle.repository_id, input.env),
    () => enqueueLocked(root, input, bundle),
    { operation: "worktree-integration-queue" },
  );
}

export async function destinationIdentity(
  root: string,
  spawn?: GitProcessOptions["spawn"],
): Promise<{ repository_id: string; git_common_dir_identity: string }> {
  const top = fs.realpathSync(await collectGitScalar({ cwd: root, args: ["rev-parse", "--show-toplevel"], spawn }));
  if (top !== root) {
    throw new WorktreeIntegrationError("integration destination is not the repository root", "INTEGRATION_IDENTITY_MISMATCH");
  }
  const commonRaw = await collectGitScalar({ cwd: root, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], spawn });
  const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(root, commonRaw));
  const format = await collectGitScalar({ cwd: root, args: ["rev-parse", "--show-object-format"], spawn });
  return {
    repository_id: sha(`${format}\u0000${common}`),
    git_common_dir_identity: sha(common),
  };
}

export function activeHead(queue: readonly IntegrationRecord[]): IntegrationRecord | undefined {
  return queue.find((record) => ACTIVE_STATES.has(record.state));
}

/** Durable cross-run destination ownership is the active IntegrationRecord itself. */
export function activeDestinationIntegrations(
  root: string,
  repositoryId: string,
  env?: NodeJS.ProcessEnv,
): IntegrationRecord[] {
  const runsRoot = rollingRunsDir(root, env);
  if (!fs.existsSync(runsRoot)) return [];
  const active: IntegrationRecord[] = [];
  for (const runEntry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!runEntry.isDirectory()) continue;
    const repositoryRoot = integrationRepositoryDir(root, runEntry.name, repositoryId, env);
    if (!fs.existsSync(repositoryRoot)) continue;
    for (const integrationEntry of fs.readdirSync(repositoryRoot, { withFileTypes: true })) {
      if (!integrationEntry.isDirectory()) continue;
      const record = readPersistedIntegrationRecord(root, runEntry.name, repositoryId, integrationEntry.name, env);
      if (record.state === "integrating" || record.state === "awaiting_parent_resolution") active.push(record);
    }
  }
  return active.sort((left, right) => left.run_id.localeCompare(right.run_id)
    || left.integration_id.localeCompare(right.integration_id));
}

export function ensureWorktreeIntegrating(
  root: string,
  bundle: ChangeBundleManifest,
  record: IntegrationRecord,
  recordedAt: string,
  env?: NodeJS.ProcessEnv,
): void {
  const worktree = readPersistedWorktreeRecord(root, bundle.run_id, bundle.unit_key, bundle.attempt_id, env);
  if (worktree.lifecycle_state === "bundle_ready") {
    transitionPersistedWorktreeRecord(root, bundle.run_id, bundle.unit_key, bundle.attempt_id, {
      idempotency_key: `integration-begin:${record.integration_id}`,
      phase: "integration",
      to_state: "integrating",
      integration_id: record.integration_id,
      retention_reasons: ["active_integration"],
      recorded_at: recordedAt,
    }, env);
  } else if (worktree.lifecycle_state !== "integrating" || worktree.integration_id !== record.integration_id) {
    throw new WorktreeIntegrationError("worktree lifecycle does not match the integration record", "INTEGRATION_STATE_INVALID");
  }
}

/**
 * Admit exactly the queue head for parent integration.
 *
 * No bundle bytes are applied here. A successful return is only a durable,
 * replayable authorization to enter the later integration transaction.
 */
