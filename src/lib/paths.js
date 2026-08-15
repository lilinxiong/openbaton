import path from "node:path";

export const BATON_DIR = ".baton";
export const CONFIG_NAME = "config.toml";
export const SKILL_NAME = "SKILL.md";
export const SPAWNS_DIR = "spawns";
export const RUNS_DIR = "runs";

export function batonDir(cwd) {
  return path.join(cwd, BATON_DIR);
}

export function configPath(cwd) {
  return path.join(cwd, BATON_DIR, CONFIG_NAME);
}

export function skillPath(cwd) {
  return path.join(cwd, BATON_DIR, SKILL_NAME);
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
