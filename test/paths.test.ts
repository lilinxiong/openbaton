import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  batonDir,
  bundleManifestPath,
  canonicalWorkspaceRoot,
  compiledApplyRunBodyPath,
  compiledApplyRunDir,
  CURRENT_RUNTIME_NAMESPACE,
  dispatchLockPath,
  hostDispatchStatePath,
  hostRouteSnapshotPath,
  integrationDestinationLockPath,
  integrationQueueLockPath,
  integrationRecordPath,
  integrationRepositoryDir,
  rollingRunAcceptedDocumentPath,
  rollingRunAcceptedDocumentsDir,
  rollingRunCheckpointPath,
  rollingRunDeltaDocumentPath,
  rollingRunFactLogPath,
  rollingRunFactsDir,
  rollingRunFactPath,
  rollingRunLockPath,
  rollingRunRoot,
  rollingRunBundlesDir,
  rollingRunIntegrationsDir,
  rollingRunSnapshotsDir,
  rollingRunWorktreesDir,
  rollingRunsDir,
  ROLLING_RUNS_DIR,
  ROLLING_PATH_SEGMENT_INVALID,
  receiptsDir,
  routeHealthPath,
  runsDir,
  selectionsDir,
  spawnsDir,
  snapshotManifestPath,
  worktreeAttemptDir,
  worktreeExecutionRootPath,
  worktreeRecordPath,
  workspaceId,
} from "../src/lib/paths.js";
import { buildSpawnTicket, listSpawns, readSpawn, writeSpawn } from "../src/lib/spawn.js";
import { withHome, testTicketId } from "./home.js";

function gitRepo(prefix: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
}

