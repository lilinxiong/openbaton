/**
 * Consume OpenCodex from Baton's package/runtime environment. It owns provider
 * auth, model discovery, and route execution. baton only schedules; resolve the engine,
 * do not start a local proxy and do not reimplement OAuth. Never write
 * openai_base_url or a catalog into ~/.codex.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./paths.js";
import type { CodedError, UnknownRecord } from "../types.js";

const KIMI_OAUTH_CARDS = new Set<string>([
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
]);

const MIMO_KEY_CARDS = new Set<string>(["mimo-v2.5", "mimo-v2.5-pro"]);

export const OCX_PACKAGE = "@bitkyc08/" + "opencodex";

export const MIMO_KEY_ONLY_MESSAGE =
  "Xiaomi MiMo in OpenCodex is still API-key, not account login. Do not paste a key here.";

export interface OcxResolution {
  source: "path" | "bundled" | "npx";
  command: string;
  prefixArgs: string[];
}

export interface OcxRunResult {
  status: number;
  stdout: string;
  stderr: string;
  error: CodedError | null;
}

export interface OcxRunnerInput {
  ocx: string;
  command: string;
  prefixArgs: string[];
  args: string[];
  inheritStdio: boolean;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  source: OcxResolution["source"];
}

export type OcxRunner = (input: OcxRunnerInput) => OcxRunResult;
export type OcxResolver = (options: OcxResolveOptions) => OcxResolution | null;
export type OcxPathFinder = (env: NodeJS.ProcessEnv) => string | null;

export interface OcxResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  packageRoot?: string;
  findOnPath?: OcxPathFinder;
  findBundled?: (options?: OcxResolveOptions) => string | null;
  findNpx?: OcxPathFinder;
  npxAvailable?: OcxPathFinder;
}

export interface OcxRunOptions extends OcxResolveOptions {
  resolved?: OcxResolution | null;
  resolve?: OcxResolver;
  runner?: OcxRunner;
  inheritStdio?: boolean;
}

export interface AuthProviderMapping {
  provider: string | null;
  keyOnly: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function engineMissingMessage(): string {
  return [
    "blocked: baton could not start the login engine.",
    "Account login is consumed, not reimplemented.",
    "Do not paste a base URL or API key.",
  ].join("\n");
}

/** @deprecated use engineMissingMessage — kept so old imports do not throw */
export function missingOcxMessage(): string {
  return engineMissingMessage();
}

