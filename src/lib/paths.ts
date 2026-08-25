import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const BATON_DIR = ".baton";
export const CONFIG_NAME = "config.toml";
export const SKILL_NAME = "SKILL.md";
export const SPAWNS_DIR = "spawns";
export const RUNS_DIR = "runs";
export const SELECTIONS_DIR = "selections";
export const RECEIPTS_DIR = "receipts";
export const TMP_DIR = "tmp";
export const CACHE_DIR = "cache";
export const WORKSPACES_DIR = "workspaces";
/**
 * Current workspace runtime-state format.
 *
 * The directory before this component is intentionally left untouched. It
 * is the unversioned state written by older releases, and current code must
 * neither inspect nor migrate it.
 */
export const CURRENT_RUNTIME_NAMESPACE = "v2";
export const CAPABILITIES_DIR = "capabilities";
export const AA_DB_NAME = "artificial-analysis.sqlite3";
export const AA_MANIFEST_NAME = "artificial-analysis.manifest.json";
export const ROUTE_HEALTH_NAME = "route-health.json";

/** Host-keyed state names used by the current runtime. */
export function hostRouteSnapshotName(host: string): string {
  return `cli-models-${String(host).trim().toLowerCase()}.json`;
}

export function hostDispatchStateName(host: string): string {
  return `dispatch-${String(host).trim().toLowerCase()}.json`;
}

/**
 * User home for host + director files.
 * HOME = env.HOME || env.USERPROFILE || os.homedir()
 */
export function hostHome(env?: NodeJS.ProcessEnv): string {
  const e = env || process.env || {};
  return e.HOME || e.USERPROFILE || os.homedir();
}

export function batonHomeDir(env?: NodeJS.ProcessEnv): string {
  return path.join(hostHome(env), BATON_DIR);
}

export function canonicalWorkspaceRoot(cwd: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return fs.realpathSync(root);
  } catch {
    // Non-Git workspaces are keyed by their canonical cwd.
  }
  return fs.realpathSync(cwd);
}

export function workspaceId(cwd: string): string {
  return crypto.createHash("sha256").update(canonicalWorkspaceRoot(cwd)).digest("hex");
}

/** User-global runtime namespace for one canonical workspace. */
export function batonDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), WORKSPACES_DIR, workspaceId(cwd), CURRENT_RUNTIME_NAMESPACE);
}

export function configPath(_cwd: string, { env }: { env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(batonHomeDir(env), CONFIG_NAME);
}

export function skillPath(_cwd: string, { env }: { env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(batonHomeDir(env), SKILL_NAME);
}

export function spawnsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), SPAWNS_DIR);
}

export function runsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), RUNS_DIR);
}

export function selectionsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), SELECTIONS_DIR);
}

export function receiptsDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), RECEIPTS_DIR);
}

export function capabilitiesCacheDir(_cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), CACHE_DIR, CAPABILITIES_DIR);
}

export function artificialAnalysisDbPath(cwd: string): string {
  return path.join(capabilitiesCacheDir(cwd), AA_DB_NAME);
}

export function artificialAnalysisManifestPath(cwd: string): string {
  return path.join(capabilitiesCacheDir(cwd), AA_MANIFEST_NAME);
}

export function hostRouteSnapshotPath(_cwd: string, host: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), CACHE_DIR, hostRouteSnapshotName(host));
}

export function routeHealthPath(_cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), CACHE_DIR, ROUTE_HEALTH_NAME);
}

/** Dispatcher runtime state (remembered capacity) for one workspace. */
export function hostDispatchStatePath(cwd: string, host: string, env?: NodeJS.ProcessEnv): string {
  return path.join(runsDir(cwd, env), hostDispatchStateName(host));
}

export function dispatchLockPath(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(batonDir(cwd, env), TMP_DIR, "dispatch.lock");
}

export function packageRoot(): string {
  const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (path.basename(candidate) === "dist") {
    const parent = path.dirname(candidate);
    if (fs.existsSync(path.join(parent, "package.json"))) return parent;
  }
  return candidate;
}

export function displayHomePath(dest: string, { cwd, env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const home = hostHome(env);
  if (home) {
    const fromHome = path.relative(home, dest);
    if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
      return `~/${fromHome.replaceAll("\\", "/")}`;
    }
  }
  if (cwd) return path.relative(cwd, dest) || dest;
  return dest;
}
