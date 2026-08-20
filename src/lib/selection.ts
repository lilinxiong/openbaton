import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scoreCard } from "./cards.js";
import {
  hostRouteAvailability,
  quotaForProvider,
  readHostCapabilitySnapshot,
  type HostCapabilitySnapshot,
  type HostRouteAvailability,
  type ProviderQuotaDisclosure,
} from "./host-capabilities.js";
import { selectionsDir } from "./paths.js";
import {
  SUBAGENT_MODEL_POLICY_ID,
  assertSubagentModelAllowed,
  isSubagentModelAllowed,
  summarizeSubagentModelPolicyExclusions,
  type SubagentModelPolicyExclusion,
} from "./model-policy.js";
import type { CardCapabilityEvidence, ModelCard, UnknownRecord } from "../types.js";

export type SelectionProposalStatus = "pending_confirmation" | "approved";

export interface SelectionCandidate {
  model_id: string;
  route_id: string;
  reasoning_effort: string | null;
  provider: string | null;
  selectable: boolean;
  automatic_eligible: boolean;
  ranked: boolean;
  task_score: number | null;
  strengths: string;
  positioning: string[];
  aa_scores: {
    intelligence: number | null;
    coding: number | null;
    agentic: number | null;
    cost_per_task: number | null;
    output_tokens_per_second: number | null;
    time_to_first_answer_seconds: number | null;
  };
  quota: ProviderQuotaDisclosure;
  host: HostRouteAvailability;
}

export interface SelectionUnit {
  key: string;
  description: string;
  prompt: string;
  director_local: boolean;
  recommended_model_id: string | null;
  requested_model_id: string | null;
  default_model_id: string | null;
  recommendation_reason: "UNIQUE_HIGHEST_TASK_SCORE" | "AMBIGUOUS_TOP_SCORE" | "NO_POSITIVE_TASK_SCORE" | "NO_SELECTABLE_RANKED_CANDIDATE" | "DIRECTOR_LOCAL";
  requires_manual_choice: boolean;
  candidates: SelectionCandidate[];
  policy_exclusions: SubagentModelPolicyExclusion[];
  metadata: UnknownRecord;
}

export interface SelectionProposal {
  schema_version: 1;
  id: string;
  status: SelectionProposalStatus;
  source: "standalone" | "openspec";
  created_at: string;
  approved_at: string | null;
  host_snapshot_id: string;
  catalog_fingerprint: string;
  source_fingerprint: string;
  model_policy_id: string;
  units: SelectionUnit[];
  policy_exclusions: SubagentModelPolicyExclusion[];
  unavailable_by_provider: Array<{ provider: string; card_count: number; routes: string[]; code: string }>;
  payload: UnknownRecord;
  approvals: Array<{
    key: string;
    approval_id: string;
    recommended_model_id: string | null;
    selected_model_id: string;
    changed_by_user: boolean;
  }>;
  history: Array<{ event: "pending_confirmation" | "approved"; at: string }>;
}

function evidenceScores(capability?: CardCapabilityEvidence) {
  return {
    intelligence: capability?.intelligence_index ?? null,
    coding: capability?.coding_index ?? null,
    agentic: capability?.agentic_index ?? null,
    cost_per_task: capability?.cost_per_task ?? null,
    output_tokens_per_second: capability?.output_tokens_per_second ?? null,
    time_to_first_answer_seconds: capability?.time_to_first_answer_seconds ?? null,
  };
}

function candidateFor(
  cwd: string,
  prompt: string,
  card: ModelCard,
  host: HostCapabilitySnapshot,
  automaticIds: Set<string>,
): SelectionCandidate | null {
  if (!card.route_id || card.executable === false) return null;
  const availability = hostRouteAvailability(cwd, card, host);
  const ranked = card.capability?.ranked === true;
  return {
    model_id: card.id,
    route_id: card.route_id,
    reasoning_effort: card.reasoning_effort || null,
    provider: card.provider || null,
    selectable: availability.available,
    automatic_eligible: availability.available && ranked && automaticIds.has(card.id),
    ranked,
    task_score: ranked ? scoreCard(prompt, card) : null,
    strengths: card.strengths,
    positioning: card.positioning || [],
    aa_scores: evidenceScores(card.capability),
    quota: quotaForProvider(host, card.provider),
    host: availability,
  };
}

