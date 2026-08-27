import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, it } from "bun:test";
import { collectGitSafetyFacts, streamGitSafetyFact } from "../src/lib/git-safety-facts.ts";
import { consumeNulRecords } from "../src/lib/git-record-consumers.ts";

function fakeSpawn(chunks: AsyncIterable<Buffer> | Iterable<Buffer>, state: { killed: boolean; produced: number; closed?: boolean; exitCode?: number }) {
  return (() => {
    const child = new EventEmitter() as any;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = Readable.from(chunks);
    child.stderr = Readable.from([]);
    child.kill = (signal: string) => {
      state.killed = true;
      child.signalCode = signal;
      queueMicrotask(() => { state.closed = true; child.emit("close", null, signal); });
      return true;
    };
    child.stdout.once("end", () => {
      if (!state.killed) { child.exitCode = state.exitCode ?? 0; state.closed = true; child.emit("close", child.exitCode, null); }
    });
    return child;
  }) as any;
}

describe("streamed Git safety facts", () => {
  it("collects every Receipt/verdict fact from real Git without aggregate output capture", async () => {
    const facts = await collectGitSafetyFacts(process.cwd());
    assert.match(facts.head, /^[0-9a-f]{40}$/);
    assert.match(facts.branchRef, /^refs\/heads\//);
    assert.ok(Array.isArray(facts.refs));
    assert.ok(facts.reflog.count >= 1);
    assert.match(facts.reflog.checksum, /^[0-9a-f]{64}$/);
    assert.match(facts.stagedTree, /^[0-9a-f]{40}$/);
    assert.equal(facts.indexControl.algorithm, "git-index-control-framed-sha256-v2");
    assert.ok(facts.indexControl.entryCount >= 0);
  });

  it("retains the legacy index-control contract when explicitly selected", async () => {
    const facts = await collectGitSafetyFacts(process.cwd(), { legacyIndexControl: true });
    assert.equal(facts.indexControl.algorithm, "legacy-json-sorted-v1");
    assert.ok(facts.indexControl.entryCount >= 0);
  });

  it("does not let a producer outrun a blocked consumer", async () => {
    const state = { killed: false, produced: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const source = (async function* () {
      for (let i = 0; i < 200; i += 1) { state.produced += 1; yield Buffer.from(`item-${i}\0`); }
    })();
    const result = streamGitSafetyFact("/repo", ["status"], async (chunks) => {
      await gate;
      const values: string[] = [];
      await consumeNulRecords(chunks, (record) => { values.push(record.toString()); });
      return values;
    }, fakeSpawn(source, state));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(state.produced <= 2);
    release();
    assert.equal((await result).length, 200);
  });

  it("terminates and reaps when the incremental consumer fails", async () => {
    const state = { killed: false, produced: 0, closed: false };
    const source = (async function* () { state.produced += 1; yield Buffer.from("partial"); })();
    await assert.rejects(
      streamGitSafetyFact("/repo", ["status"], async (chunks) => {
        for await (const _ of chunks) throw new Error("consumer failed");
      }, fakeSpawn(source, state)),
      /consumer failed/,
    );
    assert.equal(state.killed, true);
    assert.equal(state.closed, true);
  });

  it("rejects truncated output and never returns partial facts", async () => {
    const state = { killed: false, produced: 0 };
    await assert.rejects(
      streamGitSafetyFact("/repo", ["status"], (chunks) => consumeNulRecords(chunks), fakeSpawn([Buffer.from("partial")], state)),
      /unterminated record/,
    );
  });

  it("rejects a nonzero child even when its stdout is complete", async () => {
    const state = { killed: false, produced: 0, exitCode: 1 };
    await assert.rejects(
      streamGitSafetyFact("/repo", ["status"], (chunks) => consumeNulRecords(chunks, () => {}), fakeSpawn([Buffer.from("ok\0")], state)),
      /Git safety command failed/,
    );
  });

  it("aborts and reaps a child when a consumer resolves before draining", async () => {
    const state = { killed: false, produced: 0, closed: false };
    const source = (async function* () { state.produced += 1; yield Buffer.from("first\0"); yield Buffer.from("later\0"); })();
    await assert.rejects(
      streamGitSafetyFact("/repo", ["status"], async () => [], fakeSpawn(source, state)),
      /ended before draining/,
    );
    assert.equal(state.killed, true);
    assert.equal(state.closed, true);
  });

  it("rejects unknown deserialized index algorithms instead of defaulting", async () => {
    await assert.rejects(
      collectGitSafetyFacts(process.cwd(), { indexControlAlgorithm: "unknown-algorithm" as any }),
      /Unsupported index control algorithm/,
    );
  });
});
