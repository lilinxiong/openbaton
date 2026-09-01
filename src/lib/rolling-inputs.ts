/**
 * Bounded input observations for rolling unit and gate lineage.
 *
 * A rolling plan is open-world, so a run-wide source snapshot is the wrong
 * validity boundary for a unit or a gate.  This module accepts an explicit
 * list of inputs and observes only those inputs.  In particular, source and
 * dependency containers are indexes supplied by the caller; they are never
 * traversed while making an observation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ApplySourceFileKind,
  ApplySourceLstat,
  ApplySourceReadBytes,
  ApplySourceReadLink,
} from "./apply-source.js";
import { canonicalizeRolling } from "./rolling-plan.js";
import { sha256Hex } from "./json-utils.js";
import { isRecord } from "./validate-utils.js";

export const ROLLING_INPUTS_SCHEMA_VERSION = 1 as const;

/** Canonical kinds.  The aliases accepted by declarations are normalized to these values. */
export type RollingInputKind =
  | "repository-path"
  | "repository-fact"
  | "source-fact"
  | "dependency-result"
  | "evidence";

/** Source-neutral aliases used by adapters that call the kind a source. */
export type RollingInputSource = RollingInputKind;
export type RollingInputDeclarationKind = RollingInputKind;

export type RollingInputOwnerKind = "unit" | "gate";

export interface RollingRepositoryPathFact {
  path: string;
  kind: ApplySourceFileKind;
  mode: number | null;
  size: number | null;
  sha256: string | null;
  target?: string;
}

export interface RollingSourceFact {
  /** Canonical source selector, for example `repository.head`. */
  selector: string;
  value: unknown;
}

export interface RollingDependencyResultIdentity {
  unit_id: string;
  fact_id: string;
  fingerprint: string | null;
}

export interface RollingEvidenceInput {
  selector: string;
  value: unknown;
}

/**
 * One auditable component of a local fingerprint.  `value` is the selected
 * fact only; it is never the source/dependency/evidence container.
 */
export interface RollingInputFingerprintComponent {
  label: string;
  kind: RollingInputKind;
  identity: string;
  value: unknown;
  fingerprint: string;
  readonly source?: "repository" | "source" | "dependency" | "evidence";
  readonly input_kind?: RollingInputKind;
  readonly inputKind?: RollingInputKind;
  readonly digest?: string;
  readonly selected?: unknown;
  readonly path?: string;
}

export type RollingInputFact = RollingInputFingerprintComponent;
export type RollingInputComponent = RollingInputFingerprintComponent;
export type RollingInputCapture = RollingLocalInputCapture;
export type RollingUnitInputCapture = RollingUnitLocalInputs;
export type RollingGateInputCapture = RollingGateLocalInputs;

export interface RollingLocalInputCapture {
  schema_version: typeof ROLLING_INPUTS_SCHEMA_VERSION;
  owner_kind: RollingInputOwnerKind;
  owner_key: string;
  components: readonly RollingInputFingerprintComponent[];
  /** Label-to-component digests are useful when explaining a local mismatch. */
  component_fingerprints: Readonly<Record<string, string>>;
  fingerprint: string;
  /** Compatibility aliases are installed as non-enumerable read-only views. */
  readonly fingerprint_components?: readonly RollingInputFingerprintComponent[];
  readonly fingerprintComponents?: readonly RollingInputFingerprintComponent[];
  readonly inputs?: readonly RollingInputFingerprintComponent[];
  readonly input_fingerprints?: Readonly<Record<string, string>>;
  readonly inputFingerprints?: Readonly<Record<string, string>>;
  readonly local_fingerprint?: string;
  readonly localFingerprint?: string;
  readonly owner?: { kind: RollingInputOwnerKind; key: string };
  readonly unit_id?: string;
  readonly unitId?: string;
  readonly gate_key?: string;
  readonly gateKey?: string;
}

export type RollingUnitLocalInputs = RollingLocalInputCapture & { owner_kind: "unit" };
export type RollingGateLocalInputs = RollingLocalInputCapture & { owner_kind: "gate" };
export type RollingInputSnapshot = RollingLocalInputCapture;

/**
 * Declaration shape is intentionally permissive at this boundary.  Adapters
 * in the wild use snake_case, camelCase, and the names used by apply-source;
 * normalization below emits one deterministic representation.
 */
export interface RollingInputDeclaration {
  [key: string]: unknown;
  label?: string;
  name?: string;
  id?: string;
  kind?: string;
  type?: string;
  input_kind?: string;
  inputKind?: string;

  path?: string;
  repository_path?: string;
  repositoryPath?: string;
  repo_path?: string;
  repoPath?: string;
  file_path?: string;
  filePath?: string;
  repository_file?: string;
  repositoryFile?: string;

  selector?: string;
  source_fact?: string | unknown;
  sourceFact?: string | unknown;
  source_key?: string;
  sourceKey?: string;
  fact?: string | unknown;
  fact_id?: string;
  factId?: string;
  field?: string;
  key?: string;

  unit_id?: string;
  unitId?: string;
  unit_key?: string;
  unitKey?: string;
  dependency_result?: unknown;
  dependencyResult?: unknown;
  dependency?: unknown;
  predecessor?: unknown;
  predecessor_result?: unknown;
  predecessorResult?: unknown;
  result_id?: string;
  resultId?: string;
  output_id?: string;
  outputId?: string;
  fingerprint?: string | null;
  result_fingerprint?: string | null;
  resultFingerprint?: string | null;
  predecessor_fingerprint?: string | null;
  predecessorFingerprint?: string | null;
  predecessor_unit_id?: string;
  predecessorUnitId?: string;
  predecessor_fact_id?: string;
  predecessorFactId?: string;
  origin?: string;
  source?: string;

  evidence?: unknown;
  evidence_input?: unknown;
  evidenceInput?: unknown;
  evidence_key?: string;
  evidenceKey?: string;
  value?: unknown;
}

export type RollingInputDeclarationValue = string | RollingInputDeclaration;

export interface RollingInputDependencies {
  lstat?: ApplySourceLstat;
  stat?: ApplySourceLstat;
  readBytes?: ApplySourceReadBytes;
  readFile?: ApplySourceReadBytes;
  readInput?: ApplySourceReadBytes;
  readFileBytes?: ApplySourceReadBytes;
  readlink?: ApplySourceReadLink;
}