export function buildSelectionUnit({
  cwd,
  key,
  description,
  prompt,
  cards,
  automaticCards,
  host,
  requestedModelId = null,
  directorLocal = false,
  metadata = {},
}: {
  cwd: string;
  key: string;
  description: string;
  prompt: string;
  cards: ModelCard[];
  automaticCards?: ModelCard[];
  host: HostCapabilitySnapshot;
  requestedModelId?: string | null;
  directorLocal?: boolean;
  metadata?: UnknownRecord;
}): SelectionUnit {
  if (directorLocal) {
    return {
      key, description, prompt, director_local: true,
      recommended_model_id: null, requested_model_id: null, default_model_id: null,
      recommendation_reason: "DIRECTOR_LOCAL", requires_manual_choice: false, candidates: [], policy_exclusions: [], metadata,
    };
  }
  const policyExclusions = summarizeSubagentModelPolicyExclusions(cards);
  const eligibleCards = cards.filter(isSubagentModelAllowed);
  const automaticIds = new Set((automaticCards || cards).filter(isSubagentModelAllowed).map((card) => card.id));
  const candidates = eligibleCards
    .map((card) => candidateFor(cwd, prompt, card, host, automaticIds))
    .filter((item): item is SelectionCandidate => item !== null)
    .sort((a, b) => Number(b.selectable) - Number(a.selectable)
      || Number(b.automatic_eligible) - Number(a.automatic_eligible)
      || (b.task_score ?? -1) - (a.task_score ?? -1)
      || a.model_id.localeCompare(b.model_id));
  const ranked = candidates.filter((item) => item.automatic_eligible && (item.task_score || 0) > 0);
  const topScore = ranked[0]?.task_score ?? null;
  const top = topScore == null ? [] : ranked.filter((item) => item.task_score === topScore);
  const recommended = top.length === 1 ? top[0].model_id : null;
  let reason: SelectionUnit["recommendation_reason"];
  if (!ranked.length) reason = candidates.some((item) => item.selectable && item.ranked)
    ? "NO_POSITIVE_TASK_SCORE"
    : "NO_SELECTABLE_RANKED_CANDIDATE";
  else if (top.length > 1) reason = "AMBIGUOUS_TOP_SCORE";
  else reason = "UNIQUE_HIGHEST_TASK_SCORE";

  if (requestedModelId) {
    assertSubagentModelAllowed(requestedModelId, requestedModelId);
    const requested = candidates.find((item) => item.model_id === requestedModelId);
    if (!requested) throw new Error(`requested model is not an exact route/profile id in this proposal: ${requestedModelId}`);
    if (!requested.selectable) throw new Error(`${requestedModelId}: ${requested.host.code}: ${requested.host.reason}`);
  }
  const defaultModel = requestedModelId || recommended;
  return {
    key,
    description,
    prompt,
    director_local: false,
    recommended_model_id: recommended,
    requested_model_id: requestedModelId,
    default_model_id: defaultModel,
    recommendation_reason: reason,
    requires_manual_choice: defaultModel == null,
    candidates,
    policy_exclusions: policyExclusions,
    metadata,
  };
}

function policyExclusionSummary(units: SelectionUnit[]): SubagentModelPolicyExclusion[] {
  const groups = new Map<string, SubagentModelPolicyExclusion>();
  for (const unit of units) {
    for (const exclusion of unit.policy_exclusions || []) {
      const current = groups.get(exclusion.family);
      if (!current) {
        groups.set(exclusion.family, structuredClone(exclusion));
        continue;
      }
      current.card_count = Math.max(current.card_count, exclusion.card_count);
      current.routes = [...new Set([...current.routes, ...exclusion.routes])].sort();
    }
  }
  return [...groups.values()].sort((a, b) => a.family.localeCompare(b.family));
}

function nextProposalId(cwd: string): string {
  const dir = selectionsDir(cwd);
  if (!fs.existsSync(dir)) return "sel-0001";
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^sel-(\d+)\.json$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `sel-${String(max + 1).padStart(4, "0")}`;
}

function unavailableSummary(units: SelectionUnit[]): SelectionProposal["unavailable_by_provider"] {
  const groups = new Map<string, { cards: Set<string>; routes: Set<string>; codes: Set<string> }>();
  for (const unit of units) {
    for (const candidate of unit.candidates) {
      if (candidate.selectable || candidate.host.code === "NO_EXECUTABLE_ROUTE") continue;
      const provider = candidate.provider || "unknown";
      const group = groups.get(provider) || { cards: new Set(), routes: new Set(), codes: new Set() };
      group.cards.add(candidate.model_id);
      group.routes.add(candidate.route_id);
      group.codes.add(candidate.host.code);
      groups.set(provider, group);
    }
  }
  return [...groups.entries()].map(([provider, group]) => ({
    provider,
    card_count: group.cards.size,
    routes: [...group.routes].sort(),
    code: [...group.codes].sort().join(","),
  })).sort((a, b) => a.provider.localeCompare(b.provider));
}

export function createSelectionProposal(cwd: string, {
  source,
  units,
  sourceFingerprint,
  payload = {},
  now = new Date(),
}: {
  source: SelectionProposal["source"];
  units: SelectionUnit[];
  sourceFingerprint: string;
  payload?: UnknownRecord;
  now?: Date | string | number;
}): SelectionProposal {
  const host = readHostCapabilitySnapshot(cwd);
  if (!host) throw new Error("HOST_CAPABILITIES_REQUIRED: run baton host sync from the current Codex session before model selection");
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const proposal: SelectionProposal = {
    schema_version: 1,
    id: nextProposalId(cwd),
    status: "pending_confirmation",
    source,
    created_at: createdAt,
    approved_at: null,
    host_snapshot_id: host.id,
    catalog_fingerprint: host.catalog_fingerprint,
    source_fingerprint: sourceFingerprint,
    model_policy_id: SUBAGENT_MODEL_POLICY_ID,
    units,
    policy_exclusions: policyExclusionSummary(units),
    unavailable_by_provider: unavailableSummary(units),
    payload,
    approvals: [],
    history: [{ event: "pending_confirmation", at: createdAt }],
  };
  writeSelectionProposal(cwd, proposal);
  return proposal;
}

export function selectionSourceFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function writeSelectionProposal(cwd: string, proposal: SelectionProposal): SelectionProposal {
  const dir = selectionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${proposal.id}.json`);
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return proposal;
}

export function readSelectionProposal(cwd: string, id: string): SelectionProposal {
  const file = path.join(selectionsDir(cwd), `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`selection proposal not found: ${id}`);
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as SelectionProposal;
  if (value.schema_version !== 1) throw new Error(`unsupported selection proposal schema: ${value.schema_version}`);
  return value;
}

export function listSelectionProposals(cwd: string): SelectionProposal[] {
  const dir = selectionsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^sel-\d+\.json$/.test(name))
    .map((name) => readSelectionProposal(cwd, name.slice(0, -5)))
    .sort((a, b) => a.id.localeCompare(b.id));
}
