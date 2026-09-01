import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { run } from "../src/cli.js";
import { worktreeExecutionRootPath } from "../src/lib/paths.js";
import { appendRollingFact, appendRollingPlanDelta, createRollingExecutionRun, readRollingExecutionRun } from "../src/lib/rolling-run.js";
import { fingerprintUnitVersion, type GateVersion, type PlanDelta, type UnitVersion } from "../src/lib/rolling-plan.js";
import { deriveRollingAcceptance, normalizeRollingExecutionFact } from "../src/lib/rolling-acceptance.js";
import { ROLLING_EXECUTION_DOCUMENT_KIND, statusRollingControl } from "../src/lib/rolling-control.js";
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
  acceptWorktreeIntegration,
  applyWorktreeIntegration,
  beginWorktreeIntegration,
  enqueueWorktreeIntegration,
  listIntegrationQueue,
  resolveWorktreeIntegration,
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

function appendAcceptedUnitFacts(root: string, env: NodeJS.ProcessEnv, runId: string, unit: UnitVersion): void {
  const unitFingerprint = unit.fingerprint || fingerprintUnitVersion(unit);
  const attemptOwner = `${unit.unit_key}@${unit.version}:attempt-1`;
  const facts = [
    { kind: "reservation", owner_type: "attempt", owner_key: attemptOwner, attempt: 1, reservation_id: "integration-test-reservation", state: "reserved" },
    { kind: "native-attempt", owner_type: "attempt", owner_key: attemptOwner, attempt: 1, state: "running" },
    { kind: "terminal-result", owner_type: "attempt", owner_key: attemptOwner, attempt: 1, status: "completed", result: "ready" },
    { kind: "safety-verdict", owner_type: "unit_version", owner_key: `${unit.unit_key}@${unit.version}`, accepted: true, violations: [] },
    { kind: "parent-acceptance", owner_type: "unit_version", owner_key: `${unit.unit_key}@${unit.version}`, accepted: true, evidence: "bundle audited" },
    { kind: "release", owner_type: "attempt", owner_key: attemptOwner, attempt: 1, released: true },
  ].map((fact) => normalizeRollingExecutionFact({
    schema_version: 1,
    unit_key: unit.unit_key,
    unit_version: unit.version,
    unit_fingerprint: unitFingerprint,
    recorded_at: "2026-09-01T00:00:05.000Z",
    ...fact,
  }));
  for (const fact of facts) {
    appendRollingFact({
      cwd: root,
      env,
      runId,
      kind: ROLLING_EXECUTION_DOCUMENT_KIND,
      idempotency_key: `test:${fact.fact_id}`,
      fact_id: `execution:${fact.fact_id}`,
      document_id: `execution-${fact.fact_id}`,
      payload: fact,
      document: fact,
    });
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

function resultTree(root: string, content: string | Uint8Array): string {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-result-index-"));
  const index = path.join(temporary, "index");
  const env = { GIT_INDEX_FILE: index };
  const original = fs.readFileSync(path.join(root, "file.txt"));
  try {
    git(root, ["read-tree", "HEAD^{tree}"], env);
    fs.writeFileSync(path.join(root, "file.txt"), content);
    git(root, ["add", "--", "file.txt"], env);
    return git(root, ["write-tree"], env);
  } finally {
    fs.writeFileSync(path.join(root, "file.txt"), original);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function renamedResultTree(root: string, target: string): string {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-rename-index-"));
  const index = path.join(temporary, "index");
  const env = { GIT_INDEX_FILE: index };
  const source = path.join(root, "file.txt");
  const destination = path.join(root, target);
  const original = fs.readFileSync(source);
  try {
    git(root, ["read-tree", "HEAD^{tree}"], env);
    fs.renameSync(source, destination);
    git(root, ["add", "-A", "--", "."], env);
    return git(root, ["write-tree"], env);
  } finally {
    fs.rmSync(destination, { force: true });
    fs.writeFileSync(source, original);
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

  it("applies a clean bundle through isolated object plumbing without changing caller control state", async () => {
    const f = repositoryFixture();
    const runId = "run-clean-apply";
    createPlanRun(f.root, f.env, runId, [[plannedUnit("unit-clean")]]);
    const bundleTree = resultTree(f.root, "bundle result\n");
    const bundle = signedBundle({
      run: runId,
      bundle: "bundle-clean",
      unit: "unit-clean",
      repositoryId: f.repositoryId,
      commonId: f.commonId,
      tree: f.baseTree,
      resultTree: bundleTree,
    });
    markBundleReady(f.root, f.env, bundle, f.commonDir);
    fs.writeFileSync(path.join(f.root, "unrelated.txt"), "pre-existing caller content\n");
    const expected = captureVisibleTree(f.root);
    await beginWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
      at: "2026-09-01T00:00:02.000Z",
    });
    const callerControl = {
      head: git(f.root, ["rev-parse", "HEAD"]),
      index: fs.readFileSync(path.join(f.root, ".git", "index")),
      status: git(f.root, ["status", "--porcelain=v2", "--branch"]),
      content: fs.readFileSync(path.join(f.root, "file.txt"), "utf8"),
    };
    const applied = await applyWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      idempotency_key: "clean-apply",
      env: f.env,
      at: "2026-09-01T00:00:03.000Z",
    });
    assert.equal(applied.record.state, "integrated");
    assert.equal(applied.record.before_tree, expected);
    assert.equal(applied.record.application?.bundle_base_tree, f.baseTree);
    assert.equal(applied.record.application?.bundle_result_tree, bundleTree);
    assert.notEqual(applied.record.after_tree, bundleTree);
    assert.deepEqual(applied.record.conflicts, []);
    assert.equal(git(f.root, ["show", `${applied.record.after_tree}:file.txt`]), "bundle result");
    assert.equal(git(f.root, ["show", `${applied.record.after_tree}:unrelated.txt`]), "pre-existing caller content");
    const replay = await applyWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      idempotency_key: "clean-apply",
      env: f.env,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.fingerprint, applied.record.fingerprint);
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), callerControl.head);
    assert.deepEqual(fs.readFileSync(path.join(f.root, ".git", "index")), callerControl.index);
    assert.equal(git(f.root, ["status", "--porcelain=v2", "--branch"]), callerControl.status);
    assert.equal(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), callerControl.content);
    assert.equal(fs.readFileSync(path.join(f.root, "unrelated.txt"), "utf8"), "pre-existing caller content\n");
  });

  it("recovers a clean result when publication crashes after the application intent", async () => {
    const f = repositoryFixture();
    const runId = "run-apply-crash";
    createPlanRun(f.root, f.env, runId, [[plannedUnit("unit-crash")]]);
    const bundleTree = resultTree(f.root, "recovered result\n");
    const bundle = signedBundle({
      run: runId,
      bundle: "bundle-crash",
      unit: "unit-crash",
      repositoryId: f.repositoryId,
      commonId: f.commonId,
      tree: f.baseTree,
      resultTree: bundleTree,
    });
    markBundleReady(f.root, f.env, bundle, f.commonDir);
    const expected = captureVisibleTree(f.root);
    await beginWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
    });

    const originalRename = fs.renameSync;
    let integrationPublications = 0;
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      const target = String(destination);
      if (target.includes(`${path.sep}integrations${path.sep}`) && target.endsWith(`${path.sep}record-v1.json`)) {
        integrationPublications += 1;
        if (integrationPublications === 2) throw new Error("simulated integration publication crash");
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync;
    try {
      await assert.rejects(applyWorktreeIntegration({
        repository_root: f.root,
        run_id: runId,
        repository_id: f.repositoryId,
        bundle_id: bundle.bundle_id,
        idempotency_key: "crash-apply",
        env: f.env,
      }), /simulated integration publication crash/u);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(integrationPublications, 2);
    const intent = listIntegrationQueue(f.root, runId, f.repositoryId, f.env)[0];
    assert.equal(intent?.state, "integrating");
    assert.equal(intent?.application?.idempotency_key, "apply:crash-apply");

    const recovered = await applyWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      idempotency_key: "crash-apply",
      env: f.env,
    });
    assert.equal(recovered.replayed, false);
    assert.equal(recovered.record.state, "integrated");
    assert.equal(recovered.record.after_tree, bundleTree);
  });

  it("accepts a clean integrated tree into the caller while retaining unrelated dirty content and index state", async () => {
    const f = repositoryFixture();
    const runId = "run-clean-accept";
    createPlanRun(f.root, f.env, runId, [[plannedUnit("unit-accept")]]);
    const bundleTree = resultTree(f.root, "accepted bundle result\n");
    const bundle = signedBundle({ run: runId, bundle: "bundle-accept", unit: "unit-accept", repositoryId: f.repositoryId, commonId: f.commonId, tree: f.baseTree, resultTree: bundleTree });
    markBundleReady(f.root, f.env, bundle, f.commonDir);
    fs.writeFileSync(path.join(f.root, "unrelated.txt"), "keep caller dirt\n");
    const expected = captureVisibleTree(f.root);
    const head = git(f.root, ["rev-parse", "HEAD"]);
    const index = fs.readFileSync(path.join(f.root, ".git", "index"));
    await beginWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, expected_before_tree: expected, env: f.env });
    await applyWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, env: f.env });
    const accepted = await acceptWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      conclusion: "accepted clean integration",
      idempotency_key: "accept-clean",
      env: f.env,
    });
    assert.equal(accepted.record.state, "accepted");
    assert.deepEqual(accepted.accepted_gate_refs, []);
    assert.equal(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), "accepted bundle result\n");
    assert.equal(fs.readFileSync(path.join(f.root, "unrelated.txt"), "utf8"), "keep caller dirt\n");
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), head);
    assert.deepEqual(fs.readFileSync(path.join(f.root, ".git", "index")), index);
    const replay = await acceptWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, conclusion: "accepted clean integration", idempotency_key: "accept-clean", env: f.env });
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.fingerprint, accepted.record.fingerprint);
  });

  it("accepts the producer integration gate with the exact result tree for downstream base selection", async () => {
    const f = repositoryFixture();
    const runId = "run-gate-accept";
    const unit = plannedUnit("unit-gate");
    createRollingExecutionRun({ cwd: f.root, runId, host: "codex", adapter: "director", source_kind: "director", execution_mode: "isolated-worktree", env: f.env, source: { schema_version: 1, source_kind: "director", adapter: "director", selection: { run: runId } } });
    const gate: GateVersion = { schema_version: 1, gate_key: "integration-unit-gate", version: 1, type: "integration-acceptance", task_keys: unit.task_keys, depends_on: [unit.unit_key], acceptance_contract: { requires_parent: true } };
    appendRollingPlanDelta({
      cwd: f.root,
      env: f.env,
      runId,
      delta: {
        schema_version: 1,
        delta_id: "delta-gate-accept",
        prepared_from_append_sequence: 0,
        manifest_additions: [{
          schema_version: 1,
          task_key: unit.task_keys[0]!,
          source_kind: "director",
          source_ref: { id: unit.task_keys[0]! },
          display_id: unit.task_keys[0]!,
          title: unit.task_keys[0]!,
          source_fingerprint: "d".repeat(64),
          source_state: "pending",
          discovery_sequence: 0,
        }],
        unit_versions: [unit],
        gate_versions: [gate],
        task_coverage: [{ schema_version: 1, task_key: unit.task_keys[0]!, kind: "unit", unit_versions: [`${unit.unit_key}@${unit.version}`], gate_versions: [`${gate.gate_key}@${gate.version}`] }],
      },
    });
    appendAcceptedUnitFacts(f.root, f.env, runId, unit);
    const acceptedRun = readRollingExecutionRun(f.root, runId, { env: f.env });
    const acceptedProjection = deriveRollingAcceptance({ units: acceptedRun.accepted_deltas.flatMap((delta) => delta.unit_versions || []), gates: acceptedRun.accepted_deltas.flatMap((delta) => delta.gate_versions || []), facts: acceptedRun.facts.filter((fact) => fact.kind === ROLLING_EXECUTION_DOCUMENT_KIND).map((fact) => fact.payload) });
    assert.equal(acceptedProjection.units[`${unit.unit_key}@${unit.version}`]?.state, "accepted");
    const bundleTree = resultTree(f.root, "gate accepted result\n");
    const bundle = signedBundle({ run: runId, bundle: "bundle-gate", unit: unit.unit_key, repositoryId: f.repositoryId, commonId: f.commonId, tree: f.baseTree, resultTree: bundleTree });
    markBundleReady(f.root, f.env, bundle, f.commonDir);
    const expected = captureVisibleTree(f.root);
    await beginWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, expected_before_tree: expected, env: f.env });
    const applied = await applyWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, env: f.env });
    const accepted = await acceptWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, conclusion: "accept integration gate", env: f.env });
    assert.deepEqual(accepted.accepted_gate_refs, ["integration-unit-gate@1"]);
    const run = readRollingExecutionRun(f.root, runId, { env: f.env });
    const gateFact = run.facts.find((fact) => fact.kind === ROLLING_EXECUTION_DOCUMENT_KIND && (fact.payload as any)?.kind === "gate-acceptance");
    assert.equal((gateFact?.payload as any)?.result_tree, applied.record.after_tree);
    const status = await statusRollingControl({ cwd: f.root, env: f.env, run_id: runId });
    assert.equal(status.task_status[unit.task_keys[0]!]!.state, "accepted");
    assert.match(status.task_status[unit.task_keys[0]!]!.next_legal_action ?? "", /--seal-task/u);
  });

  it("persists deterministic stage-fact conflicts for parent resolution without touching the caller", async () => {
    const f = repositoryFixture();
    const runId = "run-conflicted-apply";
    createPlanRun(f.root, f.env, runId, [[plannedUnit("unit-conflict")]]);
    const bundleTree = resultTree(f.root, "bundle side\n");
    const bundle = signedBundle({
      run: runId,
      bundle: "bundle-conflict",
      unit: "unit-conflict",
      repositoryId: f.repositoryId,
      commonId: f.commonId,
      tree: f.baseTree,
      resultTree: bundleTree,
    });
    markBundleReady(f.root, f.env, bundle, f.commonDir);
    fs.writeFileSync(path.join(f.root, "file.txt"), "parent side\n");
    const expected = captureVisibleTree(f.root);
    await beginWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
    });
    const callerControl = {
      head: git(f.root, ["rev-parse", "HEAD"]),
      index: fs.readFileSync(path.join(f.root, ".git", "index")),
      status: git(f.root, ["status", "--porcelain=v2", "--branch"]),
    };
    const applied = await applyWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      idempotency_key: "conflict-apply",
      env: f.env,
    });
    assert.equal(applied.record.state, "awaiting_parent_resolution");
    assert.equal(applied.record.after_tree, undefined);
    assert.equal(applied.record.conflicts.length, 1);
    assert.equal(applied.record.conflicts[0]?.path, "file.txt");
    assert.equal(applied.record.conflicts[0]?.kind, "content");
    assert.match(applied.record.conflicts[0]?.detail ?? "", /^types=CONFLICT \(contents\);stages=1:100644:[0-9a-f]+,2:100644:[0-9a-f]+,3:100644:[0-9a-f]+$/u);
    assert.equal(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), "parent side\n");
    assert.equal(git(f.root, ["rev-parse", "HEAD"]), callerControl.head);
    assert.deepEqual(fs.readFileSync(path.join(f.root, ".git", "index")), callerControl.index);
    assert.equal(git(f.root, ["status", "--porcelain=v2", "--branch"]), callerControl.status);
  });

  it("freezes a separately fingerprinted parent resolution, preserves the bundle, and accepts the resolved tree", async () => {
    const f = repositoryFixture();
    const runId = "run-parent-resolution";
    createPlanRun(f.root, f.env, runId, [[plannedUnit("unit-resolution")]]);
    const bundleTree = resultTree(f.root, "bundle side\n");
    const bundle = signedBundle({ run: runId, bundle: "bundle-resolution", unit: "unit-resolution", repositoryId: f.repositoryId, commonId: f.commonId, tree: f.baseTree, resultTree: bundleTree });
    markBundleReady(f.root, f.env, bundle, f.commonDir);
    fs.writeFileSync(path.join(f.root, "file.txt"), "parent side\n");
    const expected = captureVisibleTree(f.root);
    await beginWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, expected_before_tree: expected, env: f.env });
    const conflicted = await applyWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, env: f.env });
    assert.equal(conflicted.record.state, "awaiting_parent_resolution");
    const bundleFingerprint = bundle.fingerprint;
    const resolvedTree = resultTree(f.root, "parent resolved both sides\n");
    const resolved = await resolveWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      resolved_tree: resolvedTree,
      conclusion: "combined the parent and worker semantics",
      idempotency_key: "resolve-parent",
      env: f.env,
    });
    assert.equal(resolved.record.state, "integrated");
    assert.equal(resolved.record.after_tree, resolvedTree);
    assert.equal(resolved.resolution.resolved_tree, resolvedTree);
    assert.match(resolved.resolution.fingerprint, /^[0-9a-f]{64}$/u);
    assert.notEqual(resolved.resolution.fingerprint, bundleFingerprint);
    assert.equal(bundle.fingerprint, bundleFingerprint);
    const accepted = await acceptWorktreeIntegration({ repository_root: f.root, run_id: runId, repository_id: f.repositoryId, bundle_id: bundle.bundle_id, conclusion: "accepted audited parent resolution", idempotency_key: "accept-resolution", env: f.env });
    assert.equal(accepted.record.state, "accepted");
    assert.equal(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), "parent resolved both sides\n");
    assert.equal(bundle.fingerprint, bundleFingerprint);
  });

  it("classifies binary conflicts from stable merge-tree message types", async () => {
    const f = repositoryFixture();
    const runId = "run-binary-conflict";
    createPlanRun(f.root, f.env, runId, [[plannedUnit("unit-binary")]]);
    const bundleTree = resultTree(f.root, Buffer.from([0, 98, 117, 110, 100, 108, 101, 10]));
    const bundle = signedBundle({
      run: runId,
      bundle: "bundle-binary",
      unit: "unit-binary",
      repositoryId: f.repositoryId,
      commonId: f.commonId,
      tree: f.baseTree,
      resultTree: bundleTree,
    });
    markBundleReady(f.root, f.env, bundle, f.commonDir);
    const parentBytes = Buffer.from([0, 112, 97, 114, 101, 110, 116, 10]);
    fs.writeFileSync(path.join(f.root, "file.txt"), parentBytes);
    const expected = captureVisibleTree(f.root);
    await beginWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
    });
    const applied = await applyWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      env: f.env,
    });
    assert.equal(applied.record.state, "awaiting_parent_resolution");
    assert.equal(applied.record.conflicts[0]?.kind, "binary");
    assert.match(applied.record.conflicts[0]?.detail ?? "", /types=CONFLICT \(binary\)/u);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "file.txt")), parentBytes);
  });

  it("classifies rename conflicts from stable merge-tree message types", async () => {
    const f = repositoryFixture();
    const runId = "run-rename-conflict";
    createPlanRun(f.root, f.env, runId, [[plannedUnit("unit-rename")]]);
    const bundleTree = renamedResultTree(f.root, "bundle-name.txt");
    const bundle = signedBundle({
      run: runId,
      bundle: "bundle-rename",
      unit: "unit-rename",
      repositoryId: f.repositoryId,
      commonId: f.commonId,
      tree: f.baseTree,
      resultTree: bundleTree,
    });
    markBundleReady(f.root, f.env, bundle, f.commonDir);
    fs.renameSync(path.join(f.root, "file.txt"), path.join(f.root, "parent-name.txt"));
    const expected = captureVisibleTree(f.root);
    await beginWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      expected_before_tree: expected,
      env: f.env,
    });
    const applied = await applyWorktreeIntegration({
      repository_root: f.root,
      run_id: runId,
      repository_id: f.repositoryId,
      bundle_id: bundle.bundle_id,
      env: f.env,
    });
    assert.equal(applied.record.state, "awaiting_parent_resolution");
    assert.ok(applied.record.conflicts.some((conflict) => conflict.kind === "rename"));
    assert.equal(fs.existsSync(path.join(f.root, "file.txt")), false);
    assert.equal(fs.readFileSync(path.join(f.root, "parent-name.txt"), "utf8"), "base\n");
  });

  it("exposes only cwd-targeted parent integration operations through the CLI transport", async () => {
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

    stdout.length = 0;
    received = undefined;
    const applyCode = await run([
      "integration", "apply",
      "--run", "run-cli",
      "--repository-id", "a".repeat(64),
      "--bundle-id", "bundle-cli",
      "--idempotency-key", "apply-cli",
      "--json",
    ], {
      cwd: "/current/repository",
      stdout: { write(value: unknown) { stdout.push(String(value)); return true; } },
      stderr: { write() { return true; } },
      integrationHandler(input) { received = input; return { record: { state: "integrated" } }; },
    });
    assert.equal(applyCode, 0);
    assert.equal((received as any).operation, "apply");
    assert.equal((received as any).cwd, "/current/repository");
    assert.equal((received as any).idempotency_key, "apply-cli");
    assert.equal(JSON.parse(stdout.join("")).record.state, "integrated");

    stdout.length = 0;
    received = undefined;
    const resolveCode = await run([
      "integration", "resolve",
      "--run", "run-cli",
      "--repository-id", "a".repeat(64),
      "--bundle-id", "bundle-cli",
      "--resolved-tree", "c".repeat(40),
      "--conclusion", "resolved parent conflict",
      "--idempotency-key", "resolve-cli",
      "--json",
    ], {
      cwd: "/current/repository",
      stdout: { write(value: unknown) { stdout.push(String(value)); return true; } },
      stderr: { write() { return true; } },
      integrationHandler(input) { received = input; return { record: { state: "integrated" } }; },
    });
    assert.equal(resolveCode, 0);
    assert.equal((received as any).operation, "resolve");
    assert.equal((received as any).resolved_tree, "c".repeat(40));
    assert.equal((received as any).conclusion, "resolved parent conflict");
    assert.equal((received as any).cwd, "/current/repository");

    stdout.length = 0;
    received = undefined;
    const acceptCode = await run([
      "integration", "accept",
      "--run", "run-cli",
      "--repository-id", "a".repeat(64),
      "--bundle-id", "bundle-cli",
      "--conclusion", "accepted parent result",
      "--idempotency-key", "accept-cli",
      "--json",
    ], {
      cwd: "/current/repository",
      stdout: { write(value: unknown) { stdout.push(String(value)); return true; } },
      stderr: { write() { return true; } },
      integrationHandler(input) { received = input; return { record: { state: "accepted" } }; },
    });
    assert.equal(acceptCode, 0);
    assert.equal((received as any).operation, "accept");
    assert.equal((received as any).conclusion, "accepted parent result");
    assert.equal((received as any).idempotency_key, "accept-cli");
    assert.equal((received as any).cwd, "/current/repository");
  });
});
