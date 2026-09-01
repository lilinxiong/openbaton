/**
 * Read-only source facts for a compiled OpenSpec apply plan.
 *
 * This module is intentionally a boundary, rather than an apply/run store.
 * It records only the repository state, OpenSpec identity, and declared unit
 * inputs that the caller supplies.  In particular, it never walks the
 * worktree and it never hashes an input produced by a predecessor unit before
 * that unit has an accepted fact.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  captureStableSafetyFacts,
  type StableGitSafetyFactsOptions,
} from "./git-safety-facts.js";
import {
  GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
  type GitIndexControlFingerprint,
} from "./git-index-control.js";
import { parseTasks } from "./openspec.js";
import { canonicalizeJson, sha256Hex } from "./json-utils.js";

export { GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM } from "./git-index-control.js";
import { isRecord } from "./validate-utils.js";

export const APPLY_SOURCE_SCHEMA_VERSION = 1 as const;
export const APPLY_PLAN_STALE = "APPLY_PLAN_STALE" as const;

export type ApplySourceInputRole = "read" | "write";
export type ApplySourceInputOrigin = "existing" | "predecessor-produced";
export type ApplySourceFileKind = "missing" | "file" | "directory" | "symlink" | "other";

export interface ApplySourceFileMetadata {
  /** Metadata is deliberately limited to stable, semantic values. */
  kind: ApplySourceFileKind;
  mode: number | null;
  size: number | null;
  /** Symlink targets are metadata, not file bytes. */
  target?: string;
}

export interface ApplySourcePredecessorFactReference {
  unit_id: string;
  fact_id: string;
  /** Fingerprint of the accepted predecessor output, when available. */
  fingerprint?: string | null;
}

export interface ApplySourceInputDeclaration {
  /** Repository-relative path, or an absolute path under repo_root. */
  path: string;
  role?: ApplySourceInputRole;
  kind?: ApplySourceInputRole;
  roles?: readonly ApplySourceInputRole[];
  /** `predecessor` and `produced` are accepted as input aliases. */
  origin?: ApplySourceInputOrigin | "predecessor" | "produced";
  source?: ApplySourceInputOrigin | "predecessor" | "produced";
  predecessor?: Partial<ApplySourcePredecessorFactReference>;
  predecessor_unit_id?: string;
  predecessorUnitId?: string;
  predecessor_fact_id?: string;
  predecessorFactId?: string;
  predecessor_fingerprint?: string | null;
  predecessorFingerprint?: string | null;
  predecessor_fact?: Partial<ApplySourcePredecessorFactReference>;
  predecessorFact?: Partial<ApplySourcePredecessorFactReference>;
  producer?: Partial<ApplySourcePredecessorFactReference>;
}

export interface ApplySourceUnitDeclaration {
  [key: string]: unknown;
  id?: string;
  unit_id?: string;
  read_paths?: readonly string[];
  readPaths?: readonly string[];
  reads?: readonly string[];
  read_inputs?: readonly string[];
  readInputs?: readonly string[];
  write_paths?: readonly string[];
  writePaths?: readonly string[];
  writes?: readonly string[];
  write_inputs?: readonly string[];
  writeInputs?: readonly string[];
  inputs?: readonly (string | ApplySourceInputDeclaration)[];
  declared_inputs?: readonly (string | ApplySourceInputDeclaration)[];
  declaredInputs?: readonly (string | ApplySourceInputDeclaration)[];
}

export type ApplySourceUnitDeclarations =
  | readonly ApplySourceUnitDeclaration[]
  | Readonly<Record<string, Omit<ApplySourceUnitDeclaration, "id" | "unit_id"> | readonly (string | ApplySourceInputDeclaration)[]>>;

export interface ApplySourceContextFileIdentity {
  artifact?: string;
  path: string;
  sha256?: string;
  hash?: string;
}

export interface ApplySourceTaskLedgerIdentity {
  path?: string;
  identity?: string;
  sha256?: string;
  fingerprint?: string;
}

/**
 * OpenSpec owns these values.  Baton receives them from the caller and only
 * normalizes them for comparison; it does not infer a new workflow state.
 * Camel-case aliases mirror `OpenSpecApplyInstructions`, while snake-case
 * fields are the deterministic wire representation emitted by this module.
 */
export interface ApplySourceOpenSpecIdentity {
  [key: string]: unknown;
  context_files?: readonly ApplySourceContextFileIdentity[] | Readonly<Record<string, readonly string[]>>;
  contextFiles?: readonly ApplySourceContextFileIdentity[] | Readonly<Record<string, readonly string[]>>;
  context_file_hashes?: Readonly<Record<string, string>>;
  contextFileHashes?: Readonly<Record<string, string>>;
  selected_task_snapshot_fingerprint?: string;
  selectedTaskSnapshotFingerprint?: string;
  selected_task_fingerprint?: string;
  selectedTaskFingerprint?: string;
  selected_task_snapshot_identity?: string;
  selectedTaskSnapshotIdentity?: string;
  selected_task_numbers?: readonly string[];
  selectedTaskNumbers?: readonly string[];
  pending_task_numbers?: readonly string[];
  pendingTaskNumbers?: readonly string[];
  selected_tasks?: readonly unknown[];
  selectedTasks?: readonly unknown[];
  task_ledger?: ApplySourceTaskLedgerIdentity | string;
  taskLedger?: ApplySourceTaskLedgerIdentity | string;
  task_ledger_identity?: string;
  taskLedgerIdentity?: string;
  tasks_path?: string;
  tasksPath?: string;
  /** A caller-provided opaque context identity is retained verbatim. */
  context_identity?: string;
  contextIdentity?: string;
  context_snapshot_fingerprint?: string;
  contextSnapshotFingerprint?: string;
  task_snapshot_fingerprint?: string;
  taskSnapshotFingerprint?: string;
  fingerprint?: string;
}

