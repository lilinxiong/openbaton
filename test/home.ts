import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  let pending = false;
  try {
    const result = fn(home);
    if (result && typeof result.then === "function") {
      pending = true;
      return Promise.resolve(result).finally(() => {
        process.env.HOME = prev;
      });
    }
    return result;
  } finally {
    if (!pending) process.env.HOME = prev;
  }
}

export function fakeEnv(home, extra = {}) {
  return { ...process.env, HOME: home, ...extra };
}

/** Isolate direct library tests whose runtime paths resolve through process.env.HOME. */
export function isolatedHome(prefix = "baton-test-home-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = home;
  return home;
}
