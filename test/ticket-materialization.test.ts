import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReadOnlyReceipt, writeReceipt } from "../src/lib/receipt.js";
import { materializeStandalonePlanAsync } from "../src/lib/ticket-materialization.js";
import { buildSpawnTicket, writeSpawn, type StandalonePlan } from "../src/lib/spawn.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { GitSafetyError, type GitSafetyErrorCode } from "../src/lib/git-safety-process.js";

function plan(cwd: string): StandalonePlan {
  const ticket = buildSpawnTicket({ id: "spn-0001", description: "materialize", prompt: "materialize", modelId: "model", cwd, taskKind: "concrete" } as Parameters<typeof buildSpawnTicket>[0]);
  const receipt = buildReadOnlyReceipt({ ticketId: ticket.id, card: { id: "model", provider: "test" } });
  ticket.receipt_id = receipt.receipt_id;
  return { director_local: false, ticket, receipt, queue: { running: 0, queued: 1 } };
}

function files(cwd: string): string[] {
  const result: string[] = [];
  if (fs.existsSync(receiptsDir(cwd))) result.push(...fs.readdirSync(receiptsDir(cwd)));
  if (fs.existsSync(spawnsDir(cwd))) result.push(...fs.readdirSync(spawnsDir(cwd)));
  return result;
}

describe("stable ticket materialization", () => {
  it("does not materialize after Git failure, malformed stream, or persistent race", async () => {
    for (const code of ["GIT_SAFETY_COMMAND_FAILED", "GIT_SAFETY_STREAM_MALFORMED", "GIT_BASELINE_RACED"] as const satisfies GitSafetyErrorCode[]) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-materialization-failure-"));
      const error = new GitSafetyError({ code, command: "git safety fixture" });
      await assert.rejects(
        materializeStandalonePlanAsync(cwd, plan(cwd), {
          writeAllowlist: ["allowed.txt"],
          captureBaseline: async () => { throw error; },
        }),
        (actual: unknown) => actual === error && actual instanceof GitSafetyError && actual.code === code,
      );
      assert.deepEqual(files(cwd), [], code);
    }
    for (const code of ["GIT_SAFETY_COMMAND_FAILED", "GIT_SAFETY_STREAM_MALFORMED", "GIT_BASELINE_RACED"] as const satisfies GitSafetyErrorCode[]) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-commit-materialization-failure-"));
      const commitPlan = plan(cwd);
      commitPlan.ticket.mode = "commit-only";
      commitPlan.ticket.read_only = false;
      const error = new GitSafetyError({ code, command: "git safety fixture" });
      await assert.rejects(
        materializeStandalonePlanAsync(cwd, commitPlan, {
          captureCommitBaseline: async () => { throw error; },
        }),
        (actual: unknown) => actual === error && actual instanceof GitSafetyError && actual.code === code,
      );
      assert.deepEqual(files(cwd), [], `commit ${code}`);
    }
  });

  it("captures a complete baseline before Receipt, then writes spawn", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-materialization-order-"));
    const events: string[] = [];
    const result = await materializeStandalonePlanAsync(cwd, plan(cwd), {
      writeAllowlist: ["allowed.txt"],
      captureBaseline: async () => {
        events.push("stable-baseline");
        return {
          repo_root: cwd, head: "a".repeat(40), branch: "main", branch_ref: "refs/heads/main", index_path: path.join(cwd, ".git/index"),
          index_tree: "b".repeat(40), index_control_checksum: "c".repeat(64), index_control_algorithm: "git-index-control-framed-sha256-v2", index_control_entry_count: 0,
          refs: [], head_reflog_count: 1, head_reflog_checksum: "d".repeat(64), dirty_entries: [], dirty_checksums: {}, captured_at: new Date().toISOString(),
        };
      },
      writeReceipt: (root, receipt) => { events.push("receipt"); return receipt; },
      writeSpawn: (root, ticket) => { events.push("spawn"); return ticket; },
    });
    assert.equal(result.mode, "write");
    assert.deepEqual(events, ["stable-baseline", "receipt", "spawn"]);
  });

  it("orders commit baseline, authorized Receipt, and worker-ready spawn", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-commit-materialization-order-"));
    const events: string[] = [];
    const commitPlan = plan(cwd);
    commitPlan.ticket.mode = "commit-only";
    commitPlan.ticket.read_only = false;
    const result = await materializeStandalonePlanAsync(cwd, commitPlan, {
      captureCommitBaseline: async () => {
        events.push("stable-commit-baseline");
        return {
          repo_root: cwd, head: "a".repeat(40), branch: "main", branch_ref: "refs/heads/main", staged_tree: "b".repeat(40),
          staged_index_control_checksum: "c".repeat(64), staged_index_control_algorithm: "git-index-control-framed-sha256-v2", staged_index_control_entry_count: 1,
          staged_paths: ["allowed.txt"], refs: ["refs/heads/main\0" + "a".repeat(40)], head_reflog_count: 1, head_reflog_checksum: "d".repeat(64), captured_at: new Date().toISOString(),
        };
      },
      writeReceipt: (root, receipt, env) => { events.push("receipt"); return receipt; },
      writeSpawn: (root, ticket, env) => { events.push("spawn"); return ticket; },
    });
    assert.equal(result.mode, "commit-only");
    assert.deepEqual(events, ["stable-commit-baseline", "receipt", "spawn"]);
    assert.equal(commitPlan.receipt.execution.mode, "commit-only");
    assert.deepEqual(commitPlan.receipt.scope.allowed_operations, ["commit"]);
    assert.equal(commitPlan.receipt.commit_baseline?.staged_tree, "b".repeat(40));
    assert.equal(commitPlan.receipt.commit_baseline?.staged_index_control_algorithm, "git-index-control-framed-sha256-v2");
    assert.equal(commitPlan.receipt.commit_baseline?.staged_index_control_entry_count, 1);
    assert.deepEqual(commitPlan.receipt.scope.write_allowlist, ["allowed.txt"]);
    assert.match(commitPlan.ticket.prompt, /expected staged tree/);
  });

  it("rolls back both artifacts when an injected spawn writer writes then fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-materialization-rollback-"));
    await assert.rejects(materializeStandalonePlanAsync(cwd, plan(cwd), {
      writeReceipt: (root, receipt, env) => {
        return writeReceipt(root, receipt, env);
      },
      writeSpawn: (root, ticket, env) => {
        writeSpawn(root, ticket, env);
        throw new Error("injected spawn failure");
      },
    }), /injected spawn failure/);
    assert.deepEqual(files(cwd), []);
  });

  it("rolls back Receipt when an injected Receipt writer writes then fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-receipt-rollback-"));
    await assert.rejects(materializeStandalonePlanAsync(cwd, plan(cwd), {
      writeReceipt: (root, receipt, env) => {
        writeReceipt(root, receipt, env);
        throw new Error("injected Receipt failure");
      },
    }), /injected Receipt failure/);
    assert.deepEqual(files(cwd), []);
  });
});
