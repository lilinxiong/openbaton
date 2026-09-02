/**
 * Per-rule contract checks for rolling plan-delta validation. Split from
 * rolling-delta.ts; depends on rolling-delta-index.ts only at runtime.
 */
import path from "node:path";
import type { SafetyOperation } from "../safety.js";
import type { GateType, GateVersion, PlanDelta, RollingDiagnostic, TaskCoverage, UnitExecutionMode, UnitVersion, WorktreeExecutionMode } from "../rolling-plan.js";
import { validatePlanDelta as validatePlanDeltaShape } from "../rolling-plan.js";
import {
  AnyRecord,
  FactIndex,
  FactKind,
  NodeFact,
  ROLLING_DELTA_GATE_TYPES,
  ROLLING_DELTA_OPERATIONS,
  VersionFact,
  contextSource,
  integer,
  issue,
  lineageState,
  own,
  ownerPath,
  parseVersionRef,
  resolveDependency,
  resolveExactVersion,
  resolveVersion,
  stableVersionId,
  supersessionReplaceable,
  taskPath,
  text
} from "./delta-index.js";
import { isRecord } from "../validate-utils.js";
import { ROLLING_WORKTREE_STATE_SCHEMA_VERSION } from "./plan-validate.js";

const HASH = /^[0-9a-f]{64}$/;
const OPERATION_ORDER = new Map(ROLLING_DELTA_OPERATIONS.map((value, index) => [value, index]));

export function normalizeScopePath(raw: string): string | null {
  const value = raw.trim().replaceAll("\\", "/");
  if (!value) return null;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return null;
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "." : normalized;
}

export function scopeIsForbidden(value: string): boolean {
  const first = value.split("/")[0];
  return first === ".git" || value === ".git" || value.startsWith(".git/");
}

export function normalizeWritePath(raw: unknown, operations: readonly SafetyOperation[]): { value?: string; error?: string } {
  if (typeof raw !== "string") return { error: "write path must be a string" };
  const value = raw.trim();
  if (operations.includes("rename") && value.includes("->")) {
    const pieces = value.split("->").map((piece) => piece.trim());
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return { error: "rename scope must contain one source and one target" };
    const source = normalizeScopePath(pieces[0]!);
    const target = normalizeScopePath(pieces[1]!);
    if (!source || !target) return { error: "rename scope contains an unsafe path" };
    if (scopeIsForbidden(source) || scopeIsForbidden(target)) return { error: ".git is not an allowed write path" };
    return { value: `${source} -> ${target}` };
  }
  const normalized = normalizeScopePath(value);
  if (!normalized) return { error: "write path must be a relative path within the workspace" };
  if (scopeIsForbidden(normalized)) return { error: ".git is not an allowed write path" };
  return { value: normalized };
}

export function normalizeOperations(raw: unknown): { values: SafetyOperation[]; valid: boolean } {
  if (!Array.isArray(raw)) return { values: [], valid: false };
  const values: SafetyOperation[] = [];
  let valid = true;
  for (const item of raw) {
    if (typeof item !== "string" || !OPERATION_ORDER.has(item as SafetyOperation)) {
      valid = false;
      continue;
    }
    const operation = item as SafetyOperation;
    if (!values.includes(operation)) values.push(operation);
    else valid = false;
  }
  values.sort((left, right) => OPERATION_ORDER.get(left)! - OPERATION_ORDER.get(right)!);
  return { values, valid };
}

export function checkFingerprintMap(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).length > 0
    && Object.values(value).every((item) => typeof item === "string" && HASH.test(item));
}

interface WorktreeRunContext {
  schema_version?: number;
  mode?: WorktreeExecutionMode;
  raw_mode?: unknown;
}

