import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./validate-utils.js";

/**
 * Shared JSON helpers: deterministic canonicalization, hashing, and small
 * file IO primitives used across persistence modules.
 */

/** Recursively sort object keys; array order stays semantic. */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

/** Canonical JSON: object keys sorted recursively; array order is semantic. */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

/** One-shot SHA-256 hex digest for string/binary payloads. */
export function sha256Hex(data: string | Uint8Array, encoding?: crypto.BinaryToTextEncoding): string {
  const hash = crypto.createHash("sha256");
  if (typeof data === "string") hash.update(data, encoding ?? "utf8");
  else hash.update(data);
  return hash.digest("hex");
}

/** Canonical JSON fingerprint, with the given keys omitted recursively. */
export function fingerprintJson(value: unknown, omitKeys: readonly string[] = ["fingerprint"]): string {
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(strip);
    if (!isRecord(item)) return item;
    return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !omitKeys.includes(key))
      .map(([key, entry]) => [key, strip(entry)]));
  };
  return sha256Hex(canonicalizeJson(strip(value)));
}

/** Read and parse a JSON file. Callers keep their own cast/error policy. */
export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Atomic byte write with fsync before rename, for durability-critical
 * records. Options preserve per-module post-rename policies.
 */
export function writeBytesAtomic(file: string, bytes: Uint8Array, options: { fsyncDirectory?: boolean; chmodAfter?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    if (options.chmodAfter) { try { fs.chmodSync(file, 0o600); } catch { /* mode is set by openSync */ } }
    if (options.fsyncDirectory) {
      try {
        const directory = fs.openSync(path.dirname(file), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } catch { /* directory fsync is not available on every platform */ }
    }
  } catch (cause) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ }
    try { fs.unlinkSync(temp); } catch { /* noop */ }
    throw cause;
  }
}

/**
 * Atomic pretty-printed JSON write: temp file in the same directory, then
 * rename. Temp files carry a per-process unique suffix and are cleaned up
 * best-effort on failure.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
  }
}
