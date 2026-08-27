import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditWorktree } from "../src/lib/safety.js";
import { assertWriteScopesAvailable, materializeStandalonePlanAsync } from "../src/lib/ticket-materialization.js";
import { planStandaloneSpawn, type StandalonePlan } from "../src/lib/spawn.js";
import { readReceipt } from "../src/lib/receipt.js";
import { fakeEnv, withHome } from "./home.js";

const CARD = {
  id: "alpha/default",
  route_id: "alpha/default",
  provider: "alpha",
  strengths: "cross-tree safety fixture",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cross-tree-safety-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "validation@example.invalid");
  git(cwd, "config", "user.name", "Validation");
  for (const file of ["owned.txt", "rename-source.txt", "delete.txt", "chmod.txt"]) {
    fs.writeFileSync(path.join(cwd, file), `${file}\n`, "utf8");
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "baseline");
  return cwd;
}

function plan(cwd: string, env: NodeJS.ProcessEnv): Extract<StandalonePlan, { director_local: false }> {
  const planned = planStandaloneSpawn({
    cwd,
    env,
    cards: [CARD],
    explicitModel: CARD.id,
    description: "cross-tree safety worker",
    taskKind: "concrete",
  });
  assert.equal(planned.director_local, false);
  return planned;
}

async function materializeWrite(
  cwd: string,
  env: NodeJS.ProcessEnv,
  writePaths: string[],
  allowedOperations: Array<"write" | "create" | "delete" | "rename" | "chmod">,
): Promise<Extract<StandalonePlan, { director_local: false }>> {
  const planned = plan(cwd, env);
  await materializeStandalonePlanAsync(cwd, planned, {
    env,
    writeAllowlist: writePaths,
    allowedOperations,
  });
  return planned;
}

describe("cross-tree workspace safety", () => {
  it("keeps independent tree capacity from allowing overlapping write, rename, delete, or chmod ownership", async () => {
    await withHome(async (home) => {
      const cases: Array<{
        operation: "write" | "rename" | "delete" | "chmod";
        ownerPaths: string[];
        incomingPaths: string[];
      }> = [
        { operation: "write", ownerPaths: ["owned.txt"], incomingPaths: ["owned.txt"] },
        { operation: "rename", ownerPaths: ["rename-source.txt"], incomingPaths: ["rename-source.txt", "rename-target.txt"] },
        { operation: "delete", ownerPaths: ["delete.txt"], incomingPaths: ["delete.txt"] },
        { operation: "chmod", ownerPaths: ["chmod.txt"], incomingPaths: ["chmod.txt"] },
      ];

      for (const item of cases) {
        const cwd = repository();
        const treeA = fakeEnv(home, { BATON_SESSION_ID: `cross-tree-owner-${item.operation}` });
        const treeB = fakeEnv(home, { BATON_SESSION_ID: `cross-tree-contender-${item.operation}` });
        try {
          const owner = await materializeWrite(cwd, treeA, item.ownerPaths, [item.operation]);
          assert.notEqual(owner.ticket.session_uid, plan(cwd, treeB).ticket.session_uid, item.operation);

          assert.throws(
            () => assertWriteScopesAvailable(cwd, [{ key: "tree-b", write_paths: item.incomingPaths }], treeB),
            /WRITE_SCOPE_CONFLICT/,
            `${item.operation} must remain workspace-conflicting across independent trees`,
          );
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      }
    });
  });

  it("does not let a cross-tree symlink escape pass the repository safety audit", async () => {
    await withHome(async (home) => {
      const cwd = repository();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cross-tree-outside-"));
      const treeA = fakeEnv(home, { BATON_SESSION_ID: "cross-tree-symlink-owner" });
      const treeB = fakeEnv(home, { BATON_SESSION_ID: "cross-tree-symlink-contender" });
      try {
        const owner = await materializeWrite(cwd, treeA, ["escape.txt"], ["create"]);
        fs.writeFileSync(path.join(outside, "target.txt"), "outside\n", "utf8");
        fs.symlinkSync(path.join(outside, "target.txt"), path.join(cwd, "escape.txt"));

        assert.throws(
          () => assertWriteScopesAvailable(cwd, [{ key: "tree-b", write_paths: ["escape.txt"] }], treeB),
          /WRITE_SCOPE_CONFLICT/,
        );
        const receipt = readReceipt(cwd, owner.ticket.receipt_id!, treeA);
        const verdict = auditWorktree(cwd, receipt.baseline!, {
          write_allowlist: ["escape.txt"],
          allowed_operations: ["create"],
          peer_write_allowlists: [["escape.txt"]],
        });
        assert.equal(verdict.accepted, false);
        assert.ok(verdict.violations.some((item) => item.code === "E_SYMLINK_ESCAPE"));
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("keeps staged paths exclusively owned by an active commit-only tree", async () => {
    await withHome(async (home) => {
      const cwd = repository();
      const treeA = fakeEnv(home, { BATON_SESSION_ID: "cross-tree-commit-owner" });
      const treeB = fakeEnv(home, { BATON_SESSION_ID: "cross-tree-commit-contender" });
      try {
        fs.appendFileSync(path.join(cwd, "owned.txt"), "staged\n", "utf8");
        git(cwd, "add", "owned.txt");

        const owner = plan(cwd, treeA);
        owner.ticket.mode = "commit-only";
        owner.ticket.read_only = false;
        await materializeStandalonePlanAsync(cwd, owner, { env: treeA });
        const receipt = readReceipt(cwd, owner.ticket.receipt_id!, treeA);
        assert.equal(receipt.execution.mode, "commit-only");
        assert.deepEqual(receipt.scope.write_allowlist, ["owned.txt"]);

        const contender = plan(cwd, treeB);
        contender.ticket.mode = "commit-only";
        contender.ticket.read_only = false;
        await assert.rejects(
          materializeStandalonePlanAsync(cwd, contender, { env: treeB }),
          /WRITE_SCOPE_CONFLICT/,
          "an independent tree must not claim an actively owned staged path",
        );
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
