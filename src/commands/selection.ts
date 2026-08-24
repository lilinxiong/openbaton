import { loadConfig } from "../lib/config.js";
import { parseHostId } from "../lib/hosts.js";
import { cardsForAutomaticSelection } from "../lib/route-health.js";
import { readRouteSnapshot } from "../lib/routes.js";
import { requireCardId } from "../lib/cards.js";
import { planStandaloneSpawn, writeSpawn, type SpawnTicket } from "../lib/spawn.js";
import { applyChange } from "../lib/apply.js";
import { scopesFromRecord } from "../lib/apply-scope.js";
import { buildWriteReceipt, writeReceipt } from "../lib/receipt.js";
import { captureBaseline, type SafetyOperation } from "../lib/safety.js";
import { loadTasksFromChangeDir } from "../lib/openspec.js";
import {
  readSelectionProposal,
  selectionSourceFingerprint,
  writeSelectionProposal,
  type SelectionCandidate,
  type SelectionProposal,
} from "../lib/selection.js";
import type { SelectionQuotaPool } from "../lib/quota-pools.js";
import type { ModelCard, ModelSelectionApproval, WritableLike } from "../types.js";
import { SUBAGENT_MODEL_POLICY_ID } from "../lib/model-policy.js";

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
    if (proposal.payload.source_shape === "multi-unit-v1") return scopedSelectionSourceFingerprint(proposal, {
        source_shape: "multi-unit-v1",
        description: String(proposal.payload.description || ""),
        units: Array.isArray(proposal.payload.units)
          ? proposal.payload.units.map((item) => {
            const unit = item && typeof item === "object" ? item as Record<string, unknown> : {};
            return { key: String(unit.key || ""), description: String(unit.description || "") };
          })
          : [],
      });
    return scopedSelectionSourceFingerprint(proposal, {
      description: proposal.payload.description,
      task_kind: proposal.payload.task_kind || null,
      deliverable: proposal.payload.deliverable || null,
      done_when: proposal.payload.done_when || null,
      write_paths: proposal.payload.write_paths || [],
      write_operations: proposal.payload.write_operations || [],
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
    throw new Error(`MODEL_RECOMMENDATION_UNAVAILABLE: ${key} has no automatic configured candidate (${unit.recommendation_reason})`);
  }
  return candidate;
}

function validateProposal(cwd: string, proposal: SelectionProposal): void {
  if (proposal.status !== "pending_confirmation") throw new Error(`selection proposal ${proposal.id} is already ${proposal.status}`);
  if (proposal.model_policy_id !== SUBAGENT_MODEL_POLICY_ID) {
    throw new Error("MODEL_POLICY_CHANGED: this proposal predates the configured CLI allowlist policy; create a new proposal");
  }
  const snapshot = readRouteSnapshot(cwd, { host: proposal.host });
  if (!snapshot || snapshot.fingerprint !== proposal.catalog_fingerprint) {
    throw new Error("ROUTE_SNAPSHOT_STALE: refresh the active CLI model catalog and create a new proposal");
  }
  if (currentSourceFingerprint(proposal) !== proposal.source_fingerprint) {
    throw new Error("SELECTION_SOURCE_CHANGED: task input changed after planning; create a new proposal");
  }
}

