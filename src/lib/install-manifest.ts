import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { batonHomeDir, hostHome, packageRoot, skillPath } from "./paths.js";
import { hostSkillDest, skillTemplatePath, HOST_IDS, type HostId } from "./hosts.js";

export const INSTALL_MANIFEST_SCHEMA = 1 as const;
export const INSTALL_MANIFEST_NAME = "install-manifest.json";

export type ManifestFileKind = "shared-runtime-skill" | "host-skill";

export interface InstallManifestFile {
  path: string;
  kind: ManifestFileKind;
  host: HostId | null;
  fingerprint: string;
}

export interface InstallManifest {
  schema: typeof INSTALL_MANIFEST_SCHEMA;
  generated_at: string;
  files: InstallManifestFile[];
}

function digestFile(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function normalizedPath(file: string): string {
  return path.resolve(file);
}

export function installManifestPath(env?: NodeJS.ProcessEnv): string {
  return path.join(batonHomeDir(env), INSTALL_MANIFEST_NAME);
}

export function fileFingerprint(file: string): string | null {
  return digestFile(normalizedPath(file));
}


function validHost(value: string): value is HostId {
  return (HOST_IDS as readonly string[]).includes(value);
}

/** Build a non-secret ownership snapshot for an installation. */
export function buildInstallManifest(
  cwd: string,
  selectedHosts: readonly HostId[] = HOST_IDS,
  env?: NodeJS.ProcessEnv,
): InstallManifest {
  const hosts = [...new Set(selectedHosts)].filter((host): host is HostId => validHost(host));
  const prior = readInstallManifest(env);
  const selected = new Set(hosts);
  const files: InstallManifestFile[] = (prior?.files || []).filter((entry) => entry.host !== null && !selected.has(entry.host));
  const shared = skillPath(cwd, { env });
  const sharedFingerprint = digestFile(shared);
  if (sharedFingerprint && (legacyOwnsSkill(null, shared, cwd, env) || manifestOwnsFile(prior, shared))) {
    files.push({ path: normalizedPath(shared), kind: "shared-runtime-skill", host: null, fingerprint: sharedFingerprint });
  }
  for (const host of hosts) {
    const file = hostSkillDest(host, { cwd, env });
    const fingerprint = digestFile(file);
    if (fingerprint && (legacyOwnsSkill(host, file, cwd, env) || manifestOwnsFile(prior, file))) {
      files.push({ path: normalizedPath(file), kind: "host-skill", host, fingerprint });
    }
  }
  return {
    schema: INSTALL_MANIFEST_SCHEMA,
    generated_at: new Date().toISOString(),
    files,
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
    if (typeof row.path !== "string" || !path.isAbsolute(row.path) || !["shared-runtime-skill", "host-skill"].includes(String(row.kind))
      || (host !== null && !validHost(host)) || (row.kind === "shared-runtime-skill" && host !== null)
      || (row.kind === "host-skill" && host === null) || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint)) {
      throw new Error("install manifest file entry is malformed");
    }
    return { path: normalizedPath(row.path), kind: row.kind as ManifestFileKind, host: host as HostId | null, fingerprint: row.fingerprint };
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
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
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
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return file;
}

export function manifestOwnsFile(manifest: InstallManifest | null, file: string): boolean {
  const fingerprint = digestFile(normalizedPath(file));
  if (!manifest || !fingerprint) return false;
  return manifest.files.some((entry) => entry.path === normalizedPath(file) && entry.fingerprint === fingerprint);
}

// Canonical skill bytes shipped by older Baton releases. These are deliberately
// exact digests: a `name: baton` frontmatter line or a fuzzy phrase is not
// enough to prove ownership of a user's skill file.
const LEGACY_CANONICAL_SKILL_DIGESTS: Record<string, string[]> = {
  shared: [
    // be2b53f (change baseline), then f6033b3/bbc28fa/85c2f68 history.
    "701865eb14feee3feb6760892981f3b07c8ab232cbcde0e903ab5ad7a78989bc",
    "ae88d22a4cc4432f33aa45f11d095e65d3888c88eee597f00806737653d3aa77",
    "9e8521de72a84f87d59930f94ec9f6e78fe619aff8524267f43edb837e5f70e3",
    "e5a53a8d87cea64a3230b08525dc36aa6ef2e31f24d1678a66b1d7745c12dd53",
  ],
  codex: [
    // be2b53f, f6033b3, bbc28fa.
    "e6c92e1d3c78302aba4729a740698b27034463b85b2f019ebe187933c67ed9d7",
    "631e9f35fd7ef1fb84915801704f97d79db777052eab6cc097bb9a93eb9ebd0d",
    "fb213a3f54bf1b567b7979494cf18563a65b0050ec788d871350fe03a0f5f917",
  ],
  claude: [
    // be2b53f, bbc28fa, 85c2f68.
    "cba921b9e45a68a0bcdc2bded5c2a09a79d503453d64cbe2706696bd00535415",
    "015c16447fe7255170b8c3200a19a7e566c477bbeaffabd4361a5cadb39fec8a",
    "4b4a23141f1ef95e464952f06a77682298a180a902bc9d1f9595c800a2490c1d",
  ],
  grok: [
    // be2b53f, f6033b3, bbc28fa.
    "4a1a8e8d94b74efc4ab3bd4db630df0a86dfc0ddd80aad6b58195a866abe7b79",
    "d0e8d66df0cd7eecda91a9350996f0294e28ce6e0d5a4601cd98f27fa2f658f5",
    "b6a0d05c6d707f8f26ea13fd5126013c7e4c559e31b0e977f09445d186653b5b",
  ],
  cursor: [
    // be2b53f.
    "73d9cc66da5da484898bfb65e8b8f25b95e8ae2bc050b2c790d59dc2dcac017c",
  ],
};

/** Strong legacy proof: exact package template or known canonical old bytes. */
export function legacyOwnsSkill(host: HostId | null, file: string, _cwd: string, _env?: NodeJS.ProcessEnv): boolean {
  const template = host ? skillTemplatePath(host) : path.join(packageRoot(), "SKILL.md");
  const actual = digestFile(file);
  const expected = digestFile(template);
  if (!actual) return false;
  if (expected && actual === expected) return true;
  const key = host || "shared";
  return LEGACY_CANONICAL_SKILL_DIGESTS[key]?.includes(actual) === true;
}

export function currentInstallHosts(): readonly HostId[] {
  return HOST_IDS;
}