export interface RollingLocalInputCaptureRequest {
  [key: string]: unknown;
  repo_root?: string;
  repoRoot?: string;
  owner_key?: string;
  ownerKey?: string;
  owner_id?: string;
  ownerId?: string;
  unit_id?: string;
  unitId?: string;
  unit_key?: string;
  unitKey?: string;
  gate_id?: string;
  gateId?: string;
  gate_key?: string;
  gateKey?: string;

  /** One explicit flat declaration list. */
  inputs?: readonly RollingInputDeclarationValue[];
  declarations?: readonly RollingInputDeclarationValue[];
  declared_inputs?: readonly RollingInputDeclarationValue[];
  declaredInputs?: readonly RollingInputDeclarationValue[];
  local_inputs?: readonly RollingInputDeclarationValue[];
  localInputs?: readonly RollingInputDeclarationValue[];

  /** Convenience lists; each item is still a caller-declared fact. */
  paths?: readonly (string | RollingInputDeclaration)[];
  repository_paths?: readonly (string | RollingInputDeclaration)[];
  repositoryPaths?: readonly (string | RollingInputDeclaration)[];
  read_paths?: readonly (string | RollingInputDeclaration)[];
  readPaths?: readonly (string | RollingInputDeclaration)[];
  source_facts?: readonly RollingInputDeclarationValue[] | Readonly<Record<string, unknown>>;
  sourceFacts?: readonly RollingInputDeclarationValue[] | Readonly<Record<string, unknown>>;
  source_inputs?: readonly RollingInputDeclarationValue[];
  sourceInputs?: readonly RollingInputDeclarationValue[];
  source_declarations?: readonly RollingInputDeclarationValue[];
  sourceDeclarations?: readonly RollingInputDeclarationValue[];
  repository_facts?: readonly RollingInputDeclarationValue[] | Readonly<Record<string, unknown>>;
  repositoryFacts?: readonly RollingInputDeclarationValue[] | Readonly<Record<string, unknown>>;
  repository_inputs?: readonly RollingInputDeclarationValue[];
  repositoryInputs?: readonly RollingInputDeclarationValue[];
  repository_declarations?: readonly RollingInputDeclarationValue[];
  repositoryDeclarations?: readonly RollingInputDeclarationValue[];
  dependency_results?: readonly unknown[] | Readonly<Record<string, unknown>>;
  dependencyResults?: readonly unknown[] | Readonly<Record<string, unknown>>;
  dependency_inputs?: readonly RollingInputDeclarationValue[];
  dependencyInputs?: readonly RollingInputDeclarationValue[];
  dependency_declarations?: readonly RollingInputDeclarationValue[];
  dependencyDeclarations?: readonly RollingInputDeclarationValue[];
  predecessor_facts?: readonly unknown[] | Readonly<Record<string, unknown>>;
  predecessorFacts?: readonly unknown[] | Readonly<Record<string, unknown>>;
  predecessor_results?: readonly unknown[] | Readonly<Record<string, unknown>>;
  predecessorResults?: readonly unknown[] | Readonly<Record<string, unknown>>;
  evidence_inputs?: readonly unknown[] | Readonly<Record<string, unknown>>;
  evidenceInputs?: readonly unknown[] | Readonly<Record<string, unknown>>;
  evidence_declarations?: readonly RollingInputDeclarationValue[];
  evidenceDeclarations?: readonly RollingInputDeclarationValue[];
  evidence?: readonly unknown[] | Readonly<Record<string, unknown>>;

  /** Complete source facts may be supplied under either name. */
  source?: unknown;
  facts?: unknown;
  repository?: unknown;
  repository_facts_snapshot?: unknown;
  repositoryFactsSnapshot?: unknown;
  dependencies?: RollingInputDependencies;
  capture?: RollingInputDependencies;
  lstat?: ApplySourceLstat;
  stat?: ApplySourceLstat;
  readBytes?: ApplySourceReadBytes;
  readFile?: ApplySourceReadBytes;
  readInput?: ApplySourceReadBytes;
  readFileBytes?: ApplySourceReadBytes;
  readlink?: ApplySourceReadLink;
}

export interface RollingUnitLocalInputCaptureRequest extends RollingLocalInputCaptureRequest {
  owner_kind?: "unit";
  ownerKind?: "unit";
  unit?: { id?: string; key?: string; unit_id?: string; unit_key?: string; inputs?: readonly RollingInputDeclarationValue[]; input_fingerprints?: Readonly<Record<string, string>>; inputFingerprints?: Readonly<Record<string, string>> };
}

export interface RollingGateLocalInputCaptureRequest extends RollingLocalInputCaptureRequest {
  owner_kind?: "gate";
  ownerKind?: "gate";
  gate?: { id?: string; key?: string; gate_id?: string; gate_key?: string; inputs?: readonly RollingInputDeclarationValue[]; relevant_input_fingerprints?: Readonly<Record<string, string>>; relevantInputFingerprints?: Readonly<Record<string, string>> };
}

export class RollingInputError extends Error {
  readonly code: string;
  readonly input?: string;

  constructor(code: string, message: string, input?: string) {
    super(message);
    this.name = "RollingInputError";
    this.code = code;
    this.input = input;
  }
}


type RecordLike = Record<string, unknown>;
type FactContainer = unknown;

const KIND_ALIASES: Readonly<Record<string, RollingInputKind>> = {
  "repository-path": "repository-path",
  "repository_path": "repository-path",
  "repository-paths": "repository-path",
  "repo-path": "repository-path",
  "repo_path": "repository-path",
  path: "repository-path",
  file: "repository-path",
  paths: "repository-path",

  "repository-fact": "repository-fact",
  "repository_fact": "repository-fact",
  "repo-fact": "repository-fact",
  "repo_fact": "repository-fact",
  repository: "repository-fact",
  git: "repository-fact",
  "git-fact": "repository-fact",

  "source-fact": "source-fact",
  "source_fact": "source-fact",
  source: "source-fact",
  fact: "source-fact",

  "dependency-result": "dependency-result",
  "dependency_result": "dependency-result",
  dependency: "dependency-result",
  predecessor: "dependency-result",
  "predecessor-result": "dependency-result",
  "predecessor_result": "dependency-result",
  output: "dependency-result",

  evidence: "evidence",
  "evidence-input": "evidence",
  "evidence_input": "evidence",
  "gate-evidence": "evidence",
  gate_evidence: "evidence",
};

