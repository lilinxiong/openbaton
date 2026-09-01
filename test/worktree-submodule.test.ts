import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { bindAgent, finishAgent, releaseAgent, reserveNext } from "../src/lib/dispatch.js";
import { markRouteAvailable } from "../src/lib/model-availability.js";
import { worktreeExecutionRootPath } from "../src/lib/paths.js";
import { buildReadOnlyReceipt, buildWriteReceipt, writeReceipt } from "../src/lib/receipt.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { appendRollingPlanDelta, createRollingExecutionRun } from "../src/lib/rolling-run.js";
import type { PlanDelta, UnitVersion } from "../src/lib/rolling-plan.js";
import { captureBaseline } from "../src/lib/safety.js";
import { buildSpawnTicket, nextSpawnId, writeSpawn } from "../src/lib/spawn.js";
import { createWorktreeChangeBundle } from "../src/lib/worktree-bundle.js";
import {
  CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
  fingerprintWorktreeRuntimeRecord,
  persistChangeBundleManifest,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type ChangeBundleManifest,
  type WorktreeRecord,
} from "../src/lib/worktree-execution.js";
import { acceptWorktreeIntegration, applyWorktreeIntegration, beginWorktreeIntegration } from "../src/lib/worktree-integration.js";
import { setupDetachedWorktree } from "../src/lib/worktree-setup.js";
import { resolveOwningRepository } from "../src/lib/worktree-topology.js";
import { configureCli } from "./configure.js";
import { fakeEnv } from "./home.js";

const HOST = "codex";
const ROUTE = "codex/exact-root";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(root: string, name: string, file: string): string {
  const repo = path.join(root, name); fs.mkdirSync(repo);
  git(repo, ["init", "-q"]); git(repo, ["config", "user.name", "Baton Test"]); git(repo, ["config", "user.email", "baton@example.invalid"]);
  fs.writeFileSync(path.join(repo, file), "base\n"); git(repo, ["add", file]); git(repo, ["commit", "-qm", "base"]);
  return repo;
}

function unit(key: string, task: string, writePaths: string[], dependsOn: string[] = []): UnitVersion {
  return {
    schema_version: 1,
    unit_key: key,
    version: 1,
    task_keys: [task],
    depends_on: dependsOn,
    execution_mode: "patch-only",
    worktree_mode: "isolated-worktree",
    prompt: `implement ${key}`,
    write_paths: writePaths,
    allowed_operations: ["write"],
    completion_criteria: ["result audited"],
    permitted_validation: ["focused test"],
    input_fingerprints: { baseline: "a".repeat(64) },
  };
}

function createRun(root: string, env: NodeJS.ProcessEnv, runId: string, units: UnitVersion[]): void {
  createRollingExecutionRun({ cwd: root, env, runId, host: HOST, adapter: "director", source_kind: "director", execution_mode: "isolated-worktree", source: { schema_version: 1, source_kind: "director", adapter: "director", selection: { run: runId } } });
  const coverage = new Map<string, string[]>();
  for (const value of units) for (const task of value.task_keys) {
    const refs = coverage.get(task) || [];
    refs.push(`${value.unit_key}@${value.version}`);
    coverage.set(task, refs);
  }
  const delta: PlanDelta = {
    schema_version: 1,
    delta_id: `delta-${runId}`,
    prepared_from_append_sequence: 0,
    unit_versions: units,
    gate_versions: [],
    task_coverage: [...coverage.entries()].map(([taskKey, unitVersions]) => ({ schema_version: 1, task_key: taskKey, kind: "unit", unit_versions: unitVersions })),
  };
  appendRollingPlanDelta({ cwd: root, env, runId, delta });
}

