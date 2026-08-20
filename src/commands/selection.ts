import { loadConfig } from "../lib/config.js";
import { cardsForAutomaticSelection } from "../lib/route-health.js";
import { readHostCapabilitySnapshot } from "../lib/host-capabilities.js";
import { requireCardId } from "../lib/cards.js";
import { planStandaloneSpawn, writeSpawn } from "../lib/spawn.js";
import { applyChange } from "../lib/apply.js";
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
import type { ModelCard, ModelSelectionApproval, WritableLike } from "../types.js";
import { SUBAGENT_MODEL_POLICY_ID, assertSubagentModelAllowed } from "../lib/model-policy.js";

type FlagValue = string | boolean;
type FlagMap = Record<string, FlagValue | FlagValue[]>;

function flagsOf(args: string[]): FlagMap {
  const flags: FlagMap = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = args[index + 1];
    const item: FlagValue = next && !next.startsWith("--") ? next : true;
    if (item !== true) index += 1;
    const current = flags[key];
    if (current === undefined) flags[key] = item;
    else if (Array.isArray(current)) current.push(item);
    else flags[key] = [current, item];
  }
  return flags;
}

function one(flags: FlagMap, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").at(-1);
  return undefined;
}

function many(flags: FlagMap, key: string): string[] {
  const value = flags[key];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function routeAssignments(values: string[]): Map<string, string> {
  const routes = new Map<string, string>();
  for (const value of values) {
    const split = value.indexOf("=");
    if (split <= 0 || split === value.length - 1) throw new Error(`invalid --route assignment: ${value}; expected TASK=EXACT_ROUTE[@PROFILE]`);
    const key = value.slice(0, split).trim();
    const model = value.slice(split + 1).trim();
    if (!key || !model) throw new Error(`invalid --route assignment: ${value}`);
    if (routes.has(key)) throw new Error(`duplicate --route assignment: ${key}`);
    routes.set(key, model);
  }
  return routes;
}

function approvalFor(proposal: SelectionProposal, key: string, selected: string, recommended: string | null, at: string): ModelSelectionApproval {
  return {
    proposal_id: proposal.id,
    approval_id: `approval-${proposal.id}-${key.replaceAll(/[^a-zA-Z0-9_.-]/g, "-")}`,
    approved_at: at,
    confirmed_by: "user",
    host_snapshot_id: proposal.host_snapshot_id,
    recommended_model_id: recommended,
    selected_model_id: selected,
    changed_by_user: selected !== recommended,
  };
}

function currentSourceFingerprint(proposal: SelectionProposal): string {
  if (proposal.source === "standalone") return selectionSourceFingerprint({
    description: proposal.payload.description,
    task_kind: proposal.payload.task_kind || null,
    deliverable: proposal.payload.deliverable || null,
    done_when: proposal.payload.done_when || null,
    write_paths: proposal.payload.write_paths || [],
    write_operations: proposal.payload.write_operations || [],
  });
  const changeDir = String(proposal.payload.change_dir || "");
  const tasks = loadTasksFromChangeDir(changeDir).tasks
    .filter((task) => task.status === "pending")
    .map((task) => ({ number: task.number, description: task.description, section: task.section }));
  return selectionSourceFingerprint(tasks);
}

function selectedCandidate(proposal: SelectionProposal, key: string, override: string | undefined): { candidate: SelectionCandidate; approval: ModelSelectionApproval } {
  const unit = proposal.units.find((item) => item.key === key);
  if (!unit || unit.director_local) throw new Error(`selection unit is not delegable: ${key}`);
  const selected = override || unit.default_model_id;
  if (!selected) throw new Error(`${key} requires an explicit --route ${key}=EXACT_ROUTE[@PROFILE] choice`);
  assertSubagentModelAllowed(selected, selected);
  const candidate = unit.candidates.find((item) => item.model_id === selected);
  if (!candidate) throw new Error(`${key}: ${selected} was not disclosed in proposal ${proposal.id}`);
  if (!candidate.selectable) throw new Error(`${key}: ${selected}: ${candidate.host.code}: ${candidate.host.reason}`);
  const at = new Date().toISOString();
  return { candidate, approval: approvalFor(proposal, key, selected, unit.recommended_model_id, at) };
}

function validateProposal(cwd: string, proposal: SelectionProposal): void {
  if (proposal.status !== "pending_confirmation") throw new Error(`selection proposal ${proposal.id} is already ${proposal.status}`);
  if (proposal.model_policy_id !== SUBAGENT_MODEL_POLICY_ID) {
    throw new Error("MODEL_POLICY_CHANGED: this proposal predates the current subagent model-family policy; create a new proposal");
  }
  const host = readHostCapabilitySnapshot(cwd);
  if (!host || host.id !== proposal.host_snapshot_id || host.catalog_fingerprint !== proposal.catalog_fingerprint) {
    throw new Error("HOST_CAPABILITIES_STALE: sync the current Codex model surface and create a new proposal");
  }
  if (currentSourceFingerprint(proposal) !== proposal.source_fingerprint) {
    throw new Error("SELECTION_SOURCE_CHANGED: task input changed after disclosure; create a new proposal");
  }
}

function approveStandalone(cwd: string, proposal: SelectionProposal, cards: ModelCard[], flags: FlagMap) {
  const unit = proposal.units.find((item) => !item.director_local);
  if (!unit) throw new Error(`proposal ${proposal.id} has no delegated unit`);
  const { candidate, approval } = selectedCandidate(proposal, unit.key, one(flags, "model"));
  requireCardId(candidate.model_id, cards);
  const planned = planStandaloneSpawn({
    description: String(proposal.payload.description),
    cards,
    explicitModel: candidate.model_id,
    cwd,
    queue: null,
    taskKind: proposal.payload.task_kind as "concrete" | "deliberative" | null,
    deliverable: typeof proposal.payload.deliverable === "string" ? proposal.payload.deliverable : null,
    doneWhen: typeof proposal.payload.done_when === "string" ? proposal.payload.done_when : null,
    selectionApproval: approval,
  });
  if (planned.director_local === true) throw new Error("selection source no longer requires delegation");
  const writePaths = Array.isArray(proposal.payload.write_paths) ? proposal.payload.write_paths.map(String) : [];
  if (writePaths.length) {
    const operations = Array.isArray(proposal.payload.write_operations)
      ? proposal.payload.write_operations.map(String) as SafetyOperation[]
      : ["write", "create"] as SafetyOperation[];
    planned.receipt = buildWriteReceipt({ base: planned.receipt, baseline: captureBaseline(cwd), writeAllowlist: writePaths, allowedOperations: operations });
    planned.ticket.mode = "write";
    planned.ticket.read_only = false;
  }
  writeReceipt(cwd, planned.receipt);
  writeSpawn(cwd, planned.ticket);
  return { tickets: [planned.ticket], approvals: [{ key: unit.key, approval }], local: [] };
}

function approveOpenSpec(cwd: string, proposal: SelectionProposal, cards: ModelCard[], flags: FlagMap) {
  const overrides = routeAssignments(many(flags, "route"));
  for (const key of overrides.keys()) {
    if (!proposal.units.some((unit) => unit.key === key && !unit.director_local)) throw new Error(`--route task is not delegable in ${proposal.id}: ${key}`);
  }
  const selected = new Map<string, ModelCard>();
  const approvals = new Map<string, ModelSelectionApproval>();
  for (const unit of proposal.units) {
    if (unit.director_local) continue;
    const choice = selectedCandidate(proposal, unit.key, overrides.get(unit.key));
    selected.set(unit.key, requireCardId(choice.candidate.model_id, cards));
    approvals.set(unit.key, choice.approval);
  }
  const result = applyChange({
    cwd,
    change: String(proposal.payload.change),
    cfg: loadConfig(cwd),
    cards,
    selectCard: (task) => selected.get(task.number),
    selectCards: (prompt, available) => cardsForAutomaticSelection(cwd, available, prompt),
    selectionApprovals: approvals,
  });
  if (result.error || result.blocked.length) throw new Error(result.error || result.blocked.map((item) => `${item.id}: ${item.error}`).join("; "));
  return {
    tickets: result.tickets,
    approvals: [...approvals.entries()].map(([key, approval]) => ({ key, approval })),
    local: result.local,
  };
}

export function runSelection(args: string[], { cwd, stdout, cards }: { cwd: string; stdout: WritableLike; cards: ModelCard[] }): number {
  const sub = args[0] || "show";
  const id = args[1];
  if (!id) throw new Error("usage: baton selection show|approve PROPOSAL [--confirm] [--model ID] [--route TASK=ID]");
  const proposal = readSelectionProposal(cwd, id);
  if (sub === "show") {
    const flags = flagsOf(args.slice(2));
    if (flags.json) stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
    else printSelectionProposal(stdout, proposal);
    return 0;
  }
  if (sub !== "approve") throw new Error("usage: baton selection show|approve PROPOSAL [--confirm] [--model ID] [--route TASK=ID]");
  const flags = flagsOf(args.slice(2));
  if (!flags.confirm) throw new Error("MODEL_SELECTION_NOT_CONFIRMED: --confirm is required only after the user has reviewed the disclosed proposal");
  validateProposal(cwd, proposal);
  const result = proposal.source === "standalone"
    ? approveStandalone(cwd, proposal, cards, flags)
    : approveOpenSpec(cwd, proposal, cards, flags);
  proposal.status = "approved";
  proposal.approved_at = result.approvals[0]?.approval.approved_at || new Date().toISOString();
  if (!Array.isArray(proposal.history)) proposal.history = [{ event: "pending_confirmation", at: proposal.created_at }];
  proposal.history.push({ event: "approved", at: proposal.approved_at });
  proposal.approvals = result.approvals.map(({ key, approval }) => ({
    key,
    approval_id: approval.approval_id,
    recommended_model_id: approval.recommended_model_id,
    selected_model_id: approval.selected_model_id,
    changed_by_user: approval.changed_by_user,
  }));
  writeSelectionProposal(cwd, proposal);
  const output = { proposal_id: proposal.id, status: proposal.status, approvals: proposal.approvals, tickets: result.tickets, director_local: result.local };
  if (flags.json) stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    stdout.write(`approved ${proposal.id}\n`);
    for (const item of proposal.approvals) stdout.write(`  ${item.key}: ${item.selected_model_id}${item.changed_by_user ? " (user changed)" : ""}\n`);
    for (const ticket of result.tickets) stdout.write(`  ticket ${ticket.id} queued; dispatch remains host-owned\n`);
  }
  return 0;
}

