import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditWorktree } from "../src/lib/safety.js";
import { assertWriteScopesAvailable, materializeStandalonePlanAsync, materializeStandalonePlansBatchAsync } from "../src/lib/ticket-materialization.js";
import { planStandaloneSpawn, writeSpawn, type StandalonePlan } from "../src/lib/spawn.js";
import { readReceipt } from "../src/lib/receipt.js";
import { compiledApplyRunsDir } from "../src/lib/paths.js";
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
  it("rolls back only newly-created artifacts when a frontier batch write fails", async () => {
    await withHome(async (home) => {
      const cwd = repository();
      const env = fakeEnv(home, { BATON_SESSION_ID: "cross-tree-batch-rollback" });
      try {
        const first = plan(cwd, env);
        const second = plan(cwd, env);
        const secondId = first.ticket.id.replace(/-\d{4}$/u, "-0002");
        second.ticket.id = secondId;
        second.ticket.receipt_id = second.receipt.receipt_id = `rcpt-${secondId}-a1`;
        let writes = 0;
        await assert.rejects(materializeStandalonePlansBatchAsync(cwd, [
          { planned: first, writeAllowlist: ["owned.txt"], allowedOperations: ["write"] },
          { planned: second, writeAllowlist: ["chmod.txt"], allowedOperations: ["chmod"] },
        ], {
          env,
          writeSpawn: (root, ticket, currentEnv) => {
            writes += 1;
            if (writes === 2) throw new Error("injected batch write failure");
            return writeSpawn(root, ticket, currentEnv);
          },
        }), /injected batch write failure/);
        assert.equal(fs.existsSync(path.join(cwd, ".baton", "receipts", `${first.receipt.receipt_id}.json`)), false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
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

  it("keeps a bound terminal-unreleased write ticket blocking an overlapping tree", async () => {
    await withHome(async (home) => {
      const cwd = repository();
      const ownerEnv = fakeEnv(home, { BATON_SESSION_ID: "terminal-unreleased-owner" });
      const contenderEnv = fakeEnv(home, { BATON_SESSION_ID: "terminal-unreleased-contender" });
      try {
        const owner = await materializeWrite(cwd, ownerEnv, ["owned.txt"], ["write"]);
        owner.ticket.status = "completed";
        owner.ticket.slot_released_at = null;
        owner.ticket.execution_handle = { kind: "alpha-task", value: "terminal-owner", source: "native-return" };
        writeSpawn(cwd, owner.ticket, ownerEnv);
        assert.throws(
          () => assertWriteScopesAvailable(cwd, [{ key: "contender", write_paths: ["owned.txt"] }], contenderEnv),
          /WRITE_SCOPE_CONFLICT/,
          "terminal completion must not release a write scope before explicit slot release",
        );
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  it("releases historical workspace scope for an unbound terminal ticket", async () => {
    await withHome(async (home) => {
      const cwd = repository();
      const ownerEnv = fakeEnv(home, { BATON_SESSION_ID: "terminal-unbound-owner" });
      const contenderEnv = fakeEnv(home, { BATON_SESSION_ID: "terminal-unbound-contender" });
      try {
        const owner = await materializeWrite(cwd, ownerEnv, ["owned.txt"], ["write"]);
        owner.ticket.status = "completed";
        owner.ticket.slot_released_at = null;
        writeSpawn(cwd, owner.ticket, ownerEnv);
        assert.doesNotThrow(
          () => assertWriteScopesAvailable(cwd, [{ key: "contender", write_paths: ["owned.txt"] }], contenderEnv),
          "an unbound terminal ticket never acquired worker-owned workspace scope",
        );
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
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

  it("on batch completion failure removes only newly-created run-state temp files", async () => {
    await withHome(async (home) => {
      const cwd = repository();
      const env = fakeEnv(home, { BATON_SESSION_ID: "batch-on-complete-failure" });
      const runDir = path.join(compiledApplyRunsDir(cwd, env), "run-state");
      const preExisting = path.join(runDir, "state-v1.json.tmp-existing");
      const createdDuringCompletion = path.join(runDir, "state-v1.json.tmp-created");
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(preExisting, "pre-existing\n", "utf8");
      try {
        const first = plan(cwd, env);
        const second = plan(cwd, env);
        second.ticket.id = first.ticket.id.replace(/-\d{4}$/u, "-0002");
        second.ticket.receipt_id = second.receipt.receipt_id = `rcpt-${second.ticket.id}-a1`;
        await assert.rejects(
          materializeStandalonePlansBatchAsync(cwd, [
            { planned: first, writeAllowlist: [], allowedOperations: [] },
            { planned: second, writeAllowlist: [], allowedOperations: [] },
          ], {
            env,
            onComplete: () => {
              fs.writeFileSync(createdDuringCompletion, "created\n", "utf8");
              throw new Error("injected onComplete failure");
            },
          }),
          /injected onComplete failure/,
        );
        assert.equal(fs.existsSync(preExisting), true);
        assert.equal(fs.readFileSync(preExisting, "utf8"), "pre-existing\n");
        assert.equal(fs.existsSync(createdDuringCompletion), false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