function visibleTree(root: string): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "baton-submodule-visible-"));
  const env = { GIT_INDEX_FILE: path.join(temp, "index") };
  try { git(root, ["read-tree", "HEAD^{tree}"], env); git(root, ["add", "-A", "--", "."], env); return git(root, ["write-tree"], env); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function gitlinkTree(superproject: string, submodulePath: string, commit: string): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "baton-superproject-gitlink-"));
  const env = { GIT_INDEX_FILE: path.join(temp, "index") };
  try {
    git(superproject, ["read-tree", "HEAD^{tree}"], env);
    git(superproject, ["update-index", "--add", "--cacheinfo", "160000", commit, submodulePath], env);
    return git(superproject, ["write-tree"], env);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function signedBundle(value: Omit<ChangeBundleManifest, "fingerprint">): ChangeBundleManifest {
  const bundle = { ...value, fingerprint: "" } as ChangeBundleManifest;
  bundle.fingerprint = fingerprintWorktreeRuntimeRecord(bundle);
  return bundle;
}

function markParentBundleReady(root: string, env: NodeJS.ProcessEnv, record: WorktreeRecord, bundleId: string): WorktreeRecord {
  let current = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: "parent-active", phase: "native_execution", to_state: "worker_active", native_handle: "parent:gitlink-audit", retention_reasons: ["live_native_handle"] }, env);
  current = transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: "parent-terminal", phase: "native_execution", to_state: "terminal_awaiting_audit", native_handle: null, retention_reasons: ["pending_audit"] }, env);
  return transitionPersistedWorktreeRecord(root, record.run_id, record.unit_key, record.attempt_id, { idempotency_key: "parent-bundle", phase: "bundling", to_state: "bundle_ready", bundle_id: bundleId, retention_reasons: ["ready_bundle"] }, env);
}