export function worktreeRunContext(context: unknown): WorktreeRunContext {
  const source = contextSource(context);
  const identity = isRecord(source.identity) ? source.identity : {};
  const schema = source.rolling_run_schema_version ?? source.run_schema_version ?? source.schema_version;
  const rawMode = source.run_execution_mode ?? source.worktree_mode ?? identity.execution_mode;
  return {
    ...(integer(schema) ? { schema_version: schema } : {}),
    ...(rawMode === "isolated-worktree" || rawMode === "shared-worktree" ? { mode: rawMode } : {}),
    ...(rawMode !== undefined ? { raw_mode: rawMode } : {}),
  };
}

export function effectiveWorktreeMode(unit: UnitVersion, run: WorktreeRunContext): WorktreeExecutionMode | undefined {
  if (unit.worktree_mode === "isolated-worktree" || unit.worktree_mode === "shared-worktree") return unit.worktree_mode;
  if (run.mode || run.schema_version !== ROLLING_WORKTREE_STATE_SCHEMA_VERSION) return run.mode || "shared-worktree";
  return undefined;
}

export function checkWorktreeModeContract(
  fact: VersionFact<UnitVersion>,
  index: FactIndex,
  context: unknown,
  diagnostics: RollingDiagnostic[],
): void {
  const unit = fact.value;
  const pathName = ownerPath("unit", fact.id);
  const run = worktreeRunContext(context);
  const explicit = unit.worktree_mode;

  if (run.raw_mode !== undefined && !run.mode) {
    issue(diagnostics, "INVALID_WORKTREE_MODE", "rolling run has an unsupported worktree execution mode", `${pathName}.worktree_mode`, [fact.id, String(run.raw_mode)]);
    return;
  }
  if (unit.execution_mode === "verification-only") {
    if (explicit !== undefined) issue(diagnostics, "FORBIDDEN_FIELD", "verification-only units do not own a worktree mode", `${pathName}.worktree_mode`, [fact.id]);
    return;
  }
  if (explicit === "isolated-worktree" && run.schema_version !== ROLLING_WORKTREE_STATE_SCHEMA_VERSION) {
    issue(diagnostics, "ROLLING_V2_REQUIRED", "isolated worktree execution requires rolling-run v2 state", `${pathName}.worktree_mode`, [fact.id]);
  }
  if (run.schema_version === ROLLING_WORKTREE_STATE_SCHEMA_VERSION && !run.mode) {
    issue(diagnostics, "WORKTREE_MODE_REQUIRED", "rolling-run v2 state must persist an explicit worktree execution mode", `${pathName}.worktree_mode`, [fact.id]);
  }
  if (run.mode && explicit === undefined) {
    issue(diagnostics, "WORKTREE_MODE_REQUIRED", "writing units must persist the rolling run worktree mode before dispatch", `${pathName}.worktree_mode`, [fact.id, run.mode]);
  }
  if (run.mode && explicit && run.mode !== explicit) {
    issue(diagnostics, "WORKTREE_MODE_IMMUTABLE", "unit worktree mode cannot differ from the active rolling run", `${pathName}.worktree_mode`, [fact.id, run.mode, explicit]);
  }

  const current = effectiveWorktreeMode(unit, run);
  const predecessors = [...index.units.values()]
    .filter((candidate) => candidate.id !== fact.id && candidate.key === fact.key && candidate.version < fact.version)
    .sort((left, right) => right.version - left.version || left.id.localeCompare(right.id));
  const previous = predecessors[0];
  if (previous) {
    const priorMode = effectiveWorktreeMode(previous.value, run);
    if (current && priorMode && current !== priorMode) {
      issue(diagnostics, "WORKTREE_MODE_IMMUTABLE", `unit ${fact.key} cannot change worktree mode across versions`, `${pathName}.worktree_mode`, [previous.id, fact.id]);
    }
  }
}

