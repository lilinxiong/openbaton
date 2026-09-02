import { execFileSync } from "node:child_process";
import { canonicalWorkspaceRoot } from "../paths.js";
import { cliProfileForHost, loadConfig } from "../config.js";
import { profileForClassification, type OpsProfileId } from "./config.js";
import {
  isCommitOnlyClassification,
  normalizeAgentTaskClassification,
  type AgentExecutionClass,
  type NormalizedAgentTaskClassification,
} from "./task.js";
import { findOpsRouteChoice, listOpsRouteChoices } from "./routes.js";
import { readRouteSnapshot } from "../routes.js";
import { buildCommitReceipt } from "../receipt.js";
import { captureCommitBaseline, captureCommitBaselineAsync, type AsyncSafetyOptions, type CommitBaseline } from "../safety.js";
import type { StandalonePlan } from "../spawn.js";
import type { ModelCard, ModelSelectionApproval } from "../../types.js";
import type { HostId } from "../hosts.js";

export type OpsResolution =
  | { kind: "not-ops" }
  | { kind: "director"; operation?: string | null; classification?: AgentExecutionClass; reason: string }
  | { kind: "blocked"; operation?: string | null; classification?: AgentExecutionClass; reason: string }
  | { kind: "empty-index"; operation?: string | null; classification?: AgentExecutionClass }
  | {
    kind: "dispatch";
    operation?: string | null;
    classification?: AgentExecutionClass;
    commit_only?: boolean;
    profile: OpsProfileId;
    route: string;
    card: ModelCard;
    approval: ModelSelectionApproval;
  };

export interface OpsDispatchOptions {
  env?: NodeJS.ProcessEnv;
  host?: HostId;
  /** Structured contract supplied by the director. */
  classification?: unknown;
  /** Operation is audit metadata and never a routing key. */
  operation?: unknown;
  /** Optional classification override for one declared multi-unit item. */
  unitClassification?: unknown;
}

function suppliedClassification(options: OpsDispatchOptions): { present: boolean; value: unknown } {
  return Object.hasOwn(options, "classification")
    ? { present: true, value: options.classification }
    : { present: false, value: undefined };
}

function classificationRequiredForHost(host: HostId | undefined): boolean {
  return Boolean(host);
}

export function hasStagedDiff(cwd: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: canonicalWorkspaceRoot(cwd),
      stdio: "ignore",
    });
    return false;
  } catch (error) {
    return (error as { status?: number }).status === 1;
  }
}

function cardForRoute(cards: ModelCard[], routeId: string, cwd: string, host?: HostId, env?: NodeJS.ProcessEnv): ModelCard | null {
  const snapshot = readRouteSnapshot(cwd, { host, env });
  const route = snapshot?.routes.find((item) => item.route_id === routeId);
  const preferred = route?.default_reasoning_effort;
  const effort = preferred && route?.reasoning_efforts.includes(preferred) ? preferred : route?.reasoning_efforts[0];
  return (effort && cards.find((card) => card.route_id === routeId && card.reasoning_effort === effort))
    || cards.find((card) => card.route_id === routeId && !card.reasoning_effort)
    || cards.find((card) => card.route_id === routeId)
    || null;
}

export function resolveOpsDispatch(
  cwd: string,
  description: unknown,
  cards: ModelCard[],
  options: OpsDispatchOptions = {},
): OpsResolution {
  const { env, host } = options;
  const supplied = suppliedClassification(options);
  if (supplied.present || options.operation !== undefined) {
    const classification = structuredClassification(supplied.value, options.operation);
    return classification
      ? resolveOpsClassificationDispatch(cwd, classification, cards, { env, host })
      : {
        kind: "blocked",
        reason: "director classification is missing or malformed; no ticket may be created",
      };
  }
  // A free-form request has no routing authority. The director must supply a
  // structured class.
  void description;
  void cards;
  if (classificationRequiredForHost(host)) {
    return { kind: "blocked", reason: "director classification is required; no ticket may be created" };
  }
  return { kind: "not-ops" };
}

