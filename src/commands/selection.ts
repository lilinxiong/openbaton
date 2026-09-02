import { loadConfig } from "../lib/config.js";
import { cardsForAutomaticSelection } from "../lib/route-health.js";
import { readRouteSnapshot } from "../lib/routes.js";
import { requireCardId } from "../lib/cards.js";
import { nextSpawnIds, planStandaloneSpawn, type SpawnTicket, type StandalonePlan } from "../lib/spawn.js";
import { applyChange } from "../lib/apply.js";
import { applyTaskId } from "../lib/task-id.js";
import { DEFAULT_WRITE_OPERATIONS, scopesFromRecord, type ApplyUnitScope } from "../lib/apply/scope.js";
import { type SafetyOperation } from "../lib/safety.js";
import { assertWriteScopesAvailable, materializeStandalonePlanAsync } from "../lib/ticket-materialization.js";
import { loadTasksFromChangeDir } from "../lib/openspec.js";
import {
  selectionSourceFingerprint,
  writeSelectionProposal,
  type SelectionCandidate,
  type SelectionProposal,
} from "../lib/selection.js";
import type { ModelCard, ModelSelectionApproval } from "../types.js";

interface ApprovalContext {
  confirmation_id: string;
  scope: "proposal";
  confirmed_at: string;
  confirmed_by: "baton-recommendation";
  selected_provider_ids: string[];
  global_provider_ids: string[];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort();
}

function automaticContext(proposal: SelectionProposal, candidates: SelectionCandidate[]): ApprovalContext {
  const providers = sortedUnique(candidates.map((candidate) => candidate.provider || "unknown"));
  return {
    confirmation_id: `confirmation-${proposal.id}-recommendation`,
    scope: "proposal",
    confirmed_at: new Date().toISOString(),
    confirmed_by: "baton-recommendation",
    selected_provider_ids: providers,
    global_provider_ids: providers,
  };
}

function approvalFor(
  proposal: SelectionProposal,
  key: string,
  candidate: SelectionCandidate,
  recommended: string | null,
  context: ApprovalContext,
): ModelSelectionApproval {
  return {
    host: proposal.host,
    proposal_id: proposal.id,
    approval_id: `approval-${proposal.id}-${key.replaceAll(/[^a-zA-Z0-9_.-]/g, "-")}`,
    confirmation_id: context.confirmation_id,
    confirmation_scope: context.scope,
    unit_key: key,
    approved_at: context.confirmed_at,
    confirmed_by: context.confirmed_by,
    catalog_fingerprint: proposal.catalog_fingerprint,
    recommended_model_id: recommended,
    selected_model_id: candidate.model_id,
    service_tier: candidate.service_tier,
    changed_by_user: false,
    selected_provider_ids: context.selected_provider_ids,
    global_provider_ids: context.global_provider_ids,
  };
}

function currentSourceFingerprint(proposal: SelectionProposal): string {
  if (proposal.source === "standalone") {
    if (proposal.payload.source_shape !== "multi-unit-v1" || !Array.isArray(proposal.payload.units)) {
      throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: standalone proposals must use the multi-unit shape");
    }
    return scopedSelectionSourceFingerprint(proposal, {
      source_shape: "multi-unit-v1",
      description: String(proposal.payload.description || ""),
      units: proposal.payload.units.map((item) => {
        const unit = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return { key: String(unit.key || ""), description: String(unit.description || "") };
      }),
      ...(Object.hasOwn(proposal.payload, "classification") ? { classification: proposal.payload.classification } : {}),
      ...(Object.hasOwn(proposal.payload, "operation") ? { operation: proposal.payload.operation } : {}),
      ...(Object.hasOwn(proposal.payload, "unit_classifications") ? { unit_classifications: proposal.payload.unit_classifications } : {}),
      ...(Object.hasOwn(proposal.payload, "unit_operations") ? { unit_operations: proposal.payload.unit_operations } : {}),
      write_paths: proposal.payload.write_paths || [],
      write_operations: proposal.payload.write_operations || [],
      ...(Object.hasOwn(proposal.payload, "unit_scopes") ? { unit_scopes: proposal.payload.unit_scopes } : {}),
    });
  }
  const changeDir = String(proposal.payload.change_dir || "");
  const tasks = loadTasksFromChangeDir(changeDir).tasks
    .filter((task) => task.status === "pending")
    .map((task) => ({ number: task.number, description: task.description, section: task.section }));
  return scopedSelectionSourceFingerprint(proposal, tasks);
}

