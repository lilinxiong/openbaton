/**
 * Consume OpenCodex from Baton's package/runtime environment. It owns provider
 * auth, model discovery, and route execution. baton only schedules and invokes
 * OpenCodex catalog commands; it does not expose account or login operations.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./paths.js";
import type { CodedError } from "../types.js";

export const OCX_PACKAGE = "@bitkyc08/" + "opencodex";

export interface OcxResolution {
  source: "path" | "bundled" | "bunx";
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
  findBunx?: OcxPathFinder;
  bunxAvailable?: OcxPathFinder;
}

export interface OcxRunOptions extends OcxResolveOptions {
  resolved?: OcxResolution | null;
  resolve?: OcxResolver;
  runner?: OcxRunner;
  inheritStdio?: boolean;
}

export function engineMissingMessage(): string {
  return [
    "blocked: OpenCodex model discovery is unavailable.",
    "Baton consumes the OpenCodex route catalog and does not own provider authentication.",
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
 * (opencodex/bin/ocx.mjs), then node_modules, then bunx.
 * Returns { source, command, prefixArgs } or null.
 */
export function resolveOcx(options: OcxResolveOptions = {}): OcxResolution | null {
  const env = options.env || process.env;
  const findOnPath = options.findOnPath || ((value: NodeJS.ProcessEnv) => findBinaryOnPath("ocx", value));
  const findBundled = options.findBundled || (() => findBundledOcx(options));
  const findBunx = options.findBunx || ((value: NodeJS.ProcessEnv) => findBinaryOnPath("bunx", value));

  const pathHit = findOnPath(env);
  if (pathHit) return { source: "path", command: pathHit, prefixArgs: [] };

  const bundled = findBundled(options);
  if (bundled) return { source: "bundled", command: bundled, prefixArgs: [] };

  if (options.bunxAvailable) {
    if (!options.bunxAvailable(env)) return null;
    return { source: "bunx", command: "bunx", prefixArgs: ["--bun", OCX_PACKAGE] };
  }
  const bunx = findBunx(env);
  if (bunx) return { source: "bunx", command: bunx, prefixArgs: ["--bun", OCX_PACKAGE] };
  return null;
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
