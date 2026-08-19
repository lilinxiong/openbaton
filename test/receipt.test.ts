import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReadOnlyReceipt, readReceipt, ReceiptError, writeReceipt } from "../src/lib/receipt.js";

describe("Delegation Receipt", () => {
  it("builds a fail-closed immutable read-only authorization snapshot", () => {
    const receipt = buildReadOnlyReceipt({
      ticketId: "spn-0001",
      card: { id: "k3", strengths: "flagship", route_id: "kimi/k3[1m]", reasoning_effort: "max", auth_provider: "kimi" },
      issuedAt: "2026-08-19T00:00:00.000Z",
    });
    assert.equal(receipt.receipt_id, "rcpt-spn-0001-a1");
    assert.equal(receipt.route.route_id, "kimi/k3[1m]");
    assert.equal(receipt.execution.mode, "read-only");
    assert.deepEqual(receipt.scope.write_allowlist, []);
    assert.deepEqual(receipt.scope.allowed_operations, ["read"]);
    assert.equal(receipt.retry.fallback, "none");
    assert.equal(receipt.git_policy.staging_owner, "parent");
    assert.equal(receipt.git_policy.worker_may_commit, false);
  });

  it("persists mode 0600 and rejects mutation of an existing receipt", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-receipt-"));
    const receipt = buildReadOnlyReceipt({ ticketId: "spn-0001", card: { id: "k3", strengths: "", route_id: "kimi/k3[1m]" } });
    writeReceipt(cwd, receipt);
    assert.deepEqual(readReceipt(cwd, receipt.receipt_id), receipt);
    const file = path.join(cwd, ".baton", "receipts", `${receipt.receipt_id}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    writeReceipt(cwd, receipt);
    const changed = structuredClone(receipt);
    changed.route.route_id = "xai/grok-4.6";
    assert.throws(() => writeReceipt(cwd, changed), (error) => error instanceof ReceiptError && error.code === "RECEIPT_IMMUTABLE");
  });
});
