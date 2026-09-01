import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
export {
  EXACT_EXECUTION_ROOT_IDENTITY_FIELDS,
  extractExactExecutionRootIdentity,
  normalizeExactExecutionRootIdentity,
  sameExactExecutionRootIdentity,
  type ExactExecutionRootAcknowledgement,
  type ExactExecutionRootCapability,
  type ExactExecutionRootIdentity,
  type ExactExecutionRootRequest,
} from "./contract.js";

/** Public Adapter SDK contract. Keep this file free of provider-specific names. */
export const ADAPTER_SDK_VERSION = "1.0" as const;
export const ADAPTER_MANIFEST_SCHEMA = 1 as const;

export type AdapterId = string;
export type ExecutionHandleKind = string;

export interface AdapterModel {
  id: string;
  model?: string;
  display_name?: string;
  description?: string;
  hidden?: boolean;
  reasoning_efforts?: Array<{ id: string; description?: string }>;
  default_reasoning_effort?: string | null;
  input_modalities?: string[];
  additional_speed_tiers?: string[];
  service_tiers?: Array<{ id: string; name?: string; description?: string }>;
  default_service_tier?: string | null;
  is_default?: boolean;
  [key: string]: unknown;
}

export interface AdapterCatalog {
  adapter_id: AdapterId;
  version: string | null;
  models: AdapterModel[];
  capabilities?: Record<string, unknown>;
}

/**
 * Manifest quota contract. The concurrent value is a per-root-tree
 * subagent limit and excludes the root agent itself.
 */
export interface AdapterManifestQuota {
  max_concurrent_subagents?: number;
  max_depth?: number;
  backpressure?: string;
}

export interface AdapterManifest {
  schema: typeof ADAPTER_MANIFEST_SCHEMA;
  adapter: {
    id: AdapterId;
    display_name: string;
    package_name: string;
    package_version: string;
    sdk_version: string;
  };
  catalog: {
    command: string;
    args: string[];
    protocol: string;
    timeout_ms?: number;
  };
  invocation: {
    signal: string;
    environment?: string;
  };
  native: {
    execution_handle_kind: ExecutionHandleKind;
    /** Omitted means unsupported/unknown and never authorizes isolated dispatch. */
    exact_execution_root?: boolean;
  };
  runtime_skill: { source: string; destination: string };
  quota: AdapterManifestQuota;
}

export interface DiscoveredAdapter {
  readonly manifest: AdapterManifest;
  readonly directory: string;
  readonly discoverModels: (options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<AdapterCatalog>;
}

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const RELATIVE = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..") && !value.startsWith("./") && !value.startsWith("../") && !value.includes("\0");
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`ADAPTER_MANIFEST_INVALID: ${label} must be an object`);
  return value as Record<string, unknown>;
}
function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`ADAPTER_MANIFEST_INVALID: ${label} must be a non-empty string`);
  return value.trim();
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`ADAPTER_MANIFEST_INVALID: unknown ${label} field ${key}`);
}

const MAX_CONCURRENT_SUBAGENT_KEYS = [
  "max_concurrent_subagents",
  // Compatibility spellings accepted for schema 1 manifests. They are
  // normalized immediately and never appear in the returned manifest.
  "max_concurrent",
  "maxConcurrentSubagents",
  "maxConcurrent",
] as const;

