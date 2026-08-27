import { GitSafetyError } from "./git-safety-process.js";
import crypto from "node:crypto";

export const CE_FSMONITOR_VALID = 0x80000000;

export interface GitIndexControlRecord {
  /** The pathname bytes exactly as emitted by Git, without the terminating NUL. */
  pathname: Buffer;
  /** The complete unsigned 32-bit value emitted by Git. */
  rawFlags: number;
  /** rawFlags with only CE_FSMONITOR_VALID cleared. */
  maskedFlags: number;
}

/** Stable wire-format identifier for index-control fingerprints. */
export const GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM = "git-index-control-framed-sha256-v2";
const FINGERPRINT_DOMAIN = Buffer.from(`${GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM}\0`, "ascii");
const FINGERPRINT_TERMINAL = Buffer.from("git-index-control-entry-count\0", "ascii");

export interface GitIndexControlFingerprint {
  algorithm: typeof GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM;
  checksum: string;
  entryCount: number;
}

/**
 * Hash parser records in their emitted order.  The framing is deliberately
 * binary: pathname lengths and flags are fixed-width big-endian integers,
 * while a terminal marker and count make empty and concatenated streams
 * unambiguous.  No pathname decoding, sorting, or deduplication is done.
 */
export function fingerprintGitIndexControlRecords(
  records: Iterable<Pick<GitIndexControlRecord, "pathname" | "maskedFlags">>,
): GitIndexControlFingerprint {
  const hash = crypto.createHash("sha256");
  hash.update(FINGERPRINT_DOMAIN);
  let entryCount = 0;
  for (const record of records) {
    if (!Buffer.isBuffer(record.pathname)) throw new TypeError("pathname must be a Buffer");
    if (record.pathname.length > 0xffffffff) throw new RangeError("pathname exceeds uint32 length");
    if (!Number.isInteger(record.maskedFlags)
      || record.maskedFlags < 0
      || record.maskedFlags > 0xffffffff) {
      throw new RangeError("maskedFlags must be an unsigned 32-bit integer");
    }
    if (!Number.isSafeInteger(entryCount) || entryCount >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("entry count exceeds safe integer range");
    }
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(record.pathname.length, 0);
    const flags = Buffer.allocUnsafe(4);
    flags.writeUInt32BE(record.maskedFlags, 0);
    hash.update(length);
    hash.update(record.pathname);
    hash.update(flags);
    entryCount += 1;
  }
  const count = Buffer.allocUnsafe(8);
  count.writeBigUInt64BE(BigInt(entryCount), 0);
  hash.update(FINGERPRINT_TERMINAL);
  hash.update(count);
  return { algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM, checksum: hash.digest("hex"), entryCount };
}

/**
 * Incrementally hash `ls-files --debug -z` records without retaining the
 * complete index.  The parser still owns one pathname/debug record at a time;
 * the digest state is the only additional memory held by this consumer.
 */
export async function consumeGitIndexControlV2(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<GitIndexControlFingerprint> {
  const hash = crypto.createHash("sha256");
  hash.update(FINGERPRINT_DOMAIN);
  let entryCount = 0;
  const parser = new GitIndexControlParser(async (record) => {
    if (record.pathname.length > 0xffffffff) throw new RangeError("pathname exceeds uint32 length");
    if (entryCount >= Number.MAX_SAFE_INTEGER) throw new RangeError("entry count exceeds safe integer range");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(record.pathname.length, 0);
    const flags = Buffer.allocUnsafe(4);
    flags.writeUInt32BE(record.maskedFlags, 0);
    hash.update(length);
    hash.update(record.pathname);
    hash.update(flags);
    entryCount += 1;
  });
  for await (const chunk of chunks) await parser.push(chunk);
  await parser.finish();
  const count = Buffer.allocUnsafe(8);
  count.writeBigUInt64BE(BigInt(entryCount), 0);
  hash.update(FINGERPRINT_TERMINAL);
  hash.update(count);
  return { algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM, checksum: hash.digest("hex"), entryCount };
}

export type GitIndexControlRecordCallback = (
  record: GitIndexControlRecord,
) => void | Promise<void>;

type ParserState = "pathname" | "debug-line" | "complete";

const COMMAND = "git ls-files --debug -z";
const FLAGS_MARKER = Buffer.from("flags:", "ascii");

function malformed(message: string): GitSafetyError {
  return new GitSafetyError({
    code: "GIT_SAFETY_STREAM_MALFORMED",
    command: COMMAND,
    message: `Malformed ${COMMAND} stream: ${message}`,
  });
}

function isHorizontalWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09;
}

function isHexDigit(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x46)
    || (byte >= 0x61 && byte <= 0x66);
}

/**
 * Parse the terminal flags field from one ASCII debug line.
 *
 * Git currently emits it after another field on the same line, for example
 * `  size: 0\tflags: 0`. Unknown lines without an independent `flags:` field
 * remain forward-compatible and return undefined.
 */