export interface ApplySourceRepositoryIdentity {
  head: string;
  branch_ref: string;
  staged_tree: string;
  index_control: GitIndexControlFingerprint;
}

export interface ApplySourceExistingInputFact {
  path: string;
  roles: readonly ApplySourceInputRole[];
  origin: "existing";
  metadata: ApplySourceFileMetadata;
  /** Null is used for a missing/non-regular input; no bytes were hashed. */
  sha256: string | null;
}

export interface ApplySourcePredecessorInputFact {
  path: string;
  roles: readonly ApplySourceInputRole[];
  origin: "predecessor-produced";
  predecessor: ApplySourcePredecessorFactReference;
}

export type ApplySourceInputFact = ApplySourceExistingInputFact | ApplySourcePredecessorInputFact;

export interface ApplySourceUnitFacts {
  unit_id: string;
  inputs: readonly ApplySourceInputFact[];
  fingerprint: string;
  readonly read_inputs?: readonly ApplySourceInputFact[];
  readonly write_inputs?: readonly ApplySourceInputFact[];
  readonly readInputs?: readonly ApplySourceInputFact[];
  readonly writeInputs?: readonly ApplySourceInputFact[];
}

export interface CompiledApplySourceFacts {
  schema_version: typeof APPLY_SOURCE_SCHEMA_VERSION;
  repo_root: string;
  repository: ApplySourceRepositoryIdentity;
  open_spec: NormalizedApplySourceOpenSpecIdentity;
  units: readonly ApplySourceUnitFacts[];
  fingerprint: string;
  /** Non-enumerable compatibility views; canonical hashing uses wire fields above. */
  readonly head?: string;
  readonly index_control?: GitIndexControlFingerprint;
  readonly indexControl?: GitIndexControlFingerprint;
  readonly openSpec?: NormalizedApplySourceOpenSpecIdentity;
  readonly unit_inputs?: readonly ApplySourceUnitFacts[];
  readonly unitInputs?: readonly ApplySourceUnitFacts[];
}

/** Alias used by callers that call the result an apply source snapshot. */
export type ApplySourceSnapshot = CompiledApplySourceFacts;
export type CompiledApplySourceSnapshot = CompiledApplySourceFacts;
export type ApplySourceFacts = CompiledApplySourceFacts;

export interface NormalizedApplySourceOpenSpecIdentity {
  context_files: readonly ApplySourceContextFileIdentity[];
  context_file_hashes: Readonly<Record<string, string>>;
  selected_task_snapshot_fingerprint: string;
  selected_task_numbers: readonly string[];
  selected_tasks: readonly unknown[];
  task_ledger: ApplySourceTaskLedgerIdentity | null;
  task_ledger_identity: string;
  context_identity?: string;
  readonly contextFiles?: readonly ApplySourceContextFileIdentity[];
  readonly contextFileHashes?: Readonly<Record<string, string>>;
  readonly selectedTaskSnapshotFingerprint?: string;
  readonly selectedTaskNumbers?: readonly string[];
  readonly taskLedger?: ApplySourceTaskLedgerIdentity | null;
}

export interface ApplySourceAcceptedPredecessorFact {
  unit_id: string;
  fact_id: string;
  fingerprint?: string | null;
}

export type ApplySourcePredecessorFacts =
  | readonly ApplySourceAcceptedPredecessorFact[]
  | Readonly<Record<string, ApplySourceAcceptedPredecessorFact | string>>;

export interface ApplySourceStatLike {
  kind?: ApplySourceFileKind | string;
  mode?: number;
  size?: number;
  target?: string;
  exists?: boolean;
  isFile?: () => boolean;
  isDirectory?: () => boolean;
  isSymbolicLink?: () => boolean;
}

export type ApplySourceLstat = (absolutePath: string) => Promise<ApplySourceStatLike> | ApplySourceStatLike;
export type ApplySourceReadBytes = (
  absolutePath: string,
) => Promise<Uint8Array | string | AsyncIterable<Uint8Array>> | Uint8Array | string | AsyncIterable<Uint8Array>;
export type ApplySourceReadLink = (absolutePath: string) => Promise<string> | string;

export interface ApplySourceGitCaptureOptions {
  purpose?: StableGitSafetyFactsOptions["purpose"];
  spawn?: StableGitSafetyFactsOptions["spawn"];
}

export interface ApplySourceDependencies {
  [key: string]: unknown;
  /** Injected complete Git capture for deterministic tests. */
  captureGitFacts?: (repoRoot: string, options?: ApplySourceGitCaptureOptions) => Promise<unknown> | unknown;
  captureGit?: (repoRoot: string, options?: ApplySourceGitCaptureOptions) => Promise<unknown> | unknown;
  captureSafetyFacts?: (repoRoot: string, options?: ApplySourceGitCaptureOptions) => Promise<unknown> | unknown;
  captureGitSafetyFacts?: (repoRoot: string, options?: ApplySourceGitCaptureOptions) => Promise<unknown> | unknown;
  /** Read the current OpenSpec identity. The expected identity is context only. */
  readOpenSpec?: (repoRoot: string, expected: ApplySourceOpenSpecIdentity) => Promise<ApplySourceOpenSpecIdentity> | ApplySourceOpenSpecIdentity;
  readOpenSpecSnapshot?: (repoRoot: string, expected: ApplySourceOpenSpecIdentity) => Promise<ApplySourceOpenSpecIdentity> | ApplySourceOpenSpecIdentity;
  readPredecessorFacts?: (
    repoRoot: string,
    expected: ApplySourcePredecessorFacts | undefined,
  ) => Promise<ApplySourcePredecessorFacts | undefined> | ApplySourcePredecessorFacts | undefined;
  lstat?: ApplySourceLstat;
  stat?: ApplySourceLstat;
  readBytes?: ApplySourceReadBytes;
  /** Alias useful for tests that model a bounded file reader. */
  readFile?: ApplySourceReadBytes;
  readInput?: ApplySourceReadBytes;
  readFileBytes?: ApplySourceReadBytes;
  readlink?: ApplySourceReadLink;
}

