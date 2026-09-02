import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ADAPTER_MANIFEST_SCHEMA, validateAdapterManifest } from "../../adapters/sdk.js";
import { batonHomeDir, packageRoot, displayHomePath } from "../paths.js";
import {
  buildInstallManifest,
  directoryFingerprint,
  manifestOwnsDirectory,
  readInstallManifest,
  writeInstallManifest,
  type AdapterOwnership,
} from "./manifest.js";
import { readJsonFile } from "../json-utils.js";

export interface BundledAdapterPackage {
  id: string;
  source: string;
}

export interface AdapterInstallResult {
  installed: string[];
  updated: string[];
  kept: string[];
  conflicts: string[];
  ownership: AdapterOwnership[];
}

function adapterRoot(env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), "adapters");
}

export function adapterInstallDir(id: string, env?: NodeJS.ProcessEnv): string {
  const normalized = String(id || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized)) throw new Error(`invalid adapter id: ${id || "<empty>"}`);
  return path.join(adapterRoot(env), normalized);
}

function readBundledManifest(directory: string): { id: string; manifest: ReturnType<typeof validateAdapterManifest> } | null {
  const file = path.join(directory, "adapter.json");
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = readJsonFile(file);
  } catch (error) {
    throw new Error(`ADAPTER_PACKAGE_INVALID: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = validateAdapterManifest(raw, directory);
  if (manifest.schema !== ADAPTER_MANIFEST_SCHEMA) throw new Error(`ADAPTER_PACKAGE_INVALID: unsupported schema in ${file}`);
  return { id: manifest.adapter.id, manifest };
}

/** Enumerate adapter packages shipped with this Baton distribution. */
export function bundledAdapterPackages(): BundledAdapterPackage[] {
  const root = path.join(packageRoot(), "adapters");
  if (!fs.existsSync(root)) return [];
  const packages: BundledAdapterPackage[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const loaded = readBundledManifest(directory);
    if (!loaded) continue;
    if (loaded.id !== entry.name.toLowerCase()) {
      throw new Error(`ADAPTER_PACKAGE_INVALID: directory ${entry.name} does not match ${loaded.id}`);
    }
    packages.push({ id: loaded.id, source: directory });
  }
  return packages;
}

function display(file: string, env?: NodeJS.ProcessEnv): string {
  return displayHomePath(file, { env });
}

function copyPackage(source: string, destination: string): void {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true });
    const catalog = path.join(temporary, "catalog.mjs");
    if (fs.existsSync(catalog)) fs.chmodSync(catalog, 0o755);
    if (fs.existsSync(destination)) {
      const existing = fs.lstatSync(destination);
      if (existing.isDirectory() && !existing.isSymbolicLink()) fs.rmSync(destination, { recursive: true, force: true });
      else fs.unlinkSync(destination);
    }
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Install/update only the adapter packages shipped by this checkout.
 * Existing packages are replaced only when the install manifest still owns
 * their exact directory bytes; modified or unowned packages are preserved.
 */
export function installBundledAdapters(
  env: NodeJS.ProcessEnv = process.env,
  packages: readonly BundledAdapterPackage[] = bundledAdapterPackages(),
): AdapterInstallResult {
  const validated = packages.map((adapter) => {
    const source = path.resolve(adapter.source);
    const sourceFingerprint = directoryFingerprint(source);
    if (!sourceFingerprint) throw new Error(`ADAPTER_PACKAGE_INVALID: unreadable package ${source}`);
    return { adapter, source, sourceFingerprint };
  });
  const prior = readInstallManifest(env);
  const result: AdapterInstallResult = { installed: [], updated: [], kept: [], conflicts: [], ownership: [] };
  for (const { adapter, source, sourceFingerprint } of validated) {
    const destination = adapterInstallDir(adapter.id, env);
    const shown = display(destination, env);
    if (!fs.existsSync(destination)) {
      copyPackage(source, destination);
      result.installed.push(`installed adapter ${adapter.id} at ${shown}`);
      result.ownership.push({ id: adapter.id, path: destination });
      continue;
    }
    const owned = manifestOwnsDirectory(prior, destination);
    const destinationFingerprint = directoryFingerprint(destination);
    if (!owned) {
      result.conflicts.push(`preserved adapter ${adapter.id} at ${shown} (modified or ownership is ambiguous)`);
      continue;
    }
    if (destinationFingerprint === sourceFingerprint) {
      result.kept.push(`kept adapter ${adapter.id} at ${shown}`);
      result.ownership.push({ id: adapter.id, path: destination });
      continue;
    }
    copyPackage(source, destination);
    result.updated.push(`updated adapter ${adapter.id} at ${shown}`);
    result.ownership.push({ id: adapter.id, path: destination });
  }
  return result;
}

/** Install bundled adapters and refresh the global ownership record. */
export function installBundledAdaptersAndRecord(
  cwd: string,
  selectedHosts: readonly import("../../adapters/contract.js").CliId[],
  env: NodeJS.ProcessEnv = process.env,
): AdapterInstallResult {
  const result = installBundledAdapters(env);
  writeInstallManifest(buildInstallManifest(cwd, selectedHosts, env, result.ownership), env);
  return result;
}
