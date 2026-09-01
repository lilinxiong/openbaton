import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
  CLEANUP_STATE_SCHEMA_VERSION,
  INTEGRATION_RECORD_SCHEMA_VERSION,
  SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  WorktreeExecutionError,
  applyWorktreeLifecycleTransition,
  assertIsolatedWorktreeExecution,
  fingerprintWorktreeRuntimeRecord,
  initializeWorktreeRecord,
  persistChangeBundleManifest,
  persistIntegrationRecord,
  persistSnapshotManifest,
  persistWorktreeRecord,
  readPersistedChangeBundleManifest,
  readPersistedIntegrationRecord,
  readPersistedSnapshotManifest,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  validateWorktreeRecord,
  type ChangeBundleManifest,
  type CreateWorktreeRecordInput,
  type IntegrationRecord,
  type SnapshotManifest,
  type WorktreeRecord,
  type WorktreeTransitionInput,
} from "../src/lib/worktree-execution.js";
import { worktreeExecutionRootPath, worktreeRecordPath } from "../src/lib/paths.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture {
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: CreateWorktreeRecordInput;
}

function fixture(prefix = "baton-worktree-state-"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cwd = path.join(root, "repository");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  git(cwd, ["init", "-q"]);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const runId = "run-1";
  const unitKey = "unit-1";
  const attemptId = "attempt-1";
  return {
    root,
    cwd,
    env,
    input: {
      record_id: "record-1",
      execution_mode: "isolated-worktree",
      repository_id: "a".repeat(64),
      repository_root: fs.realpathSync(cwd),
      git_common_dir: fs.realpathSync(path.join(cwd, ".git")),
      git_common_dir_identity: "b".repeat(64),
      execution_root: worktreeExecutionRootPath(cwd, runId, unitKey, attemptId, env),
      base_tree: "c".repeat(40),
      run_id: runId,
      unit_key: unitKey,
      unit_version: 1,
      attempt_id: attemptId,
      created_at: "2026-09-01T00:00:00.000Z",
    },
  };
}

