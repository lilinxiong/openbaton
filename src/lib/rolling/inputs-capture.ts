/**
 * Capture machinery for rolling local inputs. Split from rolling-inputs.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApplySourceFileKind } from "../apply-source.js";
import { isRecord } from "../validate-utils.js";
import { ApplySourceReadBytes } from "../apply-source.js";
import {
  EPHEMERAL_KEYS,
  NormalizedDeclaration,
  clone,
  hash,
  normalizeDeclaration,
  ownerOf,
  repoRootOf,
  text
} from "./inputs-normalize.js";
import {
  ROLLING_INPUTS_SCHEMA_VERSION,
  RollingDependencyResultIdentity,
  RollingEvidenceInput,
  RollingInputDeclaration,
  RollingInputDeclarationValue,
  RollingInputDependencies,
  RollingInputError,
  RollingInputFingerprintComponent,
  RollingInputKind,
  RollingInputOwnerKind,
  RollingLocalInputCapture,
  RollingLocalInputCaptureRequest,
  RollingRepositoryPathFact
} from "../rolling-inputs.js";

type RecordLike = Record<string, unknown>;
type FactContainer = unknown;

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

export function declarationsOf(request: RollingLocalInputCaptureRequest, ownerKind: RollingInputOwnerKind): NormalizedDeclaration[] {
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

export function containerOf(request: RollingLocalInputCaptureRequest, kind: RollingInputKind): FactContainer {
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

export function dependencyContainerOf(request: RollingLocalInputCaptureRequest): FactContainer {
  return request.dependency_results ?? request.dependencyResults ?? request.predecessor_facts ?? request.predecessorFacts ?? request.predecessor_results ?? request.predecessorResults;
}

export function evidenceContainerOf(request: RollingLocalInputCaptureRequest): FactContainer {
  return request.evidence_inputs ?? request.evidenceInputs ?? request.evidence;
}

export function dependenciesOf(request: RollingLocalInputCaptureRequest): RollingInputDependencies {
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

export function keyVariants(key: string): string[] {
  const variants = new Set<string>([key]);
  variants.add(key.replace(/[- ]/gu, "_"));
  variants.add(key.replace(/[_ -]+(.)/gu, (_match, character: string) => character.toUpperCase()));
  return [...variants];
}

export function getSelected(container: unknown, selectorValue: string): { found: boolean; value?: unknown } {
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

export function selectedFactValue(declaration: NormalizedDeclaration, request: RollingLocalInputCaptureRequest): unknown {
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

export function dependencyEntries(container: unknown): Array<{ key?: string; value: unknown }> {
  if (Array.isArray(container)) return container.map((value) => ({ value }));
  if (!isRecord(container)) return [];
  return Object.entries(container).map(([key, value]) => ({ key, value }));
}

export function directDependency(container: unknown, unitId: string, factId: string): { found: boolean; value?: unknown } {
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

export function dependencyIdentity(declaration: NormalizedDeclaration, request: RollingLocalInputCaptureRequest): RollingDependencyResultIdentity {
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

export function evidenceValue(declaration: NormalizedDeclaration, request: RollingLocalInputCaptureRequest): RollingEvidenceInput {
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

export function statKind(value: RecordLike): ApplySourceFileKind {
  if (value.exists === false || value.kind === "missing") return "missing";
  if (value.kind === "file" || value.kind === "directory" || value.kind === "symlink" || value.kind === "other") return value.kind;
  if (typeof value.isSymbolicLink === "function" && value.isSymbolicLink()) return "symlink";
  if (typeof value.isFile === "function" && value.isFile()) return "file";
  if (typeof value.isDirectory === "function" && value.isDirectory()) return "directory";
  return "other";
}

export function metadata(stat: RecordLike, kind: ApplySourceFileKind, target?: string): RollingRepositoryPathFact {
  const mode = kind === "missing" ? null : typeof stat.mode === "number" && Number.isFinite(stat.mode) ? stat.mode & 0o7777 : null;
  const size = kind === "missing" ? null : typeof stat.size === "number" && Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : null;
  return { path: "", kind, mode, size, sha256: null, ...(kind === "symlink" && target !== undefined ? { target } : {}) };
}

export async function defaultLstat(absolutePath: string): Promise<RecordLike> {
  try { return await fs.promises.lstat(absolutePath) as unknown as RecordLike; }
  catch (error) { if (isRecord(error) && error.code === "ENOENT") return { kind: "missing", exists: false }; throw error; }
}

export async function defaultReadBytes(absolutePath: string): Promise<AsyncIterable<Uint8Array>> {
  return fs.createReadStream(absolutePath);
}

export async function defaultReadlink(absolutePath: string): Promise<string> {
  return fs.promises.readlink(absolutePath);
}

export async function bytesHash(read: ApplySourceReadBytes, absolutePath: string): Promise<string> {
  const value = await read(absolutePath);
  const digest = crypto.createHash("sha256");
  if (typeof value === "string") digest.update(value);
  else if (value instanceof Uint8Array) digest.update(value);
  else for await (const chunk of value) digest.update(chunk);
  return digest.digest("hex");
}

export async function repositoryPathValue(repoRoot: string, declaration: NormalizedDeclaration, request: RollingLocalInputCaptureRequest): Promise<RollingRepositoryPathFact> {
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

export function componentIdentity(declaration: NormalizedDeclaration): string {
  if (declaration.kind === "repository-path") return declaration.path!;
  if (declaration.kind === "dependency-result") return `${declaration.unit_id!}\0${declaration.fact_id!}`;
  return declaration.selector || declaration.label;
}

export function duplicateIdentity(declaration: NormalizedDeclaration): string {
  return `${declaration.kind}\0${componentIdentity(declaration)}`;
}

export function componentFingerprint(component: Omit<RollingInputFingerprintComponent, "fingerprint">): string {
  return hash(component);
}

export function componentAliases<T extends RollingInputFingerprintComponent>(value: T): T {
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

export function aliases<T extends RollingLocalInputCapture>(value: T): T {
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

export function localFingerprint(value: Pick<RollingLocalInputCapture, "owner_kind" | "owner_key" | "components">): string {
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

export async function captureLocal(request: RollingLocalInputCaptureRequest, forced: RollingInputOwnerKind): Promise<RollingLocalInputCapture> {
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