function isFile(candidate: string): boolean {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function binaryNames(name: string): string[] {
  return process.platform === "win32" ? [name + ".cmd", name + ".exe", name] : [name];
}

export function findBinaryOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
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

export function ocxCliAvailable(env: NodeJS.ProcessEnv = process.env): string | null {
  return findBinaryOnPath("ocx", env);
}

export function findSubmoduleOcx(options: OcxResolveOptions = {}): string | null {
  const root = options.packageRoot || packageRoot();
  const submodule = path.join(root, "opencodex", "bin", "ocx.mjs");
  if (isFile(submodule)) return submodule;
  return null;
}

export function findBundledOcx(options: OcxResolveOptions = {}): string | null {
  const root = options.packageRoot || packageRoot();
  const submodule = findSubmoduleOcx({ packageRoot: root });
  if (submodule) return submodule;
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
 * Resolve an ocx invocation: PATH, then the OpenCodex git submodule
 * (opencodex/bin/ocx.mjs), then node_modules, then npx.
 * Returns { source, command, prefixArgs } or null.
 */
export function resolveOcx(options: OcxResolveOptions = {}): OcxResolution | null {
  const env = options.env || process.env;
  const findOnPath = options.findOnPath || ((value: NodeJS.ProcessEnv) => findBinaryOnPath("ocx", value));
  const findBundled = options.findBundled || (() => findBundledOcx(options));
  const findNpx = options.findNpx || ((value: NodeJS.ProcessEnv) => findBinaryOnPath("npx", value));

  const pathHit = findOnPath(env);
  if (pathHit) return { source: "path", command: pathHit, prefixArgs: [] };

  const bundled = findBundled(options);
  if (bundled) return { source: "bundled", command: bundled, prefixArgs: [] };

  if (options.npxAvailable) {
    if (!options.npxAvailable(env)) return null;
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
export function authProviderForCard(card: unknown): AuthProviderMapping {
  if (!isRecord(card)) return { provider: null, keyOnly: false };
  const id = stringValue(card.id).trim();
  if (MIMO_KEY_CARDS.has(id)) return { provider: null, keyOnly: true };
  const authProvider = stringValue(card.auth_provider).trim();
  if (authProvider) return { provider: authProvider, keyOnly: false };
  if (KIMI_OAUTH_CARDS.has(id)) return { provider: "kimi", keyOnly: false };
  if (id.toLowerCase().startsWith("grok")) return { provider: "xai", keyOnly: false };
  return { provider: null, keyOnly: false };
}

export function defaultOcxRunner(input: OcxRunnerInput): OcxRunResult {
  const cmd = input.command || input.ocx;
  const argv = [...input.prefixArgs, ...input.args];
  const result = spawnSync(cmd, argv, {
    env: input.env,
    cwd: input.cwd,
    encoding: "utf8",
    stdio: input.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status == null ? (result.error ? 1 : 0) : result.status,
    stdout: input.inheritStdio ? "" : String(result.stdout || ""),
    stderr: input.inheritStdio ? "" : String(result.stderr || ""),
    error: result.error ? result.error as CodedError : null,
  };
}

function resolvedFrom(options: OcxRunOptions): OcxResolution | null {
  if (options.resolved) return options.resolved;
  return (options.resolve || resolveOcx)(options);
}

/** Run ocx with an injectable resolver/runner. Callers pass argv after ocx. */
export function runOcx(args: string[], options: OcxRunOptions = {}): OcxRunResult {
  const env = options.env || process.env;
  const resolved = resolvedFrom({ ...options, env });
  if (!resolved) {
    const err = new Error(engineMissingMessage()) as CodedError;
    err.code = "OCX_MISSING";
    throw err;
  }
  const runner = options.runner || defaultOcxRunner;
  return runner({
    ocx: resolved.command,
    command: resolved.command,
    prefixArgs: resolved.prefixArgs || [],
    args,
    inheritStdio: Boolean(options.inheritStdio),
    env,
    cwd: options.cwd,
    source: resolved.source,
  });
}

export const ENGINE_START_FAILURE_MESSAGE =
  "Error: account login should not require a local proxy.";

export const ENGINE_UNREACHABLE_HINT =
  "hint: the login engine is not used that way. baton login is account OAuth only.";

const ENGINE_CLI_RE = /\b(?:npx\s+(?:-y\s+)?)?(?:ocx|opencodex|@bitkyc08\/opencodex)\b/i;

/** Rewrite engine CLI names so users never see or type ocx. */
export function sanitizeEngineOutput(text: unknown): string {
  if (text == null) return "";
  let out = stringValue(text);
  out = out.replace(/Start it with:\s*(?:npx\s+(?:-y\s+)?)?(?:ocx|opencodex|@bitkyc08\/opencodex)(?:\s+start)?/gi, "");
  out = out.replace(/Proxy is not running\.?/gi, "account login should not require a local proxy");
  out = out.replace(/\b(?:npx\s+(?:-y\s+)?)?@bitkyc08\/opencodex\b/gi, "the login engine");
  out = out.replace(/\bocx(?:\.[a-z]+)?\b/gi, "the login engine");
  out = out.replace(/\bopencodex\b/gi, "the login engine");
  out = out.replace(/(?:the login engine\s*){2,}/gi, "the login engine ");
  out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function mentionsEngineCli(text: unknown): boolean {
  return ENGINE_CLI_RE.test(stringValue(text));
}

export function isProxyDown(result: OcxRunResult | null | undefined): boolean {
  if (!result) return false;
  const errCode = result.error?.code;
  if (errCode === "ECONNREFUSED") return true;
  const text = [result.stderr, result.stdout, result.error?.message, errCode]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!text) return false;
  return /econnrefused|connection refused|econnreset|not running|proxy is down|unreachable proxy|connect failed|start it with/.test(text)
    || /proxy.*(not running|unreachable|refused|down)/.test(text);
}

/** Account list only. Never start a local proxy. */
export function listOcxAccounts(options: OcxRunOptions = {}): OcxRunResult {
  return runOcx(["account", "list"], { ...options, inheritStdio: false });
}

export function resolveLoginProvider(name: unknown): string {
  const raw = stringValue(name).trim();
  const id = raw.toLowerCase();
  if (!id) return "";
  if (id === "xai" || id === "grok" || id.startsWith("grok-") || id === "grok.com") return "xai";
  return raw;
}

/** Account OAuth only. Never start a local proxy or rewrite host config. */
export function loginOcxProvider(provider: string, options: OcxRunOptions = {}): OcxRunResult {
  const id = resolveLoginProvider(provider);
  if (!id) {
    const err = new Error("provider required") as CodedError;
    err.code = "OCX_PROVIDER_REQUIRED";
    throw err;
  }
  return runOcx(["account", "login", id], {
    ...options,
    inheritStdio: options.inheritStdio !== false,
  });
}

export function ocxFailureHint(result: OcxRunResult): string {
  const raw = String(result.stderr || result.error?.message || "").trim();
  if (isProxyDown(result) || mentionsEngineCli(raw)) {
    return ENGINE_START_FAILURE_MESSAGE + "\n" + ENGINE_UNREACHABLE_HINT;
  }
  const errText = sanitizeEngineOutput(raw);
  const lines: string[] = [];
  if (errText) lines.push(errText);
  lines.push(ENGINE_UNREACHABLE_HINT);
  return lines.join("\n");
}