function quotaText(candidate: SelectionCandidate): string {
  if (candidate.quota.status === "unknown") return `unknown (${candidate.quota.reason}; observed ${candidate.quota.observed_at})`;
  return candidate.quota.windows.map((item) => `${item.label} remaining ${item.remaining_percent.toFixed(2)}%${item.resets_at ? ` reset ${item.resets_at}` : ""}`).join("; ");
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

function numericDataText(value: Record<string, number | null>): string {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([key, item]) => `${key}=${metric(item)}`).join("; ") : "none";
}

function printCandidateTable(stdout: WritableLike, unit: SelectionProposal["units"][number]): void {
  stdout.write("  candidates:\n\n");
  stdout.write(tableRow(["Candidate", "Preferred", "Provider", "Evidence", "Task score", "AA I/C/A", "Cost/task", "Tok/s", "TTFA (s)", "Strengths", "Callability"]));
  stdout.write(tableRow(["---", "---", "---", "---", "---:", "---", "---:", "---:", "---:", "---", "---"]));
  for (const candidate of unit.candidates.filter((item) => item.selectable)) {
    const aa = candidate.aa_scores;
    stdout.write(tableRow([
      candidate.model_id,
      candidate.model_id === unit.recommended_model_id ? "yes" : "",
      candidate.provider || "unknown",
      evidenceText(candidate),
      candidate.task_score ?? "unranked",
      `${metric(aa.intelligence)}/${metric(aa.coding)}/${metric(aa.agentic)}`,
      metric(aa.cost_per_task),
      metric(aa.output_tokens_per_second),
      metric(aa.time_to_first_answer_seconds),
      candidate.strengths,
      `${candidate.host.code}: ${candidate.host.reason}`,
    ]));
  }
}