/** Normalize the version-1 quota aliases into the unambiguous public field. */
export function normalizeAdapterManifestQuota(value: unknown): AdapterManifestQuota {
  const q = object(value, "quota");
  exactKeys(q, [...MAX_CONCURRENT_SUBAGENT_KEYS, "max_depth", "backpressure"], "quota");

  const supplied = MAX_CONCURRENT_SUBAGENT_KEYS.filter((key) => q[key] !== undefined);
  for (const key of supplied) {
    if (!Number.isInteger(q[key]) || Number(q[key]) < 1) {
      throw new Error(`ADAPTER_MANIFEST_INVALID: quota.${key} must be a positive integer`);
    }
  }
  const distinct = [...new Set(supplied.map((key) => Number(q[key])))];
  if (distinct.length > 1) {
    throw new Error("ADAPTER_MANIFEST_INVALID: quota concurrent subagent aliases conflict");
  }
  if (q.max_depth !== undefined && (!Number.isInteger(q.max_depth) || Number(q.max_depth) < 1)) {
    throw new Error("ADAPTER_MANIFEST_INVALID: quota.max_depth must be a positive integer");
  }
  return {
    ...(distinct.length ? { max_concurrent_subagents: distinct[0] } : {}),
    ...(q.max_depth === undefined ? {} : { max_depth: q.max_depth as number }),
    ...(q.backpressure === undefined ? {} : { backpressure: stringField(q.backpressure, "quota.backpressure") }),
  };
}

export function validateAdapterManifest(value: unknown, directory: string): AdapterManifest {
  const raw = object(value, "root");
  exactKeys(raw, ["schema", "adapter", "catalog", "invocation", "native", "runtime_skill", "quota"], "root");
  if (raw.schema !== ADAPTER_MANIFEST_SCHEMA) throw new Error(`ADAPTER_MANIFEST_INVALID: unsupported schema ${String(raw.schema)}`);
  const a = object(raw.adapter, "adapter");
  exactKeys(a, ["id", "display_name", "package_name", "package_version", "sdk_version"], "adapter");
  const id = stringField(a.id, "adapter.id").toLowerCase();
  if (!ID.test(id)) throw new Error("ADAPTER_MANIFEST_INVALID: adapter.id must be a stable lowercase id");
  const sdk = stringField(a.sdk_version, "adapter.sdk_version");
  if (sdk.split(".")[0] !== ADAPTER_SDK_VERSION.split(".")[0]) throw new Error(`ADAPTER_MANIFEST_INCOMPATIBLE: sdk ${sdk}`);
  const c = object(raw.catalog, "catalog"); exactKeys(c, ["command", "args", "protocol", "timeout_ms"], "catalog");
  const command = stringField(c.command, "catalog.command");
  if (!RELATIVE(command) && !path.isAbsolute(command)) throw new Error("ADAPTER_MANIFEST_INVALID: catalog.command must be a path");
  if (!Array.isArray(c.args) || c.args.some((v) => typeof v !== "string")) throw new Error("ADAPTER_MANIFEST_INVALID: catalog.args must be strings");
  const protocol = stringField(c.protocol, "catalog.protocol");
  if (!["json", "json-lines"].includes(protocol)) throw new Error(`ADAPTER_MANIFEST_INVALID: unsupported catalog protocol ${protocol}`);
  if (c.timeout_ms !== undefined && (!Number.isInteger(c.timeout_ms) || Number(c.timeout_ms) <= 0)) throw new Error("ADAPTER_MANIFEST_INVALID: catalog.timeout_ms");
  const i = object(raw.invocation, "invocation"); exactKeys(i, ["signal", "environment"], "invocation");
  const n = object(raw.native, "native"); exactKeys(n, ["execution_handle_kind", "exact_execution_root"], "native");
  if (n.exact_execution_root !== undefined && typeof n.exact_execution_root !== "boolean") {
    throw new Error("ADAPTER_MANIFEST_INVALID: native.exact_execution_root must be boolean");
  }
  const s = object(raw.runtime_skill, "runtime_skill"); exactKeys(s, ["source", "destination"], "runtime_skill");
  const source = stringField(s.source, "runtime_skill.source");
  const destination = stringField(s.destination, "runtime_skill.destination");
  if (!RELATIVE(source) || !RELATIVE(destination)) throw new Error("ADAPTER_MANIFEST_INVALID: runtime skill paths must be relative and traversal-free");
  const quota = normalizeAdapterManifestQuota(raw.quota);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error("ADAPTER_MANIFEST_INVALID: adapter directory missing");
  return { schema: 1, adapter: { id, display_name: stringField(a.display_name, "adapter.display_name"), package_name: stringField(a.package_name, "adapter.package_name"), package_version: stringField(a.package_version, "adapter.package_version"), sdk_version: sdk }, catalog: { command, args: c.args as string[], protocol, ...(c.timeout_ms === undefined ? {} : { timeout_ms: c.timeout_ms as number }) }, invocation: { signal: stringField(i.signal, "invocation.signal"), ...(i.environment === undefined ? {} : { environment: stringField(i.environment, "invocation.environment") }) }, native: { execution_handle_kind: stringField(n.execution_handle_kind, "native.execution_handle_kind"), ...(n.exact_execution_root === undefined ? {} : { exact_execution_root: n.exact_execution_root as boolean }) }, runtime_skill: { source, destination }, quota };
}