function approveStandalone(cwd: string, proposal: SelectionProposal, cards: ModelCard[]) {
  const units = proposal.units.filter((item) => !item.director_local);
  if (!units.length) throw new Error(`proposal ${proposal.id} has no delegated unit`);
  const choices = units.map((unit) => ({ unit, candidate: recommendedCandidate(proposal, unit.key) }));
  const context = automaticContext(proposal, choices.map((item) => item.candidate));
  const writePaths = Array.isArray(proposal.payload.write_paths) ? proposal.payload.write_paths.map(String) : [];
  if (writePaths.length && units.length > 1) throw new Error("multi-unit standalone write approval is not supported; use separately scoped write proposals");
  const tickets: SpawnTicket[] = [];
  const approvals: Array<{ key: string; approval: ModelSelectionApproval }> = [];
  for (const { unit, candidate } of choices) {
    requireCardId(candidate.model_id, cards);
    const approval = approvalFor(proposal, unit.key, candidate, unit.recommended_model_id, context);
    const legacySingle = proposal.payload.source_shape !== "multi-unit-v1";
    const planned = planStandaloneSpawn({
      description: unit.description,
      cards,
      explicitModel: candidate.model_id,
      cwd,
      queue: null,
      taskKind: legacySingle ? proposal.payload.task_kind as "concrete" | "deliberative" | null : null,
      deliverable: legacySingle && typeof proposal.payload.deliverable === "string" ? proposal.payload.deliverable : null,
      doneWhen: legacySingle && typeof proposal.payload.done_when === "string" ? proposal.payload.done_when : null,
      selectionApproval: approval,
    });
    if (planned.director_local === true) throw new Error(`selection source no longer requires delegation: ${unit.key}`);
    if (writePaths.length) {
      const operations = Array.isArray(proposal.payload.write_operations)
        ? proposal.payload.write_operations.map(String) as SafetyOperation[]
        : ["write", "create"] as SafetyOperation[];
      planned.receipt = buildWriteReceipt({
        base: planned.receipt,
        baseline: captureBaseline(cwd),
        writeAllowlist: writePaths,
        allowedOperations: operations,
      });
      planned.ticket.mode = "write";
      planned.ticket.read_only = false;
    }
    writeReceipt(cwd, planned.receipt);
    writeSpawn(cwd, planned.ticket);
    tickets.push(planned.ticket);
    approvals.push({ key: unit.key, approval });
  }
  return { tickets, approvals, local: [], confirmation: context };
}

function approveOpenSpec(cwd: string, proposal: SelectionProposal, cards: ModelCard[], env: NodeJS.ProcessEnv) {
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
  const result = applyChange({
    cwd,
    change: String(proposal.payload.change),
    cfg: loadConfig(cwd, { env }),
    cards,
    includeTask: (task) => includedTasks.has(task.number),
    selectCard: (task) => selected.get(task.number),
    selectCards: (prompt, available) => cardsForAutomaticSelection(cwd, available, prompt, selectionHost),
    selectionApprovals: approvals,
    unitScopes: scopesFromRecord(proposal.payload.unit_scopes),
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
  writeSelectionProposal(cwd, proposal);
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
      throw new Error(
        `MODEL_RECOMMENDATION_UNAVAILABLE: ${unit.key} has no automatic configured candidate (${unit.recommendation_reason}). `
        + "Run `baton config` and enable at least one CLI subagent model.",
      );
    }
  }
}

export function approveRecommendedSelection({
  cwd,
  proposal,
  cards,
  env = process.env,
}: {
  cwd: string;
  proposal: SelectionProposal;
  cards: ModelCard[];
  env?: NodeJS.ProcessEnv;
}): SelectionApprovalOutput {
  validateProposal(cwd, proposal);
  assertRecommendedSelectionAvailable(proposal.units);
  const result = proposal.source === "standalone"
    ? approveStandalone(cwd, proposal, cards)
    : approveOpenSpec(cwd, proposal, cards, env);
  return finalizeSelectionApproval(cwd, proposal, result);
}

export function runSelection(args: string[], {
  cwd,
  stdout,
  host,
}: {
  cwd: string;
  stdout: WritableLike;
  cards: ModelCard[];
  env?: NodeJS.ProcessEnv;
  host?: string;
}): number {
  const sub = args[0] || "show";
  if (sub !== "show") {
    throw new Error("MODEL_SELECTION_REMOVED: selector rendering and model approval are not supported; Baton routes automatically from cli.<id>.subagent_models");
  }
  const id = args[1];
  if (!id) throw new Error("usage: baton selection show PROPOSAL [--json]");
  const proposal = readSelectionProposal(cwd, id);
  if (host && proposal.host && parseHostId(host) !== parseHostId(proposal.host)) {
    throw new Error(`HOST_MISMATCH: selection ${id} belongs to ${proposal.host}, not ${host}`);
  }
  if (args.includes("--json")) stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
  else printSelectionProposal(stdout, proposal);
  return 0;
}