describe("global Baton storage paths", () => {
  it("rejects run ids and revisions that are not single path segments", () => withHome(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-path-segment-"));
    for (const runId of ["", ".", "..", "../escape", "nested/run", "nested\\run", "bad\u0000id"]) {
      assert.throws(
        () => compiledApplyRunDir(cwd, runId),
        (error: unknown) => (error as { code?: string }).code === "COMPILED_PATH_SEGMENT_INVALID",
      );
    }
    for (const revision of ["", ".", "..", "../2", "2/3", "2\\3", "bad\u0007revision"]) {
      assert.throws(
        () => compiledApplyRunBodyPath(cwd, "safe-run", revision),
        (error: unknown) => (error as { code?: string }).code === "COMPILED_PATH_SEGMENT_INVALID",
      );
    }
    assert.match(compiledApplyRunBodyPath(cwd, "safe-run", "2"), /safe-run\/revisions\/revision-2\.json$/);
  }));

  it("uses exact canonical paths for rolling-run v2 state", () => withHome((home) => {
    const repo = gitRepo("baton-rolling-paths-");
    const runId = "run-2026-08-31";
    const root = path.join(home, ".baton", "workspaces", workspaceId(repo), CURRENT_RUNTIME_NAMESPACE, "runs", ROLLING_RUNS_DIR, runId);

    assert.equal(rollingRunsDir(repo), path.dirname(root));
    assert.equal(rollingRunRoot(repo, runId), root);
    assert.equal(rollingRunFactLogPath(repo, runId), path.join(root, "facts.ndjson"));
    assert.equal(rollingRunFactsDir(repo, runId), path.join(root, "facts"));
    assert.equal(rollingRunFactPath(repo, runId, "fact-1"), path.join(root, "facts", "fact-1.json"));
    assert.equal(rollingRunAcceptedDocumentsDir(repo, runId), path.join(root, "accepted-documents"));
    assert.equal(rollingRunAcceptedDocumentPath(repo, runId, "doc-1"), path.join(root, "accepted-documents", "doc-1.json"));
    assert.equal(rollingRunDeltaDocumentPath(repo, runId, "delta-1"), path.join(root, "accepted-documents", "delta-delta-1.json"));
    assert.throws(
      () => rollingRunAcceptedDocumentPath(repo, runId, "delta-delta-1"),
      (error: unknown) => (error as { code?: string }).code === ROLLING_PATH_SEGMENT_INVALID,
    );
    assert.equal(rollingRunCheckpointPath(repo, runId), path.join(root, "checkpoint.json"));
    assert.equal(rollingRunLockPath(repo, runId), path.join(root, ".lock"));
    assert.ok(!fs.existsSync(path.join(repo, ".baton")));
  }));

  it("keeps rolling paths stable for nested Git cwd values", () => withHome(() => {
    const repo = gitRepo("baton-rolling-nested-");
    const nested = path.join(repo, "nested", "dir");
    fs.mkdirSync(nested, { recursive: true });
    const runId = "nested-run";

    assert.equal(rollingRunsDir(nested), rollingRunsDir(repo));
    assert.equal(rollingRunRoot(nested, runId), rollingRunRoot(repo, runId));
    assert.equal(rollingRunFactLogPath(nested, runId), rollingRunFactLogPath(repo, runId));
    assert.equal(rollingRunAcceptedDocumentPath(nested, runId, "doc-1"), rollingRunAcceptedDocumentPath(repo, runId, "doc-1"));
    assert.equal(rollingRunCheckpointPath(nested, runId), rollingRunCheckpointPath(repo, runId));
    assert.equal(rollingRunLockPath(nested, runId), rollingRunLockPath(repo, runId));
    assert.ok(!fs.existsSync(path.join(repo, ".baton")));
  }));

  it("rejects malicious rolling run, delta, document, and fact segments", () => withHome(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-path-segment-"));
    const unsafe = ["", " ", ".", "..", "../escape", "nested/run", "nested\\run", "bad\u0000id", "bad\u0007id", "C:escape", "/tmp/escape"];
    const expectRollingError = (fn: () => unknown) => assert.throws(fn, (error: unknown) =>
      (error as { code?: string }).code === ROLLING_PATH_SEGMENT_INVALID);

    for (const value of unsafe) {
      expectRollingError(() => rollingRunRoot(cwd, value));
      expectRollingError(() => rollingRunFactLogPath(cwd, value));
      expectRollingError(() => rollingRunAcceptedDocumentsDir(cwd, value));
      expectRollingError(() => rollingRunCheckpointPath(cwd, value));
      expectRollingError(() => rollingRunLockPath(cwd, value));
    }
    for (const value of unsafe) {
      expectRollingError(() => rollingRunDeltaDocumentPath(cwd, "safe-run", value));
      expectRollingError(() => rollingRunAcceptedDocumentPath(cwd, "safe-run", value));
      expectRollingError(() => rollingRunFactPath(cwd, "safe-run", value));
    }
  }));

  it("keeps shared cache global and namespaces runtime by canonical Git root", () => withHome((home) => {
    const first = gitRepo("baton-path-first-");
    const nested = path.join(first, "nested", "dir");
    fs.mkdirSync(nested, { recursive: true });
    const second = gitRepo("baton-path-second-");

    assert.equal(canonicalWorkspaceRoot(nested), fs.realpathSync(first));
    assert.equal(workspaceId(nested), workspaceId(first));
    assert.notEqual(workspaceId(first), workspaceId(second));

    const firstRoot = path.join(home, ".baton", "workspaces", workspaceId(first), CURRENT_RUNTIME_NAMESPACE);
    assert.equal(batonDir(first), firstRoot);
    assert.equal(batonDir(nested), firstRoot);
    assert.equal(spawnsDir(first), path.join(firstRoot, "spawns"));
    assert.equal(runsDir(first), path.join(firstRoot, "runs"));
    assert.equal(receiptsDir(first), path.join(firstRoot, "receipts"));
    assert.equal(selectionsDir(first), path.join(firstRoot, "selections"));
    assert.equal(hostDispatchStatePath(first, "alpha"), path.join(firstRoot, "runs", "dispatch-alpha.json"));
    assert.equal(dispatchLockPath(first), path.join(firstRoot, "tmp", "dispatch.lock"));

    assert.equal(rollingRunRoot(first, "run-1"), path.join(firstRoot, "runs", ROLLING_RUNS_DIR, "run-1"));
    assert.equal(rollingRunRoot(nested, "run-1"), rollingRunRoot(first, "run-1"));

    assert.equal(hostRouteSnapshotPath(first, "alpha"), hostRouteSnapshotPath(second, "alpha"));
    assert.equal(hostRouteSnapshotPath(first, "alpha"), path.join(home, ".baton", "cache", "cli-models-alpha.json"));
    assert.equal(routeHealthPath(first), path.join(home, ".baton", "cache", "route-health.json"));
    assert.ok(!fs.existsSync(path.join(first, ".baton")));
    assert.ok(!fs.existsSync(path.join(second, ".baton")));
  }));

  it("never scans the unversioned workspace state and accepts current IDs by schema", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-path-format-"));
    const workspaceRoot = path.join(home, ".baton", "workspaces", workspaceId(cwd));
    const historicalSpawns = path.join(workspaceRoot, "spawns");
    fs.mkdirSync(historicalSpawns, { recursive: true });
    fs.writeFileSync(path.join(historicalSpawns, `${testTicketId("spn", 1)}.json`), JSON.stringify({
      id: testTicketId("spn", 1),
      schema_version: 7,
      status: "queued",
    }) + "\n");

    assert.deepEqual(listSpawns(cwd), []);

    const current = buildSpawnTicket({
      id: testTicketId("os", 1),
      description: "current-format ticket",
      prompt: "current-format ticket",
      modelId: "alpha/default",
      routeId: "alpha/default",
      taskKind: "concrete",
    });
    writeSpawn(cwd, current);

    assert.deepEqual(listSpawns(cwd).map((ticket) => ticket.id), [testTicketId("os", 1)]);
    assert.equal(readSpawn(cwd, testTicketId("os", 1)).schema_version, 8);
    assert.equal(readSpawn(cwd, testTicketId("os", 1)).work_unit.kind, "concrete");
    assert.equal("classification" in readSpawn(cwd, testTicketId("os", 1)).work_unit, false);
    assert.equal(fs.existsSync(path.join(historicalSpawns, `${testTicketId("spn", 1)}.json`)), true);
    assert.equal(fs.existsSync(path.join(spawnsDir(cwd), `${testTicketId("os", 1)}.json`)), true);
  }));

  it("fails fast when current runtime state is corrupt", () => withHome(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-path-corrupt-"));
    fs.mkdirSync(spawnsDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(spawnsDir(cwd), "corrupt.json"), "{not-json}\n");
    assert.throws(() => listSpawns(cwd), SyntaxError);
  }));

  it("derives versioned worktree, snapshot, bundle, and integration paths inside one rolling run", () => withHome(() => {
    const repo = gitRepo("baton-worktree-runtime-paths-");
    const runRoot = rollingRunRoot(repo, "run-1");
    assert.equal(rollingRunWorktreesDir(repo, "run-1"), path.join(runRoot, "worktrees"));
    assert.equal(worktreeAttemptDir(repo, "run-1", "unit-1", "attempt-1"), path.join(runRoot, "worktrees", "unit-1", "attempt-1"));
    assert.equal(worktreeExecutionRootPath(repo, "run-1", "unit-1", "attempt-1"), path.join(runRoot, "worktrees", "unit-1", "attempt-1", "root"));
    assert.equal(worktreeRecordPath(repo, "run-1", "unit-1", "attempt-1"), path.join(runRoot, "worktrees", "unit-1", "attempt-1", "record-v1.json"));
    assert.equal(rollingRunSnapshotsDir(repo, "run-1"), path.join(runRoot, "snapshots"));
    assert.equal(snapshotManifestPath(repo, "run-1", "snapshot-1"), path.join(runRoot, "snapshots", "snapshot-1", "manifest-v1.json"));
    assert.equal(rollingRunBundlesDir(repo, "run-1"), path.join(runRoot, "bundles"));
    assert.equal(bundleManifestPath(repo, "run-1", "bundle-1"), path.join(runRoot, "bundles", "bundle-1", "manifest-v1.json"));
    assert.equal(rollingRunIntegrationsDir(repo, "run-1"), path.join(runRoot, "integrations"));
    assert.equal(integrationRepositoryDir(repo, "run-1", "a".repeat(64)), path.join(runRoot, "integrations", "a".repeat(64)));
    assert.equal(integrationQueueLockPath(repo, "run-1", "a".repeat(64)), path.join(runRoot, "integrations", "a".repeat(64), ".queue-v1.lock"));
    assert.equal(integrationDestinationLockPath(repo, "a".repeat(64)), path.join(runsDir(repo), "rolling-integration-destinations-v1", "a".repeat(64), ".begin-v1.lock"));
    assert.equal(integrationRecordPath(repo, "run-1", "a".repeat(64), "integration-1"), path.join(runRoot, "integrations", "a".repeat(64), "integration-1", "record-v1.json"));
  }));

  it("rejects every unsafe worktree runtime path segment", () => withHome(() => {
    const repo = gitRepo("baton-worktree-runtime-unsafe-");
    const unsafe = ["", " ", ".", "..", "../escape", "nested/path", "nested\\path", "bad\u0000id", "/tmp/escape", "C:escape"];
    const rejects = (fn: () => unknown) => assert.throws(fn, (error: unknown) => (error as { code?: string }).code === ROLLING_PATH_SEGMENT_INVALID);
    for (const value of unsafe) {
      rejects(() => worktreeRecordPath(repo, "run", value, "attempt"));
      rejects(() => worktreeRecordPath(repo, "run", "unit", value));
      rejects(() => snapshotManifestPath(repo, "run", value));
      rejects(() => bundleManifestPath(repo, "run", value));
      rejects(() => integrationRecordPath(repo, "run", value, "integration"));
      rejects(() => integrationRecordPath(repo, "run", "a".repeat(64), value));
    }
  }));
});
