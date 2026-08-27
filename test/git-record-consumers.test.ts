import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { describe, it } from "bun:test";
import {
  consumeLineRecords,
  consumeModeChangeSummary,
  consumeNulRecords,
  consumePorcelainV1Z,
  consumeRefRecords,
  consumeReflogSummary,
  consumeStagedPaths,
  consumeUntrackedExists,
  createLineRecordConsumer,
  createNulRecordConsumer,
} from "../src/lib/git-record-consumers.ts";
import { GitSafetyError } from "../src/lib/git-safety-process.ts";
import { parsePorcelainV1Z } from "../src/lib/safety.ts";

const bytes = (value: string) => Buffer.from(value, "utf8");

type Consumer = { push(chunk: Uint8Array): Promise<void>; finish(): Promise<void> };

async function collect(factory: (items: Buffer[]) => Consumer, source: Buffer, cuts: number[]): Promise<Buffer[]> {
  const items: Buffer[] = [];
  const consumer = factory(items);
  let offset = 0;
  for (const size of cuts) { await consumer.push(source.subarray(offset, offset + size)); offset += size; }
  await consumer.push(source.subarray(offset));
  await consumer.finish();
  return items;
}

function randomizedCuts(source: Buffer, seed: number): number[] {
  let state = seed;
  const chunks: number[] = [];
  for (let offset = 0; offset < source.length;) {
    state = (state * 1103515245 + 12345) >>> 0;
    const size = 1 + (state % 11);
    chunks.push(size);
    offset += size;
  }
  return chunks;
}

function deterministicSplits(source: Buffer): Buffer[][] {
  const splits = [Array(source.length).fill(1) as number[]];
  for (let seed = 1; seed <= 20; seed += 1) splits.push(randomizedCuts(source, seed));
  return splits.map((cuts) => {
    const chunks: Buffer[] = [];
    let offset = 0;
    for (const size of cuts) {
      chunks.push(source.subarray(offset, offset + size));
      offset += size;
    }
    return chunks;
  });
}

async function forEachSplit(source: Buffer, consume: (chunks: Buffer[]) => Promise<void>): Promise<void> {
  for (const chunks of deterministicSplits(source)) await consume(chunks);
}

