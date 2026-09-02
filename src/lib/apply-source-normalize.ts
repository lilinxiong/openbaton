/**
 * Declaration and identity normalization for apply-source capture. Split
 * from apply-source.ts (leaf module; type-only imports point back).
 */
import path from "node:path";
import { canonicalizeJson, sha256Hex } from "./json-utils.js";
import { isRecord } from "./validate-utils.js";
import { parseTasks } from "./openspec.js";
import type { GitIndexControlFingerprint } from "./git-index-control.js";
import {
  ApplySourceInputError,
  GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM
} from "./apply-source.js";
import type {
  ApplySourceContextFileIdentity,
  ApplySourceInputDeclaration,
  ApplySourceInputOrigin,
  ApplySourceInputRole,
  ApplySourceOpenSpecIdentity,
  ApplySourcePredecessorFactReference,
  ApplySourceRepositoryIdentity,
  ApplySourceTaskLedgerIdentity,
  ApplySourceUnitDeclaration,
  ApplySourceUnitDeclarations,
  NormalizedApplySourceOpenSpecIdentity,
} from "./apply-source.js";

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function normalizeRepoRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("repo_root is required");
  return path.resolve(value);
}

export function normalizedRelativePath(repoRoot: string, raw: unknown): string {
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

export function normalizedContextPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ApplySourceInputError("APPLY_SOURCE_CONTEXT_INVALID", "OpenSpec context path is empty");
  return path.resolve(raw);
}

export function normalizeRoles(value: ApplySourceInputDeclaration): ApplySourceInputRole[] {
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

export function predecessorReference(value: ApplySourceInputDeclaration): ApplySourcePredecessorFactReference | null {
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

export function originOf(value: ApplySourceInputDeclaration): ApplySourceInputOrigin {
  const origin = value.origin ?? value.source ?? "existing";
  if (origin === "predecessor" || origin === "produced") return "predecessor-produced";
  if (origin === "existing" || origin === "predecessor-produced") return origin;
  throw new ApplySourceInputError("APPLY_SOURCE_ORIGIN_INVALID", `invalid input origin for ${value.path}`);
}

export interface NormalizedDeclaration {
  path: string;
  roles: ApplySourceInputRole[];
  origin: ApplySourceInputOrigin;
  predecessor: ApplySourcePredecessorFactReference | null;
}

export function normalizeDeclaration(repoRoot: string, value: string | ApplySourceInputDeclaration, defaultRole: ApplySourceInputRole): NormalizedDeclaration {
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

export function declarationList(value: ApplySourceUnitDeclaration, key: "read" | "write"): string[] {
  const snake = key === "read" ? value.read_paths : value.write_paths;
  const camel = key === "read" ? value.readPaths : value.writePaths;
  const short = key === "read" ? value.reads : value.writes;
  const inputs = key === "read" ? value.read_inputs : value.write_inputs;
  const inputCamel = key === "read" ? value.readInputs : value.writeInputs;
  return [...strings(snake), ...strings(camel), ...strings(short), ...strings(inputs), ...strings(inputCamel)];
}

export function unitEntries(value: ApplySourceUnitDeclarations | undefined): ApplySourceUnitDeclaration[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => ({ ...entry }));
  return Object.entries(value).map(([id, entry]) => Array.isArray(entry)
    ? { id, inputs: entry }
    : { ...entry, id });
}

export function normalizeUnitDeclarations(repoRoot: string, units: ApplySourceUnitDeclarations | undefined): Array<{ unit_id: string; inputs: NormalizedDeclaration[] }> {
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

export function normalizeIndexControl(value: unknown): GitIndexControlFingerprint {
  const source = isRecord(value) ? value : {};
  const algorithm = stringValue(source.algorithm) || stringValue(source.index_control_algorithm) || GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM;
  const checksum = stringValue(source.checksum) || stringValue(source.index_control_checksum) || "";
  const rawCount = source.entryCount ?? source.entry_count ?? source.index_control_entry_count;
  const entryCount = typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
  return { algorithm: algorithm as typeof GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM, checksum, entryCount };
}

export function normalizeRepository(value: unknown): ApplySourceRepositoryIdentity {
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

export function normalizeContextFiles(value: ApplySourceOpenSpecIdentity): ApplySourceContextFileIdentity[] {
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

export function normalizeTaskLedger(value: ApplySourceOpenSpecIdentity): ApplySourceTaskLedgerIdentity | null {
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

export function normalizeSelectedTasks(value: ApplySourceOpenSpecIdentity): unknown[] {
  const selected = value.selected_tasks ?? value.selectedTasks;
  if (Array.isArray(selected)) return selected.map((entry) => structuredClone(entry));
  return [];
}

export function normalizeOpenSpec(value: ApplySourceOpenSpecIdentity = {}): NormalizedApplySourceOpenSpecIdentity {
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