function scopedSelectionSourceFingerprint(proposal: SelectionProposal, value: unknown): string {
  const base = selectionSourceFingerprint(value);
  return proposal.host ? selectionSourceFingerprint({ host: proposal.host, source_fingerprint: base }) : base;
}

function recommendedCandidate(proposal: SelectionProposal, key: string): SelectionCandidate {
  const unit = proposal.units.find((item) => item.key === key);
  if (!unit || unit.director_local) throw new Error(`selection unit is not delegable: ${key}`);
  const candidate = unit.recommended_model_id
    ? unit.candidates.find((item) => item.model_id === unit.recommended_model_id)
    : null;
  if (!candidate?.selectable || !candidate.automatic_eligible) {
    throw unavailableRecommendationError(unit, key);
  }
  return candidate;
}

function validateProposal(cwd: string, proposal: SelectionProposal, env?: NodeJS.ProcessEnv): void {
  if (proposal.status !== "pending_confirmation") throw new Error(`selection proposal ${proposal.id} is already ${proposal.status}`);
  const snapshot = readRouteSnapshot(cwd, { host: proposal.host, env });
  if (!snapshot || snapshot.fingerprint !== proposal.catalog_fingerprint) {
    throw new Error("ROUTE_SNAPSHOT_STALE: refresh the active CLI model catalog and create a new proposal");
  }
  if (currentSourceFingerprint(proposal) !== proposal.source_fingerprint) {
    throw new Error("SELECTION_SOURCE_CHANGED: task input changed after planning; create a new proposal");
  }
}

async function approveStandalone(cwd: string, proposal: SelectionProposal, cards: ModelCard[], env?: NodeJS.ProcessEnv) {
  const units = proposal.units.filter((item) => !item.director_local);
  if (!units.length) throw new Error(`proposal ${proposal.id} has no delegated unit`);
  const choices = units.map((unit) => ({ unit, candidate: recommendedCandidate(proposal, unit.key) }));
  const context = automaticContext(proposal, choices.map((item) => item.candidate));
  const writePaths = Array.isArray(proposal.payload.write_paths) ? proposal.payload.write_paths.map(String) : [];
  const declaredScopes = scopesFromRecord(proposal.payload.unit_scopes);
  if (writePaths.length && units.length > 1 && declaredScopes.size === 0) {
    throw new Error("TASK_SCOPE_REQUIRED: multi-unit standalone writes require one scope per unit");
  }
  if (writePaths.length && units.length === 1 && !declaredScopes.has(units[0].key)) {
    declaredScopes.set(units[0].key, {
      mode: "write",
      write_paths: writePaths,
      allowed_operations: Array.isArray(proposal.payload.write_operations)
        ? proposal.payload.write_operations.map(String) as SafetyOperation[]
        : [...DEFAULT_WRITE_OPERATIONS],
    });
  }
  const tickets: SpawnTicket[] = [];
  const approvals: Array<{ key: string; approval: ModelSelectionApproval }> = [];
  const plans: Array<{ key: string; planned: Extract<StandalonePlan, { director_local: false }>; scope?: ApplyUnitScope; approval: ModelSelectionApproval }> = [];
  const ids = nextSpawnIds(cwd, "spn", choices.length, env);
  for (const [{ unit, candidate }, index] of choices.map((choice, index) => [choice, index] as const)) {
    requireCardId(candidate.model_id, cards);
    const approval = approvalFor(proposal, unit.key, candidate, unit.recommended_model_id, context);
    const planned = planStandaloneSpawn({
      description: unit.description,
      cards,
      explicitModel: candidate.model_id,
      cwd,
      queue: null,
      taskKind: "concrete",
      selectionApproval: approval,
      // A unit that reached automatic selection is already classified as
      // delegable. Do not let the tiny-edit hygiene shortcut pull it
      // back onto the director during ticket materialization.
      forceDelegate: true,
      id: ids[index],
    });
    if (planned.director_local === true) throw new Error(`selection source no longer requires delegation: ${unit.key}`);
    const delegated = planned;
    delegated.ticket.routing_requirements = {
      required_reasoning_effort: unit.target_reasoning_effort,
      estimated_context_tokens: unit.estimated_context_tokens,
    };
    plans.push({ key: unit.key, planned: delegated, scope: declaredScopes.get(unit.key), approval });
  }
  assertWriteScopesAvailable(cwd, plans
    .filter((item) => item.scope?.mode === "write")
    .map((item) => ({ key: item.key, write_paths: item.scope!.write_paths })), env);
  for (const { planned, scope } of plans) {
    await materializeStandalonePlanAsync(cwd, planned, {
      env,
      ...(scope?.mode === "write" ? {
        writeAllowlist: scope.write_paths,
        allowedOperations: scope.allowed_operations || [...DEFAULT_WRITE_OPERATIONS],
      } : {}),
    });
    tickets.push(planned.ticket);
  }
  approvals.push(...plans.map(({ key, approval }) => ({ key, approval })));
  return { tickets, approvals, local: [], confirmation: context };
}

