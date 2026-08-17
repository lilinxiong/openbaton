import os from "node:os";
import path from "node:path";

export const BATON_DIR = ".baton";
export const CONFIG_NAME = "config.toml";
export const SKILL_NAME = "SKILL.md";
export const SPAWNS_DIR = "spawns";
export const RUNS_DIR = "runs";

/**
 * User home for host + director files.
 * HOME = env.HOME || env.USERPROFILE || os.homedir()
 */
export function hostHome(env) {
  const e = env || process.env || {};
  return e.HOME || e.USERPROFILE || os.homedir();
}

export function batonHomeDir(env) {
  return path.join(hostHome(env), BATON_DIR);
}

/** Project-local runtime dir (spawns/runs). Init never creates this. */
export function batonDir(cwd) {
  return path.join(cwd, BATON_DIR);
}

export function configPath(_cwd, { env } = {}) {
  return path.join(batonHomeDir(env), CONFIG_NAME);
}

export function skillPath(_cwd, { env } = {}) {
  return path.join(batonHomeDir(env), SKILL_NAME);
}

export function spawnsDir(cwd) {
  return path.join(cwd, BATON_DIR, SPAWNS_DIR);
}

export function runsDir(cwd) {
  return path.join(cwd, BATON_DIR, RUNS_DIR);
}

export function packageRoot() {
  return path.resolve(new URL("../..", import.meta.url).pathname);
}

export function displayHomePath(dest, { cwd, env } = {}) {
  const home = hostHome(env);
  if (home) {
    const fromHome = path.relative(home, dest);
    if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
      return fromHome;
    }
  }
  if (cwd) return path.relative(cwd, dest) || dest;
  return dest;
}
