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
import {
  canonicalLabel,
  clone,
  slashPath
} from "./rolling/inputs-normalize.js";
import {
  captureLocal,
  componentFingerprint,
  localFingerprint
} from "./rolling/inputs-capture.js";

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

