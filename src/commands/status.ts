import {
  CodedError,
  WritableLike
} from "../types.js";
import {
  parseFlags,
  validateCommandArgs
} from "../cli-flags.js";
import {
  listSpawns,
  sessionUid
} from "../lib/spawn-store.js";
import { readRouteSnapshot } from "../lib/routes.js";
import { listSelectionProposals } from "../lib/selection-proposals.js";
import { availabilityForRoute } from "../lib/model-availability.js";
import { readOpenSpecStatus } from "../lib/openspec.js";
import { SelectionProposal } from "../lib/selection.js";
import { SelectionApprovalOutput } from "./selection.js";
import {
  formatExecutionHandle,
  resolvedCards,
  runtimeHost
} from "../cli.js";
import {
  dispatchCompatibilityBlockers,
  dispatchWorkspaceCapacitySnapshots,
  reserveNext
} from "../lib/dispatch.js";
import {
  cliProfileForHost,
  effectiveMaxDepthForHost,
  loadConfig
} from "../lib/config.js";
/**
 * `baton status` command and the automatic-recommendation printer. Split
 * from cli.ts.
 */

export function cmdStatus(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  validateCommandArgs(args, { value: ["host"], boolean: ["json"], positional: "none" });
  sessionUid(env);
  const flags = parseFlags(args);
  let cfg = null;
  try {
    cfg = loadConfig(cwd, { env });
  } catch (cause: unknown) {
    const err = cause instanceof Error ? cause as CodedError : new Error(String(cause)) as CodedError;
    if (err.code === "BATON_NOT_INITIALIZED") {
      stdout.write("baton is not initialized. Run: baton init\n");
      return 2;
    }
    throw err;
  }
  const host = runtimeHost(flags, cwd, env);
  const cards = resolvedCards(cwd, env, host);
  const executableCards = cards.filter((card) => card.executable).length;
  const cliProfile = cliProfileForHost(cfg, host);
  const snapshot = readRouteSnapshot(cwd, { host, env });
  const executableRoutes = snapshot?.routes.filter((route) => !route.disabled).length || 0;
  const selections = listSelectionProposals(cwd, env).filter((item) => !item.host || item.host === host);
  // General status keeps the complete workspace ticket inventory. Capacity
  // itself is reported separately below, grouped by (host, session_uid).
  const spawns = listSpawns(cwd, env);
  const capacityTrees = dispatchWorkspaceCapacitySnapshots(cwd, { env });
  const compatibilityBlockers = dispatchCompatibilityBlockers(cwd, env);
  const running = spawns.filter((s) => s.status === "running").length;
  const queued = spawns.filter((s) => s.status === "queued").length;
  const dispatching = spawns.filter((s) => s.status === "dispatching").length;
  const terminal = spawns.filter((s) => ["completed", "errored", "timed_out", "closed", "done"].includes(s.status)).length;
  const configuredDispatchRoutes = [...new Set([...
    cliProfile.coding_models,
    cliProfile.runner,
    cliProfile.longctx,
  ].filter(Boolean))];
  const availableDispatchRoutes = configuredDispatchRoutes.filter((routeId) =>
    snapshot?.routes.some((route) => route.route_id === routeId && !route.disabled));
  const coreDispatchReady = Boolean(snapshot && availableDispatchRoutes.length > 0);
  const coreDispatchReason = !snapshot
    ? "ROUTE_SNAPSHOT_MISSING"
    : !availableDispatchRoutes.length ? "CONFIGURED_ROUTES_UNAVAILABLE" : "READY";
  const codingAvailability = cliProfile.coding_models.map((routeId) => {
    const state = availabilityForRoute(cwd, { host, routeId }, new Date(), env);
    const catalogRoute = snapshot?.routes.find((route) => route.route_id === routeId);
    const eligibility = !snapshot
      ? { eligible: false, code: "ROUTE_SNAPSHOT_MISSING", reason: "run baton config to capture the active CLI model catalog" }
      : !catalogRoute
        ? { eligible: false, code: "ROUTE_NOT_IN_ACTIVE_CATALOG", reason: "route is not present in the captured active CLI model catalog" }
        : catalogRoute.disabled
          ? { eligible: false, code: "ROUTE_DISABLED", reason: "route is disabled in the captured active CLI model catalog" }
          : state.status === "exhausted"
            ? { eligible: false, code: "DURABLE_QUOTA_EXHAUSTED", reason: state.reason || "quota is durably exhausted" }
            : state.status === "probe_due"
              ? {
                eligible: false,
                code: state.probe_available ? "PROBE_DUE" : "PROBE_LEASE_HELD",
                reason: state.probe_available
                  ? "route is recoverable by one dispatch-side probe lease"
                  : "route is waiting for the current probe lease to complete or expire",
              }
              : { eligible: true, code: "AVAILABLE", reason: "route is present, enabled, and not durably exhausted" };
    return {
      route_id: routeId,
      availability_scope: "host-profile",
      eligible: eligibility.eligible,
      eligibility_code: eligibility.code,
      eligibility_reason: eligibility.reason,
      status: state.status,
      reason: state.reason,
      next_probe_at: state.next_probe_at,
      probe_available: state.probe_available,
    };
  });
  const codingDispatchReady = codingAvailability.some((route) => route.eligible);
  const codingDispatchReason = codingDispatchReady ? "READY" : "CODING_MODELS_EXHAUSTED";
  const spawnOutput = spawns.map((s) => ({
    id: s.id,
    status: s.status,
    model_id: s.model_id,
    execution_handle: s.execution_handle ? formatExecutionHandle(s.execution_handle) : null,
  }));
  if (flags.json) {
    stdout.write(`${JSON.stringify({
      host,
      core_dispatch_ready: coreDispatchReady,
      core_dispatch_reason: coreDispatchReason,
      coding_dispatch_ready: codingDispatchReady,
      coding_dispatch_reason: codingDispatchReason,
      coding_models: codingAvailability,
      cards: { total: cards.length, executable: executableCards },
      max_depth: effectiveMaxDepthForHost(cfg, host),
      capacity_trees: capacityTrees,
      compatibility_blockers: compatibilityBlockers,
      cli_models: { executable: executableRoutes, snapshot: snapshot?.fingerprint || null },
      selections: {
        total: selections.length,
        pending: selections.filter((item) => item.status === "pending_confirmation").length,
        approved: selections.filter((item) => item.status === "approved").length,
      },
      spawns: { total: spawns.length, dispatching, running, queued, terminal, tickets: spawnOutput },
      openspec: readOpenSpecStatus(cwd),
    }, null, 2)}\n`);
    return 0;
  }
  stdout.write("baton status\n");
  stdout.write(`  core dispatch: ${coreDispatchReady ? "ready" : "not-ready"} (${coreDispatchReason})\n`);
  stdout.write(`  Coding priority: ${cliProfile.coding_models.length ? cliProfile.coding_models.join(" > ") : "(none)"} (${codingDispatchReason})\n`);
  for (const route of codingAvailability) stdout.write(`    ${route.route_id}: ${route.status}; ${route.eligibility_code} (${route.eligibility_reason})${route.next_probe_at ? `; probe ${route.next_probe_at}` : ""}\n`);
  stdout.write(`  cards: ${cards.length} configured CLI model/effort candidates (${executableCards} executable)\n`);
  stdout.write("  model selection: automatic (no runtime confirmation UI)\n");
  stdout.write(`  cli: ${host}\n`);
  stdout.write(`  max_depth: ${effectiveMaxDepthForHost(cfg, host)}\n`);
  stdout.write("  capacity trees:\n");
  stdout.write("    scope: per host + session_uid; root excluded; descendants share one pool\n");
  for (const tree of capacityTrees) {
    const sources = tree.capacity_sources.length
      ? tree.capacity_sources.map((source) => `${source.kind}=${source.value}${source.applied ? "*" : ""}`).join(",")
      : "unknown";
    stdout.write(`    ${tree.host} session=${tree.session_uid} capacity=${tree.capacity ?? "unknown"} active=${tree.active} available=${tree.available ?? "unknown"} sources=${sources}\n`);
  }
  if (compatibilityBlockers.length) {
    stdout.write("  compatibility blockers:\n");
    for (const blocker of compatibilityBlockers) {
      stdout.write(`    ${blocker.code} ${blocker.ticket_id || blocker.file} status=${blocker.status || "unknown"}: ${blocker.reason}\n`);
    }
  }
  stdout.write(`  CLI models: ${executableRoutes}${snapshot ? ` snapshot=${snapshot.fingerprint}` : " (run baton config)"}\n`);
  stdout.write(`  selections: ${selections.length}  pending ${selections.filter((item) => item.status === "pending_confirmation").length}  approved ${selections.filter((item) => item.status === "approved").length}\n`);
  stdout.write(`  spawns: ${spawns.length}  dispatching ${dispatching}  running ${running}  queued ${queued}  terminal ${terminal}\n`);
  for (const s of spawns) {
    const extra = s.conclusion ? ` → ${s.conclusion}` : s.progress ? ` → ${s.progress.phase}: ${s.progress.summary}` : "";
    const kind = s.work_unit?.kind ? ` ${s.work_unit.kind}` : "";
    const handle = s.execution_handle ? ` execution_handle=${formatExecutionHandle(s.execution_handle)}` : "";
    stdout.write(`    ${s.id}  ${s.status}${kind}  ${s.model_id || "director"}${handle}  ${s.description}${extra}\n`);
  }
  const os = readOpenSpecStatus(cwd);
  stdout.write(`  openspec (${os.source}): ${os.text}\n`);
  return 0;
}


export function printAutomaticRecommendation(stdout: WritableLike, proposal: SelectionProposal, output: SelectionApprovalOutput): void {
  stdout.write(`auto-approved ${proposal.id} by Baton recommendation\n`);
  for (const unit of proposal.units) {
    if (unit.director_local) {
      stdout.write(`  ${unit.key}: director-local\n`);
      continue;
    }
    const selected = output.approvals.find((approval) => approval.key === unit.key)?.selected_model_id || unit.recommended_model_id;
    const candidate = unit.candidates.find((item) => item.model_id === selected);
    const speed = candidate?.speed_optimized
      ? `; fast=${candidate.service_tier || "model"} via ${candidate.speed_signals.join("+")}`
      : "";
    stdout.write(`  ${unit.key}: ${selected} (score=${candidate?.task_score ?? "none"}; effort=${unit.target_reasoning_effort}; context=${unit.estimated_context_tokens}${speed})\n`);
  }
  for (const ticket of output.tickets) stdout.write(`  ticket ${ticket.id} queued; dispatch remains host-owned\n`);
}

