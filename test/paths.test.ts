import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  batonDir,
  canonicalWorkspaceRoot,
  compiledApplyRunBodyPath,
  compiledApplyRunDir,
  CURRENT_RUNTIME_NAMESPACE,
  dispatchLockPath,
  hostDispatchStatePath,
  hostRouteSnapshotPath,
  receiptsDir,
  routeHealthPath,
  runsDir,
  selectionsDir,
  spawnsDir,
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
});
