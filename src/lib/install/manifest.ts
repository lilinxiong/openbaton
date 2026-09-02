import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { batonHomeDir, skillPath } from "../paths.js";
import { hostSkillFiles, hostIds, type HostId } from "../hosts.js";
import { readJsonFile, sha256Hex, writeJsonAtomic } from "../json-utils.js";

export const INSTALL_MANIFEST_SCHEMA = 1 as const;
export const INSTALL_MANIFEST_NAME = "install-manifest.json";

export type ManifestFileKind = "shared-runtime-skill" | "host-skill" | "adapter-package";

export interface InstallManifestFile {
  path: string;
  kind: ManifestFileKind;
  host: HostId | null;
  /** Stable adapter id for adapter-package entries; null for skills. */
  adapter?: string | null;
  fingerprint: string;
}

export interface AdapterOwnership {
  id: string;
  path: string;
}

export interface InstallManifest {
  schema: typeof INSTALL_MANIFEST_SCHEMA;
  generated_at: string;
  files: InstallManifestFile[];
}

function sameFiles(left: InstallManifestFile[] | undefined, right: InstallManifestFile[]): boolean {
  if (!left) return false;
  const normalize = (files: InstallManifestFile[]) => files
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      host: file.host,
      adapter: file.adapter ?? null,
      fingerprint: file.fingerprint,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function digestFile(file: string): string | null {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function normalizedPath(file: string): string {
  return path.resolve(file);
}

/** Stable recursive fingerprint for an installed adapter package directory. */
export function directoryFingerprint(directory: string): string | null {
  try {
    const rows: string[] = [];
    const visit = (root: string, relative: string): void => {
      for (const name of fs.readdirSync(root).sort()) {
        const file = path.join(root, name);
        const rel = path.join(relative, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) rows.push(`link:${rel}:${fs.readlinkSync(file)}`);
        else if (stat.isDirectory()) {
          rows.push(`dir:${rel}:${stat.mode & 0o7777}`);
          visit(file, rel);
        } else {
          rows.push(`file:${rel}:${stat.mode & 0o7777}:${digestFile(file) || "unreadable"}`);
        }
      }
    };
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    visit(directory, "");
    return sha256Hex(rows.join("\n"));
  } catch {
    return null;
  }
}

export function installManifestPath(env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), INSTALL_MANIFEST_NAME);
}

export function fileFingerprint(file: string): string | null {
  return digestFile(normalizedPath(file));
}


function validHost(value: string): value is HostId {
  // Ownership records must remain readable even when an adapter package is
  // currently modified, missing, or being removed. Consulting the dynamic
  // registry here would parse that package recursively and turn a safe
  // ownership conflict into an unrelated manifest error.
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value);
}

function priorOwnedFile(
  prior: InstallManifest | null | undefined,
  file: string,
  kind: ManifestFileKind,
  host: HostId | null,
): InstallManifestFile | undefined {
  const dest = normalizedPath(file);
  return prior?.files.find((entry) =>
    entry.path === dest && entry.kind === kind && entry.host === host
  );
}

function recordSkillFile(
  files: InstallManifestFile[],
  file: string,
  kind: Extract<ManifestFileKind, "shared-runtime-skill" | "host-skill">,
  host: HostId | null,
  prior: InstallManifest | null | undefined,
  skipped: Set<string>,
): void {
  const dest = normalizedPath(file);
  if (skipped.has(dest)) {
    const owned = priorOwnedFile(prior, dest, kind, host);
    if (owned) files.push({ path: dest, kind, host, fingerprint: owned.fingerprint });
    return;
  }
  const fingerprint = digestFile(dest);
  if (fingerprint) {
    files.push({ path: dest, kind, host, fingerprint });
  }
}