function manifestDirectories(env: NodeJS.ProcessEnv): string[] {
  const explicit = String(env.BATON_ADAPTER_PATHS || "").trim();
  if (explicit) return explicit.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  const root = path.join(env.HOME || env.USERPROFILE || os.homedir(), ".baton", "adapters");
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)); } catch { return []; }
}

export function discoverAdapterManifests(env: NodeJS.ProcessEnv = process.env): AdapterManifest[] {
  const found: AdapterManifest[] = []; const ids = new Set<string>();
  for (const directory of manifestDirectories(env).sort()) {
    const file = path.join(directory, "adapter.json");
    if (!fs.existsSync(file)) throw new Error(`ADAPTER_MANIFEST_INVALID: missing ${file}`);
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new Error(`ADAPTER_MANIFEST_INVALID: ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    const manifest = validateAdapterManifest(parsed, directory);
    if (ids.has(manifest.adapter.id)) throw new Error(`ADAPTER_DUPLICATE: ${manifest.adapter.id}`);
    ids.add(manifest.adapter.id); found.push(manifest);
  }
  return found;
}

export function discoverAdapters(env: NodeJS.ProcessEnv = process.env): DiscoveredAdapter[] {
  const directories = manifestDirectories(env);
  return discoverAdapterManifests(env).map((manifest) => {
    const directory = directories.find((d) => { try { const parsed = JSON.parse(fs.readFileSync(path.join(d, "adapter.json"), "utf8")); return validateAdapterManifest(parsed, d).adapter.id === manifest.adapter.id; } catch { return false; } })!;
    return { manifest, directory, discoverModels: (options = {}) => runCatalog(manifest, directory, options) };
  });
}

async function runCatalog(manifest: AdapterManifest, directory: string, options: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<AdapterCatalog> {
  const command = path.isAbsolute(manifest.catalog.command) ? manifest.catalog.command : path.join(directory, manifest.catalog.command);
  const args = manifest.catalog.args.map((arg) => arg.replaceAll("{cwd}", options.cwd || process.cwd()));
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: string[] = []; const err: string[] = []; const timer = setTimeout(() => { child.kill(); reject(new Error("ADAPTER_CATALOG_TIMEOUT")); }, manifest.catalog.timeout_ms || 15000);
    child.stdout.on("data", (v) => out.push(String(v))); child.stderr.on("data", (v) => err.push(String(v)));
    child.once("error", (e) => { clearTimeout(timer); reject(new Error(`ADAPTER_CATALOG_FAILED: ${e.message}`)); });
    child.once("close", (code) => { clearTimeout(timer); if (code !== 0) return reject(new Error(`ADAPTER_CATALOG_FAILED: ${err.join("").trim() || code}`)); try { const parsed = JSON.parse(out.join("")); const row = object(parsed, "catalog response"); if (row.adapter_id !== manifest.adapter.id || !Array.isArray(row.models)) throw new Error("catalog response must contain matching adapter_id and models"); resolve({ adapter_id: manifest.adapter.id, version: row.version == null ? null : String(row.version), models: row.models as AdapterModel[], ...(row.capabilities && typeof row.capabilities === "object" ? { capabilities: row.capabilities as Record<string, unknown> } : {}) }); } catch (e) { reject(new Error(`ADAPTER_CATALOG_INVALID: ${e instanceof Error ? e.message : String(e)}`)); } });
  });
}
