import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const TEST_SESSION_ID = "baton-test-session";
export const TEST_SESSION_UID = crypto.createHash("sha256").update(TEST_SESSION_ID).digest("hex");
export const FIXTURE_ADAPTER_PATHS = path.resolve(import.meta.dir, "fixtures/adapters");
export const FIXTURE_ALPHA = path.join(FIXTURE_ADAPTER_PATHS, "alpha");
export const FIXTURE_BETA = path.join(FIXTURE_ADAPTER_PATHS, "beta");
export function fixtureAdapterEnv(extra = {}) {
  return { ...process.env, BATON_ADAPTER_PATHS: [FIXTURE_ALPHA, FIXTURE_BETA].join(path.delimiter), ...extra };
}
export function testTicketId(prefix = "spn", ordinal = 1, session = TEST_SESSION_UID) {
  return `${prefix}-${session}-${String(ordinal).padStart(4, "0")}`;
}

/** Runtime signals that would otherwise leak the invoking CLI into isolated tests. */
const HOST_SIGNAL_KEYS = [
  "BATON_HOST",
  "ALPHA_HOST",
  "BETA_HOST",
];

function withoutHostSignals(env) {
  const next = { ...env };
  for (const key of HOST_SIGNAL_KEYS) delete next[key];
  return next;
}

export function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-home-"));
  const prev = process.env.HOME;
  const prevAdapters = process.env.BATON_ADAPTER_PATHS;
  const prevSession = process.env.BATON_SESSION_ID;
  process.env.HOME = home;
  process.env.BATON_SESSION_ID = TEST_SESSION_ID;
  process.env.BATON_ADAPTER_PATHS = [FIXTURE_ALPHA, FIXTURE_BETA].join(path.delimiter);
  let pending = false;
  try {
    const result = fn(home);
    if (result && typeof result.then === "function") {
      pending = true;
      return Promise.resolve(result).finally(() => {
        process.env.HOME = prev;
        if (prevAdapters === undefined) delete process.env.BATON_ADAPTER_PATHS; else process.env.BATON_ADAPTER_PATHS = prevAdapters;
        if (prevSession === undefined) delete process.env.BATON_SESSION_ID;
        else process.env.BATON_SESSION_ID = prevSession;
      });
    }
    return result;
  } finally {
    if (!pending) {
      process.env.HOME = prev;
      if (prevAdapters === undefined) delete process.env.BATON_ADAPTER_PATHS; else process.env.BATON_ADAPTER_PATHS = prevAdapters;
      if (prevSession === undefined) delete process.env.BATON_SESSION_ID;
      else process.env.BATON_SESSION_ID = prevSession;
    }
  }
}

export function fakeEnv(home, extra = {}) {
  return { ...withoutHostSignals(fixtureAdapterEnv()), HOME: home, BATON_SESSION_ID: TEST_SESSION_ID, ...extra };
}

/** Isolate direct library tests whose runtime paths resolve through process.env.HOME. */
export function isolatedHome(prefix = "baton-test-home-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = home;
  process.env.BATON_SESSION_ID = TEST_SESSION_ID;
  process.env.BATON_ADAPTER_PATHS = [FIXTURE_ALPHA, FIXTURE_BETA].join(path.delimiter);
  return home;
}
