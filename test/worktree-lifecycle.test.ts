import assert from "node:assert/strict";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { snapshotManifestPath, worktreeExecutionRootPath } from "../src/lib/paths.js";
import {
  CLEANUP_STATE_SCHEMA_VERSION,
  CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
  INTEGRATION_RECORD_SCHEMA_VERSION,
  fingerprintWorktreeRuntimeRecord,
  initializeWorktreeRecord,
  persistChangeBundleManifest,
  persistIntegrationRecord,
  persistSnapshotManifest,
  persistWorktreeRecord,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type ChangeBundleManifest,
  type IntegrationRecord,
  type SnapshotManifest,
  type WorktreeRecord,
} from "../src/lib/worktree-execution.js";
import {
  WorktreeLifecycleError,
  cleanupWorktreeAttempt,
  collectWorktreeRunStatus,
  markWorktreeCleanupEligible,
  recoverWorktreeRun,
} from "../src/lib/worktree-lifecycle.js";
import { setupDetachedWorktree } from "../src/lib/worktree-setup.js";
import { resolveOwningRepository } from "../src/lib/worktree-topology.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(name: string) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), `baton-lifecycle-${name}-`));
  const repo = path.join(outer, "repo");
  const stateHome = path.join(outer, "state-home");
  fs.mkdirSync(repo); fs.mkdirSync(stateHome);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Baton Test"]);
  git(repo, ["config", "user.email", "baton@example.invalid"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]); git(repo, ["commit", "-qm", "base"]);
  const owner = resolveOwningRepository(repo, "tracked.txt").repository;
  const env = { ...process.env, HOME: stateHome, USERPROFILE: stateHome, BATON_SESSION_ID: `lifecycle-${name}` };
  return { outer, repo, env, owner, baseTree: git(repo, ["rev-parse", "HEAD^{tree}"]) };
}

async function setup(f: ReturnType<typeof fixture>, runId: string, unitKey: string, attemptId = "attempt-1") {
  const executionRoot = worktreeExecutionRootPath(f.repo, runId, unitKey, attemptId, f.env);
  const result = await setupDetachedWorktree({
    repository_root: f.repo,
    repository_id: f.owner.repository_id,
    git_common_dir: f.owner.git_common_dir,
    git_common_dir_identity: f.owner.git_common_dir_identity,
    execution_root: executionRoot,
    run_id: runId,
    unit_key: unitKey,
    unit_version: 1,
    attempt_id: attemptId,
    env: f.env,
  });
  return result.record;
}

function transition(f: ReturnType<typeof fixture>, record: WorktreeRecord, input: Parameters<typeof transitionPersistedWorktreeRecord>[4]): WorktreeRecord {
  return transitionPersistedWorktreeRecord(f.repo, record.run_id, record.unit_key, record.attempt_id, input, f.env);
}

function signed<T extends { fingerprint: string }>(value: Omit<T, "fingerprint">): T {
  const result = { ...value, fingerprint: "" } as T;
  result.fingerprint = fingerprintWorktreeRuntimeRecord(result);
  return result;
}

function bundleFor(f: ReturnType<typeof fixture>, record: WorktreeRecord, bundleId: string, transport: Record<string, unknown> = { kind: "test" }): ChangeBundleManifest {
  return signed<ChangeBundleManifest>({
    schema_version: CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
    bundle_id: bundleId,
    run_id: record.run_id,
    unit_key: record.unit_key,
    unit_version: record.unit_version,
    attempt_id: record.attempt_id,
    receipt_id: `receipt-${bundleId}`,
    repository_id: record.repository_id,
    git_common_dir_identity: record.git_common_dir_identity,
    base_tree: record.base_tree,
    result_tree: record.base_tree,
    operations: [],
    changed_paths: [],
    non_text_facts: {},
    transport,
    validation_summaries: ["fixture"],
    terminal_conclusion: "fixture bundle",
    safety_verdict: "safe",
    state: "ready_for_integration",
    retention_reasons: ["ready_bundle"],
    created_at: "2026-09-01T00:00:00.000Z",
  });
}

