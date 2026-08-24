import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPLY_WRITE_CONFLICT,
  findBatchWriteConflicts,
  findInFlightWriteConflicts,
  scopesConflict,
  scopesOverlap,
  type InFlightTicket,
} from "../src/lib/apply-batch.js";

describe("apply-batch write-set intersection", () => {
  it("exports APPLY_WRITE_CONFLICT for callers", () => {
    assert.equal(APPLY_WRITE_CONFLICT, "APPLY_WRITE_CONFLICT");
  });

  it("identical write paths conflict", () => {
    assert.equal(scopesOverlap(["a.ts"], ["a.ts"]), true);
    assert.equal(
      scopesConflict(
        { mode: "write", write_paths: ["a.ts"] },
        { mode: "write", write_paths: ["a.ts"] },
      ),
      true,
    );
    assert.deepEqual(
      findBatchWriteConflicts({
        "1.1": { mode: "write", write_paths: ["a.ts"] },
        "1.4": { mode: "write", write_paths: ["a.ts"] },
      }),
      [{ a: "1.1", b: "1.4" }],
    );
  });

  it("disjoint writes do not conflict", () => {
    assert.equal(scopesOverlap(["a.ts"], ["b.ts"]), false);
    assert.deepEqual(
      findBatchWriteConflicts({
        "1.1": { mode: "write", write_paths: ["a.ts"] },
        "1.2": { mode: "write", write_paths: ["b.ts"] },
      }),
      [],
    );
  });

  it("detects glob/prefix overlap via pathAllowed", () => {
    assert.equal(scopesOverlap(["src/lib/"], ["src/lib/apply.ts"]), true);
    assert.equal(scopesOverlap(["src/lib/apply.ts"], ["src/lib/"]), true);
    assert.equal(
      scopesConflict(
        { mode: "write", write_paths: ["src/lib/"] },
        { mode: "write", write_paths: ["src/lib/apply.ts"] },
      ),
      true,
    );
  });

  it("two read-only scopes with the same path do not conflict", () => {
    assert.equal(
      scopesConflict(
        { mode: "read-only", write_paths: ["a.ts"] },
        { mode: "read-only", write_paths: ["a.ts"] },
      ),
      false,
    );
    assert.deepEqual(
      findBatchWriteConflicts({
        "1.1": { mode: "read-only", write_paths: ["a.ts"] },
        "1.2": { mode: "read-only", write_paths: ["a.ts"] },
      }),
      [],
    );
  });

  it("write vs read-only overlapping paths conflict", () => {
    assert.equal(
      scopesConflict(
        { mode: "write", write_paths: ["a.ts"] },
        { mode: "read-only", write_paths: ["a.ts"] },
      ),
      true,
    );
    assert.deepEqual(
      findBatchWriteConflicts({
        "1.1": { mode: "write", write_paths: ["a.ts"] },
        "1.2": { mode: "read-only", write_paths: ["a.ts"] },
      }),
      [{ a: "1.1", b: "1.2" }],
    );
  });

  it("empty read-only does not conflict with a writer", () => {
    assert.equal(scopesOverlap([], ["a.ts"]), false);
    assert.equal(
      scopesConflict(
        { mode: "read-only", write_paths: [] },
        { mode: "write", write_paths: ["a.ts"] },
      ),
      false,
    );
    assert.deepEqual(
      findBatchWriteConflicts({
        "1.1": { mode: "write", write_paths: ["a.ts"] },
        "1.2": { mode: "read-only", write_paths: [] },
      }),
      [],
    );
  });

  it("hint-style different files do not conflict", () => {
    assert.deepEqual(
      findBatchWriteConflicts({
        "1.1": { mode: "write", write_paths: ["a.ts"] },
        "1.2": { mode: "write", write_paths: ["b.ts"] },
      }),
      [],
    );
  });

  it("in-flight running writer of a.ts blocks a later unit writing a.ts", () => {
    const scopes = {
      "1.4": { mode: "write" as const, write_paths: ["a.ts"] },
    };
    const inflight: InFlightTicket[] = [
      {
        id: "t-running",
        status: "running",
        mode: "write",
        read_only: false,
        write_allowlist: ["a.ts"],
      },
    ];
    assert.deepEqual(findInFlightWriteConflicts(scopes, inflight), [
      { unit: "1.4", ticket_id: "t-running" },
    ]);
  });

  it("in-flight queued and completed tickets are ignored", () => {
    const scopes = {
      "1.4": { mode: "write" as const, write_paths: ["a.ts"] },
    };
    const inflight: InFlightTicket[] = [
      {
        id: "t-queued",
        status: "queued",
        mode: "write",
        read_only: false,
        write_allowlist: ["a.ts"],
      },
      {
        id: "t-done",
        status: "completed",
        mode: "write",
        read_only: false,
        write_allowlist: ["a.ts"],
      },
    ];
    assert.deepEqual(findInFlightWriteConflicts(scopes, inflight), []);
  });

  it("read-only in-flight with empty allowlist does not conflict", () => {
    const scopes = {
      "1.1": { mode: "write" as const, write_paths: ["a.ts"] },
    };
    const inflight: InFlightTicket[] = [
      {
        id: "t-ro",
        status: "running",
        mode: "read-only",
        read_only: true,
        write_allowlist: [],
      },
    ];
    assert.deepEqual(findInFlightWriteConflicts(scopes, inflight), []);
  });

  it("treats reserved status as live when present", () => {
    const scopes = {
      "1.1": { mode: "write" as const, write_paths: ["a.ts"] },
    };
    const inflight: InFlightTicket[] = [
      {
        id: "t-reserved",
        status: "reserved",
        mode: "write",
        write_allowlist: ["a.ts"],
      },
    ];
    assert.deepEqual(findInFlightWriteConflicts(scopes, inflight), [
      { unit: "1.1", ticket_id: "t-reserved" },
    ]);
  });
});
