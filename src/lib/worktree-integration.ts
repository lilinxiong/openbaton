/** Parent-owned, repository-serialized integration admission.
 *
 * This boundary deliberately stops before applying a ChangeBundle. It only
 * validates immutable lineage and the destination baseline, then persists a
 * recoverable queued -> integrating decision.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertGitSafetyStabilityTokenUnchanged,
  captureStableSafetyFacts,
  fingerprintGitSafetyStabilityToken,
  type StableGitSafetyFacts,
} from "./git-safety-facts.js";
import { collectGitScalar, runGitProcess, type GitProcessOptions } from "./git-safety-process.js";
import { withOwnedLock, withOwnedLockAsync } from "./owned-lock.js";
import {
  integrationDestinationLockPath,
  integrationQueueLockPath,
  integrationRepositoryDir,
  rollingRunsDir,
} from "./paths.js";
import { readRollingExecutionRun } from "./rolling-run.js";
import type { UnitVersion } from "./rolling-plan.js";
import {
  INTEGRATION_RECORD_SCHEMA_VERSION,
  WorktreeExecutionError,
  fingerprintWorktreeRuntimeRecord,
  persistIntegrationRecord,
  readPersistedChangeBundleManifest,
  readPersistedIntegrationRecord,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type ChangeBundleManifest,
  type IntegrationBeginAuthorization,
  type IntegrationQueueOrderProvenance,
  type IntegrationRecord,
} from "./worktree-execution.js";

export type WorktreeIntegrationErrorCode =
  | "INTEGRATION_INPUT_INVALID"
  | "INTEGRATION_BUNDLE_NOT_READY"
  | "INTEGRATION_IDENTITY_MISMATCH"
  | "INTEGRATION_DESTINATION_BASELINE_MISMATCH"
  | "INTEGRATION_QUEUE_BLOCKED"
  | "INTEGRATION_QUEUE_CORRUPT"
  | "INTEGRATION_QUEUE_LINEAGE_MISSING"
  | "INTEGRATION_STATE_INVALID";

export class WorktreeIntegrationError extends Error {
  readonly code: WorktreeIntegrationErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(message: string, code: WorktreeIntegrationErrorCode, detail?: Record<string, unknown>) {
    super(message);
    this.name = "WorktreeIntegrationError";
    this.code = code;
    this.detail = detail;
  }
}

export interface IntegrationQueueInput {
  repository_root: string;
  run_id: string;
  repository_id?: string;
  bundle_id: string;
  /** Exact tree expected before this bundle, including visible dirty content. */
  expected_before_tree?: string;
  /** Parent-authorized stable queue position. Occupied positions fail closed. */
  order_override?: number;
  idempotency_key?: string;
  env?: NodeJS.ProcessEnv;
  at?: string | number | Date;
}

export interface BeginWorktreeIntegrationInput extends IntegrationQueueInput {
  expected_before_tree: string;
  spawn?: GitProcessOptions["spawn"];
}

export interface IntegrationQueueResult {
  record: IntegrationRecord;
  queue: IntegrationRecord[];
  replayed: boolean;
}

export interface BeginWorktreeIntegrationResult extends IntegrationQueueResult {
  bundle: ChangeBundleManifest;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ACTIVE_STATES = new Set<IntegrationRecord["state"]>([
  "queued",
  "integrating",
  "awaiting_parent_resolution",
]);

function timestamp(value?: string | number | Date): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new WorktreeIntegrationError("integration timestamp is invalid", "INTEGRATION_INPUT_INVALID");
  }
  return date.toISOString();
}

function identity(value: string, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new WorktreeIntegrationError(`${label} is invalid`, "INTEGRATION_INPUT_INVALID");
  }
  return value;
}

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function integrationId(runId: string, repositoryId: string, bundleId: string): string {
  return `integration-${sha(`${runId}\u0000${repositoryId}\u0000${bundleId}`)}`;
}

function semanticOperationKey(input: IntegrationQueueInput): string {
  return input.idempotency_key ?? sha(JSON.stringify({
    run_id: input.run_id,
    repository_id: input.repository_id ?? null,
    bundle_id: input.bundle_id,
    expected_before_tree: input.expected_before_tree ?? null,
    order_override: input.order_override ?? null,
  }));
}

function enqueueOperationKey(input: IntegrationQueueInput): string {
  return `queue:${semanticOperationKey(input)}`;
}

function beginOperationKey(input: IntegrationQueueInput): string {
  return `begin:${semanticOperationKey(input)}`;
}

function sign(record: Omit<IntegrationRecord, "fingerprint">): IntegrationRecord {
  const value = { ...record, fingerprint: "" } as IntegrationRecord;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

function signQueueOrder(order: Omit<IntegrationQueueOrderProvenance, "fingerprint">): IntegrationQueueOrderProvenance {
  const value = { ...order, fingerprint: "" } as IntegrationQueueOrderProvenance;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

interface AcceptedUnitPosition {
  unit: UnitVersion;
  unit_ref: string;
  accepted_delta_index: number;
  stable_unit_index: number;
}

function queueOrderForBundle(
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

function missing(error: unknown): boolean {
  return error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_MISSING";
}

function dirtyFactsFingerprint(facts: StableGitSafetyFacts): string {
  return sha(JSON.stringify({
    dirty_entries: facts.dirtyEntries,
    untracked_exists: facts.untrackedExists,
    mode_changed_paths: [...facts.modeChangedPaths].sort(),
    git_operation: facts.gitOperation,
  }));
}

async function visibleTree(
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

async function captureBeginAuthorization(
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
function compareIntegrationOrder(left: IntegrationRecord, right: IntegrationRecord): number {
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

function readyBundle(root: string, input: IntegrationQueueInput): ChangeBundleManifest {
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

function enqueueLocked(
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

async function destinationIdentity(
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

function activeHead(queue: readonly IntegrationRecord[]): IntegrationRecord | undefined {
  return queue.find((record) => ACTIVE_STATES.has(record.state));
}

/** Durable cross-run destination ownership is the active IntegrationRecord itself. */
function activeDestinationIntegrations(
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

function ensureWorktreeIntegrating(
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

export const enqueueIntegration = enqueueWorktreeIntegration;
export const beginIntegration = beginWorktreeIntegration;