const EPHEMERAL_KEYS = new Set([
  "append_sequence",
  "appendSequence",
  "run_append_sequence",
  "runAppendSequence",
  "prepared_from_append_sequence",
  "preparedFromAppendSequence",
]);

function isPlainRecord(value: unknown): value is RecordLike {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clone(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainRecord(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !EPHEMERAL_KEYS.has(key)).map(([key, item]) => [key, clone(item)]));
  throw new RollingInputError("ROLLING_INPUT_VALUE_INVALID", "input fact must be JSON-compatible");
}

function hash(value: unknown): string {
  const canonical = canonicalizeRolling(clone(value));
  return sha256Hex(typeof canonical === "string" ? canonical : "null");
}

function canonicalLabel(raw: unknown, fallback?: string): string {
  const candidate = text(raw) || fallback;
  if (!candidate) throw new RollingInputError("ROLLING_INPUT_LABEL_INVALID", "input label is required");
  const value = candidate.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!value || value.length > 256 || value.includes("\0") || [...value].some((item) => {
    const code = item.codePointAt(0) || 0;
    return code < 0x20 || code === 0x7f;
  })) throw new RollingInputError("ROLLING_INPUT_LABEL_INVALID", `input label is unsafe: ${candidate}`, candidate);
  return value;
}

function canonicalOwnerKey(value: unknown): string {
  if (!text(value)) throw new RollingInputError("ROLLING_INPUT_OWNER_INVALID", "owner key is required");
  const candidate = canonicalLabel(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(candidate)) {
    throw new RollingInputError("ROLLING_INPUT_OWNER_INVALID", `owner key is not a stable identity: ${candidate}`, candidate);
  }
  return candidate;
}

function repoRootOf(request: RollingLocalInputCaptureRequest): string {
  const value = text(request.repo_root) || text(request.repoRoot);
  if (!value) throw new RollingInputError("ROLLING_INPUT_REPOSITORY_ROOT_REQUIRED", "repo_root is required");
  return path.resolve(value);
}

function ownerOf(request: RollingLocalInputCaptureRequest, forced?: RollingInputOwnerKind): { kind: RollingInputOwnerKind; key: string } {
  const owner = isRecord(request.owner) ? request.owner : undefined;
  const nestedUnit = isRecord(request.unit) ? request.unit : isRecord(request.unit_version) ? request.unit_version : isRecord(request.unitVersion) ? request.unitVersion : undefined;
  const nestedGate = isRecord(request.gate) ? request.gate : isRecord(request.gate_version) ? request.gate_version : isRecord(request.gateVersion) ? request.gateVersion : undefined;
  const kindValue = forced
    || (request.owner_kind === "unit" || request.owner_kind === "gate" ? request.owner_kind : undefined)
    || (request.ownerKind === "unit" || request.ownerKind === "gate" ? request.ownerKind : undefined)
    || (owner && (owner.kind === "unit" || owner.kind === "gate") ? owner.kind : undefined)
    || (nestedUnit ? "unit" : nestedGate ? "gate" : undefined);
  const kind = kindValue || (text(request.unit_id) || text(request.unitId) || text(request.unit_key) || text(request.unitKey) ? "unit" : undefined)
    || (text(request.gate_id) || text(request.gateId) || text(request.gate_key) || text(request.gateKey) ? "gate" : undefined);
  if (!kind) throw new RollingInputError("ROLLING_INPUT_OWNER_INVALID", "unit or gate owner kind is required");
  const key = text(request.owner_key)
    || text(request.ownerKey)
    || text(request.owner_id)
    || text(request.ownerId)
    || (kind === "unit" ? text(request.unit_id) || text(request.unitId) || text(request.unit_key) || text(request.unitKey) : text(request.gate_id) || text(request.gateId) || text(request.gate_key) || text(request.gateKey))
    || (kind === "unit" ? text(nestedUnit?.id) || text(nestedUnit?.key) || text(nestedUnit?.unit_id) || text(nestedUnit?.unit_key) : text(nestedGate?.id) || text(nestedGate?.key) || text(nestedGate?.gate_id) || text(nestedGate?.gate_key))
    || text(owner?.key) || text(owner?.id);
  return { kind: kind as RollingInputOwnerKind, key: canonicalOwnerKey(key) };
}

function canonicalKind(value: unknown, fallback?: RollingInputKind): RollingInputKind {
  const raw = text(value)?.normalize("NFKC").toLowerCase().replace(/\s+/gu, "-");
  if (raw && KIND_ALIASES[raw]) return KIND_ALIASES[raw];
  if (fallback) return fallback;
  throw new RollingInputError("ROLLING_INPUT_KIND_INVALID", `unsupported input kind: ${String(value)}`);
}

function slashPath(repoRoot: string, raw: unknown): string {
  const candidate = text(raw);
  if (!candidate) throw new RollingInputError("ROLLING_INPUT_PATH_INVALID", "repository input path is required");
  if (candidate.includes("\0")) throw new RollingInputError("ROLLING_INPUT_PATH_INVALID", "repository input path contains NUL", candidate);
  const absolute = path.resolve(repoRoot, candidate.replaceAll("\\", "/"));
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RollingInputError("ROLLING_INPUT_PATH_INVALID", `repository input path escapes repo_root: ${candidate}`, candidate);
  }
  const normalized = relative.split(path.sep).join("/");
  if (normalized.includes("*") || normalized.includes("?") || normalized.includes("[")) {
    throw new RollingInputError("ROLLING_INPUT_PATH_INVALID", `repository input path must be concrete: ${candidate}`, candidate);
  }
  return normalized;
}

function selector(value: unknown): string | undefined {
  if (typeof value === "string") return text(value);
  if (!isRecord(value)) return undefined;
  return text(value.selector) || text(value.path) || text(value.key) || text(value.name) || text(value.id) || text(value.fact_id) || text(value.factId);
}