/** Build a non-secret ownership snapshot for an installation. */
export function buildInstallManifest(
  cwd: string,
  selectedHosts?: readonly HostId[],
  env?: NodeJS.ProcessEnv,
  adapterPackages?: readonly AdapterOwnership[],
  skippedFiles?: readonly string[],
): InstallManifest {
  const hosts = [...new Set(selectedHosts || hostIds(env))].filter((host): host is HostId => validHost(host));
  const prior = readInstallManifest(env);
  const selected = new Set(hosts);
  const skipped = new Set((skippedFiles || []).map(normalizedPath));
  const files: InstallManifestFile[] = (prior?.files || []).filter((entry) =>
    entry.kind === "adapter-package" || (entry.host !== null && !selected.has(entry.host))
  );
  recordSkillFile(files, skillPath(cwd, { env }), "shared-runtime-skill", null, prior, skipped);
  for (const host of hosts) {
    for (const file of hostSkillFiles(host, { cwd, env })) {
      recordSkillFile(files, file, "host-skill", host, prior, skipped);
    }
  }
  for (const adapter of adapterPackages || []) {
    const id = String(adapter.id || "").trim().toLowerCase();
    const file = normalizedPath(adapter.path);
    const packageFingerprint = directoryFingerprint(file);
    if (!id || !packageFingerprint) continue;
    files.push({ path: file, kind: "adapter-package", host: null, adapter: id, fingerprint: packageFingerprint });
  }
  const byPath = new Map<string, InstallManifestFile>();
  for (const file of files) byPath.set(file.path, file);
  const entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema: INSTALL_MANIFEST_SCHEMA,
    // Keep a no-op update byte-stable. Ownership timestamps are useful when
    // the owned set changes, but should not make every repeated update look
    // like a new installation.
    generated_at: sameFiles(prior?.files, entries)
      ? prior!.generated_at
      : new Date().toISOString(),
    files: entries,
  };
}

function normalizeManifest(value: unknown): InstallManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("install manifest must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== INSTALL_MANIFEST_SCHEMA || typeof raw.generated_at !== "string" || Number.isNaN(Date.parse(raw.generated_at)) || !Array.isArray(raw.files)) {
    throw new Error("install manifest schema is invalid");
  }
  const files = raw.files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("install manifest file entry is invalid");
    const row = item as Record<string, unknown>;
    const host = row.host == null ? null : String(row.host).trim().toLowerCase();
    const kind = String(row.kind);
    const adapter = row.adapter == null ? null : String(row.adapter).trim().toLowerCase();
    if (typeof row.path !== "string" || !path.isAbsolute(row.path) || !["shared-runtime-skill", "host-skill", "adapter-package"].includes(kind)
      || (host !== null && !validHost(host)) || (row.kind === "shared-runtime-skill" && host !== null)
      || (row.kind === "host-skill" && host === null)
      || (kind === "adapter-package" && (host !== null || !adapter || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(adapter)))
      || (kind !== "adapter-package" && adapter !== null)
      || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint)) {
      throw new Error("install manifest file entry is malformed");
    }
    return { path: normalizedPath(row.path), kind: kind as ManifestFileKind, host: host as HostId | null, ...(adapter ? { adapter } : {}), fingerprint: row.fingerprint };
  });
  const paths = new Set<string>();
  for (const file of files) if (paths.has(file.path)) throw new Error("install manifest contains duplicate file paths"); else paths.add(file.path);
  return { schema: INSTALL_MANIFEST_SCHEMA, generated_at: raw.generated_at, files };
}

export function readInstallManifest(env?: NodeJS.ProcessEnv): InstallManifest | null {
  const file = installManifestPath(env);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = readJsonFile(file);
  } catch (error) {
    throw new Error(`INSTALL_MANIFEST_INVALID: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return normalizeManifest(parsed);
  } catch (error) {
    throw new Error(`INSTALL_MANIFEST_INVALID: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeInstallManifest(manifest: InstallManifest, env?: NodeJS.ProcessEnv): string {
  const value = normalizeManifest(manifest);
  const file = installManifestPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, value);
  return file;
}

export function manifestOwnsFile(manifest: InstallManifest | null, file: string): boolean {
  const fingerprint = digestFile(normalizedPath(file));
  if (!manifest || !fingerprint) return false;
  return manifest.files.some((entry) => entry.path === normalizedPath(file) && entry.fingerprint === fingerprint);
}

export function manifestOwnsDirectory(manifest: InstallManifest | null, directory: string): boolean {
  const actual = directoryFingerprint(normalizedPath(directory));
  if (!manifest || !actual) return false;
  return manifest.files.some((entry) => entry.kind === "adapter-package"
    && entry.path === normalizedPath(directory)
    && entry.fingerprint === actual);
}
