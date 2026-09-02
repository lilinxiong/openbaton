import { SafetyOperation } from "../safety.js";
import {
  criticalPath,
  graphCycle
} from "./plan-frontier.js";
import {
  HEX_SHA256,
  RUNTIME_STATES,
  TASK_STATES,
  issue,
  normalizedFactsFromPlanUnit,
  record,
  scopeConflicts,
  string,
  strings,
  unknownKeys
} from "./plan-scope.js";
import {
  APPLY_EXECUTION_PLAN_SCHEMA_VERSION,
  APPLY_PLAN_OPERATIONS,
  ApplyExecutionPlan,
  ApplyPlanDiagnostic,
  ApplyPlanOverlapEdge,
  ApplyPlanRuntimeState,
  ApplyPlanScopeFact,
  ApplyPlanTaskStatus,
  ApplyPlanUnit,
  ApplyPlanValidationError,
  ApplyPlanValidationResult,
  canonicalizeApplyPlan,
  fingerprintApplyExecutionPlan
} from "../apply-plan.js";
/**
 * Wire-level validation for apply execution plans. Split from apply-plan.ts.
 */

export function ownershipForbidden(value: unknown): boolean {
  if (!record(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (["owner", "ownership", "worker", "executor"].includes(key.toLowerCase()) && typeof item === "string" && /openspec(?:[-_ ]worker)?|open.?spec.*worker/i.test(item)) return true;
    if (ownershipForbidden(item)) return true;
    if (Array.isArray(item) && item.some(ownershipForbidden)) return true;
  }
  return false;
}

export function validateApplyExecutionPlan(input: unknown): ApplyPlanValidationResult {
  const diagnostics: ApplyPlanDiagnostic[] = []; const overlap_edges: ApplyPlanOverlapEdge[] = [];
  if (!record(input)) { issue(diagnostics, "INVALID_PLAN", "plan must be a JSON object"); return { valid: false, diagnostics, overlap_edges, remaining_critical_path: {} }; }
  const raw = input;
  unknownKeys(raw, ["schema_version", "identity", "source_snapshot", "selected_tasks", "units", "parent_gates", "task_mappings", "task_completion", "revision_lineage", "runtime_state", "fingerprint"], "plan", diagnostics);
  if (raw.schema_version !== APPLY_EXECUTION_PLAN_SCHEMA_VERSION) issue(diagnostics, "UNKNOWN_SCHEMA", `unsupported schema version ${String(raw.schema_version)}`, "plan.schema_version");
  if (!record(raw.identity)) issue(diagnostics, "REQUIRED_FIELD", "identity is required", "plan.identity");
  else { unknownKeys(raw.identity, ["plan_id", "change_id", "created_at", "owner"], "identity", diagnostics); if (!string(raw.identity.plan_id)) issue(diagnostics, "REQUIRED_FIELD", "plan_id is required", "identity.plan_id"); if (!string(raw.identity.change_id)) issue(diagnostics, "REQUIRED_FIELD", "change_id is required", "identity.change_id"); }
  if (!record(raw.source_snapshot)) issue(diagnostics, "REQUIRED_FIELD", "source_snapshot is required", "plan.source_snapshot");
  else { unknownKeys(raw.source_snapshot, ["repo_root", "revision", "tasks_path", "fingerprint"], "source_snapshot", diagnostics); if (!string(raw.source_snapshot.repo_root) || !string(raw.source_snapshot.revision)) issue(diagnostics, "REQUIRED_FIELD", "repo_root and revision are required", "source_snapshot"); }
  if (raw.revision_lineage !== undefined) {
    if (!record(raw.revision_lineage)) issue(diagnostics, "INVALID_FIELD", "revision_lineage must be an object", "revision_lineage");
    else { unknownKeys(raw.revision_lineage, ["base", "parent", "head", "ancestors"], "revision_lineage", diagnostics); if (!string(raw.revision_lineage.base)) issue(diagnostics, "REQUIRED_FIELD", "revision_lineage.base is required", "revision_lineage.base"); if (raw.revision_lineage.ancestors !== undefined && !strings(raw.revision_lineage.ancestors)) issue(diagnostics, "INVALID_FIELD", "ancestors must be a string array", "revision_lineage.ancestors"); }
  }
  if (raw.runtime_state !== undefined && !RUNTIME_STATES.includes(raw.runtime_state as ApplyPlanRuntimeState)) issue(diagnostics, "INVALID_STATE", "unknown runtime state", "runtime_state");
  if (!strings(raw.selected_tasks)) issue(diagnostics, "REQUIRED_FIELD", "selected_tasks must be a string array", "selected_tasks");
  if (!Array.isArray(raw.units)) issue(diagnostics, "REQUIRED_FIELD", "units must be an array", "units");
  if (ownershipForbidden(raw)) issue(diagnostics, "FORBIDDEN_OWNERSHIP", "OpenSpec worker ownership is forbidden");
  const selected = new Set(strings(raw.selected_tasks) ? raw.selected_tasks : []);
  if (selected.size !== (strings(raw.selected_tasks) ? raw.selected_tasks.length : 0)) issue(diagnostics, "DUPLICATE_REFERENCE", "selected_tasks contains duplicates", "selected_tasks");
  const units = Array.isArray(raw.units) ? raw.units : []; const unitIds = new Set<string>();
  const unitEdges = new Map<string, string[]>();
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]; const p = `units[${index}]`;
    if (!record(unit)) { issue(diagnostics, "INVALID_UNIT", "unit must be an object", p); continue; }
    unknownKeys(unit, ["id", "mode", "task_ids", "description", "prompt", "write_paths", "allowed_operations", "depends_on", "parent_gate_ids", "runtime_state", "remaining_critical_path", "patch", "verification"], p, diagnostics);
    if (!string(unit.id)) issue(diagnostics, "REQUIRED_FIELD", "id is required", `${p}.id`); else if (unitIds.has(unit.id)) issue(diagnostics, "DUPLICATE_REFERENCE", `duplicate unit ${unit.id}`, `${p}.id`); else unitIds.add(unit.id);
    if (unit.mode !== "patch-only" && unit.mode !== "verification-only") issue(diagnostics, "INVALID_MODE", "mode must be patch-only or verification-only", `${p}.mode`);
    if (!strings(unit.task_ids)) issue(diagnostics, "REQUIRED_FIELD", "task_ids must be a string array", `${p}.task_ids`);
    if (unit.mode === "verification-only" && (unit.write_paths !== undefined || unit.allowed_operations !== undefined || unit.patch !== undefined)) issue(diagnostics, "FORBIDDEN_FIELD", "verification-only units cannot declare patch/write fields", p);
    if (unit.mode === "verification-only" && unit.verification !== undefined && !strings(unit.verification)) issue(diagnostics, "INVALID_FIELD", "verification must be a string array", `${p}.verification`);
    if (unit.mode === "patch-only" && unit.verification !== undefined) issue(diagnostics, "FORBIDDEN_FIELD", "patch-only units cannot declare verification", `${p}.verification`);
    if (unit.mode === "patch-only" && (!strings(unit.write_paths) || unit.write_paths.length === 0)) issue(diagnostics, "REQUIRED_FIELD", "patch-only units require write_paths", `${p}.write_paths`);
    if (unit.mode === "patch-only" && (!Array.isArray(unit.allowed_operations) || unit.allowed_operations.length === 0)) issue(diagnostics, "REQUIRED_FIELD", "patch-only units require allowed_operations", `${p}.allowed_operations`);
    if (strings(unit.write_paths) && unit.write_paths.some((item) => item === ".git" || item.startsWith(".git/"))) issue(diagnostics, "FORBIDDEN_PATH", ".git is not an allowed write path", `${p}.write_paths`);
    if (unit.allowed_operations !== undefined && (!Array.isArray(unit.allowed_operations) || unit.allowed_operations.some((op) => !APPLY_PLAN_OPERATIONS.includes(op as SafetyOperation)))) issue(diagnostics, "INVALID_OPERATION", "allowed_operations contains an unsupported operation", `${p}.allowed_operations`);
    if (unit.runtime_state !== undefined && !RUNTIME_STATES.includes(unit.runtime_state as ApplyPlanRuntimeState)) issue(diagnostics, "INVALID_STATE", "unknown runtime state", `${p}.runtime_state`);
    if (strings(unit.task_ids) && new Set(unit.task_ids).size !== unit.task_ids.length) issue(diagnostics, "DUPLICATE_REFERENCE", `unit ${String(unit.id)} repeats a task`, `${p}.task_ids`);
    if (strings(unit.depends_on) && new Set(unit.depends_on).size !== unit.depends_on.length) issue(diagnostics, "DUPLICATE_REFERENCE", `unit ${String(unit.id)} repeats a dependency`, `${p}.depends_on`);
    if (string(unit.id)) unitEdges.set(unit.id, strings(unit.depends_on) ? [...unit.depends_on] : []);
  }
  for (const [id, deps] of unitEdges) for (const dep of deps) if (!unitIds.has(dep)) issue(diagnostics, "UNKNOWN_REFERENCE", `unit ${id} depends on unknown unit ${dep}`, `units.${id}.depends_on`, [dep]);
  const depCycle = graphCycle([...unitIds], unitEdges); if (depCycle) issue(diagnostics, "DEPENDENCY_CYCLE", `dependency cycle: ${depCycle.join(" -> ")}`, "units", depCycle);
  const gates = Array.isArray(raw.parent_gates) ? raw.parent_gates : []; const gateIds = new Set<string>(); const gateEdges = new Map<string, string[]>();
  if (raw.parent_gates !== undefined && !Array.isArray(raw.parent_gates)) issue(diagnostics, "INVALID_FIELD", "parent_gates must be an array", "parent_gates");
  for (let index = 0; index < gates.length; index += 1) { const gate = gates[index]; const p = `parent_gates[${index}]`; if (!record(gate)) { issue(diagnostics, "INVALID_GATE", "gate must be an object", p); continue; } const body = gate as Record<string, unknown>; unknownKeys(body, ["id", "depends_on", "unit_ids", "task_ids", "runtime_state"], p, diagnostics); if (!string(body.id)) issue(diagnostics, "REQUIRED_FIELD", "id is required", `${p}.id`); else if (gateIds.has(body.id)) issue(diagnostics, "DUPLICATE_REFERENCE", `duplicate gate ${body.id}`, `${p}.id`); else gateIds.add(body.id); gateEdges.set(body.id as string, strings(body.depends_on) ? [...body.depends_on] : []); }
  for (const [id, deps] of gateEdges) for (const dep of deps) if (!gateIds.has(dep) && !unitIds.has(dep)) issue(diagnostics, "UNKNOWN_REFERENCE", `gate ${id} depends on unknown gate or unit ${dep}`, `parent_gates.${id}.depends_on`, [dep]);
  const gateCycle = graphCycle([...gateIds], gateEdges); if (gateCycle) issue(diagnostics, "GATE_CYCLE", `gate cycle: ${gateCycle.join(" -> ")}`, "parent_gates", gateCycle);
  for (const unit of units) if (record(unit) && strings(unit.parent_gate_ids)) for (const gateId of unit.parent_gate_ids) if (!gateIds.has(gateId)) issue(diagnostics, "UNKNOWN_REFERENCE", `unit references unknown parent gate ${gateId}`, "units.parent_gate_ids", [gateId]);
  const covered = new Set<string>();
  for (const unit of units) if (record(unit) && strings(unit.task_ids)) for (const task of unit.task_ids) { if (!selected.has(task)) issue(diagnostics, "UNKNOWN_REFERENCE", `unit references unselected task ${task}`, "units.task_ids", [task]); covered.add(task); }
  for (const gate of gates) if (record(gate)) { const body = gate as Record<string, unknown>; if (strings(body.task_ids)) for (const task of body.task_ids) { if (!selected.has(task)) issue(diagnostics, "UNKNOWN_REFERENCE", `gate references unselected task ${task}`, "parent_gates.task_ids", [task]); covered.add(task); } if (strings(body.unit_ids)) for (const id of body.unit_ids) if (!unitIds.has(id)) issue(diagnostics, "UNKNOWN_REFERENCE", `gate references unknown unit ${id}`, "parent_gates.unit_ids", [id]); }
  for (const task of selected) if (!covered.has(task)) issue(diagnostics, "TASK_COVERAGE_INCOMPLETE", `selected task ${task} has no unit or gate mapping`, "selected_tasks", [task]);
  if (raw.task_completion !== undefined) { if (!record(raw.task_completion)) issue(diagnostics, "INVALID_FIELD", "task_completion must be an object", "task_completion"); else for (const [task, completion] of Object.entries(raw.task_completion)) { if (!selected.has(task)) issue(diagnostics, "UNKNOWN_REFERENCE", `completion references unselected task ${task}`, `task_completion.${task}`, [task]); if (!record(completion) || !TASK_STATES.includes(completion.status as ApplyPlanTaskStatus)) issue(diagnostics, "INVALID_STATE", `invalid task completion state for ${task}`, `task_completion.${task}`); } }
  if (raw.task_mappings !== undefined) {
    if (!Array.isArray(raw.task_mappings)) issue(diagnostics, "INVALID_FIELD", "task_mappings must be an array", "task_mappings");
    else {
      const mapped = new Set<string>();
      const unitTasks = new Map<string, Set<string>>();
      const gateTasks = new Map<string, Set<string>>();
      for (const unit of units) {
        if (record(unit) && string(unit.id) && strings(unit.task_ids)) unitTasks.set(unit.id, new Set(unit.task_ids));
      }
      for (const gate of gates) {
        if (record(gate) && string(gate.id) && strings(gate.task_ids)) gateTasks.set(gate.id, new Set(gate.task_ids));
      }
      for (const mapping of raw.task_mappings) {
        if (!record(mapping)) { issue(diagnostics, "INVALID_MAPPING", "mapping requires task_id and at least one unit or gate", "task_mappings"); continue; }
        unknownKeys(mapping, ["task_id", "unit_ids", "gate_ids"], "task_mappings", diagnostics);
        if (!string(mapping.task_id) || !strings(mapping.unit_ids) || (mapping.gate_ids !== undefined && !strings(mapping.gate_ids))) {
          issue(diagnostics, "INVALID_MAPPING", "mapping requires task_id, unit_ids, and valid gate_ids", "task_mappings");
          continue;
        }
        const mappingTaskId = mapping.task_id as string;
        const unitReferences = mapping.unit_ids as string[];
        const gateReferences = (mapping.gate_ids === undefined ? [] : mapping.gate_ids) as string[];
        if (unitReferences.length === 0 && gateReferences.length === 0) {
          issue(diagnostics, "INVALID_MAPPING", `mapping for ${mappingTaskId} requires at least one unit or gate`, "task_mappings", [mappingTaskId]);
        }
        if (mapped.has(mappingTaskId)) issue(diagnostics, "AMBIGUOUS_MAPPING", `task ${mappingTaskId} has multiple mappings`, "task_mappings", [mappingTaskId]);
        mapped.add(mappingTaskId);
        if (!selected.has(mappingTaskId)) issue(diagnostics, "UNKNOWN_REFERENCE", `mapping references unselected task ${mappingTaskId}`, "task_mappings", [mappingTaskId]);
        if (new Set(unitReferences).size !== unitReferences.length) issue(diagnostics, "DUPLICATE_REFERENCE", `mapping for ${mappingTaskId} repeats a unit`, "task_mappings", [mappingTaskId]);
        if (new Set(gateReferences).size !== gateReferences.length) issue(diagnostics, "DUPLICATE_REFERENCE", `mapping for ${mappingTaskId} repeats a gate`, "task_mappings", [mappingTaskId]);
        for (const id of unitReferences) {
          if (!unitIds.has(id)) issue(diagnostics, "UNKNOWN_REFERENCE", `mapping references unknown unit ${id}`, "task_mappings", [id]);
          else if (!unitTasks.get(id)?.has(mappingTaskId)) issue(diagnostics, "MAPPING_TASK_MISMATCH", `mapping for ${mappingTaskId} references unit ${id} without that task`, "task_mappings", [mappingTaskId, id]);
          covered.add(mappingTaskId);
        }
        for (const id of gateReferences) {
          if (!gateIds.has(id)) issue(diagnostics, "UNKNOWN_REFERENCE", `mapping for ${mappingTaskId} references unknown gate ${id}`, "task_mappings", [id]);
          else if (!gateTasks.get(id)?.has(mappingTaskId)) issue(diagnostics, "MAPPING_TASK_MISMATCH", `mapping for ${mappingTaskId} references gate ${id} without that task`, "task_mappings", [mappingTaskId, id]);
          covered.add(mappingTaskId);
        }
      }
      for (const task of selected) {
        if (!mapped.has(task)) issue(diagnostics, "TASK_COVERAGE_INCOMPLETE", `selected task ${task} has no explicit task mapping`, "task_mappings", [task]);
      }
    }
  }
  const unitWriteFacts = new Map<string, ApplyPlanScopeFact[]>();
  const getUnitWriteFacts = (unit: ApplyPlanUnit): ApplyPlanScopeFact[] => {
    const cached = unitWriteFacts.get(unit.id);
    if (cached) return cached;
    const facts = normalizedFactsFromPlanUnit(unit);
    unitWriteFacts.set(unit.id, facts);
    return facts;
  };
  for (let left = 0; left < units.length; left += 1) {
    for (let right = left + 1; right < units.length; right += 1) {
      const a = units[left];
      const b = units[right];
      if (!record(a) || !record(b)) continue;
      const aa = a as unknown as ApplyPlanUnit;
      const bb = b as unknown as ApplyPlanUnit;
      if (!string(aa.id) || !string(bb.id) || !strings(aa.write_paths) || !strings(bb.write_paths)) continue;
      const leftFacts = getUnitWriteFacts(aa);
      const rightFacts = getUnitWriteFacts(bb);
      const paths = [...new Set(
        leftFacts
          .filter((source) => rightFacts.some((target) => scopeConflicts(source, target)))
          .map((source) => source.path),
      )].sort();
      if (!paths.length) continue;
      overlap_edges.push({ from: aa.id, to: bb.id, paths });
    }
  }
  const fakePlan = raw as unknown as ApplyExecutionPlan; const remaining_critical_path = Array.isArray(raw.units) ? criticalPath(fakePlan) : {};
  if (raw.fingerprint !== undefined && (!string(raw.fingerprint) || !HEX_SHA256.test(raw.fingerprint))) issue(diagnostics, "INVALID_FINGERPRINT", "fingerprint must be a SHA-256 hex string", "fingerprint");
  return { valid: diagnostics.length === 0, diagnostics, overlap_edges, remaining_critical_path, ...(diagnostics.length === 0 ? { plan: fakePlan } : {}) };
}

export function assertValidApplyExecutionPlan(input: unknown): ApplyExecutionPlan {
  const result = validateApplyExecutionPlan(input); if (!result.valid) throw new ApplyPlanValidationError(result.diagnostics); return input as ApplyExecutionPlan;
}

export function parseApplyExecutionPlan(text: string): ApplyExecutionPlan {
  let value: unknown; try { value = JSON.parse(text); } catch { throw new ApplyPlanValidationError([{ code: "INVALID_JSON", message: "plan is not valid JSON" }]); }
  return assertValidApplyExecutionPlan(value);
}

export function serializeApplyExecutionPlan(plan: ApplyExecutionPlan): string { return canonicalizeApplyPlan(assertValidApplyExecutionPlan(plan)); }
export const canonicalJson = canonicalizeApplyPlan;
export const fingerprintPlan = fingerprintApplyExecutionPlan;
