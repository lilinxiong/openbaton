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
  dispatchLockPath,
  dispatchStatePath,
  receiptsDir,
  routeHealthPath,
  routeSnapshotPath,
  runsDir,
  spawnsDir,
  workspaceId,
} from "../src/lib/paths.js";
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

    const firstRoot = path.join(home, ".baton", "workspaces", workspaceId(first));
    assert.equal(batonDir(first), firstRoot);
    assert.equal(batonDir(nested), firstRoot);
    assert.equal(spawnsDir(first), path.join(firstRoot, "spawns"));
    assert.equal(runsDir(first), path.join(firstRoot, "runs"));
    assert.equal(receiptsDir(first), path.join(firstRoot, "receipts"));
    assert.equal(dispatchStatePath(first), path.join(firstRoot, "runs", "dispatch.json"));
    assert.equal(dispatchLockPath(first), path.join(firstRoot, "tmp", "dispatch.lock"));

    assert.equal(routeSnapshotPath(first), routeSnapshotPath(second));
    assert.equal(capabilitiesCacheDir(first), capabilitiesCacheDir(second));
    assert.equal(routeSnapshotPath(first), path.join(home, ".baton", "cache", "routes.json"));
    assert.equal(routeHealthPath(first), path.join(home, ".baton", "cache", "route-health.json"));
    assert.equal(artificialAnalysisDbPath(first), path.join(home, ".baton", "cache", "capabilities", "artificial-analysis.sqlite3"));
    assert.ok(!fs.existsSync(path.join(first, ".baton")));
    assert.ok(!fs.existsSync(path.join(second, ".baton")));
  }));
});
