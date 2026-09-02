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
import { captureCompiledApplySourceFacts } from "./apply-source-capture.js";

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


export class ApplySourceInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApplySourceInputError";
    this.code = code;
  }
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


export { captureCompiledApplySourceFacts } from "./apply-source-capture.js";