describe("incremental Git record consumers", () => {
  it("consumes NUL records across every one-byte boundary", async () => {
    const source = Buffer.from([0x61, 0x00, 0x62, 0x0a, 0x00, 0xff, 0x00]);
    const result = await collect((items) => createNulRecordConsumer((record) => { items.push(record); }), source, Array(source.length).fill(1));
    assert.deepEqual(result.map((item) => [...item]), [[0x61], [0x62, 0x0a], [0xff]]);
    const empty: string[] = [];
    await consumeNulRecords([bytes("a\0\0")], (record) => { empty.push(record.toString()); });
    assert.deepEqual(empty, ["a", ""]);
  });

  it("consumes line records across every one-byte boundary", async () => {
    const source = Buffer.from([0x61, 0x0a, 0x62, 0x0d, 0x0a, 0xff, 0x0a]);
    const result = await collect((items) => createLineRecordConsumer((record) => { items.push(record); }), source, Array(source.length).fill(1));
    assert.deepEqual(result.map((item) => [...item]), [[0x61], [0x62, 0x0d], [0xff]]);
  });

  it("handles empty streams and trailing delimiters", async () => {
    const nul: Buffer[] = [];
    await consumeNulRecords([], (record) => { nul.push(record); });
    assert.deepEqual(nul, []);
    const lines: Buffer[] = [];
    await consumeLineRecords([], (record) => { lines.push(record); });
    assert.deepEqual(lines, []);
    await consumeLineRecords([bytes("a\n\n")], (record) => { lines.push(record); });
    assert.deepEqual(lines.map((item) => item.toString()), ["a", ""]);
  });

  it("handles randomized chunk boundaries identically", async () => {
    const source = bytes("first\0second\0third\0");
    const expected = ["first", "second", "third"];
    for (let seed = 1; seed < 30; seed++) {
      let state = seed;
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < source.length;) {
        state = (state * 1103515245 + 12345) >>> 0;
        const size = 1 + (state % 7);
        chunks.push(source.subarray(offset, offset + size)); offset += size;
      }
      const actual: string[] = [];
      await consumeNulRecords(chunks, (record) => { actual.push(record.toString()); });
      assert.deepEqual(actual, expected);
    }
  });

  it("handles randomized line chunk boundaries identically", async () => {
    const source = bytes("first\nsecond\r\nthird\n");
    const expected = ["first", "second\r", "third"];
    for (let seed = 1; seed < 30; seed++) {
      let state = seed;
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < source.length;) {
        state = (state * 1103515245 + 12345) >>> 0;
        const size = 1 + (state % 7);
        chunks.push(source.subarray(offset, offset + size)); offset += size;
      }
      const actual: string[] = [];
      await consumeLineRecords(chunks, (record) => { actual.push(record.toString()); });
      assert.deepEqual(actual, expected);
    }
  });

  it("matches complete porcelain parsing for ordinary, rename, and copy records", async () => {
    const source = bytes(" M ordinary.txt\0R  renamed.txt\0original.txt\0C  copied.txt\0source.txt\0");
    const expected = parsePorcelainV1Z(source.toString("utf8"));
    await forEachSplit(source, async (chunks) => {
      assert.deepEqual(await consumePorcelainV1Z(chunks), expected);
    });
  });

  it("fails closed for short and incomplete rename/copy porcelain records", async () => {
    for (const source of [bytes("R  new.txt\0"), bytes("C  new.txt\0"), bytes("R"), bytes("C ")]) {
      await forEachSplit(source, async (chunks) => {
        await assert.rejects(
          consumePorcelainV1Z(chunks),
          (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_SAFETY_STREAM_MALFORMED",
        );
      });
    }
  });

  it("matches refs filtering while excluding only the internal namespace", async () => {
    const source = bytes(
      "refs/heads/main\0abc123\n"
      + "refs/codex/turn-diffs/turn-1\0def456\n"
      + "refs/tags/release\0fedcba\n"
      + "refs/codex/turn-diffs-extra/keep\0123456\n",
    );
    const expected = source.toString("utf8").split("\n").filter(Boolean).filter((entry) => !entry.startsWith("refs/codex/turn-diffs/"));
    await forEachSplit(source, async (chunks) => {
      assert.deepEqual(await consumeRefRecords(chunks), expected);
    });
  });

  it("matches exact reflog count and JSON-array SHA-256 checksum", async () => {
    const source = bytes("head\0commit one\n\nnext\0commit two\nfinal\0commit three\n");
    const lines = source.toString("utf8").split("\n").filter(Boolean);
    const expected = crypto.createHash("sha256").update(JSON.stringify(lines)).digest("hex");
    await forEachSplit(source, async (chunks) => {
      assert.deepEqual(await consumeReflogSummary(chunks), { count: lines.length, checksum: expected });
    });
  });

  it("matches staged path filter and sort", async () => {
    const source = bytes("zeta file\0alpha\0dir/file\0alpha\0\0");
    const expected = source.toString("utf8").split("\0").filter(Boolean).sort();
    await forEachSplit(source, async (chunks) => {
      assert.deepEqual(await consumeStagedPaths(chunks), expected);
    });
  });

  it("returns untracked existence while consuming every chunk", async () => {
    const source = bytes("first\0\0second\0third\0");
    const expected = Boolean(source.toString("utf8").split("\0").filter(Boolean).length);
    await forEachSplit(source, async (chunks) => {
      let consumed = 0;
      const wrapped = (async function* () {
        for (const chunk of chunks) {
          consumed += chunk.length;
          yield chunk;
        }
      })();
      assert.equal(await consumeUntrackedExists(wrapped), expected);
      assert.equal(consumed, source.length);
    });
  });

  it("matches mode-change summary regex and ignores other diff-summary lines", async () => {
    const source = bytes(
      " mode change 100644 => 100755 executable.sh\n"
      + " create mode 100644 new.txt\n"
      + " mode change 100755 => 100644 path with spaces\n"
      + " mode change nope => 100644 ignored\n",
    );
    const expected = new Set(source.toString("utf8").split("\n").map((line) => line.match(/^ mode change \d+ => \d+ (.+)$/)?.[1]).filter((item): item is string => Boolean(item)));
    await forEachSplit(source, async (chunks) => {
      assert.deepEqual(await consumeModeChangeSummary(chunks), expected);
    });
  });

  it("supports CRLF normalization for line records while preserving default bytes", async () => {
    const normalized: string[] = [];
    await consumeLineRecords([bytes("a\r"), bytes("\nb\n")], (record) => { normalized.push(record.toString()); }, true);
    assert.deepEqual(normalized, ["a", "b"]);
    const raw: string[] = [];
    await consumeLineRecords([bytes("a\r\n")], (record) => { raw.push(record.toString()); });
    assert.deepEqual(raw, ["a\r"]);
  });

  it("rejects malformed unterminated records and writes after EOF", async () => {
    for (const consumer of [createNulRecordConsumer(() => {}), createLineRecordConsumer(() => {})]) {
      await consumer.push(bytes("partial"));
      await assert.rejects(consumer.finish(), (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_SAFETY_STREAM_MALFORMED");
      await assert.rejects(consumer.push(bytes("x")), (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_SAFETY_STREAM_MALFORMED");
    }
  });
});