function printPartialAaTable(stdout: WritableLike, proposal: SelectionProposal): void {
  const partial = new Map<string, SelectionCandidate>();
  for (const unit of proposal.units) {
    for (const candidate of unit.candidates) {
      if (candidate.reference_only && !candidate.ranked && candidate.aa_data && !partial.has(candidate.model_id)) {
        partial.set(candidate.model_id, candidate);
      }
    }
  }
  if (!partial.size) return;
  stdout.write("\nAA partial data (reference only; no aggregate task score):\n\n");
  stdout.write(tableRow(["Candidate", "Evaluations", "Pricing", "Performance", "Cost"]));
  stdout.write(tableRow(["---", "---", "---", "---", "---"]));
  for (const candidate of partial.values()) {
    const aa = candidate.aa_data!;
    stdout.write(tableRow([
      candidate.model_id,
      numericDataText(aa.evaluations),
      numericDataText(aa.pricing),
      numericDataText(aa.performance),
      numericDataText(aa.cost),
    ]));
  }
}

function printQuotaTable(stdout: WritableLike, proposal: SelectionProposal): void {
  const providers = new Map<string, SelectionCandidate>();
  for (const unit of proposal.units) {
    for (const candidate of unit.candidates) {
      const provider = candidate.provider || "unknown";
      if (!providers.has(provider)) providers.set(provider, candidate);
    }
  }
  stdout.write("\nprovider quota (applies to every candidate with that provider):\n\n");
  stdout.write(tableRow(["Provider", "Status", "Source", "Remaining/reset or unknown reason", "Observed at"]));
  stdout.write(tableRow(["---", "---", "---", "---", "---"]));
  for (const [provider, candidate] of [...providers].sort(([a], [b]) => a.localeCompare(b))) {
    stdout.write(tableRow([
      provider,
      candidate.quota.status,
      candidate.quota.source || "unknown",
      quotaText(candidate),
      candidate.quota.observed_at,
    ]));
  }
}