function acceptedIntegration(record: WorktreeRecord, bundleId: string, integrationId: string): IntegrationRecord {
  return signed<IntegrationRecord>({
    schema_version: INTEGRATION_RECORD_SCHEMA_VERSION,
    integration_id: integrationId,
    revision: 0,
    run_id: record.run_id,
    repository_id: record.repository_id,
    git_common_dir_identity: record.git_common_dir_identity,
    bundle_id: bundleId,
    queue_position: 0,
    state: "accepted",
    before_tree: record.base_tree,
    after_tree: record.base_tree,
    conflicts: [],
    idempotency_keys: ["fixture-accepted"],
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:01.000Z",
  });
}

function advanceAccepted(f: ReturnType<typeof fixture>, initial: WorktreeRecord, bundleId: string, integrationId: string): WorktreeRecord {
  let record = transition(f, initial, { idempotency_key: "active", phase: "native_execution", to_state: "worker_active", native_handle: "task:fixture", retention_reasons: ["live_native_handle"] });
  record = transition(f, record, { idempotency_key: "terminal", phase: "native_execution", to_state: "terminal_awaiting_audit", native_handle: null, retention_reasons: ["pending_audit"] });
  record = transition(f, record, { idempotency_key: "bundle", phase: "bundling", to_state: "bundle_ready", bundle_id: bundleId, retention_reasons: ["ready_bundle"] });
  record = transition(f, record, { idempotency_key: "integrating", phase: "integration", to_state: "integrating", integration_id: integrationId, retention_reasons: ["active_integration"] });
  record = transition(f, record, { idempotency_key: "integrated", phase: "integration", to_state: "integrated", retention_reasons: ["downstream_base_dependency"] });
  return transition(f, record, { idempotency_key: "accepted", phase: "acceptance", to_state: "accepted", retention_reasons: ["downstream_base_dependency"] });
}

