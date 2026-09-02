import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import {
  CE_FSMONITOR_VALID,
  consumeGitIndexControl,
  createGitIndexControlParser,
  fingerprintGitIndexControlRecords,
  GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
  type GitIndexControlRecord,
} from "../src/lib/git/index-control.ts";
import crypto from "node:crypto";
import { GitSafetyError } from "../src/lib/git/safety-process.ts";

const ascii = (value: string): Buffer => Buffer.from(value, "ascii");

function referenceFingerprint(records: Array<{ pathname: Buffer; maskedFlags: number }>): string {
  const chunks: Buffer[] = [Buffer.from(`${GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM}\0`, "ascii")];
  for (const record of records) {
    const length = Buffer.alloc(4); length.writeUInt32BE(record.pathname.length);
    const flags = Buffer.alloc(4); flags.writeUInt32BE(record.maskedFlags >>> 0);
    chunks.push(length, record.pathname, flags);
  }
  const terminal = Buffer.from("git-index-control-entry-count\0", "ascii");
  const count = Buffer.alloc(8); count.writeBigUInt64BE(BigInt(records.length));
  chunks.push(terminal, count);
  return crypto.createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}

function oneByteChunks(source: Buffer): Buffer[] {
  return Array.from({ length: source.length }, (_, index) => source.subarray(index, index + 1));
}

function everyTwoPartSplit(source: Buffer): Buffer[][] {
  return Array.from({ length: source.length + 1 }, (_, split) => [
    source.subarray(0, split),
    source.subarray(split),
  ]);
}