function parseFlagsLine(line: Buffer): number | undefined {
  const markers: number[] = [];
  for (let offset = 0; offset <= line.length - FLAGS_MARKER.length;) {
    const index = line.indexOf(FLAGS_MARKER, offset);
    if (index < 0) break;
    if (index === 0 || isHorizontalWhitespace(line[index - 1])) markers.push(index);
    offset = index + FLAGS_MARKER.length;
  }

  if (markers.length === 0) return undefined;
  if (markers.length !== 1) throw malformed("debug line contains duplicate flags fields");

  let cursor = markers[0] + FLAGS_MARKER.length;
  while (cursor < line.length && isHorizontalWhitespace(line[cursor])) cursor += 1;
  if (cursor === line.length) throw malformed("flags field is empty");

  const valueStart = cursor;
  while (cursor < line.length && isHexDigit(line[cursor])) cursor += 1;
  const digitCount = cursor - valueStart;
  if (digitCount === 0) throw malformed("flags field is not hexadecimal");
  if (digitCount > 8) throw malformed("flags field exceeds unsigned 32-bit width");

  const valueEnd = cursor;
  while (cursor < line.length && isHorizontalWhitespace(line[cursor])) cursor += 1;
  if (cursor !== line.length) throw malformed("flags field has invalid trailing bytes");

  return Number.parseInt(line.toString("ascii", valueStart, valueEnd), 16) >>> 0;
}

/**
 * Incremental parser for the byte-oriented output of `git ls-files --debug -z`.
 * It retains at most one pathname and one debug line, and never decodes paths.
 */
export class GitIndexControlParser {
  private state: ParserState = "pathname";
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private pathname: Buffer | undefined;

  constructor(private readonly onRecord: GitIndexControlRecordCallback) {}

  private append(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.pending.push(bytes);
    this.pendingLength += bytes.length;
  }

  private takePending(): Buffer {
    const value = this.pendingLength === 0
      ? Buffer.alloc(0)
      : Buffer.concat(this.pending, this.pendingLength);
    this.pending = [];
    this.pendingLength = 0;
    return value;
  }

  private async finishDebugLine(): Promise<void> {
    const line = this.takePending();
    const rawFlags = parseFlagsLine(line);
    if (rawFlags === undefined) return;

    const pathname = this.pathname;
    if (!pathname) throw malformed("flags field has no pathname");
    await this.onRecord({
      pathname,
      rawFlags,
      maskedFlags: (rawFlags & ~CE_FSMONITOR_VALID) >>> 0,
    });
    this.pathname = undefined;
    this.state = "pathname";
  }

  async push(chunk: Uint8Array): Promise<void> {
    if (this.state === "complete") throw malformed("bytes arrived after EOF");
    if (chunk.byteLength === 0) return;

    // Own the bytes retained across awaits or future chunks. Callers may reuse
    // or mutate their Uint8Array as soon as push() settles.
    const bytes = Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      if (this.state === "pathname") {
        const delimiter = bytes.indexOf(0, offset);
        if (delimiter < 0) {
          this.append(bytes.subarray(offset));
          return;
        }
        this.append(bytes.subarray(offset, delimiter));
        const pathname = this.takePending();
        if (pathname.length === 0) throw malformed("pathname is empty");
        this.pathname = pathname;
        this.state = "debug-line";
        offset = delimiter + 1;
        continue;
      }

      let delimiter = offset;
      while (delimiter < bytes.length && bytes[delimiter] !== 0x0a) {
        const byte = bytes[delimiter];
        if (byte === 0x00) throw malformed("NUL encountered in debug state before flags");
        if (byte > 0x7f) throw malformed("debug line contains a non-ASCII byte");
        delimiter += 1;
      }
      this.append(bytes.subarray(offset, delimiter));
      if (delimiter === bytes.length) return;
      offset = delimiter + 1;
      await this.finishDebugLine();
    }
  }

  async finish(): Promise<void> {
    if (this.state === "complete") throw malformed("stream was already finished");
    const previousState = this.state;
    this.state = "complete";
    if (previousState === "pathname" && this.pendingLength === 0) return;
    if (previousState === "pathname") throw malformed("pathname is truncated at EOF");
    if (this.pendingLength !== 0) throw malformed("debug line is truncated at EOF");
    throw malformed("entry is missing its terminal flags field");
  }
}

export function createGitIndexControlParser(
  onRecord: GitIndexControlRecordCallback,
): GitIndexControlParser {
  return new GitIndexControlParser(onRecord);
}

export async function consumeGitIndexControl(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  onRecord: GitIndexControlRecordCallback,
): Promise<void> {
  const parser = createGitIndexControlParser(onRecord);
  for await (const chunk of chunks) await parser.push(chunk);
  await parser.finish();
}

// Names tied to the Git command make the parser easy to discover at callers.