export interface ApplySourceCaptureRequest {
  [key: string]: unknown;
  repo_root?: string;
  repoRoot?: string;
  open_spec?: ApplySourceOpenSpecIdentity;
  openSpec?: ApplySourceOpenSpecIdentity;
  units?: ApplySourceUnitDeclarations;
  unit_inputs?: ApplySourceUnitDeclarations;
  unitInputs?: ApplySourceUnitDeclarations;
  predecessor_facts?: ApplySourcePredecessorFacts;
  predecessorFacts?: ApplySourcePredecessorFacts;
  accepted_predecessor_facts?: ApplySourcePredecessorFacts;
  acceptedPredecessorFacts?: ApplySourcePredecessorFacts;
  dependencies?: ApplySourceDependencies;
  /** Dependency fields are also accepted at the request root for convenience. */
  captureGitFacts?: ApplySourceDependencies["captureGitFacts"];
  captureGit?: ApplySourceDependencies["captureGit"];
  captureSafetyFacts?: ApplySourceDependencies["captureSafetyFacts"];
  captureGitSafetyFacts?: ApplySourceDependencies["captureGitSafetyFacts"];
  readOpenSpec?: ApplySourceDependencies["readOpenSpec"];
  readOpenSpecSnapshot?: ApplySourceDependencies["readOpenSpecSnapshot"];
  readPredecessorFacts?: ApplySourceDependencies["readPredecessorFacts"];
  lstat?: ApplySourceLstat;
  stat?: ApplySourceLstat;
  readBytes?: ApplySourceReadBytes;
  readFile?: ApplySourceReadBytes;
  readInput?: ApplySourceReadBytes;
  readFileBytes?: ApplySourceReadBytes;
  readlink?: ApplySourceReadLink;
}

export interface ApplySourceCaptureOptions extends ApplySourceCaptureRequest {}

export interface ApplySourceAcceptanceOptions<T> extends ApplySourceCaptureRequest {
  /** Previously accepted source facts. If omitted, the first observation is the baseline. */
  expected?: CompiledApplySourceFacts;
  source?: CompiledApplySourceFacts;
  snapshot?: CompiledApplySourceFacts;
  capture?: () => Promise<CompiledApplySourceFacts> | CompiledApplySourceFacts;
  validate?: (before: CompiledApplySourceFacts) => Promise<unknown> | unknown;
  validateInputs?: (before: CompiledApplySourceFacts) => Promise<unknown> | unknown;
  persistence?: (after: CompiledApplySourceFacts) => Promise<T> | T;
  persist?: (after: CompiledApplySourceFacts) => Promise<T> | T;
  onPersist?: (after: CompiledApplySourceFacts) => Promise<T> | T;
}

export interface ApplySourceAcceptanceResult<T> {
  result: T;
  source: CompiledApplySourceFacts;
  before: CompiledApplySourceFacts;
  after: CompiledApplySourceFacts;
}

export class ApplyPlanStaleError extends Error {
  readonly code = APPLY_PLAN_STALE;
  readonly changed: readonly string[];

  constructor(changed: readonly string[] = []) {
    super(APPLY_PLAN_STALE);
    this.name = "ApplyPlanStaleError";
    this.changed = [...changed];
  }
}


class ApplySourceInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApplySourceInputError";
    this.code = code;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeRepoRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("repo_root is required");
  return path.resolve(value);
}

function normalizedRelativePath(repoRoot: string, raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ApplySourceInputError("APPLY_SOURCE_PATH_INVALID", "declared input path is empty");
  if (raw.includes("\0")) throw new ApplySourceInputError("APPLY_SOURCE_PATH_INVALID", "declared input path contains NUL");
  const absolute = path.resolve(repoRoot, raw.replaceAll("\\", "/"));
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApplySourceInputError("APPLY_SOURCE_PATH_INVALID", `declared input path escapes repository: ${raw}`);
  }
  const normalized = relative.split(path.sep).join("/");
  if (normalized.includes("*") || normalized.includes("?") || normalized.includes("[")) {
    throw new ApplySourceInputError("APPLY_SOURCE_PATH_INVALID", `declared input path must be concrete: ${raw}`);
  }
  return normalized;
}

function normalizedContextPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ApplySourceInputError("APPLY_SOURCE_CONTEXT_INVALID", "OpenSpec context path is empty");
  return path.resolve(raw);
}

function normalizeRoles(value: ApplySourceInputDeclaration): ApplySourceInputRole[] {
  const values = [
    ...(value.role ? [value.role] : []),
    ...(value.kind ? [value.kind] : []),
    ...(value.roles || []),
  ];
  if (!values.length) return ["read"];
  if (values.some((role) => role !== "read" && role !== "write")) {
    throw new ApplySourceInputError("APPLY_SOURCE_ROLE_INVALID", `invalid input role for ${value.path}`);
  }
  return [...new Set(values)].sort() as ApplySourceInputRole[];
}

function predecessorReference(value: ApplySourceInputDeclaration): ApplySourcePredecessorFactReference | null {
  const raw = value.predecessor || value.predecessor_fact || value.predecessorFact || value.producer || {};
  const unitId = stringValue(raw.unit_id) || stringValue(value.predecessor_unit_id) || stringValue(value.predecessorUnitId);
  const factId = stringValue(raw.fact_id) || stringValue(value.predecessor_fact_id) || stringValue(value.predecessorFactId);
  const fingerprint = raw.fingerprint ?? value.predecessor_fingerprint ?? value.predecessorFingerprint;
  if (!unitId && !factId && fingerprint === undefined) return null;
  if (!unitId || !factId) {
    throw new ApplySourceInputError("APPLY_SOURCE_PREDECESSOR_INVALID", `predecessor input ${value.path} needs unit_id and fact_id`);
  }
  return { unit_id: unitId, fact_id: factId, ...(fingerprint !== undefined ? { fingerprint: fingerprint ?? null } : {}) };
}