async function approveOpenSpec(cwd: string, proposal: SelectionProposal, cards: ModelCard[], env: NodeJS.ProcessEnv) {
  const candidates = new Map<string, SelectionCandidate>();
  for (const unit of proposal.units) {
    if (!unit.director_local) candidates.set(unit.key, recommendedCandidate(proposal, unit.key));
  }
  const context = automaticContext(proposal, [...candidates.values()]);
  const selected = new Map<string, ModelCard>();
  const approvals = new Map<string, ModelSelectionApproval>();
  const selectionHost = proposal.host;
  if (!selectionHost) throw new Error("TASK_SCOPE_REQUIRED: apply selection requires a host");
  const includedTasks = new Set(proposal.units.map((unit) => unit.key));
  for (const unit of proposal.units) {
    if (unit.director_local) continue;
    const candidate = candidates.get(unit.key)!;
    selected.set(unit.key, requireCardId(candidate.model_id, cards));
    approvals.set(unit.key, approvalFor(proposal, unit.key, candidate, unit.recommended_model_id, context));
  }
  const result = await applyChange({
    cwd,
    change: String(proposal.payload.change),
    cfg: loadConfig(cwd, { env }),
    cards,
    includeTask: (task) => includedTasks.has(applyTaskId(task)),
    selectCard: (task) => selected.get(applyTaskId(task)),
    selectCards: (prompt, available) => cardsForAutomaticSelection(cwd, available, prompt, selectionHost, env),
    selectionApprovals: approvals,
    unitScopes: scopesFromRecord(proposal.payload.unit_scopes),
    routingRequirements: new Map(proposal.units.map((unit) => [unit.key, {
      required_reasoning_effort: unit.target_reasoning_effort,
      estimated_context_tokens: unit.estimated_context_tokens,
    }])),
    env,
  });
  if (result.error || result.blocked.length) throw new Error(result.error || result.blocked.map((item) => `${item.id}: ${item.error}`).join("; "));
  return {
    tickets: result.tickets,
    approvals: [...approvals.entries()].map(([key, approval]) => ({ key, approval })),
    local: result.local,
    confirmation: context,
  };
}

interface SelectionExecutionResult {
  tickets: SpawnTicket[];
  approvals: Array<{ key: string; approval: ModelSelectionApproval }>;
  local: unknown[];
  confirmation: ApprovalContext;
}

