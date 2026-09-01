import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { run } from "../src/cli.js";
import { worktreeExecutionRootPath } from "../src/lib/paths.js";
import { appendRollingPlanDelta, createRollingExecutionRun } from "../src/lib/rolling-run.js";
import type { PlanDelta, UnitVersion } from "../src/lib/rolling-plan.js";
import {
  CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
  fingerprintWorktreeRuntimeRecord,
  initializeWorktreeRecord,
  persistChangeBundleManifest,
  persistWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type ChangeBundleManifest,
} from "../src/lib/worktree-execution.js";
import {
  WorktreeIntegrationError,
  beginWorktreeIntegration,
  enqueueWorktreeIntegration,
  listIntegrationQueue,
} from "../src/lib/worktree-integration.js";
import { resolveOwningRepository } from "../src/lib/worktree-topology.js";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function signedBundle(input: {
  run: string;
  bundle: string;
  unit: string;
  repositoryId: string;
  commonId: string;
  tree: string;
  resultTree?: string;
}): ChangeBundleManifest {
  const value = {
    schema_version: CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
    bundle_id: input.bundle,
    run_id: input.run,
    unit_key: input.unit,
    unit_version: 1,
    attempt_id: "attempt-1",
    receipt_id: `receipt-${input.unit}`,
    repository_id: input.repositoryId,
    git_common_dir_identity: input.commonId,
    base_tree: input.tree,
    result_tree: input.resultTree ?? input.tree,
    operations: ["write"],
    changed_paths: ["file.txt"],
    non_text_facts: {},
    transport: { kind: "test" },
    validation_summaries: [],
    terminal_conclusion: "ready",
    safety_verdict: "safe",
    state: "ready_for_integration",
    retention_reasons: ["ready_bundle"],
    created_at: "2026-09-01T00:00:00.000Z",
    fingerprint: "",
  } as ChangeBundleManifest;
  value.fingerprint = fingerprintWorktreeRuntimeRecord(value);
  return value;
}

function plannedUnit(unitKey: string, dependsOn: string[] = []): UnitVersion {
  return {
    schema_version: 1,
    unit_key: unitKey,
    version: 1,
    task_keys: [`task-${unitKey}`],
    depends_on: dependsOn,
    execution_mode: "patch-only",
    worktree_mode: "isolated-worktree",
    prompt: `implement ${unitKey}`,
    write_paths: [`src/${unitKey}.ts`],
    allowed_operations: ["write"],
    completion_criteria: [`${unitKey} complete`],
    permitted_validation: ["focused test"],
    input_fingerprints: { fixture: "f".repeat(64) },
  };
}

function createPlanRun(root: string, env: NodeJS.ProcessEnv, runId: string, deltas: UnitVersion[][]): void {
  createRollingExecutionRun({
    cwd: root,
    runId,
    host: "codex",
    adapter: "director",
    source_kind: "director",
    execution_mode: "isolated-worktree",
    env,
    source: { schema_version: 1, source_kind: "director", adapter: "director", selection: { run: runId } },
    now: "2026-09-01T00:00:00.000Z",
  });
  for (const [index, units] of deltas.entries()) {
    const delta: PlanDelta = {
      schema_version: 1,
      delta_id: `delta-${runId}-${index + 1}`,
      prepared_from_append_sequence: index,
      unit_versions: units,
      gate_versions: [],
      task_coverage: units.map((unit) => ({
        schema_version: 1,
        task_key: unit.task_keys[0]!,
        kind: "unit",
        unit_versions: [`${unit.unit_key}@${unit.version}`],
      })),
    };
    appendRollingPlanDelta({ cwd: root, env, runId, expected_append_sequence: index, delta });
  }
}

function markBundleReady(
  root: string,
  env: NodeJS.ProcessEnv,
  bundle: ChangeBundleManifest,
  gitCommonDir: string,
): void {
  const execution = worktreeExecutionRootPath(root, bundle.run_id, bundle.unit_key, bundle.attempt_id, env);
  persistWorktreeRecord(root, initializeWorktreeRecord({
    repository_id: bundle.repository_id,
    repository_root: root,
    git_common_dir: gitCommonDir,
    git_common_dir_identity: bundle.git_common_dir_identity,
    execution_root: execution,
    base_tree: bundle.base_tree,
    run_id: bundle.run_id,
    unit_key: bundle.unit_key,
    unit_version: bundle.unit_version,
    attempt_id: bundle.attempt_id,
    created_at: "2026-09-01T00:00:00.000Z",
  }), env);
  const transition = (id: string, phase: "setup" | "native_execution" | "bundling", state: "preparing" | "worker_active" | "terminal_awaiting_audit" | "bundle_ready", extra = {}) => {
    transitionPersistedWorktreeRecord(root, bundle.run_id, bundle.unit_key, bundle.attempt_id, {
      idempotency_key: id,
      phase,
      to_state: state,
      recorded_at: "2026-09-01T00:00:01.000Z",
      ...extra,
    }, env);
  };
  transition("setup-registering", "setup", "preparing", { setup_state: "registering" });
  transition("setup-registered", "setup", "preparing", { setup_state: "registered" });
  transition("setup-verified", "setup", "preparing", { setup_state: "verified" });
  transition("native-active", "native_execution", "worker_active", { native_handle: "test-handle", retention_reasons: ["live_native_handle"] });
  transition("native-terminal", "native_execution", "terminal_awaiting_audit", { native_handle: null, retention_reasons: ["pending_audit"] });
  transition("bundle-ready", "bundling", "bundle_ready", { bundle_id: bundle.bundle_id, retention_reasons: ["ready_bundle"] });
  persistChangeBundleManifest(root, bundle.run_id, bundle, env);
}