function quotaText(pool: SelectionQuotaPool): string {
  if (pool.status === "unknown") return `unknown (${pool.reason}; observed ${pool.observed_at})`;
  if (pool.status === "exhausted") return "quota exhausted; candidates unavailable";
  return pool.windows.map((item) => `${item.label} remaining ${item.remaining_percent.toFixed(2)}%${item.resets_at ? ` reset ${item.resets_at}` : ""}`).join("; ");
}

function tableCell(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

function tableRow(values: unknown[]): string {
  return `| ${values.map(tableCell).join(" | ")} |\n`;
}

function metric(value: number | null): string {
  return value == null ? "unknown" : String(value);
}

function evidenceText(candidate: SelectionCandidate): string {
  if (!candidate.reference_only) return candidate.ranked ? "exact" : "unranked";
  const source = candidate.reference_route_id
    ? `${candidate.reference_route_id}@${candidate.reference_profile || "base"}`
    : "unknown source";
  return `reference only: ${candidate.reference_reasons.join("+")}; source=${source}; AA=${candidate.aa_slug || "unknown"}`;
}

function printCandidateTable(stdout: WritableLike, proposal: SelectionProposal, unit: SelectionProposal["units"][number]): void {
  stdout.write("  candidates:\n");
  for (const pool of proposal.quota_pools) {
    const candidates = unit.candidates.filter((candidate) => candidate.quota_pool_id === pool.id && candidate.selectable);
    if (!candidates.length) continue;
    stdout.write(`\n  ${pool.label} [${pool.status}] — ${quotaText(pool)}\n\n`);
    stdout.write(tableRow(["Candidate", "Recommended", "Effort", "Fast/tier", "Evidence", "Task score", "Strengths", "Callability"]));
    stdout.write(tableRow(["---", "---", "---", "---", "---", "---:", "---", "---"]));
    for (const candidate of candidates) {
      stdout.write(tableRow([
        candidate.model_id,
        candidate.model_id === unit.recommended_model_id ? "yes" : "",
        candidate.effective_reasoning_effort || "unknown",
        candidate.speed_signals.length ? `${candidate.service_tier || "model"} via ${candidate.speed_signals.join("+")}` : "no",
        evidenceText(candidate),
        candidate.task_score ?? "unranked",
        candidate.strengths,
        `${candidate.selection_code}: ${candidate.selection_reason}`,
      ]));
    }
  }
}

export function printSelectionProposal(stdout: WritableLike, proposal: SelectionProposal): void {
  stdout.write(`automatic routing proposal ${proposal.id} [${proposal.status}]\n`);
  stdout.write(`  CLI model catalog: ${proposal.catalog_fingerprint}\n`);
  stdout.write(`  model policy: ${proposal.model_policy_id || "legacy/stale"}\n`);
  for (const unit of proposal.units) {
    stdout.write(`\n${unit.key}: ${unit.description}\n`);
    if (unit.director_local) {
      stdout.write("  director-local\n");
      continue;
    }
    stdout.write(`  selected recommendation: ${unit.recommended_model_id || "none"} (${unit.recommendation_reason})\n`);
    stdout.write(`  target effort: ${unit.target_reasoning_effort} (${unit.complexity_reason})\n`);
    stdout.write(`  estimated context: ${unit.estimated_context_tokens} tokens (${unit.context_estimate_reason})\n`);
    printCandidateTable(stdout, proposal, unit);
  }
  stdout.write("\nThis command is audit-only. Baton does not expose a runtime model selector or approval action.\n");
}
