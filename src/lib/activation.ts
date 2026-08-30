import {
  activationLockPath,
  globalActivationLockPath,
} from "./paths.js";
import type { CodedError } from "../types.js";
import { acquireOwnedLock, type OwnedLock } from "./owned-lock.js";

function invalid(message: string, code = "ACTIVATION_INVALID"): Error {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

export interface ActivationLockOptions {
  /** Host lock is required by reservation. */
  host?: string;
  scope?: "project" | "global" | "both";
  operation?: string;
  /** Test/runtime tuning; production defaults retain a 60 second lease. */
  leaseMs?: number;
  staleMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  refreshIntervalMs?: number;
}

function activationFiles(cwd: string, env: NodeJS.ProcessEnv | undefined, options: ActivationLockOptions): string[] {
  const scope = options.scope || (options.host ? "both" : "project");
  const files: string[] = [];
  if ((scope === "global" || scope === "both") && options.host) files.push(globalActivationLockPath(options.host, env));
  if (scope === "project" || scope === "both") files.push(activationLockPath(cwd, env, options.host));
  if (!files.length) throw invalid("activation lock requires a scope and host", "ACTIVATION_LOCK_INVALID");
  return files;
}

/**
 * Serialize reservations and other host/project mutations. When a host is
 * supplied the fixed order is global host lock first, then project lock.
 */
export function withActivationLock<T>(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  fn: () => T,
  options: ActivationLockOptions = {},
): T {
  const files = activationFiles(cwd, env, options);
  const acquired: OwnedLock[] = [];
  try {
    for (const file of files) {
      try { acquired.push(acquireOwnedLock(file, { ...options, operation: options.operation || "activation" })); }
      catch (error) {
        if ((error as CodedError).code === "LOCK_BUSY") throw invalid(`activation lock is busy: ${file}`, "ACTIVATION_LOCK_BUSY");
        throw error;
      }
    }
    return fn();
  } finally {
    for (const lock of acquired.reverse()) lock.release();
  }
}

/** Await-safe activation transaction. The lease is refreshed while user code awaits. */
export async function withActivationLockAsync<T>(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  fn: (locks: readonly OwnedLock[]) => Promise<T>,
  options: ActivationLockOptions = {},
): Promise<T> {
  const files = activationFiles(cwd, env, options);
  const acquired: OwnedLock[] = [];
  try {
    for (const file of files) {
      try { acquired.push(acquireOwnedLock(file, { ...options, operation: options.operation || "activation" })); }
      catch (error) {
        if ((error as CodedError).code === "LOCK_BUSY") throw invalid(`activation lock is busy: ${file}`, "ACTIVATION_LOCK_BUSY");
        throw error;
      }
    }
  } catch (error) {
    for (const lock of [...acquired].reverse()) lock.release();
    throw error;
  }
  const interval = options.refreshIntervalMs ?? Math.max(1, Math.floor((options.leaseMs ?? 60_000) / 3));
  const timer = setInterval(() => { for (const lock of acquired) lock.refresh(); }, interval);
  timer.unref?.();
  try { return await fn(acquired); } finally {
    clearInterval(timer);
    for (const lock of [...acquired].reverse()) lock.release();
  }
}