function declarationKind(value: RollingInputDeclaration): RollingInputKind {
  const explicit = value.kind ?? value.type ?? value.input_kind ?? value.inputKind;
  if (explicit !== undefined) return canonicalKind(explicit);
  if (value.origin === "predecessor" || value.origin === "produced" || value.origin === "predecessor-produced"
    || value.source === "predecessor" || value.source === "produced" || value.source === "predecessor-produced"
    || value.predecessor !== undefined || value.predecessor_result !== undefined || value.predecessorResult !== undefined
    || value.predecessor_fingerprint !== undefined || value.predecessorFingerprint !== undefined) return "dependency-result";
  if (value.repository_path !== undefined || value.repositoryPath !== undefined || value.repo_path !== undefined || value.repoPath !== undefined
    || value.file_path !== undefined || value.filePath !== undefined || value.repository_file !== undefined || value.repositoryFile !== undefined || value.path !== undefined) return "repository-path";
  if (value.dependency_result !== undefined || value.dependencyResult !== undefined || value.dependency !== undefined || value.predecessor !== undefined || value.predecessor_result !== undefined || value.predecessorResult !== undefined || value.unit_id !== undefined || value.unitId !== undefined || value.unit_key !== undefined || value.unitKey !== undefined) return "dependency-result";
  if (value.evidence !== undefined || value.evidence_input !== undefined || value.evidenceInput !== undefined || value.evidence_key !== undefined || value.evidenceKey !== undefined) return "evidence";
  if (value.repository_fact !== undefined || value.repositoryFact !== undefined) return "repository-fact";
  return "source-fact";
}

interface NormalizedDeclaration {
  label: string;
  kind: RollingInputKind;
  path?: string;
  selector?: string;
  unit_id?: string;
  fact_id?: string;
  fingerprint?: string | null;
  value?: unknown;
  /** Explicit inline source/dependency/evidence identity. */
  inline?: unknown;
}

interface DependencyParts {
  unit_id?: string;
  fact_id?: string;
  fingerprint?: string | null;
  inline?: unknown;
}

