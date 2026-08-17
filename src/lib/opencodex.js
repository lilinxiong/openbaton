/**
 * Consume OpenCodex for account login. Resolve/start the engine; do not
 * reimplement OAuth. Tokens stay in OpenCodex, never in .baton.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { packageRoot } from "./paths.js";

const KIMI_OAUTH_CARDS = new Set([
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
]);

const MIMO_KEY_CARDS = new Set(["mimo-v2.5", "mimo-v2.5-pro"]);

export const OCX_PACKAGE = "@bitkyc08/" + "opencodex";

export const MIMO_KEY_ONLY_MESSAGE =
  "Xiaomi MiMo in OpenCodex is still API-key, not account login. Do not paste a key here.";

export function engineMissingMessage() {
  return [
    "blocked: baton could not start the login engine.",
    "Account login is consumed, not reimplemented.",
    "Do not paste a base URL or API key.",
  ].join("\n");
}

/** @deprecated use engineMissingMessage — kept so old imports do not throw */
export function missingOcxMessage() {
  return engineMissingMessage();
}

function isFile(candidate) {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function binaryNames(name) {
  return process.platform === "win32" ? [name + ".cmd", name + ".exe", name] : [name];
}

export function findBinaryOnPath(name, env = process.env) {
  const pathEnv = env.PATH || env.Path || "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of parts) {
    for (const bin of binaryNames(name)) {
      const candidate = path.join(dir, bin);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function ocxCliAvailable(env = process.env) {
  return findBinaryOnPath("ocx", env);
}

export function findBundledOcx(opts = {}) {
  const root = opts.packageRoot || packageRoot();
  const binDir = path.join(root, "node_modules", ".bin");
  for (const bin of binaryNames("ocx")) {
    const candidate = path.join(binDir, bin);
    if (isFile(candidate)) return candidate;
  }
  const pkgBin = path.join(root, "node_modules", "@bitkyc08", "opencodex", "bin", "ocx.mjs");
  if (isFile(pkgBin)) return pkgBin;
  return null;
}

/**
 * Resolve an ocx invocation: PATH, then node_modules/.bin next to baton, then npx.
 * Returns { source, command, prefixArgs } or null.
 */
export function resolveOcx(opts = {}) {
  const env = opts.env || process.env;
  const findOnPath = opts.findOnPath || ((e) => findBinaryOnPath("ocx", e));
  const findBundled = opts.findBundled || (() => findBundledOcx(opts));
  const findNpx = opts.findNpx || ((e) => findBinaryOnPath("npx", e));

  const pathHit = findOnPath(env);
  if (pathHit) return { source: "path", command: pathHit, prefixArgs: [] };

  const bundled = findBundled(opts);
  if (bundled) return { source: "bundled", command: bundled, prefixArgs: [] };

  if (typeof opts.npxAvailable === "function") {
    if (!opts.npxAvailable(env)) return null;
    return { source: "npx", command: "npx", prefixArgs: ["-y", OCX_PACKAGE] };
  }
  const npx = findNpx(env);
  if (npx) return { source: "npx", command: npx, prefixArgs: ["-y", OCX_PACKAGE] };
  return null;
}

/**
 * Map a card to an OpenCodex OAuth provider id.
 * auth_provider on the card wins when present (trimmed).
 * Defaults cover OAuth account login only (authKind oauth).
 * MiMo cards stay key-only — never default to xiaomi-mimo / mimo.
 */
export function authProviderForCard(card) {
  if (!card || typeof card !== "object") {
    return { provider: null, keyOnly: false };
  }
  const id = String(card.id || "").trim();
  if (MIMO_KEY_CARDS.has(id)) {
    return { provider: null, keyOnly: true };
  }
  if (typeof card.auth_provider === "string" && card.auth_provider.trim()) {
    return { provider: card.auth_provider.trim(), keyOnly: false };
  }
  if (KIMI_OAUTH_CARDS.has(id)) {
    return { provider: "kimi", keyOnly: false };
  }
  if (id.toLowerCase().startsWith("grok")) {
    return { provider: "xai", keyOnly: false };
  }
  return { provider: null, keyOnly: false };
}

export function defaultOcxRunner({ ocx, command, prefixArgs = [], args, inheritStdio, env, cwd }) {
  const cmd = command || ocx;
  const argv = [...prefixArgs, ...args];
  const result = spawnSync(cmd, argv, {
    env,
    cwd,
    encoding: "utf8",
    stdio: inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status == null ? (result.error ? 1 : 0) : result.status,
    stdout: inheritStdio ? "" : String(result.stdout || ""),
    stderr: inheritStdio ? "" : String(result.stderr || ""),
    error: result.error || null,
  };
}

function resolvedFrom(opts) {
  if (opts.resolved) return opts.resolved;
  return (opts.resolve || resolveOcx)(opts);
}

/** Run ocx with an injectable resolver/runner. Callers pass argv after ocx. */
export function runOcx(args, opts = {}) {
  const env = opts.env || process.env;
  const resolved = resolvedFrom({ ...opts, env });
  if (!resolved) {
    const err = new Error(engineMissingMessage());
    err.code = "OCX_MISSING";
    throw err;
  }
  const runner = opts.runner || defaultOcxRunner;
  return runner({
    ocx: resolved.command,
    command: resolved.command,
    prefixArgs: resolved.prefixArgs || [],
    args,
    inheritStdio: Boolean(opts.inheritStdio),
    env,
    cwd: opts.cwd,
    source: resolved.source,
  });
}

export const ENGINE_START_FAILURE_MESSAGE =
  "Error: the login engine could not start.";

export const ENGINE_UNREACHABLE_HINT =
  "hint: baton could not reach the login engine. Try baton login again in a moment.";

const ENGINE_CLI_RE = /\b(?:npx\s+(?:-y\s+)?)?(?:ocx|opencodex|@bitkyc08\/opencodex)\b/i;

/** Rewrite engine CLI names so users never see or type ocx. */
export function sanitizeEngineOutput(text) {
  if (text == null) return "";
  let out = String(text);
  out = out.replace(/Start it with:\s*(?:npx\s+(?:-y\s+)?)?(?:ocx|opencodex|@bitkyc08\/opencodex)(?:\s+start)?/gi, "");
  out = out.replace(/Proxy is not running\.?/gi, "the login engine could not start");
  out = out.replace(/\b(?:npx\s+(?:-y\s+)?)?@bitkyc08\/opencodex\b/gi, "the login engine");
  out = out.replace(/\bocx(?:\.[a-z]+)?\b/gi, "the login engine");
  out = out.replace(/\bopencodex\b/gi, "the login engine");
  out = out.replace(/(?:the login engine\s*){2,}/gi, "the login engine ");
  out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function mentionsEngineCli(text) {
  return ENGINE_CLI_RE.test(String(text || ""));
}

export function isProxyDown(result) {
  if (!result) return false;
  const errCode = result.error && result.error.code;
  if (errCode === "ECONNREFUSED") return true;
  const text = [result.stderr, result.stdout, result.error && result.error.message, errCode]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!text) return false;
  return /econnrefused|connection refused|econnreset|not running|proxy is down|unreachable proxy|connect failed|start it with/.test(text)
    || /proxy.*(not running|unreachable|refused|down)/.test(text);
}

function defaultSleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(ms));
}

function invokeResolved(resolved, args, opts, runner) {
  return runner({
    ocx: resolved.command,
    command: resolved.command,
    prefixArgs: resolved.prefixArgs || [],
    args,
    inheritStdio: false,
    env: opts.env || process.env,
    cwd: opts.cwd,
    source: resolved.source,
  });
}

function startProxyOnce(opts) {
  try {
    return (opts.startProxy || defaultStartProxy)(opts);
  } catch {
    return { status: 1, started: false };
  }
}

/** Poll account list until the proxy is up or the timeout elapses. */
export function waitUntilProxyUp(opts = {}) {
  const timeoutMs = opts.proxyWaitMs ?? 12000;
  const intervalMs = opts.proxyPollMs ?? 250;
  const sleepFn = opts.sleep || defaultSleep;
  const started = Date.now();
  let last = runOcx(["account", "list"], { ...opts, inheritStdio: false });
  if (!isProxyDown(last)) return last;
  while (Date.now() - started < timeoutMs) {
    sleepFn(intervalMs);
    last = runOcx(["account", "list"], { ...opts, inheritStdio: false });
    if (!isProxyDown(last)) return last;
  }
  return last;
}

/**
 * One start attempt. Prefer `ensure`, then `service start`, else detach `start`.
 * Not a service manager. Callers wait/poll after this returns.
 */
export function defaultStartProxy(opts = {}) {
  const env = opts.env || process.env;
  const resolved = resolvedFrom({ ...opts, env });
  if (!resolved) return { status: 1, started: false };
  const runner = opts.runner || defaultOcxRunner;

  const ensure = invokeResolved(resolved, ["ensure"], { ...opts, env }, runner);
  if (ensure.status === 0) return { ...ensure, started: true, method: "ensure" };

  const service = invokeResolved(resolved, ["service", "start"], { ...opts, env }, runner);
  if (service.status === 0) return { ...service, started: true, method: "service" };

  try {
    const child = spawn(resolved.command, [...(resolved.prefixArgs || []), "start"], {
      env,
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { status: 0, started: true, method: "start", pid: child.pid };
  } catch (err) {
    return { status: 1, started: false, method: "start", error: err };
  }
}

/** If list/login failed because the proxy is down, start once, wait, and retry. */
export function runOcxWithProxy(args, opts = {}) {
  const first = runOcx(args, { ...opts, inheritStdio: false });
  if (first.status === 0 || !isProxyDown(first)) return first;
  startProxyOnce(opts);
  const ready = waitUntilProxyUp(opts);
  if (isProxyDown(ready)) return ready;
  return runOcx(args, opts);
}

export function listOcxAccounts(opts = {}) {
  return runOcxWithProxy(["account", "list"], { ...opts, inheritStdio: false });
}

export function resolveLoginProvider(name) {
  const raw = String(name || "").trim();
  const id = raw.toLowerCase();
  if (!id) return "";
  if (id === "xai" || id === "grok" || id.startsWith("grok-") || id === "grok.com") return "xai";
  return raw;
}

export function loginOcxProvider(provider, opts = {}) {
  const id = resolveLoginProvider(provider);
  if (!id) {
    const err = new Error("provider required");
    err.code = "OCX_PROVIDER_REQUIRED";
    throw err;
  }
  let probe = runOcx(["account", "list"], { ...opts, inheritStdio: false });
  if (isProxyDown(probe)) {
    startProxyOnce(opts);
    probe = waitUntilProxyUp(opts);
  }
  if (isProxyDown(probe)) {
    return probe;
  }
  return runOcx(["account", "login", id], {
    ...opts,
    inheritStdio: opts.inheritStdio !== false,
  });
}

export function ocxFailureHint(result) {
  const raw = String(result?.stderr || result?.error?.message || "").trim();
  if (isProxyDown(result) || mentionsEngineCli(raw)) {
    return ENGINE_START_FAILURE_MESSAGE + "\n" + ENGINE_UNREACHABLE_HINT;
  }
  const errText = sanitizeEngineOutput(raw);
  const lines = [];
  if (errText) lines.push(errText);
  lines.push(ENGINE_UNREACHABLE_HINT);
  return lines.join("\n");
}
