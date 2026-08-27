import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { legacyHookPath, removeLegacyHooks } from "./legacy-hook-cleanup.js";
import {
  batonHomeDir,
  configPath,
  hostHome,
  skillPath,
  WORKSPACES_DIR,
  CURRENT_RUNTIME_NAMESPACE,
} from "./paths.js";
import {
  installManifestPath,
  legacyOwnsSkill,
  manifestOwnsFile,
  readInstallManifest,
  type InstallManifest,
} from "./install-manifest.js";
import { HOST_IDS, hostSkillDest, type HostId } from "./hosts.js";

export const UNINSTALL_ACTIVE_TICKETS = "UNINSTALL_ACTIVE_TICKETS";
export const UNINSTALL_STATE_INVALID = "UNINSTALL_STATE_INVALID";
export const UNINSTALL_CONFIRMATION_REQUIRED = "UNINSTALL_CONFIRMATION_REQUIRED";

export type UninstallAction = "remove" | "update-entry" | "preserve" | "already-absent" | "conflict";

export interface UninstallTarget {
  action: UninstallAction;
  path: string;
  host?: HostId;
  reason: string;
  before?: string | null;
  after?: string | null;
  expected_fingerprint?: string | null;
  expected_mode?: number | null;
  expected_kind?: "file" | "directory" | "absent";
}

