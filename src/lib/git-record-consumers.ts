import { GitSafetyError } from "./git-safety-process.js";
import crypto from "node:crypto";

export interface StatusRecord {
  code: string;
  path: string;
  original_path?: string;
}

export interface ReflogSummary {
  count: number;
  checksum: string;
}

export type RecordCallback = (record: Buffer) => void | Promise<void>;

export interface IncrementalRecordConsumer {
  /** Feed an arbitrary byte chunk. The chunk is not retained by the consumer. */
  push(chunk: Uint8Array): Promise<void>;
  /** Finish the stream; EOF is valid only immediately after a delimiter. */
  finish(): Promise<void>;
}

function malformed(kind: "NUL" | "line"): GitSafetyError {
  return new GitSafetyError({
    code: "GIT_SAFETY_STREAM_MALFORMED",
    command: `${kind} record stream`,
    message: `Malformed ${kind} record stream: unterminated record`,
  });
}

/**
 * Incrementally consumes NUL-delimited byte records without decoding them.
 * Empty input and a trailing delimiter are valid; an unterminated final
 * record is rejected at finish().
 */
export class NulRecordConsumer implements IncrementalRecordConsumer {
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private ended = false;

  constructor(private readonly onRecord: RecordCallback) {}

  async push(chunk: Uint8Array): Promise<void> {
    if (this.ended) throw malformed("NUL");
    if (chunk.byteLength === 0) return;
    const bytes = Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const delimiter = bytes.indexOf(0, start);
      if (delimiter < 0) {
        if (start < bytes.length) {
          this.pending.push(bytes.subarray(start));
          this.pendingLength += bytes.length - start;
        }
        return;
      }
      const current = bytes.subarray(start, delimiter);
      const record = this.pendingLength === 0
        ? current
        : Buffer.concat([...this.pending, current], this.pendingLength + current.length);
      this.pending = [];
      this.pendingLength = 0;
      await this.onRecord(record);
      start = delimiter + 1;
      if (start === bytes.length) return;
    }
  }

  async finish(): Promise<void> {
    if (this.ended) throw malformed("NUL");
    this.ended = true;
    if (this.pendingLength !== 0) throw malformed("NUL");
  }
}

/** Incrementally consumes LF-delimited byte records, preserving bytes. */
export class LineRecordConsumer implements IncrementalRecordConsumer {
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private ended = false;

  constructor(private readonly onRecord: RecordCallback, private readonly stripCarriageReturn = false) {}

  async push(chunk: Uint8Array): Promise<void> {
    if (this.ended) throw malformed("line");
    if (chunk.byteLength === 0) return;
    const bytes = Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const delimiter = bytes.indexOf(10, start);
      if (delimiter < 0) {
        if (start < bytes.length) {
          this.pending.push(bytes.subarray(start));
          this.pendingLength += bytes.length - start;
        }
        return;
      }
      const current = bytes.subarray(start, delimiter);
      let record = this.pendingLength === 0
        ? current
        : Buffer.concat([...this.pending, current], this.pendingLength + current.length);
      if (this.stripCarriageReturn && record.at(-1) === 13) record = record.subarray(0, record.length - 1);
      this.pending = [];
      this.pendingLength = 0;
      await this.onRecord(record);
      start = delimiter + 1;
      if (start === bytes.length) return;
    }
  }

  async finish(): Promise<void> {
    if (this.ended) throw malformed("line");
    this.ended = true;
    if (this.pendingLength !== 0) throw malformed("line");
  }
}

export function createNulRecordConsumer(onRecord: RecordCallback): NulRecordConsumer {
  return new NulRecordConsumer(onRecord);
}

export function createLineRecordConsumer(onRecord: RecordCallback, stripCarriageReturn = false): LineRecordConsumer {
  return new LineRecordConsumer(onRecord, stripCarriageReturn);
}

export async function consumeNulRecords(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, onRecord: RecordCallback): Promise<void> {
  const consumer = createNulRecordConsumer(onRecord);
  for await (const chunk of chunks) await consumer.push(chunk);
  await consumer.finish();
}

export async function consumeLineRecords(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, onRecord: RecordCallback, stripCarriageReturn = false): Promise<void> {
  const consumer = createLineRecordConsumer(onRecord, stripCarriageReturn);
  for await (const chunk of chunks) await consumer.push(chunk);
  await consumer.finish();
}