export function printSelectionProposal(stdout: WritableLike, proposal: SelectionProposal): void {
  stdout.write(`model selection proposal ${proposal.id} [confirmation required]\n`);
  stdout.write(`  host snapshot: ${proposal.host_snapshot_id}\n`);
  stdout.write(`  model policy: ${proposal.model_policy_id || "legacy/stale"}\n`);
  for (const unit of proposal.units) {
    stdout.write(`\n${unit.key}: ${unit.description}\n`);
    if (unit.director_local) {
      stdout.write("  director-local: no model selection\n");
      continue;
    }
    stdout.write(`  preferred: ${unit.recommended_model_id || "none"} (${unit.recommendation_reason})\n`);
    if (unit.requested_model_id) stdout.write(`  user requested: ${unit.requested_model_id}\n`);
    printCandidateTable(stdout, unit);
  }
  printPartialAaTable(stdout, proposal);
  printQuotaTable(stdout, proposal);
  if (proposal.policy_exclusions?.length) {
    stdout.write("\nforbidden from subagent candidates by built-in policy:\n\n");
    stdout.write(tableRow(["Family", "Routes", "Code", "Cards/profiles"]));
    stdout.write(tableRow(["---", "---", "---", "---:"]));
    for (const item of proposal.policy_exclusions) {
      const routes = item.routes.length ? item.routes.join(", ") : "no currently catalogued route";
      stdout.write(tableRow([item.family, routes, item.code, item.card_count]));
    }
  }
  if (proposal.unavailable_by_provider.length) {
    stdout.write("\nvisible in OpenCodex but unavailable to this Codex host:\n\n");
    stdout.write(tableRow(["Provider", "Routes", "Code", "Cards/profiles"]));
    stdout.write(tableRow(["---", "---", "---", "---:"]));
    for (const item of proposal.unavailable_by_provider) stdout.write(tableRow([item.provider, item.routes.join(", "), item.code, item.card_count]));
  }
  stdout.write(`\nNo ticket exists yet. Approve unchanged: baton selection approve ${proposal.id} --confirm\n`);
  stdout.write(`Change a standalone choice with --model ID, or an OpenSpec choice with repeated --route TASK=ID.\n`);
}