async function parse(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<GitIndexControlRecord[]> {
  const records: GitIndexControlRecord[] = [];
  await consumeGitIndexControl(chunks, (record) => { records.push(record); });
  return records;
}

async function rejectsMalformed(source: Buffer): Promise<void> {
  await assert.rejects(
    parse(oneByteChunks(source)),
    (error: unknown) => error instanceof GitSafetyError
      && error.code === "GIT_SAFETY_STREAM_MALFORMED"
      && error.command === "git ls-files --debug -z",
  );
}

async function rejectsMalformedChunks(chunks: Iterable<Uint8Array>): Promise<void> {
  await assert.rejects(
    parse(chunks),
    (error: unknown) => error instanceof GitSafetyError
      && error.code === "GIT_SAFETY_STREAM_MALFORMED"
      && error.command === "git ls-files --debug -z",
  );
}

describe("git ls-files --debug -z parser", () => {
  it("keeps source-built Node and Bun fingerprints and verdicts identical", async () => {
    // Compile this checkout into an isolated temporary module tree. This is
    // deliberately fresh per test: neither child can accidentally use stale
    // dist output, and the Node loader needs no undeclared tsx dependency.
    const build = fs.mkdtempSync(path.join(os.tmpdir(), "baton-parity-build-"));
    fs.writeFileSync(path.join(build, "package.json"), '{"type":"module"}\n');
    const compile = spawnSync(path.join(process.cwd(), "node_modules/.bin/tsc"), ["-p", "tsconfig.json", "--outDir", build, "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"], {
      cwd: process.cwd(), encoding: "utf8", env: process.env,
    });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const script = (modulePath: string) => `
      import { captureBaselineAsync, auditWorktreeAsync } from ${JSON.stringify(modulePath)};
      const baseline = await captureBaselineAsync(process.cwd());
      const verdict = await auditWorktreeAsync(process.cwd(), baseline, { write_allowlist: [], allowed_operations: [] });
      process.stdout.write(JSON.stringify({
        runtime: process.versions.bun ? 'bun' : 'node',
        fingerprint: { algorithm: baseline.index_control_algorithm, checksum: baseline.index_control_checksum, entryCount: baseline.index_control_entry_count },
        verdict: { accepted: verdict.accepted, violations: verdict.violations.map((item) => item.code) },
      }));
    `;
    const run = (runtime: string, args: string[]): unknown => {
      const result = spawnSync(runtime, args, { cwd: process.cwd(), encoding: "utf8", env: process.env });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const node = run(process.env.BATON_TEST_NODE || "node", ["--input-type=module", "-e", script(path.join(build, "src/lib/safety.js"))]);
    const bun = run("bun", ["-e", script(path.join(process.cwd(), "src/lib/safety.ts"))]);
    assert.equal((node as any).runtime, "node");
    assert.equal((bun as any).runtime, "bun");
    const comparable = (result: any) => ({ fingerprint: result.fingerprint, verdict: result.verdict });
    assert.deepEqual(comparable(node), comparable(bun));
    assert.deepEqual((node as any).fingerprint, {
      algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
      checksum: (node as any).fingerprint.checksum,
      entryCount: (node as any).fingerprint.entryCount,
    });
    assert.deepEqual((node as any).verdict.violations, []);
  });

  it("frames empty and ordered multi-stage records deterministically", () => {
    const records = [
      { pathname: Buffer.from([0xff, 0x00, 0x61]), maskedFlags: 0x00000002 },
      { pathname: Buffer.from("same", "ascii"), maskedFlags: 0x00000003 },
      { pathname: Buffer.from("same", "ascii"), maskedFlags: 0x00000004 },
    ];
    assert.deepEqual(fingerprintGitIndexControlRecords([]), {
      algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
      checksum: referenceFingerprint([]), entryCount: 0,
    });
    assert.deepEqual(fingerprintGitIndexControlRecords(records), {
      algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
      checksum: referenceFingerprint(records), entryCount: 3,
    });
    assert.notEqual(
      fingerprintGitIndexControlRecords(records).checksum,
      fingerprintGitIndexControlRecords([...records].reverse()).checksum,
    );
  });

  it("is invariant under every structural two-part chunk split", async () => {
    const source = Buffer.concat([
      Buffer.from([0x73, 0x70, 0x20, 0x61, 0x09, 0x0a, 0xff]),
      ascii("\0  size: 0\tflags: 00000001\n"),
      Buffer.from([0x73, 0x61, 0x6d, 0x65]),
      ascii("\0  size: 0\tflags: 00001000\n"),
      Buffer.from([0x73, 0x61, 0x6d, 0x65]),
      ascii("\0  size: 0\tflags: 00002000\n"),
      Buffer.from([0x73, 0x61, 0x6d, 0x65]),
      ascii("\0  size: 0\tflags: 00003000\n"),
    ]);
    const expected = await parse([source]);
    const expectedFingerprint = fingerprintGitIndexControlRecords(expected);
    for (const chunks of everyTwoPartSplit(source)) {
      const actual = await parse(chunks);
      assert.deepEqual(actual, expected);
      assert.deepEqual(fingerprintGitIndexControlRecords(actual), expectedFingerprint);
    }
    assert.deepEqual(expected.map((record) => record.pathname), [
      Buffer.from([0x73, 0x70, 0x20, 0x61, 0x09, 0x0a, 0xff]),
      Buffer.from("same", "ascii"),
      Buffer.from("same", "ascii"),
      Buffer.from("same", "ascii"),
    ]);
    assert.deepEqual(expected.map((record) => record.maskedFlags), [1, 0x1000, 0x2000, 0x3000]);
  });

  it("masks fsmonitor-only changes but preserves other flags", () => {
    const base = [{ pathname: Buffer.from("p"), maskedFlags: 0x12345678 }];
    assert.equal(
      fingerprintGitIndexControlRecords(base).checksum,
      fingerprintGitIndexControlRecords([{ pathname: Buffer.from("p"), maskedFlags: 0x12345678 }]).checksum,
    );
    assert.notEqual(
      fingerprintGitIndexControlRecords(base).checksum,
      fingerprintGitIndexControlRecords([{ pathname: Buffer.from("p"), maskedFlags: 0x12345679 }]).checksum,
    );
  });

  it("masks fsmonitor changes from parser rawFlags before fingerprinting", async () => {
    const parseFingerprint = async (rawFlags: string): Promise<string> => {
      const records = await parse([ascii(`path\0  size: 0\tflags: ${rawFlags}\n`)]);
      return fingerprintGitIndexControlRecords(records).checksum;
    };
    assert.equal(await parseFingerprint("00000001"), await parseFingerprint("80000001"));
    assert.notEqual(await parseFingerprint("00000001"), await parseFingerprint("00000003"));
  });

  it("changes v2 hashes for every semantic flag bit but not fsmonitor volatility", async () => {
    const hash = async (flags: number): Promise<string> =>
      fingerprintGitIndexControlRecords(await parse([ascii(`path\0 flags: ${flags.toString(16)}\n`)])).checksum;
    const baseline = await hash(0);
    assert.equal(await hash(CE_FSMONITOR_VALID), baseline);
    for (let bit = 0; bit < 32; bit += 1) {
      if (bit === 31) continue;
      assert.notEqual(await hash(2 ** bit), baseline, `semantic flag bit ${bit} must affect hash`);
    }
  });

  it("rejects masked flags outside unsigned 32-bit range", () => {
    for (const maskedFlags of [-1, 0x100000000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => fingerprintGitIndexControlRecords([{ pathname: Buffer.from("p"), maskedFlags }]),
        /maskedFlags must be an unsigned 32-bit integer/,
      );
    }
  });

  it("preserves newline and invalid UTF-8 pathname bytes across one-byte chunks", async () => {
    const pathname = Buffer.from([0x64, 0x69, 0x72, 0x2f, 0x0a, 0xff, 0x09, 0x78]);
    const source = Buffer.concat([
      pathname,
      Buffer.from([0]),
      ascii("  ctime: 1:2\n  custom: ignored\n  size: 0\tflags: 80000001\n"),
    ]);

    const records = await parse(oneByteChunks(source));
    assert.equal(records.length, 1);
    assert.deepEqual([...records[0].pathname], [...pathname]);
    assert.equal(records[0].rawFlags, 0x80000001);
    assert.equal(records[0].maskedFlags, 0x00000001);
  });

  it("ignores unknown fields and recognizes one independent inline flags field", async () => {
    const source = ascii(
      "first path\0"
      + "  future-field: value\n"
      + "  notflags: abc\n"
      + "  size: 0\tflags:\t000000aF \t\n"
      + "second\0"
      + "  unknown flagsish: value\n"
      + "flags: FFFFFFFF\n",
    );

    const records = await parse([source.subarray(0, 13), source.subarray(13)]);
    assert.deepEqual(records.map((record) => record.pathname.toString("ascii")), ["first path", "second"]);
    assert.deepEqual(records.map((record) => record.rawFlags), [0xaf, 0xffffffff]);
    assert.deepEqual(records.map((record) => record.maskedFlags), [0xaf, 0x7fffffff]);
  });

  it("accepts empty input and EOF only between complete entries", async () => {
    assert.deepEqual(await parse([]), []);
    const parser = createGitIndexControlParser(() => {});
    await parser.push(ascii("path\0  size: 0\tflags: 0\n"));
    await parser.finish();
    await assert.rejects(
      parser.push(ascii("later")),
      (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_SAFETY_STREAM_MALFORMED",
    );
  });

  it("rejects NUL and non-ASCII bytes in debug state", async () => {
    await rejectsMalformed(Buffer.concat([ascii("path\0  unknown"), Buffer.from([0]), ascii("flags: 0\n")]));
    await rejectsMalformed(Buffer.concat([ascii("path\0  unknown: "), Buffer.from([0xff]), ascii("\n  flags: 0\n")]));
  });

  it("rejects missing, empty, invalid, oversized, and duplicate flags fields", async () => {
    const malformed = [
      "path\0  unknown: value\n",
      "path\0  flags: \n",
      "path\0  flags:\t\n",
      "path\0  flags: nope\n",
      "path\0  flags: 0x1\n",
      "path\0  flags: 123456789\n",
      "path\0  flags: 1 trailing\n",
      "path\0  flags: 1\tflags: 2\n",
    ];
    for (const source of malformed) {
      const bytes = ascii(source);
      for (const chunks of everyTwoPartSplit(bytes)) await rejectsMalformedChunks(chunks);
    }
  });

  it("fails closed for malformed fields at every split without consulting framing helpers", async () => {
    const malformed = [
      "path\0  flags: 0x1\n",
      "path\0  flags: 12g\n",
      "path\0  flags: 123456789\n",
      "path\0  flags: 1 flags: 2\n",
      "path\0  size: 0\n",
    ];
    for (const text of malformed) {
      const source = ascii(text);
      for (const chunks of everyTwoPartSplit(source)) {
        await assert.rejects(parse(chunks), (error: unknown) =>
          error instanceof GitSafetyError && error.code === "GIT_SAFETY_STREAM_MALFORMED");
      }
    }
  });

  it("rejects empty and truncated pathnames and truncated debug lines", async () => {
    for (const source of ["\0  flags: 0\n", "path", "path\0", "path\0  flags: 0"]) {
      await rejectsMalformed(ascii(source));
    }
  });

  it("parses this repository's real Git debug stream and preserves every pathname", async () => {
    const debug = spawnSync("git", ["ls-files", "--debug", "-z"], {
      cwd: process.cwd(),
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(debug.status, 0, debug.stderr?.toString("utf8"));
    const names = spawnSync("git", ["ls-files", "-z"], {
      cwd: process.cwd(),
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(names.status, 0, names.stderr?.toString("utf8"));

    const records = await parse([debug.stdout as Buffer]);
    const expected = (names.stdout as Buffer)
      .subarray(0, -1)
      .toString("hex")
      .split("00")
      .map((hex) => Buffer.from(hex, "hex"));
    assert(records.length > 0);
    assert.deepEqual(records.map((record) => record.pathname), expected);
  });
});