describe("worktree recovery, status, and cleanup", () => {
  it("shows live isolated progress and bounded diff facts while the caller checkout stays clean", async () => {
    const f = fixture("status");
    const record = await setup(f, "run-status", "unit-status");
    transition(f, record, { idempotency_key: "status-active", phase: "native_execution", to_state: "worker_active", native_handle: "task:live", retention_reasons: ["live_native_handle"] });
    fs.writeFileSync(path.join(record.execution_root, "tracked.txt"), "worker progress\n");
    const status = await collectWorktreeRunStatus({
      cwd: f.repo,
      run_id: record.run_id,
      env: f.env,
      tickets: [{ status: "running", liveness: { state: "running" }, rolling_unit_lineage: { run_id: record.run_id, unit_key: record.unit_key, unit_version: 1 } }],
    });
    assert.equal(status.units[0]?.lifecycle_state, "worker_active");
    assert.equal(status.units[0]?.native_liveness, "running");
    assert.deepEqual(status.units[0]?.diff.changed_paths, ["tracked.txt"]);
    assert.equal(status.units[0]?.diff.total_changed_paths, 1);
    assert.equal(status.units[0]?.registration_state, "registered");
    assert.equal(git(f.repo, ["status", "--porcelain=v1"]), "");
  });

  it("repairs a crash after Git registration and a crash after immutable bundle publication", async () => {
    const f = fixture("recovery");
    const runId = "run-recovery"; const unitKey = "unit-recovery"; const attemptId = "attempt-1";
    const executionRoot = worktreeExecutionRootPath(f.repo, runId, unitKey, attemptId, f.env);
    let record = initializeWorktreeRecord({
      repository_id: f.owner.repository_id,
      repository_root: f.repo,
      git_common_dir: f.owner.git_common_dir,
      git_common_dir_identity: f.owner.git_common_dir_identity,
      execution_root: executionRoot,
      base_tree: f.baseTree,
      run_id: runId,
      unit_key: unitKey,
      unit_version: 1,
      attempt_id: attemptId,
    });
    persistWorktreeRecord(f.repo, record, f.env);
    record = transition(f, record, { idempotency_key: "registration-started", phase: "setup", to_state: "preparing", setup_state: "registering" });
    fs.mkdirSync(path.dirname(executionRoot), { recursive: true });
    git(f.repo, ["worktree", "add", "--detach", "-q", executionRoot, "HEAD"]);
    const setupRecovery = await recoverWorktreeRun({ cwd: f.repo, run_id: runId, env: f.env });
    assert.deepEqual(setupRecovery.repaired_record_ids, [record.record_id]);
    record = readPersistedWorktreeRecord(f.repo, runId, unitKey, attemptId, f.env);
    assert.equal(record.setup_state, "verified");
    record = transition(f, record, { idempotency_key: "recovered-active", phase: "native_execution", to_state: "worker_active", native_handle: "task:done", retention_reasons: ["live_native_handle"] });
    record = transition(f, record, { idempotency_key: "recovered-terminal", phase: "native_execution", to_state: "terminal_awaiting_audit", native_handle: null, retention_reasons: ["pending_audit"] });
    const bundle = bundleFor(f, record, "bundle-recovered");
    persistChangeBundleManifest(f.repo, runId, bundle, f.env);
    const bundleRecovery = await recoverWorktreeRun({ cwd: f.repo, run_id: runId, env: f.env });
    assert.deepEqual(bundleRecovery.repaired_record_ids, [record.record_id]);
    const repaired = readPersistedWorktreeRecord(f.repo, runId, unitKey, attemptId, f.env);
    assert.equal(repaired.lifecycle_state, "bundle_ready");
    assert.equal(repaired.bundle_id, bundle.bundle_id);
    const integration = acceptedIntegration(repaired, bundle.bundle_id, "integration-recovered");
    persistIntegrationRecord(f.repo, integration, f.env);
    const integrationRecovery = await recoverWorktreeRun({ cwd: f.repo, run_id: runId, env: f.env });
    assert.deepEqual(integrationRecovery.repaired_record_ids, [record.record_id]);
    const accepted = readPersistedWorktreeRecord(f.repo, runId, unitKey, attemptId, f.env);
    assert.equal(accepted.lifecycle_state, "accepted");
    assert.equal(accepted.integration_id, integration.integration_id);
  });

  it("repairs a released pre-bind terminal attempt as rejected evidence", async () => {
    const f = fixture("pre-bind-recovery");
    const record = await setup(f, "run-pre-bind-recovery", "unit-pre-bind-recovery");
    const recovery = await recoverWorktreeRun({
      cwd: f.repo,
      run_id: record.run_id,
      env: f.env,
      tickets: [{
        status: "closed",
        slot_released_at: "2026-09-01T00:00:00.000Z",
        liveness: null,
        rolling_unit_lineage: { run_id: record.run_id, unit_key: record.unit_key, unit_version: record.unit_version },
      }],
    });
    assert.deepEqual(recovery.repaired_record_ids, [record.record_id]);
    const rejected = readPersistedWorktreeRecord(f.repo, record.run_id, record.unit_key, record.attempt_id, f.env);
    assert.equal(rejected.lifecycle_state, "rejected");
    assert.deepEqual(rejected.retention_reasons, ["rejected_result_evidence"]);
  });

  it("does not report another run's durable internal bundle ref as orphaned", async () => {
    const f = fixture("workspace-bundle-ref");
    const current = await setup(f, "run-current", "unit-current");
    const other = await setup(f, "run-other", "unit-other");
    const internalRef = "refs/baton/change-bundles/bundle-other-run";
    const internalCommit = git(f.repo, ["rev-parse", "HEAD"]);
    persistChangeBundleManifest(f.repo, other.run_id, bundleFor(f, other, "bundle-other-run", {
      kind: "git-tree-internal-commit",
      internal_base_commit: internalCommit,
      internal_commit: internalCommit,
      internal_ref: internalRef,
    }), f.env);
    git(f.repo, ["update-ref", internalRef, internalCommit]);
    const status = await collectWorktreeRunStatus({ cwd: f.repo, run_id: current.run_id, env: f.env });
    assert.equal(status.orphan_diagnostics.some((item) => item.code === "ORPHAN_INTERNAL_REF" && item.path === internalRef), false);
  });

  it("refuses unresolved retention and reports unrecorded roots as orphans", async () => {
    const f = fixture("retention");
    let record = await setup(f, "run-retention", "unit-retention");
    record = transition(f, record, { idempotency_key: "retention-active", phase: "native_execution", to_state: "worker_active", native_handle: "task:done", retention_reasons: ["live_native_handle"] });
    record = transition(f, record, { idempotency_key: "retention-terminal", phase: "native_execution", to_state: "terminal_awaiting_audit", native_handle: null, retention_reasons: ["pending_audit"] });
    record = transition(f, record, { idempotency_key: "retention-bundle", phase: "bundling", to_state: "bundle_ready", bundle_id: "bundle-retention", retention_reasons: ["ready_bundle"] });
    record = transition(f, record, { idempotency_key: "retention-integrating", phase: "integration", to_state: "integrating", integration_id: "integration-retention", retention_reasons: ["active_integration"] });
    record = transition(f, record, { idempotency_key: "retention-conflict", phase: "conflict", to_state: "awaiting_parent_resolution", retention_reasons: ["unresolved_conflict"] });
    await assert.rejects(markWorktreeCleanupEligible({ cwd: f.repo, run_id: record.run_id, unit_key: record.unit_key, attempt_id: record.attempt_id, env: f.env, release_downstream_base: true }), (error: unknown) => error instanceof WorktreeLifecycleError && error.code === "WORKTREE_CLEANUP_RETAINED" && (error.detail?.retention_reasons as string[]).includes("unresolved_conflict"));
    const orphan = worktreeExecutionRootPath(f.repo, record.run_id, "unit-orphan", "attempt-orphan", f.env);
    fs.mkdirSync(orphan, { recursive: true });
    const status = await collectWorktreeRunStatus({ cwd: f.repo, run_id: record.run_id, env: f.env });
    assert.ok(status.orphan_diagnostics.some((item) => item.code === "ORPHAN_EXECUTION_ROOT" && item.path === orphan));
    assert.equal(fs.existsSync(orphan), true);
  });

  it("cleans an exact accepted root, internal ref, and unused snapshot idempotently", async () => {
    const f = fixture("cleanup");
    let record = await setup(f, "run-cleanup", "unit-cleanup");
    const internalBase = git(f.repo, ["commit-tree", record.base_tree, "-m", "internal base"]);
    const internalCommit = git(f.repo, ["commit-tree", record.base_tree, "-p", internalBase, "-m", "internal result"]);
    const internalRef = "refs/baton/change-bundles/bundle-cleanup";
    git(f.repo, ["update-ref", internalRef, internalCommit]);
    const bundle = bundleFor(f, record, "bundle-cleanup", { kind: "git-tree-internal-commit", internal_base_commit: internalBase, internal_commit: internalCommit, internal_ref: internalRef });
    persistChangeBundleManifest(f.repo, record.run_id, bundle, f.env);
    const integration = acceptedIntegration(record, bundle.bundle_id, "integration-cleanup");
    persistIntegrationRecord(f.repo, integration, f.env);
    const snapshot = signed<SnapshotManifest>({
      schema_version: 1,
      snapshot_id: "snapshot-cleanup",
      repository_id: record.repository_id,
      git_common_dir_identity: record.git_common_dir_identity,
      source_root: f.repo,
      head_tree: record.base_tree,
      snapshot_tree: record.base_tree,
      included_paths: [],
      excluded_paths: [],
      git_facts: {},
      caller_before_fingerprint: "a".repeat(64),
      caller_after_fingerprint: "a".repeat(64),
      created_at: "2026-09-01T00:00:00.000Z",
    });
    persistSnapshotManifest(f.repo, record.run_id, snapshot, f.env);
    record = advanceAccepted(f, record, bundle.bundle_id, integration.integration_id);
    const caller = { head: git(f.repo, ["rev-parse", "HEAD"]), status: git(f.repo, ["status", "--porcelain=v1"]), index: fs.readFileSync(path.join(f.repo, ".git", "index")) };
    const gitCommands: string[][] = [];
    const capturingSpawn = ((command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => {
      gitCommands.push([...args]);
      return nodeSpawn(command, args, options);
    }) as typeof nodeSpawn;
    const cleaned = await cleanupWorktreeAttempt({ cwd: f.repo, run_id: record.run_id, unit_key: record.unit_key, attempt_id: record.attempt_id, env: f.env, release_downstream_base: true, spawn: capturingSpawn });
    assert.ok(gitCommands.some((args) => args[0] === "cat-file" && args[1] === "-e"));
    assert.equal(cleaned.record.lifecycle_state, "cleaned");
    assert.equal(cleaned.removed_worktree, true);
    assert.equal(cleaned.removed_internal_ref, internalRef);
    assert.deepEqual(cleaned.removed_snapshot_ids, [snapshot.snapshot_id]);
    assert.equal(fs.existsSync(record.execution_root), false);
    assert.equal(fs.existsSync(snapshotManifestPath(f.repo, record.run_id, snapshot.snapshot_id, f.env)), false);
    assert.throws(() => git(f.repo, ["rev-parse", "--verify", internalRef]));
    assert.deepEqual({ head: git(f.repo, ["rev-parse", "HEAD"]), status: git(f.repo, ["status", "--porcelain=v1"]), index: fs.readFileSync(path.join(f.repo, ".git", "index")) }, caller);
    const replay = await cleanupWorktreeAttempt({ cwd: f.repo, run_id: record.run_id, unit_key: record.unit_key, attempt_id: record.attempt_id, env: f.env, release_downstream_base: true });
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.cleanup.status, "cleaned");
    const status = await collectWorktreeRunStatus({
      cwd: f.repo,
      run_id: record.run_id,
      env: f.env,
      tickets: [{
        status: "completed",
        slot_released_at: "2026-09-01T00:00:00.000Z",
        liveness: { state: "running" },
        rolling_unit_lineage: { run_id: record.run_id, unit_key: record.unit_key, unit_version: record.unit_version },
      }],
    });
    assert.equal(status.units[0]?.native_liveness, "terminal");
    assert.equal(status.units[0]?.diagnostics.some((item) => item.code === "BUNDLE_INTERNAL_REF_MISSING"), false);
  });

  it("refuses a rewritten cleanup target, preserves it, and records a visible cleanup failure", async () => {
    const f = fixture("cleanup-drift");
    let record = await setup(f, "run-cleanup-drift", "unit-cleanup-drift");
    const bundle = bundleFor(f, record, "bundle-cleanup-drift");
    const integration = acceptedIntegration(record, bundle.bundle_id, "integration-cleanup-drift");
    persistChangeBundleManifest(f.repo, record.run_id, bundle, f.env);
    persistIntegrationRecord(f.repo, integration, f.env);
    record = advanceAccepted(f, record, bundle.bundle_id, integration.integration_id);
    git(f.repo, ["worktree", "remove", "--force", record.execution_root]);
    fs.mkdirSync(record.execution_root, { recursive: true });
    fs.writeFileSync(path.join(record.execution_root, "foreign.txt"), "must survive refusal\n");
    await assert.rejects(cleanupWorktreeAttempt({ cwd: f.repo, run_id: record.run_id, unit_key: record.unit_key, attempt_id: record.attempt_id, env: f.env, release_downstream_base: true }), (error: unknown) => error instanceof WorktreeLifecycleError && error.code === "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH");
    assert.equal(fs.readFileSync(path.join(record.execution_root, "foreign.txt"), "utf8"), "must survive refusal\n");
    const failed = readPersistedWorktreeRecord(f.repo, record.run_id, record.unit_key, record.attempt_id, f.env);
    assert.equal(failed.lifecycle_state, "cleanup_failed");
    assert.equal(failed.cleanup.status, "failed");
    assert.match(failed.cleanup.last_error ?? "", /recorded repository/u);
  });

  it("prunes stale Git registration when an eligible execution root is already absent", async () => {
    const f = fixture("cleanup-stale-registration");
    let record = await setup(f, "run-cleanup-stale-registration", "unit-cleanup-stale-registration");
    const bundle = bundleFor(f, record, "bundle-cleanup-stale-registration");
    const integration = acceptedIntegration(record, bundle.bundle_id, "integration-cleanup-stale-registration");
    persistChangeBundleManifest(f.repo, record.run_id, bundle, f.env);
    persistIntegrationRecord(f.repo, integration, f.env);
    record = advanceAccepted(f, record, bundle.bundle_id, integration.integration_id);
    fs.rmSync(record.execution_root, { recursive: true, force: true });
    assert.match(git(f.repo, ["worktree", "list", "--porcelain"]), new RegExp(record.execution_root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const cleaned = await cleanupWorktreeAttempt({
      cwd: f.repo,
      run_id: record.run_id,
      unit_key: record.unit_key,
      attempt_id: record.attempt_id,
      env: f.env,
      release_downstream_base: true,
    });
    assert.equal(cleaned.record.lifecycle_state, "cleaned");
    assert.equal(cleaned.removed_worktree, true, `expected stale registration cleanup for ${record.execution_root}: ${git(f.repo, ["worktree", "list", "--porcelain"])}`);
    assert.doesNotMatch(git(f.repo, ["worktree", "list", "--porcelain"]), new RegExp(record.execution_root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