function objectSelector(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return text(value);
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function dependencyParts(value: RollingInputDeclaration): DependencyParts {
  const nested = value.dependency_result ?? value.dependencyResult ?? value.dependency ?? value.predecessor_result ?? value.predecessorResult ?? value.predecessor;
  const nestedRecord = isRecord(nested) ? nested : undefined;
  const unit_id = text(value.unit_id) || text(value.unitId) || text(value.unit_key) || text(value.unitKey) || text(value.predecessor_unit_id) || text(value.predecessorUnitId)
    || objectSelector(nested, ["unit_id", "unitId", "unit_key", "unitKey", "producer_unit_id", "producerUnitId"]);
  const fact_id = text(value.fact_id) || text(value.factId) || text(value.result_id) || text(value.resultId) || text(value.output_id) || text(value.outputId) || text(value.predecessor_fact_id) || text(value.predecessorFactId)
    || objectSelector(nested, ["fact_id", "factId", "result_id", "resultId", "output_id", "outputId", "id", "name"]);
  const supplied = value.fingerprint ?? value.result_fingerprint ?? value.resultFingerprint ?? value.predecessor_fingerprint ?? value.predecessorFingerprint;
  const fingerprint = supplied !== undefined
    ? supplied
    : nestedRecord
      ? (nestedRecord.fingerprint ?? nestedRecord.result_fingerprint ?? nestedRecord.resultFingerprint ?? nestedRecord.output_fingerprint ?? nestedRecord.outputFingerprint ?? null) as string | null
      : typeof nested === "string" ? nested : undefined;
  return { unit_id, fact_id, fingerprint, inline: nestedRecord || (nested !== undefined && typeof nested !== "string" ? nested : undefined) };
}

function normalizeDeclaration(repoRoot: string, value: RollingInputDeclarationValue, fallbackKind?: RollingInputKind, fallbackLabel?: string): NormalizedDeclaration {
  const source: RollingInputDeclaration = typeof value === "string" ? { path: value } : value;
  if (!isRecord(source)) throw new RollingInputError("ROLLING_INPUT_DECLARATION_INVALID", "input declaration must be a string or object");
  const rawKind = source.kind ?? source.type ?? source.input_kind ?? source.inputKind;
  const kind = rawKind === undefined ? fallbackKind || declarationKind(source) : canonicalKind(rawKind);
  const rawPath = source.path ?? source.repository_path ?? source.repositoryPath ?? source.repo_path ?? source.repoPath
    ?? source.file_path ?? source.filePath ?? source.repository_file ?? source.repositoryFile;
  const rawSelector = text(source.selector)
    || (kind === "source-fact" || kind === "repository-fact"
      ? text(source.source_key) || text(source.sourceKey) || text(source.field) || text(source.key)
        || selector(source.source_fact) || selector(source.sourceFact) || selector(source.fact)
        || (typeof rawPath === "string" ? text(rawPath) : undefined)
      : undefined)
    || (kind === "evidence" ? text(source.evidence_key) || text(source.evidenceKey) || selector(source.evidence_input ?? source.evidenceInput ?? source.evidence)
      || (typeof rawPath === "string" ? text(rawPath) : undefined) : undefined);
  const dependency = kind === "dependency-result" ? dependencyParts(source) : {};
  const label = canonicalLabel(source.label ?? source.name ?? source.id, fallbackLabel || (kind === "repository-path" ? rawPath : rawSelector || dependency.fact_id));
  const inlineFact = source.value !== undefined
    ? source.value
    : kind !== "dependency-result" && source.fingerprint !== undefined
      ? source.fingerprint
      : undefined;
  const evidenceRaw = source.evidence_input ?? source.evidenceInput ?? source.evidence;
  const inlineEvidence = kind === "evidence" && inlineFact === undefined && evidenceRaw !== undefined
    && (typeof evidenceRaw !== "object" || evidenceRaw === null)
    ? evidenceRaw
    : undefined;
  const evidenceEnvelope = kind === "evidence" && inlineFact === undefined && isRecord(evidenceRaw)
    && (evidenceRaw.fingerprint !== undefined || evidenceRaw.sha256 !== undefined || evidenceRaw.hash !== undefined)
    ? evidenceRaw
    : undefined;
  const result: NormalizedDeclaration = {
    label,
    kind,
    ...(kind === "repository-path" ? { path: slashPath(repoRoot, rawPath) } : {}),
    ...(kind !== "repository-path" && (rawSelector || inlineFact !== undefined || inlineEvidence !== undefined || evidenceEnvelope !== undefined) ? { selector: canonicalLabel(rawSelector || label) } : {}),
    ...(dependency.unit_id ? { unit_id: canonicalOwnerKey(dependency.unit_id) } : {}),
    ...(dependency.fact_id ? { fact_id: canonicalLabel(dependency.fact_id) } : {}),
    ...(dependency.fingerprint !== undefined ? { fingerprint: dependency.fingerprint ?? null } : {}),
    ...(inlineFact !== undefined ? { value: clone(inlineFact) } : {}),
    ...(inlineEvidence !== undefined ? { inline: clone(inlineEvidence) } : {}),
    ...(evidenceEnvelope !== undefined ? { inline: clone(evidenceEnvelope) } : {}),
    ...(dependency.inline !== undefined ? { inline: clone(dependency.inline) } : {}),
  };
  if (kind !== "repository-path" && !result.selector && kind !== "dependency-result") {
    throw new RollingInputError("ROLLING_INPUT_SELECTOR_INVALID", `input ${label} needs a source/evidence selector`, label);
  }
  if (kind === "dependency-result" && (!result.unit_id || !result.fact_id)) {
    throw new RollingInputError("ROLLING_INPUT_DEPENDENCY_INVALID", `dependency input ${label} needs unit_id and fact_id`, label);
  }
  if (kind === "repository-path" && result.path === undefined) {
    throw new RollingInputError("ROLLING_INPUT_PATH_INVALID", `repository input ${label} needs a path`, label);
  }
  return result;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function declarationsOf(request: RollingLocalInputCaptureRequest, ownerKind: RollingInputOwnerKind): NormalizedDeclaration[] {
  const repoRoot = repoRootOf(request);
  const out: NormalizedDeclaration[] = [];
  const generic = request.inputs ?? request.declarations ?? request.declared_inputs ?? request.declaredInputs ?? request.local_inputs ?? request.localInputs;
  const nested = ownerKind === "unit"
    ? isRecord(request.unit) ? request.unit : isRecord(request.unit_version) ? request.unit_version : isRecord(request.unitVersion) ? request.unitVersion : undefined
    : isRecord(request.gate) ? request.gate : isRecord(request.gate_version) ? request.gate_version : isRecord(request.gateVersion) ? request.gateVersion : undefined;
  const nestedInputs = nested
    ? [
      ...list(nested.inputs),
      ...list(nested.declared_inputs),
      ...list(nested.declaredInputs),
      ...list(nested.read_paths),
      ...list(nested.readPaths),
      ...list(nested.read_inputs),
      ...list(nested.readInputs),
      ...list(nested.write_paths),
      ...list(nested.writePaths),
      ...list(nested.write_inputs),
      ...list(nested.writeInputs),
      ...Object.entries(isRecord(nested.input_fingerprints ?? nested.inputFingerprints) ? nested.input_fingerprints ?? nested.inputFingerprints : {})
        .map(([label, value]) => ({ label, kind: "source-fact", selector: label, value })),
      ...Object.entries(isRecord(nested.relevant_input_fingerprints ?? nested.relevantInputFingerprints) ? nested.relevant_input_fingerprints ?? nested.relevantInputFingerprints : {})
        .map(([label, value]) => ({ label, kind: "source-fact", selector: label, value })),
    ]
    : [];
  for (const entry of [...list(generic), ...nestedInputs]) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue));

  const paths = [
    ...list(request.paths),
    ...list(request.repository_paths),
    ...list(request.repositoryPaths),
    ...list(request.read_paths),
    ...list(request.readPaths),
  ];
  for (const entry of paths) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "repository-path"));

  for (const entry of [
    ...list(request.source_inputs),
    ...list(request.sourceInputs),
    ...list(request.source_declarations),
    ...list(request.sourceDeclarations),
  ]) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "source-fact"));
  // An array in `source_facts` is retained as a declaration-list convenience;
  // an object in that field is an index of caller-supplied facts and is only
  // queried when a declaration selects one member.
  if (Array.isArray(request.source_facts)) for (const entry of request.source_facts) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "source-fact"));
  if (Array.isArray(request.sourceFacts)) for (const entry of request.sourceFacts) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "source-fact"));
  if (isRecord(request.source_facts) && (request.source_facts.label !== undefined || request.source_facts.selector !== undefined || request.source_facts.fingerprint !== undefined || request.source_facts.value !== undefined)) {
    out.push(normalizeDeclaration(repoRoot, request.source_facts as unknown as RollingInputDeclaration, "source-fact"));
  }
  if (isRecord(request.sourceFacts) && (request.sourceFacts.label !== undefined || request.sourceFacts.selector !== undefined || request.sourceFacts.fingerprint !== undefined || request.sourceFacts.value !== undefined)) {
    out.push(normalizeDeclaration(repoRoot, request.sourceFacts as unknown as RollingInputDeclaration, "source-fact"));
  }
  for (const entry of [
    ...list(request.repository_inputs),
    ...list(request.repositoryInputs),
    ...list(request.repository_declarations),
    ...list(request.repositoryDeclarations),
  ]) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "repository-fact"));
  if (Array.isArray(request.repository_facts)) for (const entry of request.repository_facts) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "repository-fact"));
  if (Array.isArray(request.repositoryFacts)) for (const entry of request.repositoryFacts) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "repository-fact"));
  if (isRecord(request.repository_facts) && (request.repository_facts.label !== undefined || request.repository_facts.selector !== undefined || request.repository_facts.fingerprint !== undefined || request.repository_facts.value !== undefined)) {
    out.push(normalizeDeclaration(repoRoot, request.repository_facts as unknown as RollingInputDeclaration, "repository-fact"));
  }
  if (isRecord(request.repositoryFacts) && (request.repositoryFacts.label !== undefined || request.repositoryFacts.selector !== undefined || request.repositoryFacts.fingerprint !== undefined || request.repositoryFacts.value !== undefined)) {
    out.push(normalizeDeclaration(repoRoot, request.repositoryFacts as unknown as RollingInputDeclaration, "repository-fact"));
  }
  for (const entry of [
    ...list(request.dependency_inputs),
    ...list(request.dependencyInputs),
    ...list(request.dependency_declarations),
    ...list(request.dependencyDeclarations),
  ]) out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "dependency-result"));
  for (const entry of [...list(request.evidence_declarations), ...list(request.evidenceDeclarations)]) {
    out.push(normalizeDeclaration(repoRoot, entry as RollingInputDeclarationValue, "evidence"));
  }

  return out;
}

