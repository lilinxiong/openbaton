import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  artificialAnalysisDbPath,
  batonDir,
  capabilitiesCacheDir,
  canonicalWorkspaceRoot,
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
import { withHome } from "./home.js";

function gitRepo(prefix: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
}

describe("global Baton storage paths", () => {
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
    assert.equal(hostDispatchStatePath(first, "codex"), path.join(firstRoot, "runs", "dispatch-codex.json"));
    assert.equal(dispatchLockPath(first), path.join(firstRoot, "tmp", "dispatch.lock"));

    assert.equal(hostRouteSnapshotPath(first, "codex"), hostRouteSnapshotPath(second, "codex"));
    assert.equal(capabilitiesCacheDir(first), capabilitiesCacheDir(second));
    assert.equal(hostRouteSnapshotPath(first, "codex"), path.join(home, ".baton", "cache", "cli-models-codex.json"));
    assert.equal(routeHealthPath(first), path.join(home, ".baton", "cache", "route-health.json"));
    assert.equal(artificialAnalysisDbPath(first), path.join(home, ".baton", "cache", "capabilities", "artificial-analysis.sqlite3"));
    assert.ok(!fs.existsSync(path.join(first, ".baton")));
    assert.ok(!fs.existsSync(path.join(second, ".baton")));
  }));

  it("never scans the unversioned workspace state and accepts current IDs by schema", () => withHome((home) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-path-format-"));
    const workspaceRoot = path.join(home, ".baton", "workspaces", workspaceId(cwd));
    const legacySpawns = path.join(workspaceRoot, "spawns");
    fs.mkdirSync(legacySpawns, { recursive: true });
    fs.writeFileSync(path.join(legacySpawns, "spn-0001.json"), JSON.stringify({
      id: "spn-0001",
      schema_version: 7,
      status: "queued",
    }) + "\n");

    assert.deepEqual(listSpawns(cwd), []);

    const current = buildSpawnTicket({
      id: "os-0001",
      description: "current-format ticket",
      prompt: "current-format ticket",
      modelId: "codex/default",
      routeId: "codex/default",
      taskKind: "concrete",
    });
    writeSpawn(cwd, current);

    assert.deepEqual(listSpawns(cwd).map((ticket) => ticket.id), ["os-0001"]);
    assert.equal(readSpawn(cwd, "os-0001").schema_version, 8);
    assert.equal(readSpawn(cwd, "os-0001").work_unit.kind, "concrete");
    assert.equal("classification" in readSpawn(cwd, "os-0001").work_unit, false);
    assert.equal(fs.existsSync(path.join(legacySpawns, "spn-0001.json")), true);
    assert.equal(fs.existsSync(path.join(spawnsDir(cwd), "os-0001.json")), true);
  }));

  it("fails fast when current runtime state is corrupt", () => withHome(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-path-corrupt-"));
    fs.mkdirSync(spawnsDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(spawnsDir(cwd), "corrupt.json"), "{not-json}\n");
    assert.throws(() => listSpawns(cwd), SyntaxError);
  }));
});