/** Consume `status --porcelain=v1 -z`, including the second token of R/C records. */
export async function consumePorcelainV1Z(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  onEntry?: (entry: StatusRecord) => void | Promise<void>,
): Promise<StatusRecord[]> {
  const entries: StatusRecord[] = [];
  let renameOriginal: string | undefined;
  await consumeNulRecords(chunks, async (record) => {
    const token = record.toString("utf8");
    if (renameOriginal !== undefined) {
      if (!token) throw new GitSafetyError({ code: "GIT_SAFETY_STREAM_MALFORMED", command: "git status --porcelain=v1 -z", message: "Rename/copy record is missing its original path" });
      const entry = { code: renameOriginal.slice(0, 2), path: renameOriginal.slice(3), original_path: token };
      // The primary record is retained while waiting for its original path.
      entries.push(entry);
      if (onEntry) await onEntry(entry);
      renameOriginal = undefined;
      return;
    }
    if (token.length < 4) throw new GitSafetyError({ code: "GIT_SAFETY_STREAM_MALFORMED", command: "git status --porcelain=v1 -z", message: "Invalid Git porcelain record" });
    const code = token.slice(0, 2);
    const entry: StatusRecord = { code, path: token.slice(3) };
    if (code.includes("R") || code.includes("C")) {
      renameOriginal = token;
      return;
    }
    entries.push(entry);
    if (onEntry) await onEntry(entry);
  });
  if (renameOriginal !== undefined) throw new GitSafetyError({ code: "GIT_SAFETY_STREAM_MALFORMED", command: "git status --porcelain=v1 -z", message: "Rename/copy record is missing its original path" });
  return entries;
}

const GIT_RESERVED_REF_NAMESPACES = new Set([
  "bisect",
  "heads",
  "notes",
  "remotes",
  "replace",
  "rewritten",
  "stash",
  "tags",
  "worktree",
]);
const RUNTIME_TURN_DIFF_REF = /^refs\/([^/]+)\/turn-diffs\//;

/**
 * Return whether a complete `for-each-ref` record belongs to a runtime's
 * private turn-diff namespace. Git's well-known ref namespaces stay audited,
 * even when a user happens to create a nested `turn-diffs` ref there.
 */
export function isRuntimeTurnDiffRef(value: string): boolean {
  const match = RUNTIME_TURN_DIFF_REF.exec(value);
  return match !== null && !GIT_RESERVED_REF_NAMESPACES.has(match[1]);
}

/** Consume `for-each-ref --format=%(refname)%00%(objectname)` compactly. */
export async function consumeRefRecords(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  excludedPrefix?: string,
): Promise<string[]> {
  const refs: string[] = [];
  await consumeLineRecords(chunks, (record) => {
    const value = record.toString("utf8");
    const excluded = excludedPrefix === undefined ? isRuntimeTurnDiffRef(value) : value.startsWith(excludedPrefix);
    if (value && !excluded) refs.push(value);
  });
  return refs;
}

/** Consume reflog lines while reproducing sha256(JSON.stringify(filteredLines)). */
export async function consumeReflogSummary(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<ReflogSummary> {
  const hash = crypto.createHash("sha256");
  hash.update("[");
  let count = 0;
  await consumeLineRecords(chunks, (record) => {
    const line = record.toString("utf8");
    if (!line) return;
    if (count > 0) hash.update(",");
    hash.update(JSON.stringify(line));
    count += 1;
  });
  hash.update("]");
  return { count, checksum: hash.digest("hex") };
}

/** Consume staged pathname records, retaining only the paths required by a Receipt. */
export async function consumeStagedPaths(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<string[]> {
  const paths: string[] = [];
  await consumeNulRecords(chunks, (record) => {
    const value = record.toString("utf8");
    if (value) paths.push(value);
  });
  return paths.sort();
}

/** Consume untracked pathname records and retain only whether any record exists. */
export async function consumeUntrackedExists(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<boolean> {
  let exists = false;
  await consumeNulRecords(chunks, (record) => { if (record.length > 0) exists = true; });
  return exists;
}

/** Consume `diff --summary` and retain only the existing mode-change paths. */
export async function consumeModeChangeSummary(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<Set<string>> {
  const paths = new Set<string>();
  await consumeLineRecords(chunks, (record) => {
    const match = record.toString("utf8").match(/^ mode change \d+ => \d+ (.+)$/);
    if (match) paths.add(match[1]);
  });
  return paths;
}
