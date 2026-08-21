import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCommitReceipt, buildReadOnlyReceipt, readReceipt, ReceiptError, writeReceipt } from "../src/lib/receipt.js";
import { receiptsDir } from "../src/lib/paths.js";
import { withHome } from "./home.js";

describe("Delegation Receipt", () => {
  it("builds a fail-closed immutable read-only authorization snapshot", () => {
    const receipt = buildReadOnlyReceipt({
      ticketId: "spn-0001",
      card: { id: "k3", strengths: "flagship", route_id: "kimi/k3[1m]", reasoning_effort: "max", provider: "kimi" },
      issuedAt: "2026-08-19T00:00:00.000Z",
    });
    assert.equal(receipt.receipt_id, "rcpt-spn-0001-a1");
    assert.equal(receipt.route.route_id, "kimi/k3[1m]");
    assert.equal(receipt.route.provider, "kimi");
    assert.equal(receipt.execution.mode, "read-only");
    assert.deepEqual(receipt.scope.write_allowlist, []);
    assert.deepEqual(receipt.scope.allowed_operations, ["read"]);
    assert.equal(receipt.retry.fallback, "none");
    assert.equal(receipt.git_policy.staging_owner, "parent");
    assert.equal(receipt.git_policy.worker_may_commit, false);
  });

  it("persists mode 0600 and rejects mutation of an existing receipt", () => withHome(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-receipt-"));
    const receipt = buildReadOnlyReceipt({ ticketId: "spn-0001", card: { id: "k3", strengths: "", route_id: "kimi/k3[1m]" } });
    writeReceipt(cwd, receipt);
    assert.deepEqual(readReceipt(cwd, receipt.receipt_id), receipt);
    const file = path.join(receiptsDir(cwd), `${receipt.receipt_id}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    writeReceipt(cwd, receipt);
    const changed = structuredClone(receipt);
    changed.route.route_id = "xai/grok-4.6";
    assert.throws(() => writeReceipt(cwd, changed), (error) => error instanceof ReceiptError && error.code === "RECEIPT_IMMUTABLE");
  }));

  it("authorizes one parent-staged commit without granting general Git mutations", () => {
    const base = buildReadOnlyReceipt({
      ticketId: "spn-0002",
      card: { id: "k3", strengths: "", route_id: "kimi/k3[1m]" },
    });
    const receipt = buildCommitReceipt({
      base,
      baseline: {
        repo_root: "/repo",
        head: "a".repeat(40),
        branch: "main",
        branch_ref: "refs/heads/main",
        staged_tree: "b".repeat(40),
        staged_paths: ["README.md", "src/index.ts"],
        refs: [`refs/heads/main\0${"a".repeat(40)}`],
        head_reflog_count: 1,
        head_reflog_checksum: "c".repeat(64),
        captured_at: "2026-08-21T00:00:00.000Z",
      },
    });
    assert.equal(receipt.schema_version, 4);
    assert.equal(receipt.execution.mode, "commit-only");
    assert.deepEqual(receipt.scope.write_allowlist, ["README.md", "src/index.ts"]);
    assert.deepEqual(receipt.scope.allowed_operations, ["commit"]);
    assert.equal(receipt.git_policy.worker_may_stage, false);
    assert.equal(receipt.git_policy.worker_may_commit, true);
    assert.equal(receipt.git_policy.worker_may_branch, false);
    assert.equal(receipt.baseline, null);
    assert.equal(receipt.commit_baseline?.staged_tree, "b".repeat(40));
  });
});