function containerOf(request: RollingLocalInputCaptureRequest, kind: RollingInputKind): FactContainer {
  if (kind === "repository-fact") {
    const supplied = request.repository_facts_snapshot ?? request.repositoryFactsSnapshot ?? request.repository_facts ?? request.repositoryFacts;
    if (supplied !== undefined) return supplied;
    if (isRecord(request.repository)) return request.repository;
    const source = request.source ?? request.facts;
    if (isRecord(source) && isRecord(source.repository)) return source.repository;
    return request.source_facts ?? request.sourceFacts ?? source;
  }
  return request.source_facts ?? request.sourceFacts ?? request.source ?? request.facts;
}

function dependencyContainerOf(request: RollingLocalInputCaptureRequest): FactContainer {
  return request.dependency_results ?? request.dependencyResults ?? request.predecessor_facts ?? request.predecessorFacts ?? request.predecessor_results ?? request.predecessorResults;
}

function evidenceContainerOf(request: RollingLocalInputCaptureRequest): FactContainer {
  return request.evidence_inputs ?? request.evidenceInputs ?? request.evidence;
}

function dependenciesOf(request: RollingLocalInputCaptureRequest): RollingInputDependencies {
  const nested = isRecord(request.dependencies) ? request.dependencies : {};
  const capture = isRecord(request.capture) ? request.capture : {};
  return {
    ...(capture as RollingInputDependencies),
    ...(nested as RollingInputDependencies),
    ...(request.lstat ? { lstat: request.lstat } : {}),
    ...(request.stat ? { stat: request.stat } : {}),
    ...(request.readBytes ? { readBytes: request.readBytes } : {}),
    ...(request.readFile ? { readFile: request.readFile } : {}),
    ...(request.readInput ? { readInput: request.readInput } : {}),
    ...(request.readFileBytes ? { readFileBytes: request.readFileBytes } : {}),
    ...(request.readlink ? { readlink: request.readlink } : {}),
  };
}

function keyVariants(key: string): string[] {
  const variants = new Set<string>([key]);
  variants.add(key.replace(/[- ]/gu, "_"));
  variants.add(key.replace(/[_ -]+(.)/gu, (_match, character: string) => character.toUpperCase()));
  return [...variants];
}

function getSelected(container: unknown, selectorValue: string): { found: boolean; value?: unknown } {
  if (container instanceof Map) {
    for (const candidate of keyVariants(selectorValue)) if (container.has(candidate)) return { found: true, value: container.get(candidate) };
    return { found: false };
  }
  if (!isRecord(container)) return { found: false };
  for (const candidate of keyVariants(selectorValue)) if (Object.prototype.hasOwnProperty.call(container, candidate)) return { found: true, value: container[candidate] };
  const parts = selectorValue.split(".");
  let current: unknown = container;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(part)) return { found: false };
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return { found: false };
    let selected: unknown;
    let found = false;
    for (const candidate of keyVariants(part)) if (Object.prototype.hasOwnProperty.call(current, candidate)) { selected = current[candidate]; found = true; break; }
    if (!found) return { found: false };
    current = selected;
  }
  return { found: true, value: current };
}

function selectedFactValue(declaration: NormalizedDeclaration, request: RollingLocalInputCaptureRequest): unknown {
  const inline = declaration.value !== undefined ? declaration.value : declaration.inline;
  if (inline !== undefined) return clone(inline);
  const container = containerOf(request, declaration.kind);
  let selected = getSelected(container, declaration.selector || declaration.label);
  if (!selected.found && declaration.kind === "repository-fact" && isRecord(container) && isRecord(container.repository)) {
    selected = getSelected(container.repository, declaration.selector || declaration.label);
  }
  if (!selected.found) throw new RollingInputError("ROLLING_INPUT_FACT_MISSING", `declared ${declaration.kind} is not available: ${declaration.selector || declaration.label}`, declaration.label);
  const value = selected.value;
  if (isRecord(value)) {
    // A result/fact envelope contributes the selected identity, not metadata
    // such as an append sequence or an unrelated payload.
    if (value.fingerprint !== undefined && Object.keys(value).every((key) => ["fingerprint", "sha256", "hash", "identity", "id", "label"].includes(key) || EPHEMERAL_KEYS.has(key))) {
      return clone(value.fingerprint);
    }
    if (value.sha256 !== undefined && Object.keys(value).every((key) => ["fingerprint", "sha256", "hash", "identity", "id", "label"].includes(key) || EPHEMERAL_KEYS.has(key))) {
      return clone(value.sha256);
    }
  }
  return clone(value);
}

function dependencyEntries(container: unknown): Array<{ key?: string; value: unknown }> {
  if (Array.isArray(container)) return container.map((value) => ({ value }));
  if (!isRecord(container)) return [];
  return Object.entries(container).map(([key, value]) => ({ key, value }));
}

function directDependency(container: unknown, unitId: string, factId: string): { found: boolean; value?: unknown } {
  const keys = [`${unitId}\0${factId}`, `${unitId}:${factId}`, `${unitId}/${factId}`];
  if (container instanceof Map) {
    for (const key of keys) if (container.has(key)) return { found: true, value: container.get(key) };
    if (container.has(unitId)) {
      const nested = getSelected(container.get(unitId), factId);
      if (nested.found) return nested;
    }
    return { found: false };
  }
  if (!isRecord(container)) return { found: false };
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(container, key)) return { found: true, value: container[key] };
  if (Object.prototype.hasOwnProperty.call(container, unitId)) {
    const nested = getSelected(container[unitId], factId);
    if (nested.found) return nested;
  }
  return { found: false };
}