describe("submodule isolated execution and parent gitlink ordering", () => {
  it("keeps submodule objects independent and audits the superproject gitlink as a later parent step", async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "baton-submodule-e2e-"));
    const childSource = repository(outer, "child-source", "child.txt");
    const superproject = repository(outer, "superproject", "root.txt");
    git(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", childSource, "modules/child"]);
    git(superproject, ["commit", "-qam", "add submodule"]);
    const moduleRoot = fs.realpathSync(path.join(superproject, "modules/child"));
    const stateHome = path.join(outer, "state-home"); fs.mkdirSync(stateHome);
    const env = fakeEnv(stateHome, { BATON_SESSION_ID: "submodule-e2e", BATON_ADAPTER_PATHS: path.resolve("adapters/codex") });
    configureCli(moduleRoot, env, HOST, [ROUTE]);
    publishRouteSnapshot(moduleRoot, { models: [{ id: ROUTE, route_id: ROUTE, provider: HOST, supportedReasoningEfforts: [] }] }, new Date("2026-09-01T00:00:00.000Z"), { cli: HOST, host: HOST, env });
    markRouteAvailable(moduleRoot, { host: HOST, routeId: ROUTE }, { now: "2026-09-01T00:00:00.000Z", env });
    const moduleOwner = resolveOwningRepository(superproject, "modules/child/child.txt").repository;
    const superOwner = resolveOwningRepository(superproject, "root.txt").repository;
    assert.equal(moduleOwner.topology_kind, "submodule");
    assert.notEqual(moduleOwner.repository_id, superOwner.repository_id);
    assert.notEqual(moduleOwner.git_common_dir_identity, superOwner.git_common_dir_identity);

    const moduleRun = "run-submodule"; const moduleUnit = unit("unit-submodule", "task-submodule", ["child.txt"]);
    createRun(moduleRoot, env, moduleRun, [moduleUnit]);
    fs.writeFileSync(path.join(moduleRoot, "child.txt"), "authorized dirty base\n");
    const moduleBefore = { head: git(moduleRoot, ["rev-parse", "HEAD"]), status: git(moduleRoot, ["status", "--porcelain=v1"]), superStatus: git(superproject, ["status", "--porcelain=v1"]), superGitlink: git(superproject, ["rev-parse", "HEAD:modules/child"]) };
    const attemptId = "attempt-1";
    const executionRoot = worktreeExecutionRootPath(moduleRoot, moduleRun, moduleUnit.unit_key, attemptId, env);
    const setup = await setupDetachedWorktree({
      repository_root: moduleRoot,
      repository_id: moduleOwner.repository_id,
      git_common_dir: moduleOwner.git_common_dir,
      git_common_dir_identity: moduleOwner.git_common_dir_identity,
      execution_root: executionRoot,
      run_id: moduleRun,
      unit_key: moduleUnit.unit_key,
      unit_version: moduleUnit.version,
      attempt_id: attemptId,
      include_dirty_baseline: true,
      dirty_baseline_authorized: true,
      dirty_baseline_paths: ["child.txt"],
      env,
    });
    assert.ok(setup.snapshot);
    assert.equal(setup.record.repository_root, moduleRoot);
    assert.equal(setup.record.repository_id, moduleOwner.repository_id);
    assert.equal(fs.readFileSync(path.join(executionRoot, "child.txt"), "utf8"), "authorized dirty base\n");
    assert.deepEqual({ head: git(moduleRoot, ["rev-parse", "HEAD"]), status: git(moduleRoot, ["status", "--porcelain=v1"]), superStatus: git(superproject, ["status", "--porcelain=v1"]) }, { head: moduleBefore.head, status: moduleBefore.status, superStatus: moduleBefore.superStatus });

    const exactRoot = { repository_id: setup.record.repository_id, git_common_dir_identity: setup.record.git_common_dir_identity, execution_root: setup.record.execution_root, base_tree: setup.record.base_tree, worktree_record_id: setup.record.record_id };
    const lineage = { schema_version: 1 as const, run_id: moduleRun, unit_key: moduleUnit.unit_key, unit_version: 1, unit_fingerprint: "b".repeat(64), task_keys: moduleUnit.task_keys, mode: "patch-only" as const, worktree_mode: "isolated-worktree" as const, ...exactRoot };
    const selection = { host: HOST, proposal_id: "proposal-submodule", approval_id: "approval-submodule", approved_at: "2026-09-01T00:00:00.000Z", confirmed_by: "baton-recommendation" as const, catalog_fingerprint: "catalog-submodule", recommended_model_id: ROUTE, selected_model_id: ROUTE, changed_by_user: false };
    const ticket = buildSpawnTicket({ cwd: moduleRoot, env, id: nextSpawnId(moduleRoot, "spn", env), description: "edit submodule root", prompt: "edit child.txt", modelId: ROUTE, routeId: ROUTE, taskKind: "concrete", selection, targetHost: HOST, rollingUnitLineage: lineage, deliverable: "submodule edit", doneWhen: "child result", readContext: ["child.txt"], writePaths: ["child.txt"], allowedOperations: ["write"], completionCriteria: ["child changed"], permittedValidation: ["read"] });
    const baseReceipt = buildReadOnlyReceipt({ ticketId: ticket.id, card: { id: ROUTE, route_id: ROUTE, provider: HOST, strengths: "exact root" }, issuedAt: ticket.created_at, selection, host: HOST, rollingUnitLineage: lineage });
    const receipt = buildWriteReceipt({ base: baseReceipt, baseline: captureBaseline(executionRoot, new Date(ticket.created_at)), writeAllowlist: ["child.txt"], allowedOperations: ["write"] });
    ticket.mode = "write"; ticket.read_only = false; ticket.receipt_id = receipt.receipt_id;
    writeReceipt(moduleRoot, receipt, env); writeSpawn(moduleRoot, ticket, env);
    const reserved = await reserveNext(moduleRoot, { host: HOST, capacity: 1, limit: 1, env });
    assert.equal(reserved.reserved[0]?.execution_root, executionRoot);
    const handle = { kind: "task_name", value: "native-submodule", source: "native-return" as const, ...exactRoot };
    bindAgent(moduleRoot, ticket.id, { host: HOST, executionHandle: handle, env });
    fs.writeFileSync(path.join(executionRoot, "child.txt"), "worker submodule result\n");
    await finishAgent(moduleRoot, ticket.id, { host: HOST, status: "completed", conclusion: "submodule result ready", env });
    releaseAgent(moduleRoot, ticket.id, { host: HOST, executionHandle: handle, env });
    const terminal = readPersistedWorktreeRecord(moduleRoot, moduleRun, moduleUnit.unit_key, attemptId, env);
    assert.equal(terminal.lifecycle_state, "terminal_awaiting_audit");
    const bundleResult = await createWorktreeChangeBundle({
      record: terminal,
      receipt: { receipt_id: receipt.receipt_id, ...exactRoot, run_id: moduleRun, unit_key: moduleUnit.unit_key, unit_version: 1, attempt_id: attemptId, write_allowlist: ["child.txt"], allowed_operations: ["write"] },
      terminal_conclusion: "submodule worker result audited",
      validation_summaries: ["native exact-root dispatch passed"],
      env,
    });
    assert.equal(bundleResult.audit.accepted, true, JSON.stringify(bundleResult.audit.violations));
    const moduleBundle = bundleResult.bundle!;
    await beginWorktreeIntegration({ repository_root: moduleRoot, run_id: moduleRun, repository_id: moduleOwner.repository_id, bundle_id: moduleBundle.bundle_id, expected_before_tree: setup.base_tree, env });
    const moduleIntegrated = await applyWorktreeIntegration({ repository_root: moduleRoot, run_id: moduleRun, repository_id: moduleOwner.repository_id, bundle_id: moduleBundle.bundle_id, env });
    const moduleAccepted = await acceptWorktreeIntegration({ repository_root: moduleRoot, run_id: moduleRun, repository_id: moduleOwner.repository_id, bundle_id: moduleBundle.bundle_id, conclusion: "accept submodule repository result", env });
    assert.equal(moduleAccepted.record.state, "accepted");
    assert.equal(fs.readFileSync(path.join(moduleRoot, "child.txt"), "utf8"), "worker submodule result\n");
    assert.equal(git(moduleRoot, ["rev-parse", "HEAD"]), moduleBefore.head);
    assert.equal(git(superproject, ["rev-parse", "HEAD:modules/child"]), moduleBefore.superGitlink);

    const targetCommit = String(moduleBundle.transport.internal_commit);
    assert.equal(git(moduleRoot, ["rev-parse", `${targetCommit}^{tree}`]), moduleIntegrated.record.after_tree);
    const parentRun = "run-parent-gitlink";
    const dependency = unit("unit-submodule-accepted", "task-parent", ["modules/child"]);
    const gitlinkUnit = unit("unit-parent-gitlink", "task-parent", ["modules/child"], [dependency.unit_key]);
    createRun(superproject, env, parentRun, [dependency, gitlinkUnit]);
    const parentSetup = await setupDetachedWorktree({ repository_root: superproject, repository_id: superOwner.repository_id, git_common_dir: superOwner.git_common_dir, git_common_dir_identity: superOwner.git_common_dir_identity, execution_root: worktreeExecutionRootPath(superproject, parentRun, gitlinkUnit.unit_key, "attempt-1", env), run_id: parentRun, unit_key: gitlinkUnit.unit_key, unit_version: 1, attempt_id: "attempt-1", env });
    const parentBeforeTree = git(superproject, ["rev-parse", "HEAD^{tree}"]);
    const parentResultTree = gitlinkTree(superproject, "modules/child", targetCommit);
    const rawAudit = git(superproject, ["diff-tree", "--no-commit-id", "-r", "--raw", parentBeforeTree, parentResultTree]);
    assert.match(rawAudit, /:160000 160000 [0-9a-f]+ [0-9a-f]+ M\tmodules\/child/u);
    const parentBundle = signedBundle({
      schema_version: CHANGE_BUNDLE_MANIFEST_SCHEMA_VERSION,
      bundle_id: "bundle-parent-gitlink",
      run_id: parentRun,
      unit_key: gitlinkUnit.unit_key,
      unit_version: 1,
      attempt_id: "attempt-1",
      receipt_id: "parent-gitlink-audit",
      repository_id: superOwner.repository_id,
      git_common_dir_identity: superOwner.git_common_dir_identity,
      base_tree: parentBeforeTree,
      result_tree: parentResultTree,
      operations: ["write"],
      changed_paths: ["modules/child"],
      non_text_facts: { gitlinks: [{ path: "modules/child", old_object: moduleBefore.superGitlink, new_object: targetCommit }], source_submodule_integration: moduleAccepted.record.integration_id, source_submodule_bundle_fingerprint: moduleBundle.fingerprint },
      transport: { kind: "parent-audited-gitlink-tree", target_commit: targetCommit },
      validation_summaries: ["exact gitlink-only diff audited"],
      terminal_conclusion: "parent prepared explicit submodule gitlink update",
      safety_verdict: "safe",
      state: "ready_for_integration",
      retention_reasons: ["ready_bundle"],
      created_at: "2026-09-01T00:00:10.000Z",
    });
    persistChangeBundleManifest(superproject, parentRun, parentBundle, env);
    markParentBundleReady(superproject, env, parentSetup.record, parentBundle.bundle_id);
    const parentBegin = await beginWorktreeIntegration({ repository_root: superproject, run_id: parentRun, repository_id: superOwner.repository_id, bundle_id: parentBundle.bundle_id, expected_before_tree: visibleTree(superproject), env });
    assert.deepEqual(parentBegin.record.queue_order?.depends_on, [`${dependency.unit_key}@1`]);
    const parentApplied = await applyWorktreeIntegration({ repository_root: superproject, run_id: parentRun, repository_id: superOwner.repository_id, bundle_id: parentBundle.bundle_id, env });
    assert.equal(parentApplied.record.state, "integrated");
    assert.equal(parentApplied.record.after_tree, parentResultTree);
    assert.deepEqual(parentApplied.record.conflicts, []);
    assert.equal(git(superproject, ["rev-parse", "HEAD^{tree}"]), parentBeforeTree);
    assert.equal(git(superproject, ["rev-parse", "HEAD:modules/child"]), moduleBefore.superGitlink);
  });
});
