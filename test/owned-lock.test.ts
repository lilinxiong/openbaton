import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireOwnedLock, withOwnedLock, withOwnedLockAsync } from "../src/lib/owned-lock.js";

function fixture() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "baton-owned-lock-")), "lock.json"); }

describe("owned file lock", () => {
  it("writes metadata and token-checks replacement release/refresh", () => {
    const file = fixture(); let now = Date.now();
    const first = acquireOwnedLock(file, { now: () => now, leaseMs: 10, pid: 111, operation: "scan", isPidAlive: () => true });
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual([owner.version, owner.pid, owner.operation, owner.token], [1, 111, "scan", first.token]);
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify({ ...owner, token: "replacement", lease_until: new Date(now + 100).toISOString() }));
    assert.equal(first.refresh(), false);
    assert.equal(first.release(), false);
    assert.equal(fs.existsSync(file), true);
  });

  it("reclaims malformed/dead owners only after expiry and preserves live owners", () => {
    const file = fixture(); let now = Date.now();
    fs.writeFileSync(file, "malformed");
    assert.throws(() => acquireOwnedLock(file, { now: () => now, staleMs: 10, isPidAlive: () => false }), (error) => (error as NodeJS.ErrnoException).code === "LOCK_BUSY");
    now += 20; const lock = acquireOwnedLock(file, { now: () => now, staleMs: 10, pid: 7, isPidAlive: () => false }); lock.release();
    fs.writeFileSync(file, JSON.stringify({ version: 1, token: "live", pid: 7, operation: "x", acquired_at: new Date(0).toISOString(), refreshed_at: new Date(0).toISOString(), lease_until: new Date(1).toISOString() }));
    assert.throws(() => acquireOwnedLock(file, { now: () => 1000, isPidAlive: () => true }), (error) => (error as NodeJS.ErrnoException).code === "LOCK_BUSY");
  });

  it("keeps a valid dead-PID owner busy until its lease expires", () => {
    const file = fixture(); let now = Date.now();
    const owner = { version: 1, token: "dead", pid: 999999, operation: "x", acquired_at: new Date(now).toISOString(), refreshed_at: new Date(now).toISOString(), lease_until: new Date(now + 20).toISOString() };
    fs.writeFileSync(file, JSON.stringify(owner));
    assert.throws(() => acquireOwnedLock(file, { now: () => now + 10, isPidAlive: () => false }), (e) => (e as NodeJS.ErrnoException).code === "LOCK_BUSY");
    now += 30; const lock = acquireOwnedLock(file, { now: () => now, isPidAlive: () => false }); assert.equal(lock.owner.pid, process.pid); lock.release();
  });

  it("refreshes lease and sync wrappers clean up on success and throw", () => {
    const file = fixture(); let now = 0;
    const lock = acquireOwnedLock(file, { now: () => now, leaseMs: 10, pid: 1, isPidAlive: () => true });
    now = 9; assert.equal(lock.refresh(), true); assert.equal(Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).lease_until), 19); lock.release();
    withOwnedLock(file, () => 1); assert.equal(fs.existsSync(file), false);
    assert.throws(() => withOwnedLock(file, () => { throw new Error("x"); }), /x/); assert.equal(fs.existsSync(file), false);
  });

  it("rejects refresh when pathname is replaced during its precheck", () => {
    const file = fixture(); let now = Date.now(); let raced = false; let initialized = false;
    const lock = acquireOwnedLock(file, { now: () => {
      if (initialized && !raced) { raced = true; fs.unlinkSync(file); fs.writeFileSync(file, JSON.stringify({ version: 1, token: "new", pid: process.pid, operation: "replacement", acquired_at: new Date(now).toISOString(), refreshed_at: new Date(now).toISOString(), lease_until: new Date(now + 1000).toISOString() })); }
      initialized = true;
      return now;
    }, pid: process.pid });
    assert.equal(lock.refresh(), false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, "new");
    lock.release();
    assert.equal(fs.existsSync(file), true);
  });

  it("does not reclaim a replacement introduced during stale recheck", () => {
    const file = fixture(); const now = Date.now();
    const stale = { version: 1, token: "old", pid: 999999, operation: "old", acquired_at: new Date(now - 100).toISOString(), refreshed_at: new Date(now - 100).toISOString(), lease_until: new Date(now - 10).toISOString() };
    fs.writeFileSync(file, JSON.stringify(stale)); let checks = 0;
    assert.throws(() => acquireOwnedLock(file, { now: () => now, isPidAlive: () => { checks += 1; if (checks === 2) { fs.unlinkSync(file); fs.writeFileSync(file, JSON.stringify({ ...stale, token: "new", lease_until: new Date(now + 1000).toISOString() })); } return false; } }), (e) => (e as NodeJS.ErrnoException).code === "LOCK_BUSY");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, "new");
  });

  it("async wrappers release on resolve and reject", async () => {
    const file = fixture();
    assert.equal(await withOwnedLockAsync(file, async () => "ok", { leaseMs: 8, refreshIntervalMs: 1 }), "ok");
    assert.equal(fs.existsSync(file), false);
    await assert.rejects(withOwnedLockAsync(file, async () => { throw new Error("reject"); }, { leaseMs: 8, refreshIntervalMs: 1 }), /reject/);
    assert.equal(fs.existsSync(file), false);
  });

  it("runs an actual timer refresh and extends the lease", async () => {
    const file = fixture();
    let initial = 0; let refreshed = 0;
    await withOwnedLockAsync(file, async () => {
      initial = Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).lease_until);
      await new Promise((resolve) => setTimeout(resolve, 18));
      refreshed = Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).lease_until);
    }, { leaseMs: 20, refreshIntervalMs: 3 });
    assert.equal(fs.existsSync(file), false);
    assert.ok(refreshed > initial);
  });
});