export function resolveOpsUnitDispatch(
  cwd: string,
  requestDescription: unknown,
  unitDescription: unknown,
  cards: ModelCard[],
  options: OpsDispatchOptions = {},
): OpsResolution {
  const { env, host } = options;
  const supplied = suppliedClassification(options);
  const hasStructured = supplied.present || options.operation !== undefined || options.unitClassification !== undefined;
  if (hasStructured) {
    const request = supplied.present ? structuredClassification(supplied.value, options.operation) : null;
    const unit = options.unitClassification === undefined
      ? null
      : structuredClassification(options.unitClassification, options.operation);
    if (options.unitClassification !== undefined && !unit) {
      return { kind: "blocked", reason: "unit classification is missing or malformed; no ticket may be created" };
    }
    if (request && unit && request.kind !== unit.kind) {
      return { kind: "blocked", reason: `request/unit classification conflict: ${request.kind} != ${unit.kind}` };
    }
    const classification = unit || request;
    return classification
      ? resolveOpsClassificationDispatch(cwd, classification, cards, { env, host })
      : { kind: "blocked", reason: "director classification is missing or malformed; no ticket may be created" };
  }
  // A free-form request has no routing authority. The director must supply a
  // structured class.
  void requestDescription;
  void unitDescription;
  void cards;
  if (classificationRequiredForHost(host)) {
    return { kind: "blocked", reason: "director classification is required; no ticket may be created" };
  }
  return { kind: "not-ops" };
}

function structuredClassification(value: unknown, operation: unknown): NormalizedAgentTaskClassification | null {
  if (value === undefined || value === null) return null;
  if (operation === undefined) return normalizeAgentTaskClassification(value);
  if (typeof value === "string") return normalizeAgentTaskClassification({ kind: value, operation });
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeAgentTaskClassification({ ...(value as Record<string, unknown>), operation });
  }
  return null;
}

function safeApprovalPart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "operation";
}

/** Route an agent-supplied class directly to its configured profile. */
export function resolveOpsClassificationDispatch(
  cwd: string,
  classification: NormalizedAgentTaskClassification | unknown,
  cards: ModelCard[],
  { env, host }: { env?: NodeJS.ProcessEnv; host?: HostId } = {},
): OpsResolution {
  const normalized = normalizeAgentTaskClassification(classification);
  if (!normalized || normalized.kind === "general") return { kind: "not-ops" };
  const operation = normalized.operation;
  const commitOnly = isCommitOnlyClassification(normalized);
  // Commit-only is a mechanical capability. Never let a contradictory
  // long-context label move an audited Git commit onto the longctx route.
  if (commitOnly && normalized.kind !== "mechanical") {
    return {
      kind: "blocked",
      ...(operation !== null ? { operation } : {}),
      classification: normalized.kind,
      reason: "commit-only capability conflicts with a non-mechanical classification",
    };
  }
  const profile = profileForClassification(normalized.kind);
  if (!profile) return { kind: "not-ops" };
  const routed = resolveOpsProfileDispatch(cwd, {
    operation,
    classification: normalized.kind,
    commitOnly,
  }, cards, { env, host });
  // Resolve and validate the configured runner before the empty-index
  // shortcut. A missing/unusable route must block even when there is no staged
  // work to commit.
  if (commitOnly && routed.kind === "dispatch" && !hasStagedDiff(cwd)) {
    return {
      kind: "empty-index",
      ...(operation !== null ? { operation } : {}),
      classification: normalized.kind,
    };
  }
  return routed;
}

interface OpsProfileDispatchInput {
  operation: string | null;
  classification: AgentExecutionClass;
  commitOnly: boolean;
}