function signed<T extends { fingerprint: string }>(input: Omit<T, "fingerprint">): T {
  const value = { ...input, fingerprint: "" } as T;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

function transition(f: Fixture, input: WorktreeTransitionInput): WorktreeRecord {
  return transitionPersistedWorktreeRecord(f.cwd, f.input.run_id, f.input.unit_key, f.input.attempt_id, input, f.env);
}

describe("worktree execution state", () => {
  it("gates isolated execution on persisted rolling-v2 mode", () => {
    assert.equal(assertIsolatedWorktreeExecution({ schema_version: 2, identity: { execution_mode: "isolated-worktree" } }), "isolated-worktree");
    assert.throws(
      () => assertIsolatedWorktreeExecution({ schema_version: 1 }, "isolated-worktree"),
      (error: unknown) => (error as { code?: string }).code === "ROLLING_V2_REQUIRED",
    );
    assert.throws(
      () => assertIsolatedWorktreeExecution({ schema_version: 2, identity: { execution_mode: "shared-worktree" } }),
      (error: unknown) => error instanceof WorktreeExecutionError && error.code === "ISOLATED_WORKTREE_REQUIRED",
    );
  });

  it("persists setup through cleanup atomically and replays transition identities idempotently", () => {
    const f = fixture();
    const initial = initializeWorktreeRecord(f.input);
    assert.equal(validateWorktreeRecord(initial).valid, true);
    assert.equal(persistWorktreeRecord(f.cwd, initial, f.env).fingerprint, initial.fingerprint);
    assert.equal(persistWorktreeRecord(f.cwd, initial, f.env).fingerprint, initial.fingerprint);

    const inputs: WorktreeTransitionInput[] = [
      { idempotency_key: "setup-registering", phase: "setup", to_state: "preparing", setup_state: "registering", recorded_at: "2026-09-01T00:00:01.000Z" },
      { idempotency_key: "setup-registered", phase: "setup", to_state: "preparing", setup_state: "registered", recorded_at: "2026-09-01T00:00:02.000Z" },
      { idempotency_key: "setup-verified", phase: "setup", to_state: "preparing", setup_state: "verified", recorded_at: "2026-09-01T00:00:03.000Z" },
      { idempotency_key: "native-active", phase: "native_execution", to_state: "worker_active", native_handle: "opaque-handle", retention_reasons: ["live_native_handle"], recorded_at: "2026-09-01T00:00:04.000Z" },
      { idempotency_key: "native-terminal", phase: "native_execution", to_state: "terminal_awaiting_audit", retention_reasons: ["pending_audit"], recorded_at: "2026-09-01T00:00:05.000Z" },
      { idempotency_key: "bundle-ready", phase: "bundling", to_state: "bundle_ready", bundle_id: "bundle-1", retention_reasons: ["ready_bundle"], recorded_at: "2026-09-01T00:00:06.000Z" },
      { idempotency_key: "integration-active", phase: "integration", to_state: "integrating", integration_id: "integration-1", retention_reasons: ["active_integration"], recorded_at: "2026-09-01T00:00:07.000Z" },
      { idempotency_key: "integration-conflict", phase: "conflict", to_state: "awaiting_parent_resolution", retention_reasons: ["unresolved_conflict"], recorded_at: "2026-09-01T00:00:08.000Z" },
      { idempotency_key: "integration-resolved", phase: "integration", to_state: "integrated", retention_reasons: ["downstream_base_dependency"], recorded_at: "2026-09-01T00:00:09.000Z" },
      { idempotency_key: "parent-accepted", phase: "acceptance", to_state: "accepted", recorded_at: "2026-09-01T00:00:10.000Z" },
      {
        idempotency_key: "cleanup-eligible",
        phase: "cleanup",
        to_state: "cleanup_eligible",
        retention_reasons: [],
        cleanup: { schema_version: CLEANUP_STATE_SCHEMA_VERSION, status: "eligible", attempts: 0, updated_at: "2026-09-01T00:00:11.000Z" },
        recorded_at: "2026-09-01T00:00:11.000Z",
      },
      {
        idempotency_key: "cleanup-complete",
        phase: "cleanup",
        to_state: "cleaned",
        cleanup: { schema_version: CLEANUP_STATE_SCHEMA_VERSION, status: "cleaned", attempts: 1, updated_at: "2026-09-01T00:00:12.000Z" },
        recorded_at: "2026-09-01T00:00:12.000Z",
      },
    ];
    let current = initial;
    for (const input of inputs) current = transition(f, input);
    assert.equal(current.lifecycle_state, "cleaned");
    assert.equal(current.revision, inputs.length);
    assert.equal(current.cleanup.status, "cleaned");
    assert.deepEqual(current.retention_reasons, []);

    const replay = transition(f, inputs[0]!);
    assert.equal(replay.fingerprint, current.fingerprint);
    assert.throws(
      () => transition(f, { ...inputs[0]!, to_state: "worker_active" }),
      (error: unknown) => error instanceof WorktreeExecutionError && error.code === "WORKTREE_IDEMPOTENCY_CONFLICT",
    );
    assert.throws(
      () => transition(f, { idempotency_key: "after-cleanup", phase: "native_execution", to_state: "worker_active" }),
      (error: unknown) => error instanceof WorktreeExecutionError && error.code === "WORKTREE_TRANSITION_INVALID",
    );
  });

  it("keeps immutable worktree identity fixed across persisted revisions", () => {
    const f = fixture("baton-worktree-immutable-");
    const initial = initializeWorktreeRecord(f.input);
    persistWorktreeRecord(f.cwd, initial, f.env);
    const next = applyWorktreeLifecycleTransition(initial, {
      idempotency_key: "setup-registering",
      phase: "setup",
      to_state: "preparing",
      setup_state: "registering",
      recorded_at: "2026-09-01T00:00:01.000Z",
    });
    const changed = { ...next, execution_root: path.join(f.root, "different-root") };
    changed.fingerprint = fingerprintWorktreeRuntimeRecord(changed);
    assert.throws(
      () => persistWorktreeRecord(f.cwd, changed, f.env),
      (error: unknown) => error instanceof WorktreeExecutionError && error.code === "WORKTREE_IDENTITY_MISMATCH",
    );

    for (const mutation of [
      { repository_id: "d".repeat(64) },
      { base_tree: "e".repeat(40) },
      { execution_mode: "shared-worktree" as const },
    ]) {
      const changedIdentity = { ...next, ...mutation };
      changedIdentity.fingerprint = fingerprintWorktreeRuntimeRecord(changedIdentity);
      assert.throws(
        () => persistWorktreeRecord(f.cwd, changedIdentity, f.env),
        (error: unknown) => error instanceof WorktreeExecutionError && error.code === "WORKTREE_IDENTITY_MISMATCH",
      );
    }
  });

  it("recovers a valid partial atomic record and rejects corrupt or conflicting candidates", () => {
    const recoverable = fixture("baton-worktree-partial-");
    const record = initializeWorktreeRecord(recoverable.input);
    const file = worktreeRecordPath(recoverable.cwd, record.run_id, record.unit_key, record.attempt_id, recoverable.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp-recoverable`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const recovered = readPersistedWorktreeRecord(recoverable.cwd, record.run_id, record.unit_key, record.attempt_id, recoverable.env);
    assert.equal(recovered.fingerprint, record.fingerprint);
    assert.equal(fs.existsSync(file), true);

    const divergent = fixture("baton-worktree-divergent-");
    const primary = initializeWorktreeRecord(divergent.input);
    persistWorktreeRecord(divergent.cwd, primary, divergent.env);
    const higherRevision = applyWorktreeLifecycleTransition(primary, {
      idempotency_key: "setup-registering",
      phase: "setup",
      to_state: "preparing",
      setup_state: "registering",
      recorded_at: "2026-09-01T00:00:01.000Z",
    });
    higherRevision.repository_id = "d".repeat(64);
    higherRevision.fingerprint = fingerprintWorktreeRuntimeRecord(higherRevision);
    const divergentFile = worktreeRecordPath(divergent.cwd, primary.run_id, primary.unit_key, primary.attempt_id, divergent.env);
    fs.writeFileSync(`${divergentFile}.tmp-divergent`, JSON.stringify(higherRevision));
    assert.throws(
      () => readPersistedWorktreeRecord(divergent.cwd, primary.run_id, primary.unit_key, primary.attempt_id, divergent.env),
      (error: unknown) => error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_CONFLICT",
    );

    const conflicting = fixture("baton-worktree-conflicting-");
    const first = initializeWorktreeRecord(conflicting.input);
    const second = initializeWorktreeRecord({ ...conflicting.input, record_id: "record-2", repository_id: "d".repeat(64) });
    const conflictFile = worktreeRecordPath(conflicting.cwd, first.run_id, first.unit_key, first.attempt_id, conflicting.env);
    fs.mkdirSync(path.dirname(conflictFile), { recursive: true });
    fs.writeFileSync(`${conflictFile}.tmp-first`, JSON.stringify(first));
    fs.writeFileSync(`${conflictFile}.tmp-second`, JSON.stringify(second));
    assert.throws(
      () => readPersistedWorktreeRecord(conflicting.cwd, first.run_id, first.unit_key, first.attempt_id, conflicting.env),
      (error: unknown) => error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_CONFLICT",
    );

    const corrupt = fixture("baton-worktree-corrupt-");
    const corruptRecord = initializeWorktreeRecord(corrupt.input);
    const corruptFile = worktreeRecordPath(corrupt.cwd, corruptRecord.run_id, corruptRecord.unit_key, corruptRecord.attempt_id, corrupt.env);
    fs.mkdirSync(path.dirname(corruptFile), { recursive: true });
    fs.writeFileSync(corruptFile, "{partial\n");
    assert.throws(
      () => readPersistedWorktreeRecord(corrupt.cwd, corruptRecord.run_id, corruptRecord.unit_key, corruptRecord.attempt_id, corrupt.env),
      (error: unknown) => error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_CORRUPT",
    );

    const incompatible = { ...record, schema_version: 99 };
    assert.equal(validateWorktreeRecord(incompatible).valid, false);
    assert.ok(validateWorktreeRecord(incompatible).diagnostics.some((item) => item.code === "UNKNOWN_SCHEMA"));
  });

  it("does not publish a record when its atomic rename fails", () => {
    const f = fixture("baton-worktree-atomic-");
    const record = initializeWorktreeRecord(f.input);
    const file = worktreeRecordPath(f.cwd, record.run_id, record.unit_key, record.attempt_id, f.env);
    const original = fs.renameSync;
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (String(destination) === file) throw new Error("simulated rename failure");
      return original(source, destination);
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => persistWorktreeRecord(f.cwd, record, f.env), /simulated rename failure/);
    } finally {
      fs.renameSync = original;
    }
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).some((name) => name.startsWith(`${path.basename(file)}.tmp-`)) : false, false);
  });

  it("round trips versioned snapshot, bundle, and integration records idempotently", () => {
    const f = fixture("baton-worktree-manifests-");
    const snapshot = signed<SnapshotManifest>({
      schema_version: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
      snapshot_id: "snapshot-1",
      repository_id: "a".repeat(64),
      git_common_dir_identity: "b".repeat(64),
      source_root: f.cwd,
      head_tree: "c".repeat(40),
      snapshot_tree: "d".repeat(40),
      included_paths: ["src/a.ts"],
      excluded_paths: ["tmp/"],
      git_facts: { "src/a.ts": { object_id: "e".repeat(40), mode: "100644" } },
      caller_before_fingerprint: "f".repeat(64),
      caller_after_fingerprint: "f".repeat(64),
      created_at: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(persistSnapshotManifest(f.cwd, "run-1", snapshot, f.env).fingerprint, snapshot.fingerprint);
    assert.equal(persistSnapshotManifest(f.cwd, "run-1", snapshot, f.env).fingerprint, snapshot.fingerprint);
    assert.deepEqual(readPersistedSnapshotManifest(f.cwd, "run-1", "snapshot-1", f.env), snapshot);

    const bundle = signed<ChangeBundleManifest>({
      schema_version: CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
      bundle_id: "bundle-1",
      run_id: "run-1",
      unit_key: "unit-1",
      unit_version: 1,
      attempt_id: "attempt-1",
      receipt_id: "receipt-1",
      repository_id: "a".repeat(64),
      git_common_dir_identity: "b".repeat(64),
      base_tree: "c".repeat(40),
      result_tree: "d".repeat(40),
      operations: ["write", "rename"],
      changed_paths: ["src/a.ts", "src/b.ts"],
      non_text_facts: { renames: [{ source: "src/a.ts", target: "src/b.ts" }], binary_paths: [] },
      transport: { internal_commit: "e".repeat(40) },
      validation_summaries: ["focused tests passed"],
      terminal_conclusion: "Implemented the scoped change.",
      safety_verdict: "safe",
      retention_reasons: ["ready_bundle"],
      created_at: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(persistChangeBundleManifest(f.cwd, "run-1", bundle, f.env).fingerprint, bundle.fingerprint);
    assert.deepEqual(readPersistedChangeBundleManifest(f.cwd, "run-1", "bundle-1", f.env), bundle);

    const integration = signed<IntegrationRecord>({
      schema_version: INTEGRATION_RECORD_SCHEMA_VERSION,
      integration_id: "integration-1",
      revision: 0,
      run_id: "run-1",
      repository_id: "a".repeat(64),
      git_common_dir_identity: "b".repeat(64),
      bundle_id: "bundle-1",
      queue_position: 0,
      state: "queued",
      before_tree: "c".repeat(40),
      conflicts: [],
      idempotency_keys: ["queue-integration-1"],
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(persistIntegrationRecord(f.cwd, integration, f.env).fingerprint, integration.fingerprint);
    assert.deepEqual(readPersistedIntegrationRecord(f.cwd, "run-1", "a".repeat(64), "integration-1", f.env), integration);

    const conflictingSnapshot = signed<SnapshotManifest>({ ...snapshot, included_paths: ["src/other.ts"] });
    assert.throws(
      () => persistSnapshotManifest(f.cwd, "run-1", conflictingSnapshot, f.env),
      (error: unknown) => error instanceof WorktreeExecutionError && error.code === "WORKTREE_IDEMPOTENCY_CONFLICT",
    );
  });
});
