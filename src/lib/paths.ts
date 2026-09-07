import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BATON_DIR = ".baton";
export const CONFIG_NAME = "config.toml";
export const SKILL_NAME = "SKILL.md";

export function hostHome(env?: NodeJS.ProcessEnv): string {
  const source = env || process.env;
  return source.HOME || source.USERPROFILE || os.homedir();
}
export function batonHomeDir(env?: NodeJS.ProcessEnv): string {
  return path.join(hostHome(env), BATON_DIR);
}
export function configPath(
  _cwd: string,
  { env }: { env?: NodeJS.ProcessEnv } = {},
): string {
  return path.join(batonHomeDir(env), CONFIG_NAME);
}
export function skillPath(
  _cwd: string,
  { env }: { env?: NodeJS.ProcessEnv } = {},
): string {
  return path.join(batonHomeDir(env), SKILL_NAME);
}
export function packageRoot(): string {
  const candidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  if (path.basename(candidate) === "dist") {
    const parent = path.dirname(candidate);
    if (fs.existsSync(path.join(parent, "package.json"))) return parent;
  }
  return candidate;
}
export function displayHomePath(
  destination: string,
  { cwd, env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const relative = path.relative(hostHome(env), destination);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    return `~/${relative.replaceAll("\\\\", "/")}`;
  return cwd ? path.relative(cwd, destination) || destination : destination;
}