export function checkRepositoryParts(
  fact: VersionFact<UnitVersion>,
  normalized: UnitVersion,
  index: FactIndex,
  diagnostics: RollingDiagnostic[],
): void {
  const unit = fact.value;
  if (!Array.isArray(unit.repository_parts)) return;
  const pathName = ownerPath("unit", fact.id);
  if (unit.execution_mode !== "patch-only") {
    issue(diagnostics, "FORBIDDEN_FIELD", "only writing units may declare repository-local parts", `${pathName}.repository_parts`, [fact.id]);
    return;
  }
  const operations = normalizeOperations(unit.allowed_operations).values;
  const unitPaths = new Set(Array.isArray(normalized.write_paths) ? normalized.write_paths : []);
  const claimed = new Set<string>();
  const parts = new Map<string, { order: number; value: AnyRecord }>();
  const normalizedParts: AnyRecord[] = [];
  for (const [partIndex, rawPart] of unit.repository_parts.entries()) {
    if (!isRecord(rawPart)) continue;
    const partPath = `${pathName}.repository_parts.${partIndex}`;
    if (text(rawPart.part_key) && integer(rawPart.integration_order)) parts.set(rawPart.part_key, { order: rawPart.integration_order, value: rawPart });
    const copy = structuredClone(rawPart);
    const normalizedPaths: string[] = [];
    for (const rawPath of Array.isArray(rawPart.write_paths) ? rawPart.write_paths : []) {
      const result = normalizeWritePath(rawPath, operations);
      if (!result.value) {
        issue(diagnostics, result.error?.includes(".git") ? "FORBIDDEN_PATH" : "INVALID_SCOPE", result.error || "repository part path is invalid", `${partPath}.write_paths`, [fact.id, String(rawPath)]);
        continue;
      }
      normalizedPaths.push(result.value);
      if (!unitPaths.has(result.value)) issue(diagnostics, "REPOSITORY_PART_SCOPE_MISMATCH", `repository part path ${result.value} is outside the unit scope`, `${partPath}.write_paths`, [fact.id, result.value]);
      if (claimed.has(result.value)) issue(diagnostics, "DUPLICATE_REPOSITORY_PART_SCOPE", `write path ${result.value} is claimed by more than one repository part`, `${partPath}.write_paths`, [fact.id, result.value]);
      claimed.add(result.value);
    }
    copy.write_paths = normalizedPaths;
    normalizedParts.push(copy);
  }
  for (const unitPath of unitPaths) if (!claimed.has(unitPath)) {
    issue(diagnostics, "REPOSITORY_PART_SCOPE_MISMATCH", `unit write path ${unitPath} is not assigned to a repository-local part`, `${pathName}.repository_parts`, [fact.id, unitPath]);
  }
  for (const [partKey, part] of parts) {
    for (const dependency of Array.isArray(part.value.depends_on) ? part.value.depends_on : []) {
      const predecessor = parts.get(String(dependency));
      if (predecessor && predecessor.order >= part.order) {
        issue(diagnostics, "INVALID_INTEGRATION_ORDER", `repository part ${partKey} must follow dependency ${String(dependency)}`, `${pathName}.repository_parts`, [String(dependency), partKey]);
      }
    }
  }
  const integrationGates = new Set<string>([
    ...(Array.isArray(unit.integration_gate_keys) ? unit.integration_gate_keys : []),
    ...unit.repository_parts.flatMap((part) => isRecord(part) && Array.isArray(part.integration_gate_keys) ? part.integration_gate_keys.filter(text) : []),
  ]);
  for (const gateKey of integrationGates) {
    const gate = resolveVersion(gateKey, index.gates);
    if (!gate) issue(diagnostics, "UNKNOWN_DEPENDENCY", `unit ${fact.id} requires unknown integration gate ${gateKey}`, `${pathName}.integration_gate_keys`, [fact.id, gateKey]);
    else if ((gate.value as GateVersion).type !== "integration-acceptance") issue(diagnostics, "INVALID_INTEGRATION_GATE", `gate ${gate.id} is not an integration-acceptance gate`, `${pathName}.integration_gate_keys`, [fact.id, gate.id]);
  }
  normalized.repository_parts = normalizedParts as unknown as UnitVersion["repository_parts"];
}