function originOf(value: ApplySourceInputDeclaration): ApplySourceInputOrigin {
  const origin = value.origin ?? value.source ?? "existing";
  if (origin === "predecessor" || origin === "produced") return "predecessor-produced";
  if (origin === "existing" || origin === "predecessor-produced") return origin;
  throw new ApplySourceInputError("APPLY_SOURCE_ORIGIN_INVALID", `invalid input origin for ${value.path}`);
}

interface NormalizedDeclaration {
  path: string;
  roles: ApplySourceInputRole[];
  origin: ApplySourceInputOrigin;
  predecessor: ApplySourcePredecessorFactReference | null;
}

function normalizeDeclaration(repoRoot: string, value: string | ApplySourceInputDeclaration, defaultRole: ApplySourceInputRole): NormalizedDeclaration {
  const source: ApplySourceInputDeclaration = typeof value === "string" ? { path: value, role: defaultRole } : value;
  const roles = normalizeRoles(source);
  if (!source.role && !source.kind && !source.roles) roles.splice(0, roles.length, defaultRole);
  const origin = originOf(source);
  const predecessor = predecessorReference(source);
  if (origin === "predecessor-produced" && !predecessor) {
    throw new ApplySourceInputError("APPLY_SOURCE_PREDECESSOR_INVALID", `predecessor input ${source.path} has no accepted fact reference`);
  }
  if (origin === "existing" && predecessor) {
    throw new ApplySourceInputError("APPLY_SOURCE_PREDECESSOR_INVALID", `existing input ${source.path} cannot carry predecessor facts`);
  }
  return { path: normalizedRelativePath(repoRoot, source.path), roles, origin, predecessor };
}

function declarationList(value: ApplySourceUnitDeclaration, key: "read" | "write"): string[] {
  const snake = key === "read" ? value.read_paths : value.write_paths;
  const camel = key === "read" ? value.readPaths : value.writePaths;
  const short = key === "read" ? value.reads : value.writes;
  const inputs = key === "read" ? value.read_inputs : value.write_inputs;
  const inputCamel = key === "read" ? value.readInputs : value.writeInputs;
  return [...strings(snake), ...strings(camel), ...strings(short), ...strings(inputs), ...strings(inputCamel)];
}

function unitEntries(value: ApplySourceUnitDeclarations | undefined): ApplySourceUnitDeclaration[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => ({ ...entry }));
  return Object.entries(value).map(([id, entry]) => Array.isArray(entry)
    ? { id, inputs: entry }
    : { ...entry, id });
}

function normalizeUnitDeclarations(repoRoot: string, units: ApplySourceUnitDeclarations | undefined): Array<{ unit_id: string; inputs: NormalizedDeclaration[] }> {
  const output: Array<{ unit_id: string; inputs: NormalizedDeclaration[] }> = [];
  const seen = new Set<string>();
  for (const unit of unitEntries(units)) {
    const id = stringValue(unit.id) || stringValue(unit.unit_id);
    if (!id) throw new ApplySourceInputError("APPLY_SOURCE_UNIT_INVALID", "declared input unit has no id");
    if (seen.has(id)) throw new ApplySourceInputError("APPLY_SOURCE_UNIT_INVALID", `duplicate declared input unit: ${id}`);
    seen.add(id);
    const readDeclarations = declarationList(unit, "read").map((entry) => ({ path: entry, role: "read" as const }));
    const writeDeclarations = declarationList(unit, "write").map((entry) => ({ path: entry, role: "write" as const }));
    // A bare value in the generic `inputs` list is a read by default.  The
    // dedicated read_paths/write_paths lists already carry an explicit role.
    const genericDeclarations = [
      ...(unit.inputs || []),
      ...(unit.declared_inputs || []),
      ...(unit.declaredInputs || []),
    ].map((entry) => typeof entry === "string" ? { path: entry, role: "read" as const } : entry);
    const declarations: Array<string | ApplySourceInputDeclaration> = [...readDeclarations, ...writeDeclarations, ...genericDeclarations];
    const normalized = declarations.map((entry) => normalizeDeclaration(repoRoot, entry, "read"));
    const merged = new Map<string, NormalizedDeclaration>();
    for (const entry of normalized) {
      const prior = merged.get(entry.path);
      if (!prior) {
        merged.set(entry.path, entry);
        continue;
      }
      if (prior.origin !== entry.origin) {
        throw new ApplySourceInputError("APPLY_SOURCE_INPUT_CONFLICT", `input ${entry.path} has existing and predecessor origins`);
      }
      const predecessor = prior.predecessor || entry.predecessor;
      if (prior.origin === "predecessor-produced"
        && canonicalizeJson(prior.predecessor) !== canonicalizeJson(entry.predecessor)) {
        throw new ApplySourceInputError("APPLY_SOURCE_PREDECESSOR_INVALID", `input ${entry.path} has conflicting predecessor facts`);
      }
      merged.set(entry.path, {
        ...prior,
        roles: [...new Set([...prior.roles, ...entry.roles])].sort() as ApplySourceInputRole[],
        predecessor,
      });
    }
    output.push({ unit_id: id, inputs: [...merged.values()].sort((left, right) => left.path.localeCompare(right.path)) });
  }
  return output.sort((left, right) => left.unit_id.localeCompare(right.unit_id));
}

function normalizeIndexControl(value: unknown): GitIndexControlFingerprint {
  const source = isRecord(value) ? value : {};
  const algorithm = stringValue(source.algorithm) || stringValue(source.index_control_algorithm) || GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM;
  const checksum = stringValue(source.checksum) || stringValue(source.index_control_checksum) || "";
  const rawCount = source.entryCount ?? source.entry_count ?? source.index_control_entry_count;
  const entryCount = typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
  return { algorithm: algorithm as typeof GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM, checksum, entryCount };
}

