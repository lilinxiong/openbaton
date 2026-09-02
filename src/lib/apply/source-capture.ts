/**
 * Capture machinery for compiled apply-source facts. Split from
 * apply-source.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalizeJson, sha256Hex } from "../json-utils.js";
import { isRecord } from "../validate-utils.js";
import { parseTasks } from "../openspec.js";
import {
  NormalizedDeclaration,
  normalizeOpenSpec,
  normalizeRepoRoot,
  normalizeRepository,
  normalizeUnitDeclarations
} from "./source-normalize.js";
import {
  APPLY_SOURCE_SCHEMA_VERSION,
  ApplySourceAcceptedPredecessorFact,
  ApplySourceCaptureRequest,
  ApplySourceContextFileIdentity,
  ApplySourceDependencies,
  ApplySourceExistingInputFact,
  ApplySourceFileKind,
  ApplySourceFileMetadata,
  ApplySourceInputError,
  ApplySourceInputFact,
  ApplySourceOpenSpecIdentity,
  ApplySourcePredecessorFactReference,
  ApplySourcePredecessorFacts,
  ApplySourcePredecessorInputFact,
  ApplySourceReadBytes,
  ApplySourceRepositoryIdentity,
  ApplySourceStatLike,
  ApplySourceUnitDeclarations,
  ApplySourceUnitFacts,
  CompiledApplySourceFacts,
  NormalizedApplySourceOpenSpecIdentity
} from "../apply-source.js";
import { captureStableSafetyFacts } from "../git/safety-facts.js";

export function dependencySet(request: ApplySourceCaptureRequest): ApplySourceDependencies {
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

export async function defaultReadBytes(absolutePath: string): Promise<AsyncIterable<Uint8Array>> {
  return fs.createReadStream(absolutePath);
}

export async function defaultLstat(absolutePath: string): Promise<ApplySourceStatLike> {
  try {
    const stat = await fs.promises.lstat(absolutePath);
    return stat;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "missing", exists: false };
    throw error;
  }
}

export async function defaultReadlink(absolutePath: string): Promise<string> {
  return fs.promises.readlink(absolutePath);
}

export function statKind(value: ApplySourceStatLike): ApplySourceFileKind {
  if (value.exists === false || value.kind === "missing") return "missing";
  if (value.kind === "file" || value.kind === "directory" || value.kind === "symlink" || value.kind === "other") return value.kind;
  if (value.isSymbolicLink?.()) return "symlink";
  if (value.isFile?.()) return "file";
  if (value.isDirectory?.()) return "directory";
  return "other";
}

export function normalizedMetadata(stat: ApplySourceStatLike, kind: ApplySourceFileKind, target?: string): ApplySourceFileMetadata {
  if (kind === "missing") return { kind, mode: null, size: null };
  const mode = typeof stat.mode === "number" && Number.isFinite(stat.mode) ? stat.mode & 0o7777 : null;
  const size = typeof stat.size === "number" && Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : null;
  return { kind, mode, size, ...(kind === "symlink" && target !== undefined ? { target } : {}) };
}

export async function bytesHash(read: ApplySourceReadBytes, absolutePath: string): Promise<string> {
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

export async function captureExistingInput(
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

export function predecessorKey(value: ApplySourcePredecessorFactReference): string {
  return `${value.unit_id}\0${value.fact_id}`;
}

export function predecessorMap(value: ApplySourcePredecessorFacts | undefined): Map<string, ApplySourceAcceptedPredecessorFact> {
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

export async function capturePredecessorInput(
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

export async function captureOpenSpecFromFiles(
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

export async function captureOpenSpec(
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

export async function captureGit(repoRoot: string, dependencies: ApplySourceDependencies): Promise<ApplySourceRepositoryIdentity> {
  const capture = dependencies.captureGitFacts
    || dependencies.captureGit
    || dependencies.captureSafetyFacts
    || dependencies.captureGitSafetyFacts;
  const value = capture
    ? await capture(repoRoot, { purpose: "baseline" })
    : await captureStableSafetyFacts(repoRoot, { purpose: "baseline" });
  return normalizeRepository(value);
}

export function requestRepoRoot(request: ApplySourceCaptureRequest): string {
  return normalizeRepoRoot(request.repo_root ?? request.repoRoot);
}

export function requestOpenSpec(request: ApplySourceCaptureRequest): ApplySourceOpenSpecIdentity {
  return request.open_spec ?? request.openSpec ?? {};
}

export function requestUnits(request: ApplySourceCaptureRequest): ApplySourceUnitDeclarations | undefined {
  return request.units ?? request.unit_inputs ?? request.unitInputs;
}

export function requestPredecessorFacts(request: ApplySourceCaptureRequest): ApplySourcePredecessorFacts | undefined {
  return request.accepted_predecessor_facts ?? request.acceptedPredecessorFacts ?? request.predecessor_facts ?? request.predecessorFacts;
}

export function sourceFingerprint(value: Omit<CompiledApplySourceFacts, "fingerprint">): string {
  return sha256Hex(canonicalizeJson(value));
}

export function compatibilityViews<T extends CompiledApplySourceFacts>(value: T): T {
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

export function unitFingerprint(value: Omit<ApplySourceUnitFacts, "fingerprint">): string {
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
