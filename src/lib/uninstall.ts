import fs from "node:fs";
import path from "node:path";
import {
  installManifestPath,
  manifestOwnsDirectory,
  manifestOwnsFile,
  readInstallManifest,
} from "./install-manifest.js";
import { batonHomeDir, configPath, displayHomePath } from "./paths.js";
import type { HostId } from "./hosts.js";

export type UninstallAction = "remove" | "already-absent" | "conflict";
export interface UninstallTarget {
  action: UninstallAction;
  path: string;
  reason: string;
}
export interface UninstallPlan {
  hosts: HostId[];
  clean: boolean;
  dry_run: boolean;
  targets: UninstallTarget[];
  constraints: string[];
}
export interface BuildUninstallPlanOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  hosts?: readonly HostId[];
  clean?: boolean;
  dry_run?: boolean;
}
export interface ApplyUninstallPlanOptions {
  env?: NodeJS.ProcessEnv;
  dry_run?: boolean;
}

function shown(file: string, env?: NodeJS.ProcessEnv): string {
  return displayHomePath(file, { env });
}
function ownedFile(file: string, env?: NodeJS.ProcessEnv): UninstallTarget {
  if (!fs.existsSync(file))
    return {
      action: "already-absent",
      path: shown(file, env),
      reason: "absent",
    };
  return manifestOwnsFile(readInstallManifest(env), file)
    ? {
        action: "remove",
        path: shown(file, env),
        reason: "manifest-owned file",
      }
    : {
        action: "conflict",
        path: shown(file, env),
        reason: "modified or ownership is ambiguous",
      };
}
function ownedDirectory(
  file: string,
  env?: NodeJS.ProcessEnv,
): UninstallTarget {
  if (!fs.existsSync(file))
    return {
      action: "already-absent",
      path: shown(file, env),
      reason: "absent",
    };
  return manifestOwnsDirectory(readInstallManifest(env), file)
    ? {
        action: "remove",
        path: shown(file, env),
        reason: "manifest-owned directory",
      }
    : {
        action: "conflict",
        path: shown(file, env),
        reason: "modified or ownership is ambiguous",
      };
}
function absolute(target: UninstallTarget, env?: NodeJS.ProcessEnv): string {
  const home = batonHomeDir(env);
  const file = target.path.startsWith("~/")
    ? path.join(path.dirname(home), target.path.slice(2))
    : path.resolve(target.path);
  const relative = path.relative(path.dirname(home), file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`uninstall target escapes home: ${target.path}`);
  return file;
}
function batonFile(
  file: string,
  reason: string,
  env?: NodeJS.ProcessEnv,
): UninstallTarget {
  return {
    action: fs.existsSync(file) ? "remove" : "already-absent",
    path: shown(file, env),
    reason,
  };
}

export function buildUninstallPlan(
  options: BuildUninstallPlanOptions,
): UninstallPlan {
  const env = options.env || process.env;
  const manifest = readInstallManifest(env);
  const requested = new Set(options.hosts || []);
  const entries =
    manifest?.files.filter(
      (entry) =>
        options.clean ||
        (entry.host !== null && requested.has(entry.host)) ||
        (entry.kind === "adapter-package" &&
          entry.adapter !== null &&
          requested.has(entry.adapter)),
    ) || [];
  const targets = entries.map((entry) =>
    entry.kind === "adapter-package"
      ? ownedDirectory(entry.path, env)
      : ownedFile(entry.path, env),
  );
  if (options.clean) {
    const home = batonHomeDir(env);
    targets.push(
      batonFile(configPath(options.cwd, { env }), "Baton config", env),
    );
    targets.push(
      batonFile(path.join(home, "results.jsonl"), "Baton results", env),
    );
    if (!targets.some((target) => target.action === "conflict")) {
      targets.push(
        batonFile(installManifestPath(env), "Baton install manifest", env),
      );
    }
  }
  const unique = new Map<string, UninstallTarget>();
  for (const target of targets) unique.set(target.path, target);
  return {
    hosts: [...requested] as HostId[],
    clean: options.clean === true,
    dry_run: options.dry_run === true,
    targets: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path)),
    constraints: [
      "preserve modified or ambiguous external integrations",
      "only remove manifest-owned external files and known Baton files during clean",
    ],
  };
}

export function applyUninstallPlan(
  plan: UninstallPlan,
  options: ApplyUninstallPlanOptions = {},
): UninstallPlan {
  if (plan.dry_run || options.dry_run) return plan;
  for (const target of plan.targets) {
    if (target.action !== "remove" || target.reason.startsWith("Baton "))
      continue;
    const file = absolute(target, options.env);
    if (
      target.reason === "manifest-owned directory" &&
      !manifestOwnsDirectory(readInstallManifest(options.env), file)
    ) {
      throw new Error(`uninstall target changed: ${target.path}`);
    }
    if (
      target.reason === "manifest-owned file" &&
      !manifestOwnsFile(readInstallManifest(options.env), file)
    ) {
      throw new Error(`uninstall target changed: ${target.path}`);
    }
  }
  for (const target of plan.targets)
    if (target.action === "remove") {
      const file = absolute(target, options.env);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        fs.rmSync(file, { recursive: true, force: true });
      else fs.unlinkSync(file);
    }
  return plan;
}
