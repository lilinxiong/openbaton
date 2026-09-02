/**
 * Selection proposal persistence. Split from selection.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, sha256Hex, writeJsonAtomic } from "./json-utils.js";
import { selectionsDir } from "./paths.js";
import { quotaPoolForCandidate } from "./selection-candidates.js";
import { deriveMinimumModelRequirements } from "./selection-requirements.js";
import { readRouteSnapshot } from "./routes.js";
import {
  MinimumModelRequirements,
  SelectionCandidate,
  SelectionProposal,
  SelectionQuotaPool,
  SelectionUnit
} from "./selection.js";
import type { UnknownRecord } from "../types.js";
import type { TaskCapabilityExclusion } from "./task-suitability.js";

export function scopedSourceFingerprint(host: string | undefined, sourceFingerprint: string): string {
  return host ? selectionSourceFingerprint({ host, source_fingerprint: sourceFingerprint }) : sourceFingerprint;
}


export function taskExclusionSummary(units: SelectionUnit[]): TaskCapabilityExclusion[] {
  const exclusions = new Map<string, TaskCapabilityExclusion>();
  for (const unit of units) {
    for (const exclusion of unit.task_exclusions || []) exclusions.set(exclusion.model_id, exclusion);
  }
  return [...exclusions.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
}

export function proposalQuotaPools(units: SelectionUnit[]): SelectionQuotaPool[] {
  const candidates = new Map<string, SelectionCandidate>();
  for (const unit of units) {
    for (const candidate of unit.candidates) {
      if (!candidates.has(candidate.model_id)) candidates.set(candidate.model_id, candidate);
    }
  }
  return [...candidates.values()].map((candidate) => quotaPoolForCandidate(candidate)).sort((a, b) => a.id.localeCompare(b.id));
}

export function proposalMinimumRequirements(units: SelectionUnit[]): Record<string, MinimumModelRequirements> {
  const result: Record<string, MinimumModelRequirements> = {};
  for (const unit of units.slice().sort((left, right) => left.key.localeCompare(right.key))) {
    result[unit.key] = structuredClone(unit.minimum_requirements || deriveMinimumModelRequirements(unit.prompt, {
      complexity: unit.complexity_reason,
      estimated_context_tokens: unit.estimated_context_tokens,
      reasoning: unit.target_reasoning_effort,
      native_execution: !unit.director_local,
    }));
  }
  return result;
}

export function nextProposalId(cwd: string, env?: NodeJS.ProcessEnv): string {
  const dir = selectionsDir(cwd, env);
  if (!fs.existsSync(dir)) return "sel-0001";
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^sel-(\d+)\.json$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `sel-${String(max + 1).padStart(4, "0")}`;
}

export function createSelectionProposal(cwd: string, {
  host,
  source,
  units,
  sourceFingerprint,
  payload = {},
  now = new Date(),
  env,
}: {
  host?: string;
  source: SelectionProposal["source"];
  units: SelectionUnit[];
  sourceFingerprint: string;
  payload?: UnknownRecord;
  now?: Date | string | number;
  env?: NodeJS.ProcessEnv;
}): SelectionProposal {
  if (source === "standalone" && (payload.source_shape !== "multi-unit-v1" || !Array.isArray(payload.units))) {
    throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: standalone proposals must use the multi-unit shape");
  }
  const scopedHost = host || units.find((unit) => unit.host)?.host;
  const snapshot = readRouteSnapshot(cwd, { host: scopedHost, env });
  if (!snapshot) throw new Error("ROUTE_SNAPSHOT_REQUIRED: run baton config before model selection");
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const proposal: SelectionProposal = {
    schema_version: 2,
    ...(scopedHost ? { host: scopedHost } : {}),
    id: nextProposalId(cwd, env),
    status: "pending_confirmation",
    source,
    created_at: createdAt,
    approved_at: null,
    catalog_fingerprint: snapshot.fingerprint,
    source_fingerprint: scopedSourceFingerprint(scopedHost, sourceFingerprint),
    units,
    minimum_requirements: proposalMinimumRequirements(units),
    quota_pools: proposalQuotaPools(units),
    task_exclusions: taskExclusionSummary(units),
    payload,
    confirmation: null,
    approvals: [],
    history: [{ event: "pending_confirmation", at: createdAt }],
  };
  writeSelectionProposal(cwd, proposal, env);
  return proposal;
}

export function selectionSourceFingerprint(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

export function writeSelectionProposal(cwd: string, proposal: SelectionProposal, env?: NodeJS.ProcessEnv): SelectionProposal {
  const dir = selectionsDir(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${proposal.id}.json`);
  writeJsonAtomic(file, proposal);
  return proposal;
}

export function readSelectionProposal(cwd: string, id: string, env?: NodeJS.ProcessEnv): SelectionProposal {
  const file = path.join(selectionsDir(cwd, env), `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`selection proposal not found: ${id}`);
  const value = readJsonFile(file) as SelectionProposal;
  if (value.schema_version !== 2) {
    throw new Error(`SELECTION_PROPOSAL_SCHEMA_UNSUPPORTED: ${value.schema_version}; create a new proposal`);
  }
  if (value.source === "standalone" && (value.payload?.source_shape !== "multi-unit-v1" || !Array.isArray(value.payload?.units))) {
    throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: standalone proposals must use the multi-unit shape");
  }
  if (!Array.isArray(value.units) || !Array.isArray(value.quota_pools) || !Array.isArray(value.task_exclusions)) {
    throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: proposal fields are incomplete");
  }
  for (const unit of value.units) {
    if (!unit || typeof unit !== "object" || !Array.isArray(unit.candidates)) {
      throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: proposal units are incomplete");
    }
    for (const candidate of unit.candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("SELECTION_PROPOSAL_SHAPE_INVALID: proposal candidates are incomplete");
      }
      // Early schema-v2 proposals persisted the same diagnostics under the
      // compatibility aliases only. Keep those records readable while making
      // the required runtime field total for every returned candidate.
      if (!Array.isArray(candidate.diagnostics)) {
        const legacy = Array.isArray(candidate.selection_diagnostics)
          ? candidate.selection_diagnostics
          : Array.isArray(candidate.exclusion_reasons) ? candidate.exclusion_reasons : [];
        candidate.diagnostics = structuredClone(legacy);
      }
    }
  }
  // Proposals written before requirement persistence remain readable. New
  // proposals always carry a deterministic unit-keyed copy.
  if (!value.minimum_requirements || typeof value.minimum_requirements !== "object" || Array.isArray(value.minimum_requirements)) {
    value.minimum_requirements = proposalMinimumRequirements(value.units);
  }
  return value;
}

export function listSelectionProposals(cwd: string, env?: NodeJS.ProcessEnv): SelectionProposal[] {
  const dir = selectionsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^sel-\d+\.json$/.test(name))
    .map((name) => readSelectionProposal(cwd, name.slice(0, -5), env))
    .sort((a, b) => a.id.localeCompare(b.id));
}
