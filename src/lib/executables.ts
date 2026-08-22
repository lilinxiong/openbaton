import fs from "node:fs";
import path from "node:path";

export function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryNames(name: string): string[] {
  return process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
}

export function findBinaryOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnv = env.PATH || env.Path || "";
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const bin of binaryNames(name)) {
      const candidate = path.join(dir, bin);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
