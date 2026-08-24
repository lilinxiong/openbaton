import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runtime signals that would otherwise leak the invoking CLI into isolated tests. */
const HOST_SIGNAL_KEYS = [
  "BATON_HOST",
  "GROK_AGENT",
  "GROK_SESSION_ID",
  "CURSOR_AGENT",
  "CURSOR_CONVERSATION_ID",
  "CODEX_SANDBOX",
  "CODEX_INTERNAL",
];

function withoutHostSignals(env) {
  const next = { ...env };
  for (const key of HOST_SIGNAL_KEYS) delete next[key];
  return next;
}

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
  return { ...withoutHostSignals(process.env), HOME: home, ...extra };
}

/** Isolate direct library tests whose runtime paths resolve through process.env.HOME. */
export function isolatedHome(prefix = "baton-test-home-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = home;
  return home;
}
