/**
 * Workspace dispatch lock helpers. Split from dispatch.ts.
 */
import type { ActivationLockOptions } from "./activation.js";
import type { OwnedLockOptions } from "./owned-lock.js";
import { dispatchLockPath } from "./paths.js";
import { DispatchError } from "./dispatch-core.js";
import {
  OwnedLock,
  withOwnedLock,
  withOwnedLockAsync
} from "./owned-lock.js";

export function lockPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return dispatchLockPath(cwd, env);
}

export function dispatchLockError(error: unknown): never {
  if (error instanceof Error && "code" in error && error.code === "LOCK_BUSY") {
    throw new DispatchError("another dispatcher holds the project lock", "DISPATCH_LOCKED");
  }
  throw error;
}

export type DispatchLockOptions = Omit<OwnedLockOptions, "operation"> & { env?: NodeJS.ProcessEnv };
export type ReserveActivationLockOptions = Omit<ActivationLockOptions, "host" | "scope" | "operation">;

/** Serialize a synchronous dispatch operation using the shared owned-lock primitive. */
export function withDispatchLock<T>(cwd: string, fn: () => T, options: DispatchLockOptions = {}): T {
  let acquired = false;
  const { env = process.env, ...lockOptions } = options;
  try {
    return withOwnedLock(lockPath(cwd, env), () => {
      acquired = true;
      return fn();
    }, { ...lockOptions, operation: "dispatch" });
  } catch (error) {
    if (acquired) throw error;
    return dispatchLockError(error);
  }
}

/** Await-safe dispatch transaction; ownership and lease refresh span all awaited work. */
export async function withDispatchLockAsync<T>(
  cwd: string,
  fn: (lock: OwnedLock) => Promise<T>,
  options: DispatchLockOptions = {},
): Promise<T> {
  let acquired = false;
  const { env = process.env, ...lockOptions } = options;
  try {
    return await withOwnedLockAsync(lockPath(cwd, env), (lock) => {
      acquired = true;
      return fn(lock);
    }, { ...lockOptions, operation: "dispatch" });
  } catch (error) {
    if (acquired) throw error;
    return dispatchLockError(error);
  }
}

export function withLock<T>(cwd: string, fn: () => T, env: NodeJS.ProcessEnv = process.env): T {
  return withDispatchLock(cwd, fn, { env });
}
