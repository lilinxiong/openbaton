import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./json-utils.js";

export interface LockOwnerRecord {
  version: 1;
  token: string;
  pid: number;
  operation: string;
  acquired_at: string;
  lease_until: string;
  refreshed_at: string;
}

export interface OwnedLockOptions {
  operation?: string;
  leaseMs?: number;
  staleMs?: number;
  now?: () => number;
  pid?: number;
  token?: string;
  isPidAlive?: (pid: number) => boolean;
  refreshIntervalMs?: number;
}

export interface OwnedLock {
  readonly file: string;
  readonly token: string;
  readonly owner: LockOwnerRecord;
  refresh(): boolean;
  release(): boolean;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_STALE_MS = 60_000;

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validOwner(value: unknown): value is LockOwnerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.token === "string" && v.token.length > 0
    && Number.isInteger(v.pid) && (v.pid as number) > 0 && typeof v.operation === "string"
    && typeof v.acquired_at === "string" && typeof v.lease_until === "string"
    && typeof v.refreshed_at === "string";
}

function expired(owner: LockOwnerRecord | null, mtime: number, now: number, staleMs: number): boolean {
  const until = owner ? Date.parse(owner.lease_until) : NaN;
  return Number.isFinite(until) ? now >= until : now - mtime >= staleMs;
}

function readOwner(file: string): { owner: LockOwnerRecord | null; mtime: number } {
  const stat = fs.statSync(file);
  try {
    const parsed = readJsonFile(file);
    return { owner: validOwner(parsed) ? parsed : null, mtime: stat.mtimeMs };
  } catch { return { owner: null, mtime: stat.mtimeMs }; }
}

function writeOwner(fd: number, owner: LockOwnerRecord): void {
  const data = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, data, 0, data.length, 0);
  fs.fsyncSync(fd);
}

export function acquireOwnedLock(file: string, options: OwnedLockOptions = {}): OwnedLock {
  const now = options.now || Date.now;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isPidAlive || alive;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = options.token || crypto.randomUUID();
    const acquiredAt = now();
    const owner: LockOwnerRecord = {
      version: 1, token, pid, operation: options.operation || "lock",
      acquired_at: new Date(acquiredAt).toISOString(),
      lease_until: new Date(acquiredAt + leaseMs).toISOString(),
      refreshed_at: new Date(acquiredAt).toISOString(),
    };
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { writeOwner(fd, owner); } catch (error) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} throw error; }
      let released = false;
      let closed = false;
      const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch {} } };
      return {
        file, token, owner,
        refresh(): boolean {
          if (released) return false;
          try {
            const visible = readOwner(file);
            const own = fs.fstatSync(fd);
            const current = visible.owner;
            if (!current || current.token !== token || own.dev !== fs.statSync(file).dev || own.ino !== fs.statSync(file).ino) return false;
            const refreshedAt = now();
            owner.refreshed_at = new Date(refreshedAt).toISOString();
            owner.lease_until = new Date(refreshedAt + leaseMs).toISOString();
            writeOwner(fd, owner);
            const visibleAfter = readOwner(file);
            const visibleStat = fs.statSync(file);
            return visibleAfter.owner?.token === token && own.dev === visibleStat.dev && own.ino === visibleStat.ino;
          } catch { return false; }
        },
        release(): boolean {
          if (released) return false;
          released = true;
          try {
            const current = readOwner(file);
            const own = fs.fstatSync(fd);
            const visible = fs.statSync(file);
            if (current.owner?.token !== token || own.dev !== visible.dev || own.ino !== visible.ino) { close(); return false; }
            fs.unlinkSync(file);
            close();
            return true;
          } catch { close(); return false; }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: { owner: LockOwnerRecord | null; mtime: number };
      try { current = readOwner(file); } catch { continue; }
      const existingAlive = current.owner ? isAlive(current.owner.pid) : false;
      // A live owner is never reclaimed, even after its nominal lease expires.
      if (existingAlive || !expired(current.owner, current.mtime, now(), staleMs)) break;
      // Recheck identity and owner immediately before reclaiming. A refresh or
      // replacement winning between the first read and unlink must survive.
      try {
        const before = fs.statSync(file);
        const again = readOwner(file);
        const after = fs.statSync(file);
        const same = before.dev === after.dev && before.ino === after.ino
          && before.mtimeMs === after.mtimeMs
          && (current.owner ? again.owner?.token === current.owner.token : !again.owner);
        const live = again.owner ? isAlive(again.owner.pid) : false;
        const final = readOwner(file);
        const finalStat = fs.statSync(file);
        const sameAfterProbe = after.dev === finalStat.dev && after.ino === finalStat.ino
          && (again.owner ? final.owner?.token === again.owner.token : !final.owner);
        const reclaimable = final.owner === null
          ? expired(null, final.mtime, now(), staleMs)
          : !live && !isAlive(final.owner.pid) && expired(final.owner, final.mtime, now(), staleMs);
        if (reclaimable && same && sameAfterProbe) fs.unlinkSync(file);
      } catch { /* another owner won the race */ }
    }
  }
  const error = new Error(`lock is busy: ${file}`) as NodeJS.ErrnoException;
  error.code = "LOCK_BUSY";
  throw error;
}

export function withOwnedLock<T>(file: string, fn: (lock: OwnedLock) => T, options: OwnedLockOptions = {}): T {
  const lock = acquireOwnedLock(file, options);
  try { return fn(lock); } finally { lock.release(); }
}

export async function withOwnedLockAsync<T>(file: string, fn: (lock: OwnedLock) => Promise<T>, options: OwnedLockOptions = {}): Promise<T> {
  const lock = acquireOwnedLock(file, options);
  const interval = options.refreshIntervalMs ?? Math.max(1, Math.floor((options.leaseMs ?? DEFAULT_LEASE_MS) / 3));
  const timer = setInterval(() => { lock.refresh(); }, interval);
  timer.unref?.();
  try { return await fn(lock); } finally { clearInterval(timer); lock.release(); }
}