export function checkUnitContract(
  fact: VersionFact<UnitVersion>,
  normalized: UnitVersion,
  index: FactIndex,
  context: unknown,
  diagnostics: RollingDiagnostic[],
): void {
  const pathName = ownerPath("unit", fact.id);
  const unit = fact.value as unknown as AnyRecord;
  const mode = unit.execution_mode as UnitExecutionMode;
  if (!Array.isArray(unit.task_keys) || unit.task_keys.length === 0) {
    issue(diagnostics, "INCOMPLETE_EXECUTION_CONTRACT", "a unit must claim at least one task", `${pathName}.task_keys`, [fact.id]);
  }
  if (!["prompt", "recipe", "description"].some((key) => text(unit[key]))) {
    issue(diagnostics, "INCOMPLETE_EXECUTION_CONTRACT", "unit requires a non-empty prompt, recipe, or description", `${pathName}.prompt`, [fact.id]);
  }
  for (const key of ["completion_criteria", "permitted_validation"] as const) {
    if (!Array.isArray(unit[key]) || unit[key].length === 0 || !unit[key].every(text)) {
      issue(diagnostics, "INCOMPLETE_EXECUTION_CONTRACT", `${key} must be a non-empty string array`, `${pathName}.${key}`, [fact.id]);
    }
  }
  if (!checkFingerprintMap(unit.input_fingerprints)) {
    issue(diagnostics, "MISSING_BASELINE", "unit requires at least one relevant input fingerprint", `${pathName}.input_fingerprints`, [fact.id]);
  }

  const operationResult = normalizeOperations(unit.allowed_operations);
  if (mode === "patch-only") {
    if (!Array.isArray(unit.write_paths) || unit.write_paths.length === 0) {
      issue(diagnostics, "REQUIRED_SCOPE", "patch-only units require a non-empty write scope", `${pathName}.write_paths`, [fact.id]);
    }
    if (!Array.isArray(unit.allowed_operations) || unit.allowed_operations.length === 0) {
      issue(diagnostics, "REQUIRED_OPERATION", "patch-only units require at least one allowed operation", `${pathName}.allowed_operations`, [fact.id]);
    }
    if (!operationResult.valid) {
      issue(diagnostics, "INVALID_OPERATION", "allowed_operations contains an unsupported or duplicate operation", `${pathName}.allowed_operations`, [fact.id]);
    }
    if (Array.isArray(unit.write_paths)) {
      const normalizedPaths: string[] = [];
      for (const raw of unit.write_paths) {
        const scope = normalizeWritePath(raw, operationResult.values);
        if (!scope.value) {
          issue(diagnostics, scope.error?.includes(".git") ? "FORBIDDEN_PATH" : "INVALID_SCOPE", scope.error || "write path is invalid", `${pathName}.write_paths`, [fact.id, String(raw)]);
          continue;
        }
        if (normalizedPaths.includes(scope.value)) {
          issue(diagnostics, "DUPLICATE_SCOPE", `duplicate normalized write path ${scope.value}`, `${pathName}.write_paths`, [fact.id, scope.value]);
        } else normalizedPaths.push(scope.value);
      }
      normalized.write_paths = normalizedPaths;
    }
    normalized.allowed_operations = operationResult.values;
  } else if (mode === "verification-only") {
    if (own(unit, "write_paths") || own(unit, "allowed_operations")) {
      issue(diagnostics, "FORBIDDEN_FIELD", "verification-only units cannot declare write scope or operations", pathName, [fact.id]);
    }
    // Keep verification contracts canonical and explicit.  These properties
    // are absent from a valid verification-only unit rather than empty arrays.
    delete (normalized as unknown as AnyRecord).write_paths;
    delete (normalized as unknown as AnyRecord).allowed_operations;
  }
  checkWorktreeModeContract(fact, index, context, diagnostics);
  checkRepositoryParts(fact, normalized, index, diagnostics);
}