function dependencyIdentity(declaration: NormalizedDeclaration, request: RollingLocalInputCaptureRequest): RollingDependencyResultIdentity {
  const unit_id = declaration.unit_id!;
  const fact_id = declaration.fact_id!;
  const expected = `${unit_id}\0${fact_id}`;
  let found: unknown;
  let has = false;
  const container = dependencyContainerOf(request);
  const direct = directDependency(container, unit_id, fact_id);
  if (direct.found) found = direct.value, has = true;
  // Array-shaped facts have no key index.  The scan remains bounded to the
  // caller's supplied list and happens only when direct lookup cannot match.
  if (!has) for (const { value } of dependencyEntries(container)) {
    const item = isRecord(value) ? value : undefined;
    const itemUnit = text(item?.unit_id) || text(item?.unitId) || text(item?.unit_key) || text(item?.unitKey);
    const itemFact = text(item?.fact_id) || text(item?.factId) || text(item?.result_id) || text(item?.resultId) || text(item?.output_id) || text(item?.outputId);
    if (itemUnit === unit_id && itemFact === fact_id) { found = value; has = true; break; }
  }
  if (!has && declaration.inline !== undefined) found = declaration.inline, has = true;
  if (!has && declaration.fingerprint !== undefined) found = { fingerprint: declaration.fingerprint }, has = true;
  if (!has) throw new RollingInputError("ROLLING_INPUT_DEPENDENCY_MISSING", `accepted dependency result is not available: ${unit_id}/${fact_id}`, declaration.label);
  let fingerprint: string | null | undefined;
  if (typeof found === "string") fingerprint = found;
  else if (isRecord(found)) {
    const value = found;
    fingerprint = (value.fingerprint ?? value.result_fingerprint ?? value.resultFingerprint ?? value.output_fingerprint ?? value.outputFingerprint ?? value.sha256 ?? value.hash) as string | null | undefined;
  }
  if (fingerprint === undefined) fingerprint = declaration.fingerprint;
  if (fingerprint !== null && fingerprint !== undefined && typeof fingerprint !== "string") {
    throw new RollingInputError("ROLLING_INPUT_DEPENDENCY_INVALID", `dependency fingerprint is not a string: ${declaration.label}`, declaration.label);
  }
  return { unit_id, fact_id, fingerprint: fingerprint ?? null };
}

function evidenceValue(declaration: NormalizedDeclaration, request: RollingLocalInputCaptureRequest): RollingEvidenceInput {
  let value: unknown;
  if (declaration.value !== undefined) value = declaration.value;
  else {
    const selected = getSelected(evidenceContainerOf(request), declaration.selector || declaration.label);
    if (selected.found) value = selected.value;
    else if (declaration.inline !== undefined) value = declaration.inline;
    else throw new RollingInputError("ROLLING_INPUT_EVIDENCE_MISSING", `declared evidence is not available: ${declaration.selector || declaration.label}`, declaration.label);
  }
  return { selector: declaration.selector || declaration.label, value: clone(value) };
}

function statKind(value: RecordLike): ApplySourceFileKind {
  if (value.exists === false || value.kind === "missing") return "missing";
  if (value.kind === "file" || value.kind === "directory" || value.kind === "symlink" || value.kind === "other") return value.kind;
  if (typeof value.isSymbolicLink === "function" && value.isSymbolicLink()) return "symlink";
  if (typeof value.isFile === "function" && value.isFile()) return "file";
  if (typeof value.isDirectory === "function" && value.isDirectory()) return "directory";
  return "other";
}

function metadata(stat: RecordLike, kind: ApplySourceFileKind, target?: string): RollingRepositoryPathFact {
  const mode = kind === "missing" ? null : typeof stat.mode === "number" && Number.isFinite(stat.mode) ? stat.mode & 0o7777 : null;
  const size = kind === "missing" ? null : typeof stat.size === "number" && Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : null;
  return { path: "", kind, mode, size, sha256: null, ...(kind === "symlink" && target !== undefined ? { target } : {}) };
}

async function defaultLstat(absolutePath: string): Promise<RecordLike> {
  try { return await fs.promises.lstat(absolutePath) as unknown as RecordLike; }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return { kind: "missing", exists: false }; throw error; }
}

async function defaultReadBytes(absolutePath: string): Promise<AsyncIterable<Uint8Array>> {
  return fs.createReadStream(absolutePath);
}

async function defaultReadlink(absolutePath: string): Promise<string> {
  return fs.promises.readlink(absolutePath);
}

async function bytesHash(read: ApplySourceReadBytes, absolutePath: string): Promise<string> {
  const value = await read(absolutePath);
  const digest = crypto.createHash("sha256");
  if (typeof value === "string") digest.update(value);
  else if (value instanceof Uint8Array) digest.update(value);
  else for await (const chunk of value) digest.update(chunk);
  return digest.digest("hex");
}

async function repositoryPathValue(repoRoot: string, declaration: NormalizedDeclaration, request: RollingLocalInputCaptureRequest): Promise<RollingRepositoryPathFact> {
  const dependencies = dependenciesOf(request);
  const lstat = dependencies.lstat || dependencies.stat || defaultLstat;
  const absolute = path.join(repoRoot, declaration.path!);
  const stat = await lstat(absolute) as RecordLike;
  const kind = statKind(stat);
  let target: string | undefined;
  if (kind === "symlink") {
    target = text(stat.target);
    if (target === undefined) {
      const readlink = dependencies.readlink || defaultReadlink;
      try { target = await readlink(absolute); } catch { /* metadata remains bounded when readlink is unavailable */ }
    }
  }
  const result = metadata(stat, kind, target);
  result.path = declaration.path!;
  if (kind === "file") {
    const read = dependencies.readBytes || dependencies.readInput || dependencies.readFile || dependencies.readFileBytes || defaultReadBytes;
    result.sha256 = await bytesHash(read, absolute);
  }
  return result;
}

function componentIdentity(declaration: NormalizedDeclaration): string {
  if (declaration.kind === "repository-path") return declaration.path!;
  if (declaration.kind === "dependency-result") return `${declaration.unit_id!}\0${declaration.fact_id!}`;
  return declaration.selector || declaration.label;
}

function duplicateIdentity(declaration: NormalizedDeclaration): string {
  return `${declaration.kind}\0${componentIdentity(declaration)}`;
}

function componentFingerprint(component: Omit<RollingInputFingerprintComponent, "fingerprint">): string {
  return hash(component);
}

function componentAliases<T extends RollingInputFingerprintComponent>(value: T): T {
  const source = value.kind === "repository-path" || value.kind === "repository-fact"
    ? "repository"
    : value.kind === "source-fact" ? "source" : value.kind === "dependency-result" ? "dependency" : "evidence";
  Object.defineProperties(value, {
    source: { configurable: false, enumerable: false, value: source },
    input_kind: { configurable: false, enumerable: false, value: value.kind },
    inputKind: { configurable: false, enumerable: false, value: value.kind },
    digest: { configurable: false, enumerable: false, value: value.fingerprint },
    selected: { configurable: false, enumerable: false, value: value.value },
    ...(value.kind === "repository-path" && isRecord(value.value) && typeof value.value.path === "string"
      ? { path: { configurable: false, enumerable: false, value: value.value.path } }
      : {}),
  });
  return value;
}

