/**
 * Declaration normalization for rolling local input capture. Split from
 * rolling-inputs.ts (leaf module; type-only imports point back).
 */
import path from "node:path";
import { sha256Hex } from "../json-utils.js";
import { isRecord } from "../validate-utils.js";
import { RollingInputError } from "../rolling-inputs.js";
import { canonicalizeRolling } from "./plan-validate.js";
import type {
  RollingInputDeclaration,
  RollingInputDeclarationValue,
  RollingInputKind,
  RollingInputOwnerKind,
  RollingLocalInputCaptureRequest,
} from "../rolling-inputs.js";

type RecordLike = Record<string, unknown>;

export const KIND_ALIASES: Readonly<Record<string, RollingInputKind>> = {
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

export const EPHEMERAL_KEYS = new Set([
  "append_sequence",
  "appendSequence",
  "run_append_sequence",
  "runAppendSequence",
  "prepared_from_append_sequence",
  "preparedFromAppendSequence",
]);

export function isPlainRecord(value: unknown): value is RecordLike {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function clone(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainRecord(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !EPHEMERAL_KEYS.has(key)).map(([key, item]) => [key, clone(item)]));
  throw new RollingInputError("ROLLING_INPUT_VALUE_INVALID", "input fact must be JSON-compatible");
}

export function hash(value: unknown): string {
  const canonical = canonicalizeRolling(clone(value));
  return sha256Hex(typeof canonical === "string" ? canonical : "null");
}

export function canonicalLabel(raw: unknown, fallback?: string): string {
  const candidate = text(raw) || fallback;
  if (!candidate) throw new RollingInputError("ROLLING_INPUT_LABEL_INVALID", "input label is required");
  const value = candidate.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!value || value.length > 256 || value.includes("\0") || [...value].some((item) => {
    const code = item.codePointAt(0) || 0;
    return code < 0x20 || code === 0x7f;
  })) throw new RollingInputError("ROLLING_INPUT_LABEL_INVALID", `input label is unsafe: ${candidate}`, candidate);
  return value;
}

export function canonicalOwnerKey(value: unknown): string {
  if (!text(value)) throw new RollingInputError("ROLLING_INPUT_OWNER_INVALID", "owner key is required");
  const candidate = canonicalLabel(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(candidate)) {
    throw new RollingInputError("ROLLING_INPUT_OWNER_INVALID", `owner key is not a stable identity: ${candidate}`, candidate);
  }
  return candidate;
}

export function repoRootOf(request: RollingLocalInputCaptureRequest): string {
  const value = text(request.repo_root) || text(request.repoRoot);
  if (!value) throw new RollingInputError("ROLLING_INPUT_REPOSITORY_ROOT_REQUIRED", "repo_root is required");
  return path.resolve(value);
}

export function ownerOf(request: RollingLocalInputCaptureRequest, forced?: RollingInputOwnerKind): { kind: RollingInputOwnerKind; key: string } {
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

export function canonicalKind(value: unknown, fallback?: RollingInputKind): RollingInputKind {
  const raw = text(value)?.normalize("NFKC").toLowerCase().replace(/\s+/gu, "-");
  if (raw && KIND_ALIASES[raw]) return KIND_ALIASES[raw];
  if (fallback) return fallback;
  throw new RollingInputError("ROLLING_INPUT_KIND_INVALID", `unsupported input kind: ${String(value)}`);
}

export function slashPath(repoRoot: string, raw: unknown): string {
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

export function selector(value: unknown): string | undefined {
  if (typeof value === "string") return text(value);
  if (!isRecord(value)) return undefined;
  return text(value.selector) || text(value.path) || text(value.key) || text(value.name) || text(value.id) || text(value.fact_id) || text(value.factId);
}

export function declarationKind(value: RollingInputDeclaration): RollingInputKind {
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

export interface NormalizedDeclaration {
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

export interface DependencyParts {
  unit_id?: string;
  fact_id?: string;
  fingerprint?: string | null;
  inline?: unknown;
}

export function objectSelector(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return text(value);
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

export function dependencyParts(value: RollingInputDeclaration): DependencyParts {
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

export function normalizeDeclaration(repoRoot: string, value: RollingInputDeclarationValue, fallbackKind?: RollingInputKind, fallbackLabel?: string): NormalizedDeclaration {
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