export function checkGateContract(
  fact: VersionFact<GateVersion>,
  diagnostics: RollingDiagnostic[],
): void {
  const gate = fact.value as unknown as AnyRecord;
  const pathName = ownerPath("gate", fact.id);
  if (!ROLLING_DELTA_GATE_TYPES.includes(gate.type as GateType)) {
    issue(diagnostics, "UNKNOWN_GATE_TYPE", "gate type is unsupported", `${pathName}.type`, [fact.id]);
  }
  if (!Array.isArray(gate.task_keys) || gate.task_keys.length === 0) {
    issue(diagnostics, "INCOMPLETE_GATE_CONTRACT", "a gate must claim at least one task", `${pathName}.task_keys`, [fact.id]);
  }
  if (gate.acceptance_contract === undefined || gate.acceptance_contract === null) {
    issue(diagnostics, "INCOMPLETE_GATE_CONTRACT", "gate requires an acceptance contract", `${pathName}.acceptance_contract`, [fact.id]);
  }
}

export function stableStructuralPath(input: unknown, diagnostic: RollingDiagnostic): RollingDiagnostic {
  const pathName = diagnostic.path;
  if (!pathName || !isRecord(input)) return diagnostic;
  const delta = input;
  const match = pathName.match(/^delta\.(unit_versions|gate_versions|task_coverage|manifest_additions|manifest_refreshes|supersessions|seals)\.(\d+)(?:\.(.*))?$/);
  if (!match) return diagnostic;
  const list = Array.isArray(delta[match[1]!]) ? delta[match[1]!] as unknown[] : [];
  const item = list[Number(match[2])];
  let stable: string | null = null;
  if (match[1] === "unit_versions" && isRecord(item)) stable = stableVersionId(item.unit_key, item.version);
  if (match[1] === "gate_versions" && isRecord(item)) stable = stableVersionId(item.gate_key, item.version);
  if ((match[1] === "task_coverage" || match[1] === "manifest_additions" || match[1] === "manifest_refreshes" || match[1] === "seals") && isRecord(item) && text(item.task_key)) stable = item.task_key;
  if (match[1] === "supersessions" && isRecord(item) && text(item.owner) && text(item.previous) && text(item.successor)) stable = `${item.owner}:${item.previous}->${item.successor}`;
  if (!stable) return diagnostic;
  return { ...diagnostic, path: `delta.${match[1]}[${stable}]${match[3] ? `.${match[3]}` : ""}` };
}

export function addStructuralDiagnostics(input: unknown, diagnostics: RollingDiagnostic[]): boolean {
  const result = validatePlanDeltaShape(input);
  for (const diagnostic of result.diagnostics) diagnostics.push(stableStructuralPath(input, diagnostic));
  return result.valid;
}

export function checkTaskRefs(
  fact: NodeFact,
  index: FactIndex,
  diagnostics: RollingDiagnostic[],
): void {
  const values = Array.isArray(fact.value.task_keys) ? fact.value.task_keys : [];
  const pathName = `${ownerPath(fact.kind, fact.id)}.task_keys`;
  for (const taskKey of values) {
    if (!index.tasks.has(taskKey)) {
      issue(diagnostics, "UNKNOWN_TASK_REFERENCE", `unknown task ${taskKey}`, pathName, [fact.id, taskKey]);
    }
  }
}