export interface SelectionApprovalOutput {
  proposal_id: string;
  status: "approved";
  confirmation: NonNullable<SelectionProposal["confirmation"]>;
  approvals: SelectionProposal["approvals"];
  tickets: SpawnTicket[];
  director_local: unknown[];
}

function finalizeSelectionApproval(
  cwd: string,
  proposal: SelectionProposal,
  result: SelectionExecutionResult,
  env?: NodeJS.ProcessEnv,
): SelectionApprovalOutput {
  proposal.status = "approved";
  proposal.approved_at = result.confirmation.confirmed_at;
  proposal.confirmation = {
    confirmation_id: result.confirmation.confirmation_id,
    scope: result.confirmation.scope,
    confirmed_at: result.confirmation.confirmed_at,
    confirmed_by: result.confirmation.confirmed_by,
    selected_provider_ids: result.confirmation.selected_provider_ids,
    global_provider_ids: result.confirmation.global_provider_ids,
    unit_keys: result.approvals.map(({ key }) => key),
  };
  if (!Array.isArray(proposal.history)) proposal.history = [{ event: "pending_confirmation", at: proposal.created_at }];
  proposal.history.push({ event: "approved", at: proposal.approved_at });
  proposal.approvals = result.approvals.map(({ key, approval }) => ({
    key,
    host: approval.host,
    approval_id: approval.approval_id,
    confirmation_id: approval.confirmation_id,
    confirmed_by: approval.confirmed_by,
    recommended_model_id: approval.recommended_model_id,
    selected_model_id: approval.selected_model_id,
    service_tier: approval.service_tier || null,
    changed_by_user: false,
    selected_provider_ids: approval.selected_provider_ids,
    global_provider_ids: approval.global_provider_ids,
  }));
  writeSelectionProposal(cwd, proposal, env);
  return {
    proposal_id: proposal.id,
    status: proposal.status,
    confirmation: proposal.confirmation,
    approvals: proposal.approvals,
    tickets: result.tickets,
    director_local: result.local,
  };
}

export function assertRecommendedSelectionAvailable(units: SelectionProposal["units"]): void {
  for (const unit of units) {
    if (unit.director_local) continue;
    const candidate = unit.recommended_model_id
      ? unit.candidates.find((item) => item.model_id === unit.recommended_model_id)
      : null;
    if (!candidate?.selectable || !candidate.automatic_eligible) {
      throw unavailableRecommendationError(unit, unit.key);
    }
  }
}

function unavailableRecommendationError(
  unit: SelectionProposal["units"][number],
  key: string,
): Error & { code: string } {
  const exhausted = unit.recommendation_reason === "CODING_MODELS_EXHAUSTED";
  const code = exhausted ? "CODING_MODELS_EXHAUSTED" : "MODEL_RECOMMENDATION_UNAVAILABLE";
  const reasons = unit.candidates.length
    ? unit.candidates.map((candidate) => `${candidate.route_id}:${candidate.selection_code}:${candidate.selection_reason}`).join("; ")
    : "no configured Coding routes";
  const error = new Error(
    `${code}: ${key} has no automatic configured candidate (${unit.recommendation_reason}); ${reasons}. `
    + "Run `baton config`, wait for recovery, or reset confirmed quota state.",
  ) as Error & { code: string };
  error.code = code;
  return error;
}

export async function approveRecommendedSelection({
  cwd,
  proposal,
  cards,
  env = process.env,
}: {
  cwd: string;
  proposal: SelectionProposal;
  cards: ModelCard[];
  env?: NodeJS.ProcessEnv;
}): Promise<SelectionApprovalOutput> {
  validateProposal(cwd, proposal, env);
  assertRecommendedSelectionAvailable(proposal.units);
  const result = proposal.source === "standalone"
    ? await approveStandalone(cwd, proposal, cards, env)
    : await approveOpenSpec(cwd, proposal, cards, env);
  return finalizeSelectionApproval(cwd, proposal, result, env);
}