function captureVisibleTree(root: string): string {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-test-index-"));
  const index = path.join(temporary, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    git(root, ["read-tree", "HEAD^{tree}"], env);
    git(root, ["add", "-A", "--", "."], env);
    return git(root, ["write-tree"], env);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function repositoryFixture(): {
  root: string;
  env: NodeJS.ProcessEnv;
  repositoryId: string;
  commonId: string;
  commonDir: string;
  baseTree: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-home-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Baton Test"]);
  git(root, ["config", "user.email", "baton@example.invalid"]);
  fs.writeFileSync(path.join(root, "file.txt"), "base\n");
  git(root, ["add", "file.txt"]);
  git(root, ["commit", "-qm", "base"]);
  const owner = resolveOwningRepository(root, "file.txt").repository;
  return {
    root,
    env: { ...process.env, HOME: home, USERPROFILE: home, BATON_SESSION_ID: "integration-test" },
    repositoryId: owner.repository_id,
    commonId: owner.git_common_dir_identity,
    commonDir: owner.git_common_dir,
    baseTree: git(root, ["rev-parse", "HEAD^{tree}"]),
  };
}

describe("repository integration queue", () => {
  it("orders inverse arrivals by accepted delta dependencies and preserves parent override provenance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-queue-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-queue-home-"));
    const env = { ...process.env, HOME: home, USERPROFILE: home, BATON_SESSION_ID: "integration-queue-test" };
    const runId = "run-queue";
    const repositoryId = "a".repeat(64);
    const commonId = "b".repeat(64);
    const tree = "c".repeat(40);
    createPlanRun(root, env, runId, [
      [plannedUnit("unit-b", ["unit-a"]), plannedUnit("unit-a")],
      [plannedUnit("unit-c")],
    ]);
    for (const [bundleId, unit] of [["bundle-a", "unit-a"], ["bundle-b", "unit-b"], ["bundle-c", "unit-c"]]) {
      const bundle = signedBundle({ run: runId, bundle: bundleId!, unit: unit!, repositoryId, commonId, tree });
      persistChangeBundleManifest(root, runId, bundle, env);
    }
    const dependentFirst = enqueueWorktreeIntegration({ repository_root: root, run_id: runId, repository_id: repositoryId, bundle_id: "bundle-b", expected_before_tree: tree, env, at: "2026-09-01T00:00:01.000Z" });
    const replay = enqueueWorktreeIntegration({ repository_root: root, run_id: runId, repository_id: repositoryId, bundle_id: "bundle-b", expected_before_tree: tree, env, at: "2026-09-01T00:00:09.000Z" });
    const overridden = enqueueWorktreeIntegration({ repository_root: root, run_id: runId, repository_id: repositoryId, bundle_id: "bundle-c", expected_before_tree: tree, order_override: 7, env, at: "2026-09-01T00:00:02.000Z" });
    const dependencyLast = enqueueWorktreeIntegration({ repository_root: root, run_id: runId, repository_id: repositoryId, bundle_id: "bundle-a", expected_before_tree: tree, env, at: "2026-09-01T00:00:03.000Z" });
    assert.equal(dependentFirst.record.queue_order?.dependency_rank, 1);
    assert.equal(dependencyLast.record.queue_order?.dependency_rank, 0);
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.fingerprint, dependentFirst.record.fingerprint);
    assert.equal(overridden.record.queue_position, 7);
    assert.equal(overridden.record.queue_order?.accepted_delta_index, 1);
    assert.equal(overridden.record.queue_order?.parent_order_override, 7);
    const ordered = listIntegrationQueue(root, runId, repositoryId, env);
    assert.deepEqual(ordered.map((record) => record.queue_order?.unit_ref), ["unit-a@1", "unit-b@1", "unit-c@1"]);
    assert.deepEqual(ordered.map((record) => record.queue_position), [1, 0, 7]);
  });

  it("freezes a dirty destination baseline and rejects a concurrent begin in the same repository", async () => {
    const f = repositoryFixture();
    const run = "run-begin";
    createPlanRun(f.root, f.env, run, [[plannedUnit("unit-first"), plannedUnit("unit-second")]]);
    const firstBundle = signedBundle({ run, bundle: "bundle-first", unit: "unit-first", repositoryId: f.repositoryId, commonId: f.commonId, tree: f.baseTree, resultTree: "d".repeat(40) });
    const secondBundle = signedBundle({ run, bundle: "bundle-second", unit: "unit-second", repositoryId: f.repositoryId, commonId: f.commonId, tree: f.baseTree, resultTree: "e".repeat(40) });
    markBundleReady(f.root, f.env, firstBundle, f.commonDir);
    markBundleReady(f.root, f.env, secondBundle, f.commonDir);
    fs.writeFileSync(path.join(f.root, "file.txt"), "dirty parent state\n");
    const expected = captureVisibleTree(f.root);
    const callerControl = {
      head: git(f.root, ["rev-parse", "HEAD"]),
      index: fs.readFileSync(path.join(f.root, ".git", "index")),
      status: git(f.root, ["status", "--porcelain=v2", "--branch"]),
    };

    const first = await beginWorktreeIntegration({
      repository_root: f.root,
      run_id: run,
      repository_id: f.repositoryId,
      bundle_id: firstBundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
      at: "2026-09-01T00:00:03.000Z",
    });
    assert.equal(first.record.state, "integrating");
    assert.equal(first.record.before_tree, expected);
    assert.equal(first.record.after_tree, undefined);
    assert.notEqual(first.record.before_tree, firstBundle.result_tree);
    assert.deepEqual(first.record.conflicts, []);
    assert.equal(first.record.authorization?.observed_before_tree, expected);
    assert.match(first.record.authorization?.control_facts_fingerprint ?? "", /^[0-9a-f]{64}$/u);
    assert.match(first.record.authorization?.dirty_facts_fingerprint ?? "", /^[0-9a-f]{64}$/u);
    const replay = await beginWorktreeIntegration({
      repository_root: f.root,
      run_id: run,
      repository_id: f.repositoryId,
      bundle_id: firstBundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
      at: "2026-09-01T00:00:09.000Z",
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.fingerprint, first.record.fingerprint);
    await assert.rejects(beginWorktreeIntegration({
      repository_root: f.root,
      run_id: run,
      repository_id: f.repositoryId,
      bundle_id: secondBundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
    }), (error: unknown) => error instanceof WorktreeIntegrationError && error.code === "INTEGRATION_QUEUE_BLOCKED");
    assert.equal(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), "dirty parent state\n");
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), callerControl.head);
    assert.deepEqual(fs.readFileSync(path.join(f.root, ".git", "index")), callerControl.index);
    assert.equal(git(f.root, ["status", "--porcelain=v2", "--branch"]), callerControl.status);
  });

  it("blocks a second rolling run while durable destination ownership is active", async () => {
    const f = repositoryFixture();
    createPlanRun(f.root, f.env, "run-owner-a", [[plannedUnit("unit-owner-a")]]);
    createPlanRun(f.root, f.env, "run-owner-b", [[plannedUnit("unit-owner-b")]]);
    const firstBundle = signedBundle({
      run: "run-owner-a",
      bundle: "bundle-owner-a",
      unit: "unit-owner-a",
      repositoryId: f.repositoryId,
      commonId: f.commonId,
      tree: f.baseTree,
      resultTree: "d".repeat(40),
    });
    const secondBundle = signedBundle({
      run: "run-owner-b",
      bundle: "bundle-owner-b",
      unit: "unit-owner-b",
      repositoryId: f.repositoryId,
      commonId: f.commonId,
      tree: f.baseTree,
      resultTree: "e".repeat(40),
    });
    markBundleReady(f.root, f.env, firstBundle, f.commonDir);
    markBundleReady(f.root, f.env, secondBundle, f.commonDir);
    const expected = captureVisibleTree(f.root);
    const first = await beginWorktreeIntegration({
      repository_root: f.root,
      run_id: "run-owner-a",
      repository_id: f.repositoryId,
      bundle_id: firstBundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
    });
    assert.equal(first.record.state, "integrating");
    await assert.rejects(beginWorktreeIntegration({
      repository_root: f.root,
      run_id: "run-owner-b",
      repository_id: f.repositoryId,
      bundle_id: secondBundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
    }), (error: unknown) => error instanceof WorktreeIntegrationError
      && error.code === "INTEGRATION_QUEUE_BLOCKED"
      && error.detail?.blocking_run_id === "run-owner-a");
    assert.deepEqual(listIntegrationQueue(f.root, "run-owner-b", f.repositoryId, f.env), []);
  });

  it("exposes only cwd-targeted begin through the CLI transport", async () => {
    const stdout: string[] = [];
    let received: unknown;
    const code = await run([
      "integration", "begin",
      "--run", "run-cli",
      "--repository-id", "a".repeat(64),
      "--bundle-id", "bundle-cli",
      "--expected-before-tree", "b".repeat(40),
      "--order-override", "3",
      "--json",
    ], {
      cwd: "/current/repository",
      stdout: { write(value: unknown) { stdout.push(String(value)); return true; } },
      stderr: { write() { return true; } },
      integrationHandler(input) { received = input; return { record: { state: "integrating" } }; },
    });
    assert.equal(code, 0);
    assert.equal((received as any).cwd, "/current/repository");
    assert.equal((received as any).order_override, 3);
    assert.equal(JSON.parse(stdout.join("")).record.state, "integrating");
  });
});