export function checkDependencies(
  fact: NodeFact,
  index: FactIndex,
  edges: Map<string, Set<string>>,
  diagnostics: RollingDiagnostic[],
): void {
  const pathName = `${ownerPath(fact.kind, fact.id)}.depends_on`;
  const dependencies = Array.isArray(fact.value.depends_on) ? fact.value.depends_on : [];
  const from = `${fact.kind}:${fact.id}`;
  if (!edges.has(from)) edges.set(from, new Set());
  for (const dependency of dependencies) {
    const target = resolveDependency(dependency, fact.kind, index);
    if (!target) {
      issue(diagnostics, "UNKNOWN_DEPENDENCY", `${fact.kind} ${fact.id} depends on unknown unit or gate ${String(dependency)}`, pathName, [fact.id, String(dependency)]);
      continue;
    }
    edges.get(from)!.add(`${target.kind}:${target.id}`);
  }
  if (fact.kind === "unit") {
    const unit = fact.value as UnitVersion;
    const requiredGates = new Set([
      ...(Array.isArray(unit.required_gate_keys) ? unit.required_gate_keys : []),
      ...(Array.isArray(unit.integration_gate_keys) ? unit.integration_gate_keys : []),
      ...(Array.isArray(unit.repository_parts)
        ? unit.repository_parts.flatMap((part) => Array.isArray(part.integration_gate_keys) ? part.integration_gate_keys : [])
        : []),
    ]);
    if (requiredGates.size > 0) {
      for (const gateKey of requiredGates) {
        const target = resolveVersion(gateKey, index.gates);
        if (!target) {
          issue(diagnostics, "UNKNOWN_DEPENDENCY", `unit ${fact.id} requires unknown gate ${gateKey}`, `${ownerPath(fact.kind, fact.id)}.required_gate_keys`, [fact.id, gateKey]);
        } else edges.get(from)!.add(`gate:${target.id}`);
      }
    }
  }
}

/** Add edges for an accepted fact without attributing malformed fixed state
 * to the proposed delta.  Fixed facts are expected to have passed this
 * validator already, but their edges are still needed to detect a cycle that
 * enters a fixed node and returns through a local node. */
export function addKnownDependencies(
  fact: NodeFact,
  index: FactIndex,
  edges: Map<string, Set<string>>,
): void {
  const from = `${fact.kind}:${fact.id}`;
  if (!edges.has(from)) edges.set(from, new Set());
  const dependencies = Array.isArray(fact.value.depends_on) ? fact.value.depends_on : [];
  for (const dependency of dependencies) {
    const target = resolveDependency(dependency, fact.kind, index);
    if (target) edges.get(from)!.add(`${target.kind}:${target.id}`);
  }
  if (fact.kind !== "unit") return;
  const unit = fact.value as UnitVersion;
  const requiredGates = [
    ...(Array.isArray(unit.required_gate_keys) ? unit.required_gate_keys : []),
    ...(Array.isArray(unit.integration_gate_keys) ? unit.integration_gate_keys : []),
    ...(Array.isArray(unit.repository_parts)
      ? unit.repository_parts.flatMap((part) => Array.isArray(part.integration_gate_keys) ? part.integration_gate_keys : [])
      : []),
  ];
  for (const gateKey of requiredGates) {
    const target = resolveVersion(gateKey, index.gates);
    if (target) edges.get(from)!.add(`gate:${target.id}`);
  }
}

export function checkAcyclic(
  index: FactIndex,
  edges: Map<string, Set<string>>,
  diagnostics: RollingDiagnostic[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const local = new Set<string>([
    ...[...index.localUnits.keys()].map((id) => `unit:${id}`),
    ...[...index.localGates.keys()].map((id) => `gate:${id}`),
  ]);

  const visit = (node: string): void => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = (start >= 0 ? stack.slice(start) : [node]).concat(node);
      const cycleSet = [...new Set(cycle)].sort();
      if (!cycleSet.some((item) => local.has(item))) return;
      const signature = cycleSet.join("|");
      if (reported.has(signature)) return;
      reported.add(signature);
      const firstLocal = cycleSet.find((item) => local.has(item))!;
      const separator = firstLocal.indexOf(":");
      const kind = firstLocal.slice(0, separator) as FactKind;
      const id = firstLocal.slice(separator + 1);
      issue(diagnostics, "DEPENDENCY_CYCLE", `dependency cycle: ${cycleSet.join(" -> ")}`, `${ownerPath(kind, id)}.depends_on`, cycleSet);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const target of [...(edges.get(node) || [])].sort()) {
      if (index.nodes.has(target)) visit(target);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of [...index.nodes.keys()].sort()) visit(node);
}