function aliases<T extends RollingLocalInputCapture>(value: T): T {
  const descriptors = {
    fingerprint_components: { configurable: false, enumerable: false, value: value.components },
    fingerprintComponents: { configurable: false, enumerable: false, value: value.components },
    inputs: { configurable: false, enumerable: false, value: value.components },
    input_fingerprints: { configurable: false, enumerable: false, value: value.component_fingerprints },
    inputFingerprints: { configurable: false, enumerable: false, value: value.component_fingerprints },
    local_fingerprint: { configurable: false, enumerable: false, value: value.fingerprint },
    localFingerprint: { configurable: false, enumerable: false, value: value.fingerprint },
    owner: { configurable: false, enumerable: false, value: { kind: value.owner_kind, key: value.owner_key } },
    ...(value.owner_kind === "unit"
      ? { unit_id: { configurable: false, enumerable: false, value: value.owner_key }, unitId: { configurable: false, enumerable: false, value: value.owner_key } }
      : { gate_key: { configurable: false, enumerable: false, value: value.owner_key }, gateKey: { configurable: false, enumerable: false, value: value.owner_key } }),
  };
  Object.defineProperties(value, descriptors);
  return value;
}

function localFingerprint(value: Pick<RollingLocalInputCapture, "owner_kind" | "owner_key" | "components">): string {
  const components = [...value.components].sort((left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind) || left.identity.localeCompare(right.identity));
  return hash({
    schema_version: ROLLING_INPUTS_SCHEMA_VERSION,
    owner_kind: value.owner_kind,
    owner_key: value.owner_key,
    components: components.map((component) => ({
      label: component.label,
      kind: component.kind,
      identity: component.identity,
      value: component.value,
      fingerprint: component.fingerprint,
    })),
  });
}

async function captureLocal(request: RollingLocalInputCaptureRequest, forced: RollingInputOwnerKind): Promise<RollingLocalInputCapture> {
  const repoRoot = repoRootOf(request);
  const owner = ownerOf(request, forced);
  const declarations = declarationsOf(request, owner.kind);
  const seenLabels = new Set<string>();
  const seenIdentities = new Set<string>();
  const components: RollingInputFingerprintComponent[] = [];
  for (const declaration of declarations) {
    if (seenLabels.has(declaration.label)) throw new RollingInputError("ROLLING_INPUT_DUPLICATE", `duplicate input label: ${declaration.label}`, declaration.label);
    seenLabels.add(declaration.label);
    const identity = componentIdentity(declaration);
    const identityKey = duplicateIdentity(declaration);
    if (seenIdentities.has(identityKey)) throw new RollingInputError("ROLLING_INPUT_DUPLICATE", `duplicate input identity: ${identity}`, declaration.label);
    seenIdentities.add(identityKey);
    let value: unknown;
    if (declaration.kind === "repository-path") value = await repositoryPathValue(repoRoot, declaration, request);
    else if (declaration.kind === "dependency-result") value = dependencyIdentity(declaration, request);
    else if (declaration.kind === "evidence") value = evidenceValue(declaration, request).value;
    else value = selectedFactValue(declaration, request);
    const normalizedValue = clone(value);
    const withoutFingerprint = { label: declaration.label, kind: declaration.kind, identity, value: normalizedValue };
    components.push(componentAliases({ ...withoutFingerprint, fingerprint: componentFingerprint(withoutFingerprint) }));
  }
  components.sort((left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind) || left.identity.localeCompare(right.identity));
  const component_fingerprints = Object.fromEntries(components.map((component) => [component.label, component.fingerprint]));
  const result: RollingLocalInputCapture = {
    schema_version: ROLLING_INPUTS_SCHEMA_VERSION,
    owner_kind: owner.kind,
    owner_key: owner.key,
    components,
    component_fingerprints,
    fingerprint: localFingerprint({ owner_kind: owner.kind, owner_key: owner.key, components }),
  };
  return aliases(result);
}

/** Capture only the explicitly declared inputs for one unit. */
export async function captureUnitLocalInputs(request: RollingUnitLocalInputCaptureRequest): Promise<RollingUnitLocalInputs> {
  return await captureLocal(request, "unit") as RollingUnitLocalInputs;
}

/** Capture only the explicitly declared inputs for one gate. */
export async function captureGateLocalInputs(request: RollingGateLocalInputCaptureRequest): Promise<RollingGateLocalInputs> {
  return await captureLocal(request, "gate") as RollingGateLocalInputs;
}

/** Source-neutral form for callers that choose the owner kind dynamically. */
export async function captureLocalInputs(request: RollingLocalInputCaptureRequest & { owner_kind: RollingInputOwnerKind }): Promise<RollingLocalInputCapture> {
  return captureLocal(request, request.owner_kind);
}


/**
 * Return the digest of an already captured local observation.  This overload
 * also makes the hashing rule useful to append validators that already hold
 * canonical components and do not need another filesystem read.
 */
export function fingerprintLocalInputs(value: RollingLocalInputCapture): string;
export function fingerprintLocalInputs(value: Pick<RollingLocalInputCapture, "owner_kind" | "owner_key" | "components">): string;
export function fingerprintLocalInputs(value: Pick<RollingLocalInputCapture, "owner_kind" | "owner_key" | "components">): string {
  return localFingerprint(value);
}


export function fingerprintInputComponent(value: Omit<RollingInputFingerprintComponent, "fingerprint"> | RollingInputFingerprintComponent): string {
  const { label, kind, identity, value: selected } = value;
  return componentFingerprint({ label, kind, identity, value: clone(selected) });
}


/** Exposed for validators and diagnostics that need to explain path rejection. */
export function normalizeRollingRepositoryPath(repoRoot: string, inputPath: string): string {
  return slashPath(path.resolve(repoRoot), inputPath);
}

/** Exposed for tests and adapters that need the exact label identity rule. */
export function normalizeRollingInputLabel(label: string): string {
  return canonicalLabel(label);
}