export interface UninstallPlan {
  hosts: HostId[];
  clean: boolean;
  dry_run: boolean;
  targets: UninstallTarget[];
  active_tickets: Array<{ path: string; ticket_id: string; status: string; host: string }>;
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

function coded(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function display(file: string, env?: NodeJS.ProcessEnv): string {
  const home = hostHome(env);
  const relative = path.relative(home, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `~/${relative}` : file;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fingerprint(file: string): string | null {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function directoryFingerprint(directory: string): string | null {
  try {
    const rows: string[] = [];
    const visit = (root: string, relative: string): void => {
      for (const name of fs.readdirSync(root).sort()) {
        const file = path.join(root, name);
        const rel = path.join(relative, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) rows.push(`link:${rel}:${fs.readlinkSync(file)}`);
        else if (stat.isDirectory()) { rows.push(`dir:${rel}:${stat.mode & 0o7777}`); visit(file, rel); }
        else rows.push(`file:${rel}:${stat.mode & 0o7777}:${fingerprint(file) || "unreadable"}`);
      }
    };
    visit(directory, "");
    return crypto.createHash("sha256").update(rows.join("\n")).digest("hex");
  } catch { return null; }
}

function targetFile(file: string, base: UninstallTarget): UninstallTarget {
  let kind: UninstallTarget["expected_kind"] = "absent";
  let expected_fingerprint: string | null = null;
  let expected_mode: number | null = null;
  try {
    const stat = fs.statSync(file);
    kind = stat.isDirectory() ? "directory" : "file";
    expected_fingerprint = kind === "file" ? fingerprint(file) : directoryFingerprint(file);
    expected_mode = stat.mode & 0o7777;
  } catch { /* already absent */ }
  return { ...base, expected_fingerprint, expected_mode, expected_kind: kind };
}

function readJsonObject(file: string): { value: Record<string, unknown>; text: string } | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("top level must be an object");
  return { value: value as Record<string, unknown>, text };
}

function hookTarget(host: HostId, cwd: string, env: NodeJS.ProcessEnv | undefined): string {
  return legacyHookPath(host, env);
}

function removeHookEntry(host: HostId, cwd: string, env?: NodeJS.ProcessEnv): UninstallTarget {
  const file = hookTarget(host, cwd, env);
  const shown = display(file, env);
  if (!fs.existsSync(file)) return targetFile(file, { action: "already-absent", host, reason: "hook file absent", path: shown });
  let loaded: { value: Record<string, unknown>; text: string };
  try {
    loaded = readJsonObject(file) || (() => { throw new Error("hook file absent"); })();
  } catch (error) {
    return { action: "conflict", path: shown, host, reason: `hook file unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const result = removeLegacyHooks(host, loaded.value);
    const after = jsonText(result.document);
    if (result.action === "removed" && result.canDelete) {
      return targetFile(file, { action: "remove", path: shown, host, reason: "canonical Baton-owned hook file", before: loaded.text, after: null });
    }
    if (after === loaded.text) return targetFile(file, { action: result.action === "conflict" ? "conflict" : "preserve", path: shown, host, reason: result.action === "conflict" ? "ambiguous hook ownership" : "no Baton-owned handler", before: loaded.text, after: loaded.text });
    return targetFile(file, { action: "update-entry", path: shown, host, reason: "remove Baton-owned handlers and retain unrelated hooks", before: loaded.text, after });
  } catch (error) {
    return { action: "conflict", path: shown, host, reason: `ambiguous hook ownership: ${error instanceof Error ? error.message : String(error)}`, before: loaded.text };
  }
}

function skillTarget(host: HostId | null, cwd: string, env: NodeJS.ProcessEnv | undefined, manifest: InstallManifest | null): UninstallTarget {
  const file = host ? hostSkillDest(host, { cwd, env }) : skillPath(cwd, { env });
  const shown = display(file, env);
  if (!fs.existsSync(file)) return targetFile(file, { action: "already-absent", path: shown, host: host || undefined, reason: "skill absent" });
  const owned = manifestOwnsFile(manifest, file) || legacyOwnsSkill(host, file, cwd, env);
  return targetFile(file, owned
    ? { action: "remove", path: shown, host: host || undefined, reason: manifest ? "manifest fingerprint match" : "strong canonical legacy marker match" }
    : { action: "conflict", path: shown, host: host || undefined, reason: "skill was modified or ownership is ambiguous" });
}

function stateInvalid(message: string): never {
  throw coded(message, UNINSTALL_STATE_INVALID);
}

function directoryEntries(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return stateInvalid(`state directory is unreadable: ${directory}`);
  }
}

function requireDirectory(file: string, label: string): void {
  try {
    if (!fs.statSync(file).isDirectory()) stateInvalid(`${label} is malformed: ${file}`);
  } catch (error) {
    if ((error as { code?: string }).code === UNINSTALL_STATE_INVALID) throw error;
    stateInvalid(`${label} is unreadable: ${file}`);
  }
}

function validateJsonState(file: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    stateInvalid(`${label} is unreadable: ${file}`);
  }
}

function scanJsonStateDirectory(directory: string, label: string): void {
  if (!fs.existsSync(directory)) return;
  requireDirectory(directory, label);
  for (const name of directoryEntries(directory)) {
    const file = path.join(directory, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { stateInvalid(`${label} is unreadable: ${file}`); }
    if (stat!.isDirectory()) continue;
    if (!name.endsWith(".json")) stateInvalid(`${label} contains an unrecognized entry: ${file}`);
    validateJsonState(file, label);
  }
}

const ACTIVE_TICKET_STATUSES = new Set(["reserved", "dispatching", "running", "active"]);

function ticketHost(row: Record<string, unknown>): string {
  const selection = row.selection;
  const selectionHost = selection && typeof selection === "object" && !Array.isArray(selection)
    ? (selection as Record<string, unknown>).host
    : undefined;
  return String(row.target_host || row.dispatch_host || row.host || selectionHost || "").trim().toLowerCase();
}

function activeTickets(cwd: string, env: NodeJS.ProcessEnv | undefined, selected: readonly HostId[], clean: boolean): Array<{ path: string; ticket_id: string; status: string; host: string }> {
  const root = path.join(batonHomeDir(env), WORKSPACES_DIR);
  if (!fs.existsSync(root)) return [];
  requireDirectory(root, "workspace state");
  const names = directoryEntries(root);
  const found: Array<{ path: string; ticket_id: string; status: string; host: string }> = [];
  const selectedSet = new Set(selected);
  for (const name of names) {
    const workspace = path.join(root, name);
    requireDirectory(workspace, "workspace entry");
    const runtimeRoots = [workspace, path.join(workspace, CURRENT_RUNTIME_NAMESPACE)];
    for (const runtimeRoot of runtimeRoots) {
      if (!fs.existsSync(runtimeRoot)) continue;
      if (runtimeRoot !== workspace) requireDirectory(runtimeRoot, "workspace runtime");
      scanJsonStateDirectory(path.join(runtimeRoot, "runs"), "runtime state");
    }
    const dirs = [path.join(workspace, "spawns"), path.join(workspace, CURRENT_RUNTIME_NAMESPACE, "spawns")];
    for (const directory of dirs) {
      if (!fs.existsSync(directory)) continue;
      requireDirectory(directory, "spawn state");
      const files = directoryEntries(directory);
      for (const fileName of files) {
        if (!fileName.endsWith(".json")) stateInvalid(`spawn state contains an unrecognized entry: ${path.join(directory, fileName)}`);
        const file = path.join(directory, fileName);
        const value = validateJsonState(file, "dispatch ticket");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`dispatch ticket is malformed: ${file}`, UNINSTALL_STATE_INVALID);
        const row = value as Record<string, unknown>;
        const status = String(row.status || "").trim().toLowerCase();
        const host = ticketHost(row);
        const id = String(row.id || path.basename(fileName, ".json")).trim();
        const selection = row.selection;
        const selectionHost = selection && typeof selection === "object" && !Array.isArray(selection)
          ? String((selection as Record<string, unknown>).host || "").trim().toLowerCase()
          : "";
        if (!status || !host || !id || !HOST_IDS.includes(host as HostId)
          || (selection !== undefined && (!selection || typeof selection !== "object" || Array.isArray(selection)))
          || (selection && typeof selection === "object" && (selection as Record<string, unknown>).host !== undefined
            && (!selectionHost || !HOST_IDS.includes(selectionHost as HostId) || selectionHost !== host))) {
          throw coded(`dispatch ticket is malformed: ${file}`, UNINSTALL_STATE_INVALID);
        }
        if (ACTIVE_TICKET_STATUSES.has(status) && (clean || selectedSet.has(host as HostId))) found.push({ path: file, ticket_id: id, status, host });
      }
    }
  }
  return found;
}

function addTarget(targets: UninstallTarget[], target: UninstallTarget): void { targets.push(target); }

/** Build a complete, serializable plan without mutating any file. */
export function buildUninstallPlan(options: BuildUninstallPlanOptions): UninstallPlan {
  const env = options.env || process.env;
  const clean = options.clean === true;
  const hosts = (clean ? [...HOST_IDS] : [...new Set(options.hosts || HOST_IDS)]) as HostId[];
  const manifest = readInstallManifest(env);
  // Surgical host uninstall does not touch runtime state and must not be
  // blocked by an unrelated stale/corrupt workspace. Clean is the only mode
  // that performs the global dispatch safety scan.
  const active = clean ? activeTickets(options.cwd, env, hosts, clean) : [];
  if (clean && active.length && !options.dry_run) throw coded(`${UNINSTALL_ACTIVE_TICKETS}: ${active.map((item) => item.ticket_id).join(", ")}`, UNINSTALL_ACTIVE_TICKETS);
  const targets: UninstallTarget[] = [];
  for (const host of clean ? HOST_IDS : hosts) {
    addTarget(targets, removeHookEntry(host, options.cwd, env));
    addTarget(targets, skillTarget(host, options.cwd, env, manifest));
  }
  // Default uninstall removes the selected host integration and the shared
  // Baton skill. Clean adds the remaining global/runtime ownership below.
  if (!clean) addTarget(targets, skillTarget(null, options.cwd, env, manifest));
  if (clean) {
    addTarget(targets, skillTarget(null, options.cwd, env, manifest));
    const home = batonHomeDir(env);
    for (const file of [configPath(options.cwd, { env }), installManifestPath(env)]) {
      addTarget(targets, targetFile(file, { action: fs.existsSync(file) ? "remove" : "already-absent", path: display(file, env), reason: "clean removes Baton-owned global file" }));
    }
    for (const directory of [path.join(home, "cache"), path.join(home, "state"), path.join(home, WORKSPACES_DIR)]) {
      addTarget(targets, targetFile(directory, { action: fs.existsSync(directory) ? "remove" : "already-absent", path: display(directory, env), reason: "clean removes explicit Baton runtime directory" }));
    }
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  return {
    hosts,
    clean,
    dry_run: options.dry_run === true,
    targets,
    active_tickets: active,
    constraints: [
      "preserve unrelated hooks/settings",
      "preserve modified or ambiguous skills",
      "never remove package-manager executable",
      "never recurse outside explicit Baton/host integration paths",
      ...(clean && active.length ? ["blocked by active dispatch tickets; no mutation is permitted"] : []),
    ],
  };
}

function atomicWrite(file: string, text: string, modeBits: number | null = null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: modeBits ?? 0o600 });
    if (modeBits !== null) fs.chmodSync(temporary, modeBits);
    fs.renameSync(temporary, file);
  }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function resolvePlanPath(target: UninstallTarget, env?: NodeJS.ProcessEnv): string {
  const displayed = target.path;
  const file = displayed.startsWith("~/") ? path.join(hostHome(env), displayed.slice(2)) : path.resolve(displayed);
  const home = path.resolve(hostHome(env));
  const relative = path.relative(home, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw coded(`uninstall plan escapes the user home: ${displayed}`, UNINSTALL_STATE_INVALID);
  }
  return file;
}

function validateTarget(target: UninstallTarget, env?: NodeJS.ProcessEnv): void {
  if (!["remove", "update-entry"].includes(target.action)) return;
  const file = resolvePlanPath(target, env);
  const exists = fs.existsSync(file);
  if (target.expected_kind === "absent") {
    if (exists) throw coded(`UNINSTALL_PLAN_STALE: target appeared: ${target.path}`, "UNINSTALL_PLAN_STALE");
    return;
  }
  if (!exists) throw coded(`UNINSTALL_PLAN_STALE: target disappeared: ${target.path}`, "UNINSTALL_PLAN_STALE");
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { throw coded(`UNINSTALL_PLAN_STALE: target unreadable: ${target.path}`, "UNINSTALL_PLAN_STALE"); }
  const kind = stat.isDirectory() ? "directory" : "file";
  if (kind !== target.expected_kind) throw coded(`UNINSTALL_PLAN_STALE: target type changed: ${target.path}`, "UNINSTALL_PLAN_STALE");
  if (target.expected_mode !== null && (stat.mode & 0o7777) !== target.expected_mode) throw coded(`UNINSTALL_PLAN_STALE: target mode changed: ${target.path}`, "UNINSTALL_PLAN_STALE");
  const currentFingerprint = kind === "file" ? fingerprint(file) : directoryFingerprint(file);
  if (target.expected_fingerprint === null || currentFingerprint !== target.expected_fingerprint) {
    throw coded(`UNINSTALL_PLAN_STALE: target bytes changed: ${target.path}`, "UNINSTALL_PLAN_STALE");
  }
}

export function applyUninstallPlan(plan: UninstallPlan, options: ApplyUninstallPlanOptions = {}): UninstallPlan {
  if (plan.dry_run || options.dry_run) return plan;
  // Revalidate the complete mutation set before changing any target. This is
  // the TOCTOU boundary: a later conflict cannot leave earlier files removed.
  for (const target of plan.targets) validateTarget(target, options.env);
  for (const target of plan.targets) {
    if (target.action === "remove") {
      const file = resolvePlanPath(target, options.env);
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        // Never follow a user-created symlink while removing a directory.
        if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(file, { recursive: true, force: true });
        else fs.unlinkSync(file);
      }
    } else if (target.action === "update-entry" && target.after != null) {
      const file = resolvePlanPath(target, options.env);
      atomicWrite(file, target.after, target.expected_mode ?? null);
    }
  }
  return plan;
}