export function coverageRefs(coverage: TaskCoverage): { units: string[]; gates: string[] } {
  return {
    units: Array.isArray(coverage.unit_versions) ? coverage.unit_versions : [],
    gates: Array.isArray(coverage.gate_versions) ? coverage.gate_versions : [],
  };
}

export function checkCoverage(delta: PlanDelta, index: FactIndex, diagnostics: RollingDiagnostic[]): void {
  const coverage = Array.isArray(delta.task_coverage) ? delta.task_coverage : [];
  const covered = new Set<string>();
  const coveredUnits = new Set<string>();
  const coveredGates = new Set<string>();
  for (const item of coverage) {
    if (!isRecord(item) || !text(item.task_key)) continue;
    const value = item as unknown as TaskCoverage;
    const pathName = taskPath(value.task_key);
    covered.add(value.task_key);
    if (!index.tasks.has(value.task_key)) {
      issue(diagnostics, "UNKNOWN_TASK_REFERENCE", `coverage references unknown task ${value.task_key}`, pathName, [value.task_key]);
    }
    const refs = coverageRefs(value);
    if (value.kind === "unit" && refs.units.length === 0) issue(diagnostics, "INCOMPLETE_COVERAGE", "unit coverage requires at least one unit version", `${pathName}.unit_versions`, [value.task_key]);
    if (value.kind === "gate" && refs.gates.length === 0) issue(diagnostics, "INCOMPLETE_COVERAGE", "gate coverage requires at least one gate version", `${pathName}.gate_versions`, [value.task_key]);
    if (value.kind === "no-op" && (refs.units.length > 0 || refs.gates.length > 0)) issue(diagnostics, "INVALID_COVERAGE", "no-op coverage cannot reference unit or gate versions", pathName, [value.task_key]);

    for (const ref of refs.units) {
      const fact = resolveVersion(ref, index.units);
      if (!fact || !parseVersionRef(ref)) {
        issue(diagnostics, "UNKNOWN_COVERAGE_REFERENCE", `coverage references unknown unit version ${ref}`, `${pathName}.unit_versions`, [value.task_key, ref]);
      } else if (!Array.isArray(fact.value.task_keys) || !fact.value.task_keys.includes(value.task_key)) {
        issue(diagnostics, "COVERAGE_TASK_MISMATCH", `unit version ${ref} does not claim task ${value.task_key}`, `${pathName}.unit_versions`, [value.task_key, ref]);
      } else coveredUnits.add(fact.id);
    }
    for (const ref of refs.gates) {
      const fact = resolveVersion(ref, index.gates);
      if (!fact || !parseVersionRef(ref)) {
        issue(diagnostics, "UNKNOWN_COVERAGE_REFERENCE", `coverage references unknown gate version ${ref}`, `${pathName}.gate_versions`, [value.task_key, ref]);
      } else if (!Array.isArray(fact.value.task_keys) || !fact.value.task_keys.includes(value.task_key)) {
        issue(diagnostics, "COVERAGE_TASK_MISMATCH", `gate version ${ref} does not claim task ${value.task_key}`, `${pathName}.gate_versions`, [value.task_key, ref]);
      } else coveredGates.add(fact.id);
    }
  }

  // Only tasks claimed by a newly introduced unit or gate need coverage in
  // this delta.  Fixed manifest entries and manifest-only additions remain
  // open-world and intentionally do not trigger a whole-manifest requirement.
  const claimedByLocal = new Set<string>();
  for (const fact of [...index.localUnits.values(), ...index.localGates.values()]) {
    for (const taskKey of fact.value.task_keys) claimedByLocal.add(taskKey);
  }
  for (const taskKey of [...claimedByLocal].sort()) {
    if (!covered.has(taskKey)) issue(diagnostics, "MISSING_COVERAGE", `delta claims task ${taskKey} without task coverage`, taskPath(taskKey), [taskKey]);
  }
  for (const fact of [...index.localUnits.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!coveredUnits.has(fact.id)) issue(diagnostics, "MISSING_COVERAGE", `unit version ${fact.id} is not present in task coverage`, `${ownerPath("unit", fact.id)}.task_keys`, [fact.id]);
  }
  for (const fact of [...index.localGates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!coveredGates.has(fact.id)) issue(diagnostics, "MISSING_COVERAGE", `gate version ${fact.id} is not present in task coverage`, `${ownerPath("gate", fact.id)}.task_keys`, [fact.id]);
  }
}

