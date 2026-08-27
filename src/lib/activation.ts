import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseCliId, type CliId } from "../adapters/registry.js";
import { parseToml, stringifyToml } from "./toml.js";
import {
  activationLockPath,
  batonHomeDir,
  configPath,
  globalActivationLockPath,
  projectSettingsPath,
  spawnsDir,
  WORKSPACES_DIR,
  CURRENT_RUNTIME_NAMESPACE,
} from "./paths.js";
import type { CodedError, UnknownRecord, WritableLike } from "../types.js";
import { acquireOwnedLock, type OwnedLock } from "./owned-lock.js";

export type ActivationScope = "all" | "curproject";
export type ActivationProvenance = "global" | "project" | "global-and-project" | "invalid";

export interface ActivationState {
  host: CliId;
  valid: boolean;
  enabled: boolean;
  global_enabled: boolean | null;
  project_enabled: boolean | null;
  effective_enabled: boolean;
  provenance: ActivationProvenance;
  reason: string | null;
  project_settings_path: string;
}

export interface DrainingTicket {
  workspace_id: string;
  path: string;
  ticket_id: string;
  status: string;
  host: string;
}

interface ActivationOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function invalid(message: string, code = "ACTIVATION_INVALID"): Error {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

function hostValue(host: string | undefined): CliId {
  try {
    return parseCliId(String(host || ""));
  } catch {
    throw invalid(`invalid activation host: ${host || "<empty>"}`, "HOST_REQUIRED");
  }
}

function readTomlFile(file: string): UnknownRecord {
  try {
    return parseToml(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    throw invalid(`activation settings are unreadable: ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function globalEnabled(host: CliId, env?: NodeJS.ProcessEnv): boolean {
  const file = configPath("", { env });
  if (!fs.existsSync(file)) throw invalid(`global Baton config is missing: ${file}`);
  const raw = readTomlFile(file);
  const cli = record(raw.cli);
  const profile = cli ? record(cli[host]) : null;
  if (!cli || !profile || typeof profile.enabled !== "boolean") {
    throw invalid(`global activation profile is missing or malformed for ${host}`);
  }
  return profile.enabled;
}

function projectEnabled(cwd: string, host: CliId, env?: NodeJS.ProcessEnv): boolean {
  const file = projectSettingsPath(cwd, env);
  if (!fs.existsSync(file)) return true;
  const raw = readTomlFile(file);
  if (!Object.hasOwn(raw, "cli")) return true;
  const cli = record(raw.cli);
  if (!cli) throw invalid(`project activation settings are malformed: ${file}`);
  const profile = cli[host];
  if (profile === undefined) return true;
  const table = record(profile);
  if (!table || typeof table.enabled !== "boolean") {
    throw invalid(`project activation profile is malformed for ${host}: ${file}`);
  }
  return table.enabled;
}

export function resolveActivation(cwd: string, { env = process.env, host }: ActivationOptions = {}): ActivationState {
  const selectedHost = hostValue(host);
  const projectPath = projectSettingsPath(cwd, env);
  try {
    const global = globalEnabled(selectedHost, env);
    const project = projectEnabled(cwd, selectedHost, env);
    const effective = global && project;
    return {
      host: selectedHost,
      valid: true,
      enabled: effective,
      global_enabled: global,
      project_enabled: project,
      effective_enabled: effective,
      provenance: global && project ? "global-and-project" : global ? "project" : "global",
      reason: effective ? null : !global ? "GLOBAL_DISABLED" : "PROJECT_DISABLED",
      project_settings_path: projectPath,
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      host: selectedHost,
      valid: false,
      enabled: false,
      global_enabled: null,
      project_enabled: null,
      effective_enabled: false,
      provenance: "invalid",
      reason,
      project_settings_path: projectPath,
    };
  }
}

function writeTomlAtomically(file: string, value: UnknownRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, stringifyToml(value), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeProjectEnabled(cwd: string, host: CliId, enabled: boolean, env?: NodeJS.ProcessEnv): string {
  const file = projectSettingsPath(cwd, env);
  const raw = fs.existsSync(file) ? readTomlFile(file) : {};
  const cli = record(raw.cli) || {};
  const existing = record(cli[host]) || {};
  cli[host] = { ...existing, enabled };
  raw.cli = cli;
  writeTomlAtomically(file, raw);
  return file;
}

function writeGlobalEnabled(cwd: string, host: CliId, enabled: boolean, env?: NodeJS.ProcessEnv): string {
  const file = configPath(cwd, { env });
  const raw = readTomlFile(file);
  const cli = record(raw.cli);
  const profile = cli ? record(cli[host]) : null;
  if (!cli || !profile || typeof profile.enabled !== "boolean") {
    throw invalid(`global activation profile is missing or malformed for ${host}`);
  }
  // Activation is not the config-schema migration boundary. Mutate only the
  // requested raw field so a legacy subagent_models array survives unchanged
  // until a successful `baton config` explicitly writes coding_models.
  profile.enabled = enabled;
  cli[host] = profile;
  raw.cli = cli;
  writeTomlAtomically(file, raw);
  return file;
}

const ACTIVE_STATUSES = new Set(["reserved", "dispatching", "running"]);
const VALID_TICKET_STATUSES = new Set([
  "queued", "reserved", "dispatching", "running", "completed", "errored", "timed_out", "closed", "done",
]);

function ticketHost(value: UnknownRecord): string | null {
  const selection = record(value.selection);
  return String(value.target_host || value.dispatch_host || value.host || selection?.host || "").trim().toLowerCase() || null;
}

function scanSpawnDirectory(directory: string, workspaceId: string, host: CliId): DrainingTicket[] {
  if (!fs.existsSync(directory)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch (cause) {
    throw invalid(`dispatch state is unreadable: ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const draining: DrainingTicket[] = [];
  for (const name of files) {
    const file = path.join(directory, name);
    let value: UnknownRecord;
    try {
      value = record(JSON.parse(fs.readFileSync(file, "utf8"))) || (() => { throw new Error("ticket is not an object"); })();
    } catch (cause) {
      throw invalid(`dispatch ticket is unreadable: ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const status = String(value.status || "").trim().toLowerCase();
    const ticketId = String(value.id || path.basename(name, ".json")).trim();
    const actualHost = ticketHost(value);
    if (!status || !VALID_TICKET_STATUSES.has(status) || !ticketId || !actualHost) {
      throw invalid(`dispatch ticket is malformed: ${file}`);
    }
    if (actualHost === host && ACTIVE_STATUSES.has(status)) {
      draining.push({ workspace_id: workspaceId, path: file, ticket_id: ticketId, status, host: actualHost });
    }
  }
  return draining;
}

export function listDrainingTickets(
  cwd: string,
  host: string,
  { scope = "all", env = process.env }: { scope?: ActivationScope; env?: NodeJS.ProcessEnv } = {},
): DrainingTicket[] {
  const selectedHost = hostValue(host);
  if (scope === "curproject") {
    return scanSpawnDirectory(spawnsDir(cwd, env), path.basename(path.dirname(path.dirname(spawnsDir(cwd, env)))), selectedHost);
  }
  const root = path.join(batonHomeDir(env), WORKSPACES_DIR);
  if (!fs.existsSync(root)) return [];
  let workspaceNames: string[];
  try {
    workspaceNames = fs.readdirSync(root);
  } catch (cause) {
    throw invalid(`workspace dispatch state is unreadable: ${root}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const draining: DrainingTicket[] = [];
  for (const name of workspaceNames) {
    const workspace = path.join(root, name);
    try {
      if (!fs.statSync(workspace).isDirectory()) throw new Error("workspace entry is not a directory");
    } catch (cause) {
      throw invalid(`workspace dispatch state is malformed: ${workspace}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const runtime = path.join(workspace, CURRENT_RUNTIME_NAMESPACE);
    if (fs.existsSync(runtime) && !fs.statSync(runtime).isDirectory()) throw invalid(`workspace runtime is malformed: ${runtime}`);
    draining.push(...scanSpawnDirectory(path.join(runtime, "spawns"), name, selectedHost));
  }
  return draining;
}

export interface ActivationLockOptions {
  /** Host lock is required by reservation and all activation mutations. */
  host?: string;
  scope?: "project" | "global" | "both";
  operation?: string;
  /** Test/runtime tuning; production defaults retain a 60 second lease. */
  leaseMs?: number;
  staleMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  refreshIntervalMs?: number;
}

function activationFiles(cwd: string, env: NodeJS.ProcessEnv | undefined, options: ActivationLockOptions): string[] {
  const scope = options.scope || (options.host ? "both" : "project");
  const files: string[] = [];
  if ((scope === "global" || scope === "both") && options.host) files.push(globalActivationLockPath(options.host, env));
  if (scope === "project" || scope === "both") files.push(activationLockPath(cwd, env, options.host));
  if (!files.length) throw invalid("activation lock requires a scope and host", "ACTIVATION_LOCK_INVALID");
  return files;
}

/**
 * Serialize activation changes and reservations. When a host is supplied the
 * fixed order is global host lock first, then project lock. This is deliberate:
 * every caller crossing both scopes must use the same order.
 */
export function withActivationLock<T>(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  fn: () => T,
  options: ActivationLockOptions = {},
): T {
  const files = activationFiles(cwd, env, options);
  const acquired: OwnedLock[] = [];
  try {
    for (const file of files) {
      try { acquired.push(acquireOwnedLock(file, { ...options, operation: options.operation || "activation" })); }
      catch (error) {
        if ((error as CodedError).code === "LOCK_BUSY") throw invalid(`activation lock is busy: ${file}`, "ACTIVATION_LOCK_BUSY");
        throw error;
      }
    }
    return fn();
  } finally {
    for (const lock of acquired.reverse()) lock.release();
  }
}

/** Await-safe activation transaction. The lease is refreshed while user code awaits. */
export async function withActivationLockAsync<T>(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  fn: (locks: readonly OwnedLock[]) => Promise<T>,
  options: ActivationLockOptions = {},
): Promise<T> {
  const files = activationFiles(cwd, env, options);
  const acquired: OwnedLock[] = [];
  try {
    for (const file of files) {
      try { acquired.push(acquireOwnedLock(file, { ...options, operation: options.operation || "activation" })); }
      catch (error) {
        if ((error as CodedError).code === "LOCK_BUSY") throw invalid(`activation lock is busy: ${file}`, "ACTIVATION_LOCK_BUSY");
        throw error;
      }
    }
  } catch (error) {
    for (const lock of [...acquired].reverse()) lock.release();
    throw error;
  }
  const interval = options.refreshIntervalMs ?? Math.max(1, Math.floor((options.leaseMs ?? 60_000) / 3));
  const timer = setInterval(() => { for (const lock of acquired) lock.refresh(); }, interval);
  timer.unref?.();
  try { return await fn(acquired); } finally {
    clearInterval(timer);
    for (const lock of [...acquired].reverse()) lock.release();
  }
}

export interface ActivationCommandOptions {
  cwd: string;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw invalid(`${name} requires a value`, "ACTIVATION_USAGE");
  return value;
}

export function runActivation(args: string[], { cwd, stdout, env = process.env }: ActivationCommandOptions): number {
  const action = args[0];
  const scope = args[1] as ActivationScope | undefined;
  if ((action !== "enable" && action !== "disable") || (scope !== "all" && scope !== "curproject")) {
    throw invalid("usage: baton enable|disable all|curproject --host HOST [--json]", "ACTIVATION_USAGE");
  }
  const host = hostValue(flagValue(args, "--host"));
  const json = args.includes("--json");
  const result = withActivationLock(cwd, env, () => {
    const before = resolveActivation(cwd, { host, env });
    if (!before.valid) {
      throw invalid(`cannot change activation while state is invalid: ${before.reason || "unknown"}`);
    }
    const draining = action === "disable" ? listDrainingTickets(cwd, host, { scope, env }) : [];
    const pathWritten = scope === "all"
      ? writeGlobalEnabled(cwd, host, action === "enable", env)
      : writeProjectEnabled(cwd, host, action === "enable", env);
    return { draining, pathWritten };
  }, { host, scope: "both" });
  const { draining, pathWritten } = result;
  const activation = resolveActivation(cwd, { host, env });
  const payload = { action, scope, host, path: pathWritten, activation, draining_tickets: draining, draining_count: draining.length };
  if (json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else stdout.write(`${action} ${scope}: ${host} (${activation.effective_enabled ? "enabled" : "disabled"}); draining=${draining.length}\n`);
  return 0;
}