function normalizeRepository(value: unknown): ApplySourceRepositoryIdentity {
  const source = isRecord(value) ? value : {};
  const nested = isRecord(source.repository) ? source.repository : source;
  const head = stringValue(nested.head) || stringValue(nested.HEAD) || "";
  const branchRef = stringValue(nested.branch_ref) || stringValue(nested.branchRef) || stringValue(nested.branch) || "";
  const stagedTree = stringValue(nested.staged_tree) || stringValue(nested.stagedTree) || stringValue(nested.index_tree) || stringValue(nested.indexTree) || "";
  const index = nested.index_control
    ?? nested.indexControl
    ?? source.indexControl
    ?? source.index_control
    ?? (isRecord(source.index) ? source.index : undefined);
  return { head, branch_ref: branchRef, staged_tree: stagedTree, index_control: normalizeIndexControl(index) };
}

function normalizeContextFiles(value: ApplySourceOpenSpecIdentity): ApplySourceContextFileIdentity[] {
  const raw = value.context_files ?? value.contextFiles;
  const hashes = value.context_file_hashes ?? value.contextFileHashes ?? {};
  const files: ApplySourceContextFileIdentity[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry) || typeof entry.path !== "string") continue;
      const filePath = normalizedContextPath(entry.path);
      const hash = stringValue(entry.sha256) || stringValue(entry.hash) || hashes[entry.path] || hashes[filePath];
      files.push({ ...(entry.artifact ? { artifact: String(entry.artifact) } : {}), path: filePath, ...(hash ? { sha256: hash } : {}) });
    }
  } else if (isRecord(raw)) {
    for (const artifact of Object.keys(raw).sort()) {
      for (const candidate of strings(raw[artifact])) {
        const filePath = normalizedContextPath(candidate);
        const hash = hashes[candidate] || hashes[filePath];
        files.push({ artifact, path: filePath, ...(hash ? { sha256: hash } : {}) });
      }
    }
  }
  for (const [candidate, hash] of Object.entries(hashes)) {
    const filePath = normalizedContextPath(candidate);
    if (!files.some((entry) => entry.path === filePath)) files.push({ path: filePath, sha256: hash });
  }
  const seen = new Set<string>();
  return files
    .filter((entry) => {
      const key = `${entry.artifact || ""}\0${entry.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.path.localeCompare(right.path) || (left.artifact || "").localeCompare(right.artifact || ""));
}

function normalizeTaskLedger(value: ApplySourceOpenSpecIdentity): ApplySourceTaskLedgerIdentity | null {
  const raw = value.task_ledger ?? value.taskLedger;
  const pathValue = typeof raw === "string" ? raw : raw?.path;
  const identity = stringValue(value.task_ledger_identity) || stringValue(value.taskLedgerIdentity) || (typeof raw === "string" ? raw : raw?.identity);
  const sha = typeof raw === "object" && raw !== null ? stringValue(raw.sha256) : undefined;
  const fingerprint = typeof raw === "object" && raw !== null ? stringValue(raw.fingerprint) : undefined;
  const tasksPath = stringValue(value.tasks_path) || stringValue(value.tasksPath);
  if (!pathValue && !identity && !tasksPath && !sha && !fingerprint) return null;
  const resolvedPath = pathValue || tasksPath;
  return {
    ...(resolvedPath ? { path: normalizedContextPath(resolvedPath) } : {}),
    ...(identity ? { identity } : {}),
    ...(sha ? { sha256: sha } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function normalizeSelectedTasks(value: ApplySourceOpenSpecIdentity): unknown[] {
  const selected = value.selected_tasks ?? value.selectedTasks;
  if (Array.isArray(selected)) return selected.map(cloneJsonValue);
  return [];
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)])) as T;
  return value;
}

function normalizeOpenSpec(value: ApplySourceOpenSpecIdentity = {}): NormalizedApplySourceOpenSpecIdentity {
  const contextFiles = normalizeContextFiles(value);
  const contextHashes: Record<string, string> = {};
  for (const file of contextFiles) if (file.sha256) contextHashes[file.path] = file.sha256;
  for (const [candidate, hash] of Object.entries(value.context_file_hashes ?? value.contextFileHashes ?? {})) {
    contextHashes[normalizedContextPath(candidate)] = hash;
  }
  const selectedTasks = normalizeSelectedTasks(value);
  const selectedNumbers = [
    ...strings(value.selected_task_numbers),
    ...strings(value.selectedTaskNumbers),
    ...strings(value.pending_task_numbers),
    ...strings(value.pendingTaskNumbers),
  ];
  const uniqueNumbers = [...new Set(selectedNumbers)].sort();
  const snapshot = stringValue(value.selected_task_snapshot_fingerprint)
    || stringValue(value.selectedTaskSnapshotFingerprint)
    || stringValue(value.selected_task_fingerprint)
    || stringValue(value.selectedTaskFingerprint)
    || stringValue(value.task_snapshot_fingerprint)
    || stringValue(value.taskSnapshotFingerprint)
    || stringValue(value.selected_task_snapshot_identity)
    || stringValue(value.selectedTaskSnapshotIdentity)
    || sha256Hex(canonicalizeJson({ selected_tasks: selectedTasks, selected_task_numbers: uniqueNumbers }));
  const ledger = normalizeTaskLedger(value);
  const ledgerIdentity = stringValue(value.task_ledger_identity)
    || stringValue(value.taskLedgerIdentity)
    || ledger?.identity
    || ledger?.path
    || "";
  const contextIdentity = stringValue(value.context_identity)
    || stringValue(value.contextIdentity)
    || stringValue(value.context_snapshot_fingerprint)
    || stringValue(value.contextSnapshotFingerprint)
    || stringValue(value.fingerprint);
  return {
    context_files: contextFiles,
    context_file_hashes: Object.fromEntries(Object.entries(contextHashes).sort(([left], [right]) => left.localeCompare(right))),
    selected_task_snapshot_fingerprint: snapshot,
    selected_task_numbers: uniqueNumbers,
    selected_tasks: selectedTasks,
    task_ledger: ledger,
    task_ledger_identity: ledgerIdentity,
    ...(contextIdentity ? { context_identity: contextIdentity } : {}),
  };
}

function dependencySet(request: ApplySourceCaptureRequest): ApplySourceDependencies {
  return {
    ...(request.dependencies || {}),
    ...(request.captureGitFacts ? { captureGitFacts: request.captureGitFacts } : {}),
    ...(request.captureGit ? { captureGit: request.captureGit } : {}),
    ...(request.captureSafetyFacts ? { captureSafetyFacts: request.captureSafetyFacts } : {}),
    ...(request.captureGitSafetyFacts ? { captureGitSafetyFacts: request.captureGitSafetyFacts } : {}),
    ...(request.readOpenSpec ? { readOpenSpec: request.readOpenSpec } : {}),
    ...(request.readOpenSpecSnapshot ? { readOpenSpecSnapshot: request.readOpenSpecSnapshot } : {}),
    ...(request.readPredecessorFacts ? { readPredecessorFacts: request.readPredecessorFacts } : {}),
    ...(request.lstat ? { lstat: request.lstat } : {}),
    ...(request.stat ? { stat: request.stat } : {}),
    ...(request.readBytes ? { readBytes: request.readBytes } : {}),
    ...(request.readFile ? { readFile: request.readFile } : {}),
    ...(request.readInput ? { readInput: request.readInput } : {}),
    ...(request.readFileBytes ? { readFileBytes: request.readFileBytes } : {}),
    ...(request.readlink ? { readlink: request.readlink } : {}),
  };
}

async function defaultReadBytes(absolutePath: string): Promise<AsyncIterable<Uint8Array>> {
  return fs.createReadStream(absolutePath);
}

async function defaultLstat(absolutePath: string): Promise<ApplySourceStatLike> {
  try {
    const stat = await fs.promises.lstat(absolutePath);
    return stat;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "missing", exists: false };
    throw error;
  }
}

async function defaultReadlink(absolutePath: string): Promise<string> {
  return fs.promises.readlink(absolutePath);
}

function statKind(value: ApplySourceStatLike): ApplySourceFileKind {
  if (value.exists === false || value.kind === "missing") return "missing";
  if (value.kind === "file" || value.kind === "directory" || value.kind === "symlink" || value.kind === "other") return value.kind;
  if (value.isSymbolicLink?.()) return "symlink";
  if (value.isFile?.()) return "file";
  if (value.isDirectory?.()) return "directory";
  return "other";
}

function normalizedMetadata(stat: ApplySourceStatLike, kind: ApplySourceFileKind, target?: string): ApplySourceFileMetadata {
  if (kind === "missing") return { kind, mode: null, size: null };
  const mode = typeof stat.mode === "number" && Number.isFinite(stat.mode) ? stat.mode & 0o7777 : null;
  const size = typeof stat.size === "number" && Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : null;
  return { kind, mode, size, ...(kind === "symlink" && target !== undefined ? { target } : {}) };
}

async function bytesHash(read: ApplySourceReadBytes, absolutePath: string): Promise<string> {
  const value = await read(absolutePath);
  const hash = crypto.createHash("sha256");
  if (typeof value === "string") {
    hash.update(value);
  } else if (value instanceof Uint8Array) {
    hash.update(value);
  } else {
    for await (const chunk of value) hash.update(chunk);
  }
  return hash.digest("hex");
}

async function captureExistingInput(
  repoRoot: string,
  declaration: NormalizedDeclaration,
  dependencies: ApplySourceDependencies,
): Promise<ApplySourceExistingInputFact> {
  const absolute = path.join(repoRoot, declaration.path);
  const stat = await (dependencies.lstat || dependencies.stat || defaultLstat)(absolute);
  const kind = statKind(stat);
  let target: string | undefined;
  if (kind === "symlink") {
    target = stat.target;
    if (target === undefined) {
      try { target = await (dependencies.readlink || defaultReadlink)(absolute); } catch { target = undefined; }
    }
  }
  const metadata = normalizedMetadata(stat, kind, target);
  const read = dependencies.readBytes || dependencies.readInput || dependencies.readFile || dependencies.readFileBytes || defaultReadBytes;
  const digest = kind === "file" ? await bytesHash(read, absolute) : null;
  return { path: declaration.path, roles: declaration.roles, origin: "existing", metadata, sha256: digest };
}

function predecessorKey(value: ApplySourcePredecessorFactReference): string {
  return `${value.unit_id}\0${value.fact_id}`;
}

function predecessorMap(value: ApplySourcePredecessorFacts | undefined): Map<string, ApplySourceAcceptedPredecessorFact> {
  const result = new Map<string, ApplySourceAcceptedPredecessorFact>();
  if (!value) return result;
  if (Array.isArray(value)) {
    for (const fact of value) {
      if (!fact || !fact.unit_id || !fact.fact_id) continue;
      result.set(predecessorKey(fact), { unit_id: fact.unit_id, fact_id: fact.fact_id, fingerprint: fact.fingerprint ?? null });
    }
    return result;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      const [unitId, factId] = key.split("\0");
      result.set(key, { unit_id: unitId || key, fact_id: factId || key, fingerprint: raw });
    } else if (isRecord(raw) && typeof raw.unit_id === "string" && typeof raw.fact_id === "string") {
      result.set(predecessorKey(raw as ApplySourceAcceptedPredecessorFact), {
        unit_id: raw.unit_id,
        fact_id: raw.fact_id,
        fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : null,
      });
    } else if (isRecord(raw)) {
      const [unitId, factId] = key.split("\0");
      result.set(key, {
        unit_id: unitId || key,
        fact_id: factId || key,
        fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : null,
      });
    }
  }
  return result;
}

async function capturePredecessorInput(
  declaration: NormalizedDeclaration,
  facts: Map<string, ApplySourceAcceptedPredecessorFact>,
  requireAcceptedFact = false,
): Promise<ApplySourcePredecessorInputFact> {
  if (!declaration.predecessor) throw new ApplySourceInputError("APPLY_SOURCE_PREDECESSOR_INVALID", `input ${declaration.path} has no predecessor reference`);
  const reference = declaration.predecessor;
  const accepted = facts.get(predecessorKey(reference));
  // Keep the accepted observation in the fact even when it differs from the
  // plan's reference.  The enclosing two-observation comparison then reports
  // the stable APPLY_PLAN_STALE error; a pre-plan file hash must never be used
  // as a substitute for this predecessor identity check.
  return {
    path: declaration.path,
    roles: declaration.roles,
    origin: "predecessor-produced",
    predecessor: accepted
      ? { unit_id: accepted.unit_id, fact_id: accepted.fact_id, fingerprint: accepted.fingerprint ?? null }
      : requireAcceptedFact ? { ...reference, fingerprint: null } : reference,
  };
}

async function captureOpenSpecFromFiles(
  repoRoot: string,
  expected: ApplySourceOpenSpecIdentity,
  dependencies: ApplySourceDependencies,
): Promise<NormalizedApplySourceOpenSpecIdentity> {
  const normalized = normalizeOpenSpec(expected);
  const read = dependencies.readBytes || dependencies.readInput || dependencies.readFile || dependencies.readFileBytes || defaultReadBytes;
  const hashes: Record<string, string> = {};
  const files = [] as ApplySourceContextFileIdentity[];
  for (const file of normalized.context_files) {
    const digest = await bytesHash(read, file.path);
    files.push({ ...(file.artifact ? { artifact: file.artifact } : {}), path: file.path, sha256: digest });
    hashes[file.path] = digest;
  }
  const ledger = normalized.task_ledger;
  let selectedNumbers = [...normalized.selected_task_numbers];
  let selectedTasks = [...normalized.selected_tasks];
  let selectedFingerprint = normalized.selected_task_snapshot_fingerprint;
  let ledgerCurrent = ledger ? { ...ledger } : null;
  if (ledger?.path) {
    const ledgerBytes = await (async () => {
      const value = await read(ledger.path!);
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
      const chunks: Buffer[] = [];
      for await (const chunk of value) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    })();
    const parsed = parseTasks(ledgerBytes);
    const pending = parsed.filter((task) => task.status === "pending").map((task) => ({ number: task.number, description: task.description, section: task.section }));
    selectedTasks = pending;
    selectedNumbers = pending.map((task) => task.number).sort();
    selectedFingerprint = sha256Hex(canonicalizeJson(selectedTasks));
    const ledgerDigest = sha256Hex(Buffer.from(ledgerBytes, "utf8"));
    ledgerCurrent = { ...ledger, sha256: ledgerDigest, fingerprint: ledgerDigest };
  }
  return {
    ...normalized,
    context_files: files,
    context_file_hashes: Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))),
    selected_task_snapshot_fingerprint: selectedFingerprint,
    selected_task_numbers: [...new Set(selectedNumbers)].sort(),
    selected_tasks: selectedTasks,
    task_ledger: ledgerCurrent,
  };
}

async function captureOpenSpec(
  repoRoot: string,
  expected: ApplySourceOpenSpecIdentity,
  dependencies: ApplySourceDependencies,
): Promise<NormalizedApplySourceOpenSpecIdentity> {
  const readOpenSpec = dependencies.readOpenSpec || dependencies.readOpenSpecSnapshot;
  if (readOpenSpec) {
    const supplied = await readOpenSpec(repoRoot, expected);
    return normalizeOpenSpec(supplied || {});
  }
  return captureOpenSpecFromFiles(repoRoot, expected, dependencies);
}

async function captureGit(repoRoot: string, dependencies: ApplySourceDependencies): Promise<ApplySourceRepositoryIdentity> {
  const capture = dependencies.captureGitFacts
    || dependencies.captureGit
    || dependencies.captureSafetyFacts
    || dependencies.captureGitSafetyFacts;
  const value = capture
    ? await capture(repoRoot, { purpose: "baseline" })
    : await captureStableSafetyFacts(repoRoot, { purpose: "baseline" });
  return normalizeRepository(value);
}

function requestRepoRoot(request: ApplySourceCaptureRequest): string {
  return normalizeRepoRoot(request.repo_root ?? request.repoRoot);
}

function requestOpenSpec(request: ApplySourceCaptureRequest): ApplySourceOpenSpecIdentity {
  return request.open_spec ?? request.openSpec ?? {};
}

function requestUnits(request: ApplySourceCaptureRequest): ApplySourceUnitDeclarations | undefined {
  return request.units ?? request.unit_inputs ?? request.unitInputs;
}

function requestPredecessorFacts(request: ApplySourceCaptureRequest): ApplySourcePredecessorFacts | undefined {
  return request.accepted_predecessor_facts ?? request.acceptedPredecessorFacts ?? request.predecessor_facts ?? request.predecessorFacts;
}

function sourceFingerprint(value: Omit<CompiledApplySourceFacts, "fingerprint">): string {
  return sha256Hex(canonicalizeJson(value));
}

function compatibilityViews<T extends CompiledApplySourceFacts>(value: T): T {
  // Keep the serialized source fact small and unambiguous.  These read-only
  // views make the most common camel-case/flat access patterns convenient
  // without making duplicate aliases part of the fingerprint.
  Object.defineProperties(value, {
    head: { configurable: false, enumerable: false, value: value.repository.head },
    index_control: { configurable: false, enumerable: false, value: value.repository.index_control },
    indexControl: { configurable: false, enumerable: false, value: value.repository.index_control },
    openSpec: { configurable: false, enumerable: false, value: value.open_spec },
    unit_inputs: { configurable: false, enumerable: false, value: value.units },
    unitInputs: { configurable: false, enumerable: false, value: value.units },
  });
  Object.defineProperties(value.open_spec, {
    contextFiles: { configurable: false, enumerable: false, value: value.open_spec.context_files },
    contextFileHashes: { configurable: false, enumerable: false, value: value.open_spec.context_file_hashes },
    selectedTaskSnapshotFingerprint: { configurable: false, enumerable: false, value: value.open_spec.selected_task_snapshot_fingerprint },
    selectedTaskNumbers: { configurable: false, enumerable: false, value: value.open_spec.selected_task_numbers },
    taskLedger: { configurable: false, enumerable: false, value: value.open_spec.task_ledger },
  });
  for (const unit of value.units) {
    const readInputs = unit.inputs.filter((input) => input.roles.includes("read"));
    const writeInputs = unit.inputs.filter((input) => input.roles.includes("write"));
    Object.defineProperties(unit, {
      read_inputs: { configurable: false, enumerable: false, value: readInputs },
      write_inputs: { configurable: false, enumerable: false, value: writeInputs },
      readInputs: { configurable: false, enumerable: false, value: readInputs },
      writeInputs: { configurable: false, enumerable: false, value: writeInputs },
    });
  }
  return value;
}

function unitFingerprint(value: Omit<ApplySourceUnitFacts, "fingerprint">): string {
  return sha256Hex(canonicalizeJson(value));
}

/**
 * Capture one deterministic source observation. Only `units[*].inputs` and
 * the protected repository/OpenSpec identities participate in the result.
 */
export async function captureCompiledApplySourceFacts(
  request: ApplySourceCaptureRequest,
): Promise<CompiledApplySourceFacts> {
  const repoRoot = requestRepoRoot(request);
  const dependencies = dependencySet(request);
  const openSpec = await captureOpenSpec(repoRoot, requestOpenSpec(request), dependencies);
  const repository = await captureGit(repoRoot, dependencies);
  let predecessorFacts = requestPredecessorFacts(request);
  const requireAcceptedPredecessorFact = Boolean(dependencies.readPredecessorFacts);
  if (dependencies.readPredecessorFacts) predecessorFacts = await dependencies.readPredecessorFacts(repoRoot, predecessorFacts);
  const predecessorIndex = predecessorMap(predecessorFacts);
  const normalizedUnits = normalizeUnitDeclarations(repoRoot, requestUnits(request));
  const units: ApplySourceUnitFacts[] = [];
  for (const unit of normalizedUnits) {
    const inputs: ApplySourceInputFact[] = [];
    for (const declaration of unit.inputs) {
      inputs.push(declaration.origin === "existing"
        ? await captureExistingInput(repoRoot, declaration, dependencies)
        : await capturePredecessorInput(declaration, predecessorIndex, requireAcceptedPredecessorFact));
    }
    const stableInputs = inputs.sort((left, right) => left.path.localeCompare(right.path));
    const withoutFingerprint = { unit_id: unit.unit_id, inputs: stableInputs };
    units.push({ ...withoutFingerprint, fingerprint: unitFingerprint(withoutFingerprint) });
  }
  const withoutFingerprint = {
    schema_version: APPLY_SOURCE_SCHEMA_VERSION,
    repo_root: repoRoot,
    repository,
    open_spec: openSpec,
    units: units.sort((left, right) => left.unit_id.localeCompare(right.unit_id)),
  };
  return compatibilityViews({ ...withoutFingerprint, fingerprint: sourceFingerprint(withoutFingerprint) });
}


function sourceDifferences(expected: CompiledApplySourceFacts, actual: CompiledApplySourceFacts): string[] {
  const changed: string[] = [];
  if (canonicalizeJson(expected.repository) !== canonicalizeJson(actual.repository)) changed.push("repository");
  if (canonicalizeJson(expected.open_spec) !== canonicalizeJson(actual.open_spec)) changed.push("open_spec");
  const expectedUnits = new Map(expected.units.map((unit) => [unit.unit_id, unit]));
  const actualUnits = new Map(actual.units.map((unit) => [unit.unit_id, unit]));
  const unitIds = [...new Set([...expectedUnits.keys(), ...actualUnits.keys()])].sort();
  for (const id of unitIds) {
    if (canonicalizeJson(expectedUnits.get(id)) !== canonicalizeJson(actualUnits.get(id))) changed.push(`unit:${id}`);
  }
  if (!changed.length && expected.repo_root !== actual.repo_root) changed.push("repo_root");
  return changed;
}

export function assertApplySourceCurrent(
  expected: CompiledApplySourceFacts,
  actual: CompiledApplySourceFacts,
): void {
  const changed = sourceDifferences(expected, actual);
  if (changed.length) throw new ApplyPlanStaleError(changed);
}


/**
 * Capture, run the injected read-only validation, capture again, and invoke
 * persistence only after both observations equal the accepted source.  No
 * ticket, Receipt, run, or OpenSpec write is performed here.
 */
export async function acceptCompiledApplySource<T>(
  options: ApplySourceAcceptanceOptions<T>,
): Promise<ApplySourceAcceptanceResult<T>> {
  const capture = options.capture || (() => captureCompiledApplySourceFacts(options));
  const before = await capture();
  const expected = options.expected || options.source || options.snapshot || before;
  assertApplySourceCurrent(expected, before);
  const validate = options.validate || options.validateInputs;
  if (validate) await validate(before);
  const after = await capture();
  assertApplySourceCurrent(expected, after);
  assertApplySourceCurrent(before, after);
  const persist = options.persistence || options.persist || options.onPersist;
  if (!persist) return { result: undefined as T, source: after, before, after };
  const result = await persist(after);
  return { result, source: after, before, after };
}

