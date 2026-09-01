/** Parent-owned, repository-serialized bundle integration lifecycle.
 *
 * Admission freezes the caller baseline, application uses isolated Git object
 * plumbing, resolution records a separate audited result, and acceptance is
 * the only phase allowed to apply the frozen result to the caller checkout.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertGitSafetyStabilityTokenUnchanged,
  captureStableSafetyFacts,
  consumeGitBinaryPaths,
  consumeGitRawTreeChanges,
  fingerprintGitSafetyStabilityToken,
  streamGitSafetyFact,
  type GitTreeChangeFact,
  type StableGitSafetyFacts,
} from "./git-safety-facts.js";
import { collectGitScalar, GitSafetyError, runGitProcess, type GitProcessOptions } from "./git-safety-process.js";
import { withOwnedLock, withOwnedLockAsync } from "./owned-lock.js";
import {
  integrationDestinationLockPath,
  integrationQueueLockPath,
  integrationRepositoryDir,
  rollingRunsDir,
} from "./paths.js";
import { readRollingExecutionRun } from "./rolling-run.js";
import { acceptRollingGate } from "./rolling-control.js";
import type { UnitVersion } from "./rolling-plan.js";
import type { ChangeBundleOperation } from "./worktree-execution.js";
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
  type IntegrationApplicationIntent,
  type IntegrationAcceptanceIntent,
  type IntegrationBeginAuthorization,
  type IntegrationConflict,
  type IntegrationQueueOrderProvenance,
  type IntegrationRecord,
  type IntegrationResolutionResult,
} from "./worktree-execution.js";

export type WorktreeIntegrationErrorCode =
  | "INTEGRATION_INPUT_INVALID"
  | "INTEGRATION_BUNDLE_NOT_READY"
  | "INTEGRATION_IDENTITY_MISMATCH"
  | "INTEGRATION_DESTINATION_BASELINE_MISMATCH"
  | "INTEGRATION_QUEUE_BLOCKED"
  | "INTEGRATION_QUEUE_CORRUPT"
  | "INTEGRATION_QUEUE_LINEAGE_MISSING"
  | "INTEGRATION_APPLICATION_FAILED"
  | "INTEGRATION_RESOLUTION_INVALID"
  | "INTEGRATION_ACCEPTANCE_FAILED"
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

export interface ApplyWorktreeIntegrationInput {
  repository_root: string;
  run_id: string;
  repository_id: string;
  bundle_id: string;
  idempotency_key?: string;
  env?: NodeJS.ProcessEnv;
  at?: string | number | Date;
  spawn?: GitProcessOptions["spawn"];
}

export interface ResolveWorktreeIntegrationInput extends ApplyWorktreeIntegrationInput {
  resolved_tree: string;
  conclusion: string;
}

export interface AcceptWorktreeIntegrationInput extends ApplyWorktreeIntegrationInput {
  conclusion: string;
}

export interface IntegrationQueueResult {
  record: IntegrationRecord;
  queue: IntegrationRecord[];
  replayed: boolean;
}

export interface BeginWorktreeIntegrationResult extends IntegrationQueueResult {
  bundle: ChangeBundleManifest;
}

export interface ApplyWorktreeIntegrationResult {
  record: IntegrationRecord;
  bundle: ChangeBundleManifest;
  replayed: boolean;
}

export interface ResolveWorktreeIntegrationResult extends ApplyWorktreeIntegrationResult {
  resolution: IntegrationResolutionResult;
}

export interface AcceptWorktreeIntegrationResult extends ApplyWorktreeIntegrationResult {
  accepted_gate_refs: string[];
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

function applyOperationKey(input: ApplyWorktreeIntegrationInput): string {
  return `apply:${input.idempotency_key ?? sha(JSON.stringify({
    run_id: input.run_id,
    repository_id: input.repository_id,
    bundle_id: input.bundle_id,
  }))}`;
}

function resolveOperationKey(input: ResolveWorktreeIntegrationInput): string {
  return `resolve:${input.idempotency_key ?? sha(JSON.stringify({
    run_id: input.run_id,
    repository_id: input.repository_id,
    bundle_id: input.bundle_id,
    resolved_tree: input.resolved_tree,
    conclusion: input.conclusion.trim(),
  }))}`;
}

function acceptOperationKey(input: AcceptWorktreeIntegrationInput): string {
  return `accept:${input.idempotency_key ?? sha(JSON.stringify({
    run_id: input.run_id,
    repository_id: input.repository_id,
    bundle_id: input.bundle_id,
    conclusion: input.conclusion.trim(),
  }))}`;
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

function signApplication(intent: Omit<IntegrationApplicationIntent, "fingerprint">): IntegrationApplicationIntent {
  const value = { ...intent, fingerprint: "" } as IntegrationApplicationIntent;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

function signResolution(result: Omit<IntegrationResolutionResult, "fingerprint">): IntegrationResolutionResult {
  const value = { ...result, fingerprint: "" } as IntegrationResolutionResult;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

function signAcceptance(intent: Omit<IntegrationAcceptanceIntent, "fingerprint">): IntegrationAcceptanceIntent {
  const value = { ...intent, fingerprint: "" } as IntegrationAcceptanceIntent;
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

interface MergeStageFact { path: string; mode: string; object: string; stage: 1 | 2 | 3 }

function conflictKind(types: readonly string[], facts: readonly MergeStageFact[]): IntegrationConflict["kind"] {
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

function classifyConflict(pathName: string, facts: readonly MergeStageFact[], types: readonly string[]): IntegrationConflict {
  const stableTypes = [...new Set(types)].sort();
  const stages = [...facts]
    .sort((left, right) => left.stage - right.stage)
    .map((fact) => `${fact.stage}:${fact.mode}:${fact.object}`)
    .join(",");
  const detail = `${stableTypes.length ? `types=${stableTypes.join("|")};` : ""}stages=${stages}`;
  return { path: pathName, kind: conflictKind(stableTypes, facts), detail };
}

function parseConflictTypes(fields: readonly string[], start: number, knownPaths: ReadonlySet<string>): Map<string, string[]> {
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

async function mergeBundleTrees(
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

function ensureWorktreeApplicationState(
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

const OPERATION_ORDER: readonly ChangeBundleOperation[] = ["write", "create", "delete", "rename", "copy", "chmod"];

function operationsForChange(change: GitTreeChangeFact): ChangeBundleOperation[] {
  const operations = new Set<ChangeBundleOperation>([change.operation]);
  if (change.old_mode !== change.new_mode && change.status !== "A" && change.status !== "D") operations.add("chmod");
  return OPERATION_ORDER.filter((operation) => operations.has(operation));
}

async function auditResolutionTree(
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

function sameCallerControl(left: IntegrationBeginAuthorization, right: IntegrationBeginAuthorization): boolean {
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

async function applyAcceptedTree(
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

function integrationGateRefs(run: ReturnType<typeof readRollingExecutionRun>, bundle: ChangeBundleManifest): string[] {
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

async function acceptIntegrationGates(
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

function ensureWorktreeAcceptedState(
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

export const enqueueIntegration = enqueueWorktreeIntegration;
export const beginIntegration = beginWorktreeIntegration;
export const applyIntegration = applyWorktreeIntegration;
export const resolveIntegration = resolveWorktreeIntegration;
export const acceptIntegration = acceptWorktreeIntegration;
