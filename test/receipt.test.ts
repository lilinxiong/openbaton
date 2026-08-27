import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCommitReceipt, buildReadOnlyReceipt, buildWriteReceipt, readReceipt, ReceiptError, writeReceipt } from "../src/lib/receipt.js";
import { validateIndexControlBaselineMetadata } from "../src/lib/safety.js";
import { receiptsDir } from "../src/lib/paths.js";
import { withHome } from "./home.js";

describe("Delegation Receipt", () => {
  it("builds a fail-closed immutable read-only authorization snapshot", () => {
    const receipt = buildReadOnlyReceipt({
      ticketId: "spn-0001",
      card: { id: "k3", strengths: "flagship", route_id: "kimi/k3[1m]", reasoning_effort: "max", provider: "kimi" },
      issuedAt: "2026-08-19T00:00:00.000Z",
      selection: {
        proposal_id: "sel-1", approval_id: "approval-1", approved_at: "2026-08-19T00:00:00.000Z",
        confirmed_by: "baton-recommendation", catalog_fingerprint: "catalog", recommended_model_id: "k3",
        selected_model_id: "k3", service_tier: "priority", changed_by_user: false,
      },
    });
    assert.equal(receipt.receipt_id, "rcpt-spn-0001-a1");
    assert.equal(receipt.route.route_id, "kimi/k3[1m]");
    assert.equal(receipt.route.provider, "kimi");
    assert.equal(receipt.route.service_tier, "priority");
    assert.equal(receipt.execution.mode, "read-only");
    assert.deepEqual(receipt.scope.write_allowlist, []);
    assert.deepEqual(receipt.scope.allowed_operations, ["read"]);
    assert.deepEqual(receipt.retry, { max_attempts: 1 });
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
      changed.route.route_id = "other/model-4.6";
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
        staged_index_control_checksum: "c".repeat(64),
        staged_index_control_algorithm: "git-index-control-framed-sha256-v2",
        staged_index_control_entry_count: 2,
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

  it("requires complete current v2 baseline metadata", () => {
    assert.equal(validateIndexControlBaselineMetadata({ index_control_checksum: "a".repeat(64) }), "INDEX_CONTROL_ALGORITHM_UNSUPPORTED");
    const valid = {
      index_control_algorithm: "git-index-control-framed-sha256-v2",
      index_control_checksum: "a".repeat(64),
      index_control_entry_count: 0,
    };
    assert.equal(validateIndexControlBaselineMetadata(valid), null);
    assert.equal(validateIndexControlBaselineMetadata({ ...valid, index_control_algorithm: "future-v3" }), "INDEX_CONTROL_ALGORITHM_UNSUPPORTED");
    assert.equal(validateIndexControlBaselineMetadata({ ...valid, index_control_entry_count: -1 }), "INDEX_CONTROL_BASELINE_INVALID");
    assert.equal(validateIndexControlBaselineMetadata({ index_control_entry_count: 1 }), "INDEX_CONTROL_ALGORITHM_UNSUPPORTED");
    assert.equal(validateIndexControlBaselineMetadata({ ...valid, index_control_checksum: "A".repeat(64) }), "INDEX_CONTROL_BASELINE_INVALID");
  });

  it("enforces metadata at Receipt construction and persistence boundaries", () => withHome(() => {
    const base = buildReadOnlyReceipt({ ticketId: "spn-0003", card: { id: "k3", strengths: "", route_id: "kimi/k3[1m]" } });
    const writeBaseline = {
      repo_root: "/repo", head: "a".repeat(40), branch: "main", branch_ref: "refs/heads/main",
      index_path: "/repo/.git/index", index_tree: "b".repeat(40), index_control_checksum: "c".repeat(64), index_control_algorithm: "git-index-control-framed-sha256-v2", index_control_entry_count: 0,
      staged_paths: [], refs: [], head_reflog_count: 0, head_reflog_checksum: "d".repeat(64), dirty_entries: [], dirty_checksums: {}, captured_at: "2026-08-21T00:00:00.000Z",
    };
    const commitBaseline = { repo_root: "/repo", head: "a".repeat(40), branch: "main", branch_ref: "refs/heads/main", staged_tree: "b".repeat(40), staged_index_control_checksum: "c".repeat(64), staged_index_control_algorithm: "git-index-control-framed-sha256-v2", staged_index_control_entry_count: 1, staged_paths: ["x"], refs: [], head_reflog_count: 1, head_reflog_checksum: "d".repeat(64), captured_at: "2026-08-21T00:00:00.000Z" };
    assert.throws(() => buildWriteReceipt({ base, baseline: { ...writeBaseline, index_control_algorithm: "future" }, writeAllowlist: ["x"], allowedOperations: ["write"] }), (error) => error instanceof ReceiptError && error.code === "INDEX_CONTROL_ALGORITHM_UNSUPPORTED");
    assert.throws(() => buildCommitReceipt({ base, baseline: { ...commitBaseline, staged_index_control_entry_count: undefined } as any }), (error) => error instanceof ReceiptError && error.code === "INDEX_CONTROL_BASELINE_INVALID");
    const malformed = structuredClone(base) as any;
    malformed.execution.mode = "write"; malformed.baseline = { ...writeBaseline, index_control_checksum: undefined }; malformed.scope.write_allowlist = ["x"];
    const boundary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-receipt-boundary-"));
    assert.throws(() => writeReceipt(boundary, malformed), (error) => error instanceof ReceiptError && error.code === "INDEX_CONTROL_BASELINE_INVALID");
    const obsolete = structuredClone(base) as any;
    obsolete.receipt_id = "rcpt-obsolete"; obsolete.execution.mode = "write"; obsolete.baseline = { ...writeBaseline }; delete obsolete.baseline.index_control_algorithm; delete obsolete.baseline.index_control_entry_count; obsolete.scope.write_allowlist = ["x"];
    assert.throws(() => writeReceipt(boundary, obsolete), (error) => error instanceof ReceiptError);
    const disk = fs.mkdtempSync(path.join(os.tmpdir(), "baton-receipt-read-") );
    fs.mkdirSync(receiptsDir(disk), { recursive: true });
    const persistedWrite = structuredClone(base) as any;
    persistedWrite.receipt_id = "rcpt-invalid-write"; persistedWrite.execution.mode = "write"; persistedWrite.baseline = { ...writeBaseline, index_control_algorithm: "future" }; persistedWrite.scope.write_allowlist = ["x"];
    fs.writeFileSync(path.join(receiptsDir(disk), `${persistedWrite.receipt_id}.json`), JSON.stringify(persistedWrite));
    assert.throws(() => readReceipt(disk, persistedWrite.receipt_id), (error) => error instanceof ReceiptError && error.code === "INDEX_CONTROL_ALGORITHM_UNSUPPORTED");
    const persistedCommit = structuredClone(base) as any;
    persistedCommit.receipt_id = "rcpt-invalid-commit"; persistedCommit.execution.mode = "commit-only"; persistedCommit.commit_baseline = { ...commitBaseline, staged_index_control_entry_count: undefined }; persistedCommit.baseline = null;
    fs.writeFileSync(path.join(receiptsDir(disk), `${persistedCommit.receipt_id}.json`), JSON.stringify(persistedCommit));
    assert.throws(() => readReceipt(disk, persistedCommit.receipt_id), (error) => error instanceof ReceiptError && error.code === "INDEX_CONTROL_BASELINE_INVALID");
  }));
});
