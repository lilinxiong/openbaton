/**
 * OpenSpec CLI discovery and the default command runner. Split from
 * openspec.ts (leaf module).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { OpenSpecCommandResult } from "../openspec.js";

export function openspecCliAvailable(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnv = env.PATH || env.Path || "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["openspec.cmd", "openspec.exe", "openspec"] : ["openspec"];
  for (const dir of parts) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

export function detectOpenSpecRoot(cwd: string): string | null {
  const config = path.join(cwd, "openspec", "config.yaml");
  const changes = path.join(cwd, "openspec", "changes");
  if (fs.existsSync(config) || fs.existsSync(changes)) {
    return path.join(cwd, "openspec");
  }
  return null;
}

export function resolveChangeDir(cwd: string, change: string | null | undefined): string | null {
  if (!change) return null;
  if (path.isAbsolute(change)) return change;
  if (change.startsWith("openspec/") || change.startsWith("openspec\\")) {
    return path.join(cwd, change);
  }
  return path.join(cwd, "openspec", "changes", change);
}


export function defaultOpenSpecRunner(command: string, args: string[], cwd: string): OpenSpecCommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}