export function checkSupersessions(delta: PlanDelta, index: FactIndex, diagnostics: RollingDiagnostic[]): void {
  const supersessions = Array.isArray(delta.supersessions) ? delta.supersessions : [];
  const seenPrevious = new Set<string>();
  for (const value of supersessions) {
    if (!isRecord(value) || !text(value.owner) || !text(value.previous) || !text(value.successor)) continue;
    const owner = value.owner as string;
    const expectedKind: FactKind | null = owner === "unit_version" ? "unit" : owner === "gate_version" ? "gate" : null;
    const pathName = `delta.supersessions[${owner}:${value.previous}->${value.successor}]`;
    if (!expectedKind) continue;
    const facts = expectedKind === "unit" ? index.units : index.gates;
    // Supersession is a lineage operation, so both sides must identify an
    // exact immutable version.  Dependencies and coverage intentionally allow
    // key-only shorthand, but silently resolving `unit@9` to the latest known
    // version would let a caller replace the wrong owner.
    const previous = resolveExactVersion(value.previous, facts);
    const successor = resolveExactVersion(value.successor, facts);
    if (!previous || !parseVersionRef(value.previous)) issue(diagnostics, "UNKNOWN_SUPERSESSION_REFERENCE", `supersession references unknown previous ${value.previous}`, `${pathName}.previous`, [String(value.previous)]);
    if (!successor || !parseVersionRef(value.successor)) issue(diagnostics, "UNKNOWN_SUPERSESSION_REFERENCE", `supersession references unknown successor ${value.successor}`, `${pathName}.successor`, [String(value.successor)]);
    if (!successor || successor.source !== "delta") issue(diagnostics, "SUPERSESSION_SUCCESSOR_NOT_LOCAL", "a supersession successor must be introduced by this delta", `${pathName}.successor`, [String(value.successor)]);
    if (previous && successor) {
      if (previous.key !== successor.key || successor.version <= previous.version) {
        issue(diagnostics, "INVALID_SUPERSESSION", "supersession successor must be a higher version of the same key", pathName, [previous.id, successor.id]);
      }
      const state = lineageState(index, expectedKind, previous.id, previous.key);
      if (!supersessionReplaceable(state)) {
        issue(diagnostics, "SUPERSESSION_FORBIDDEN", `cannot supersede ${previous.id}: lineage is ${state}`, `${pathName}.previous`, [previous.id, state]);
      }
    }
    if (seenPrevious.has(`${expectedKind}:${value.previous}`)) issue(diagnostics, "DUPLICATE_SUPERSESSION", `version ${value.previous} is superseded more than once`, `${pathName}.previous`, [String(value.previous)]);
    seenPrevious.add(`${expectedKind}:${value.previous}`);
  }
}

export function normalizeDelta(delta: PlanDelta, index: FactIndex): PlanDelta {
  const output = structuredClone(delta);
  const units = Array.isArray(output.unit_versions) ? output.unit_versions : [];
  for (const unit of units) {
    if (!isRecord(unit)) continue;
    const id = stableVersionId(unit.unit_key, unit.version);
    if (!id) continue;
    const fact = index.localUnits.get(id);
    if (!fact) continue;
    const operations = normalizeOperations(unit.allowed_operations).values;
    if (Array.isArray(unit.write_paths)) {
      const paths = unit.write_paths.map((item) => normalizeWritePath(item, operations).value).filter((item): item is string => Boolean(item));
      unit.write_paths = paths;
    }
    if (Array.isArray(unit.allowed_operations)) unit.allowed_operations = operations;
  }
  return output;
}