function resolveOpsProfileDispatch(
  cwd: string,
  input: OpsProfileDispatchInput,
  cards: ModelCard[],
  { env, host }: { env?: NodeJS.ProcessEnv; host?: HostId } = {},
): OpsResolution {
  const config = loadConfig(cwd, { env });
  const profile = cliProfileForHost(config, host);
  const route = profile[input.classification === "mechanical" ? "runner" : "longctx"].trim();
  const configured = route
    ? { profile: input.classification === "mechanical" ? "runner" as const : "longctx" as const, route }
    : null;
  if (!configured) {
    return {
      kind: "blocked",
      ...(input.operation !== null ? { operation: input.operation } : {}),
      classification: input.classification,
      reason: `ops ${input.classification === "long-context" ? "longctx" : "runner"} route is empty; classified work is not executable on the director`,
    };
  }
  const choices = listOpsRouteChoices(cwd, configured.profile, cards, { env, host });
  if (!findOpsRouteChoice(choices, configured.route)) {
    return {
      kind: "blocked",
      ...(input.operation !== null ? { operation: input.operation } : {}),
      classification: input.classification,
      reason: `ops ${configured.profile} model is unset or unusable; classified work is not executable on the director`,
    };
  }
  const card = cardForRoute(cards, configured.route, cwd, host, env);
  if (!card?.route_id) {
    return {
      kind: "blocked",
      ...(input.operation !== null ? { operation: input.operation } : {}),
      classification: input.classification,
      reason: `ops ${configured.profile} model is unset or unusable; classified work is not executable on the director`,
    };
  }
  const approval: ModelSelectionApproval = {
    host,
    proposal_id: "ops-config",
    approval_id: `ops-${configured.profile}-${safeApprovalPart(input.operation || input.classification)}`,
    approved_at: new Date().toISOString(),
    confirmed_by: "ops-config",
    catalog_fingerprint: readRouteSnapshot(cwd, { host, env })?.fingerprint || "",
    recommended_model_id: card.id,
    selected_model_id: card.id,
    changed_by_user: false,
    ops_profile: configured.profile,
    ...(input.operation !== null ? { ops_operation: input.operation } : {}),
  };
  return {
    kind: "dispatch",
    ...(input.operation !== null ? { operation: input.operation } : {}),
    ...(input.classification ? { classification: input.classification } : {}),
    ...(input.commitOnly ? { commit_only: true } : {}),
    profile: configured.profile,
    route: configured.route,
    card,
    approval,
  };
}

export function applyCommitBaselineToPlan(planned: StandalonePlan, baseline: CommitBaseline): StandalonePlan {
  if (planned.director_local === true) throw new Error("commit-only ops dispatch unexpectedly stayed on the director");
  planned.ticket.mode = "commit-only";
  planned.ticket.read_only = false;
  planned.ticket.prompt = [
    planned.ticket.prompt,
    "",
    "[Baton commit-only authorization]",
    "The director already staged the complete authorized change set.",
    `expected parent HEAD: ${baseline.head}`,
    `expected staged tree: ${baseline.staged_tree}`,
    "authorized staged paths:",
    ...baseline.staged_paths.map((item) => `- ${JSON.stringify(item)}`),
    "Inspect only read-only Git evidence such as status, diff --cached, and log; choose one concise repository-style message; then run exactly one git commit.",
    "Do not edit files or alter the index before committing. Do not use git add, commit -a/--all, --amend, --only, --include, or a pathspec.",
    "Do not run reset, restore, checkout, switch, branch, merge, rebase, cherry-pick, revert, tag, stash, clean, or push.",
    "Return only the commit id, subject, and concise verification evidence.",
  ].join("\n");
  planned.receipt = buildCommitReceipt({ base: planned.receipt, baseline });
  planned.ticket.receipt_id = planned.receipt.receipt_id;
  return planned;
}

export function authorizeCommitOpsPlan(cwd: string, planned: StandalonePlan): StandalonePlan {
  return applyCommitBaselineToPlan(planned, captureCommitBaseline(cwd));
}

/** Promise-based commit authorization. Baseline capture is stable and fully
 * drained before the plan can reach Receipt/spawn materialization. */
export async function authorizeCommitOpsPlanAsync(
  cwd: string,
  planned: StandalonePlan,
  options: AsyncSafetyOptions = {},
): Promise<StandalonePlan> {
  if (planned.director_local === true) throw new Error("commit-only ops dispatch unexpectedly stayed on the director");
  return applyCommitBaselineToPlan(planned, await captureCommitBaselineAsync(cwd, new Date(), options));
}
