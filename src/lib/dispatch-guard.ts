import { SpawnTicket } from "./spawn.js";
import {
  DelegationReceipt,
  assertValidTicketReceiptLineage,
  readReceipt
} from "./receipt.js";
import { HostId } from "./hosts.js";
import { requireExactRootAdapter } from "./dispatch-exact-root.js";
import {
  DispatchError,
  ticketTargetHost,
  transition
} from "./dispatch-core.js";
import { normalizeRollingUnitLineage } from "./receipt-lineage.js";
import { AsyncSafetyOptions } from "./safety.js";
import { availabilityForRoute } from "./model-availability.js";
import { readRouteSnapshot } from "./routes.js";
import {
  compiledUnitReady,
  isCompiledApplyTicket,
  validateCompiledTicket
} from "./dispatch-compiled.js";
import { routeVariantBase } from "./dispatch-successor.js";
import { auditPreparedCommitAsync } from "./safety-audit.js";
import { writeSpawn } from "./spawn-store.js";
import {
  cliProfileForHost,
  configuredCodingModelsForHost,
  loadConfig
} from "./config.js";
/**
 * Pre-dispatch rejection machinery (rolling artifacts, undispatchable
 * tickets). Split from dispatch.ts.
 */

export function receiptModeMatches(ticket: SpawnTicket, receipt: DelegationReceipt): boolean {
  if (receipt.schema_version !== 4
    || receipt.execution.mode !== ticket.mode
    || receipt.execution.fork_context !== false
    || receipt.execution.max_depth !== 1
    || ticket.read_only !== (ticket.mode === "read-only")
    || (ticket.service_tier || null) !== (receipt.route.service_tier || null)
    || receipt.git_policy.worker_may_stage !== false
    || receipt.git_policy.worker_may_branch !== false
    || receipt.git_policy.worker_may_rebase !== false
    || receipt.git_policy.staging_owner !== "parent") return false;
  if (ticket.mode === "read-only") {
    return !receipt.baseline
      && !receipt.commit_baseline
      && receipt.git_policy.worker_may_commit === false
      && receipt.scope.write_allowlist.length === 0
      && receipt.scope.allowed_operations.length === 1
      && receipt.scope.allowed_operations[0] === "read"
      && receipt.scope.side_effects.length === 0;
  }
  if (ticket.mode === "write") {
    return Boolean(receipt.baseline)
      && !receipt.commit_baseline
      && receipt.git_policy.worker_may_commit === false
      && receipt.scope.write_allowlist.length > 0
      && receipt.scope.allowed_operations.length > 0
      && !receipt.scope.allowed_operations.includes("read")
      && !receipt.scope.allowed_operations.includes("commit")
      && receipt.scope.side_effects.length === 1
      && receipt.scope.side_effects[0] === "filesystem-write";
  }
  return !receipt.baseline
    && Boolean(receipt.commit_baseline)
    && receipt.git_policy.worker_may_commit === true
    && receipt.scope.allowed_operations.length === 1
    && receipt.scope.allowed_operations[0] === "commit"
    && receipt.scope.side_effects.length === 1
    && receipt.scope.side_effects[0] === "git-commit"
    && JSON.stringify(receipt.scope.write_allowlist) === JSON.stringify(receipt.commit_baseline!.staged_paths);
}

export function isRollingDispatchTicket(ticket: SpawnTicket): boolean {
  const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
  return ticket.rolling_unit_lineage !== undefined || unit?.schema_version === 3;
}

/**
 * Validate the artifact-local identity of a rolling dispatch.  Rolling
 * lifecycle authorization is intentionally anchored only in the immutable
 * ticket, schema-3 work unit, and Receipt; rolling-run state and append
 * progress are not consulted here.
 */
export function validateRollingDispatchArtifacts(
  cwd: string,
  ticket: SpawnTicket,
  host: HostId,
  env: NodeJS.ProcessEnv,
  receiptOverride?: DelegationReceipt,
): DelegationReceipt | null {
  if (!isRollingDispatchTicket(ticket)) return null;
  try {
    requireExactRootAdapter(ticket, host, env);
    const unit = ticket.work_unit as unknown as Record<string, unknown> | null;
    if (!unit || unit.schema_version !== 3 || !unit.rolling_unit_lineage) {
      throw new DispatchError(`ticket ${ticket.id} requires a schema-3 rolling work unit`, "ROLLING_LINEAGE_MISMATCH", { ticketId: ticket.id });
    }
    if (!ticket.rolling_unit_lineage) {
      throw new DispatchError(`ticket ${ticket.id} requires rolling unit lineage`, "ROLLING_LINEAGE_MISMATCH", { ticketId: ticket.id });
    }
    if (!ticket.receipt_id) {
      throw new DispatchError(`ticket ${ticket.id} has no Receipt`, "RECEIPT_REQUIRED", { ticketId: ticket.id });
    }
    const receipt = receiptOverride || readReceipt(cwd, ticket.receipt_id, env);
    const ticketLineage = normalizeRollingUnitLineage(ticket.rolling_unit_lineage);
    const workUnitLineage = normalizeRollingUnitLineage(unit.rolling_unit_lineage);
    const receiptLineage = receipt.rolling_unit_lineage === undefined
      ? null
      : normalizeRollingUnitLineage(receipt.rolling_unit_lineage);
    const serialized = JSON.stringify(ticketLineage);
    if (serialized !== JSON.stringify(workUnitLineage)
      || receiptLineage === null
      || serialized !== JSON.stringify(receiptLineage)) {
      throw new DispatchError(`ticket ${ticket.id} rolling unit lineage does not match its work unit and Receipt`, "ROLLING_LINEAGE_MISMATCH", { ticketId: ticket.id });
    }
    const expectedReceiptHost = ticket.target_host || ticket.dispatch_host || ticket.host;
    if (receipt.ticket_id !== ticket.id
      || receipt.receipt_id !== ticket.receipt_id
      || (expectedReceiptHost ? receipt.host !== expectedReceiptHost : Boolean(receipt.host && receipt.host !== host))
      || receipt.route.route_id !== ticket.route_id
      || !receiptModeMatches(ticket, receipt)
      || !receipt.selection
      || !ticket.selection
      || receipt.selection.approval_id !== ticket.selection.approval_id
      || receipt.selection.selected_model_id !== ticket.model_id
      || receipt.selection.host !== host
      || ticket.selection.host !== host) {
      throw new DispatchError(`ticket ${ticket.id} does not match its rolling Delegation Receipt`, "RECEIPT_MISMATCH", { ticketId: ticket.id });
    }
    // Keep the existing generic lineage checks as part of the rolling edge;
    // this also covers route/model/service-tier and execution-mode identity.
    assertValidTicketReceiptLineage({
      ...ticket,
      target_host: ticket.target_host || host,
    }, receipt);
    return receipt;
  } catch (error) {
    if (error instanceof DispatchError) throw error;
    const code = error instanceof Error && "code" in error
      ? String((error as Error & { code?: unknown }).code || "ROLLING_LINEAGE_MISMATCH")
      : "ROLLING_LINEAGE_MISMATCH";
    throw new DispatchError(
      error instanceof Error ? error.message : String(error),
      code,
      { ticketId: ticket.id },
    );
  }
}


export async function rejectUndispatchable(
  cwd: string,
  ticket: SpawnTicket,
  at: string,
  host: HostId,
  env: NodeJS.ProcessEnv = process.env,
  safetyOptions: AsyncSafetyOptions = {},
  preflightError: unknown = null,
): Promise<{ ticket_id: string; code: string; message: string } | null> {
  let code: string | null = preflightError instanceof DispatchError
    ? preflightError.code
    : preflightError instanceof Error && "code" in preflightError
      ? String((preflightError as Error & { code?: unknown }).code || "ROLLING_LINEAGE_MISMATCH")
      : preflightError === null
        ? null
        : "ROLLING_LINEAGE_MISMATCH";
  let message: string | null = preflightError === null
    ? null
    : preflightError instanceof Error
      ? preflightError.message
      : String(preflightError);
  let capturedHost: HostId | null = null;
  try {
    capturedHost = ticketTargetHost(ticket, env);
  } catch (error) {
    if (error instanceof DispatchError) {
      code = error.code;
      message = error.message;
    } else {
      code = "INVALID_HOST";
      message = `ticket ${ticket.id} has an invalid target host`;
    }
  }
  if (code) {
    // Preserve the host resolution error below.
  } else if (capturedHost !== host) {
    code = "HOST_MISMATCH";
    message = `ticket ${ticket.id} targets ${capturedHost}, not ${host}`;
  } else if (!ticket.route_id) {
    code = "NO_EXECUTABLE_ROUTE";
    message = `ticket ${ticket.id} has no executable route for this host`;
  } else if (ticket.fork_context !== false) {
    code = "FULL_CONTEXT_NOT_ALLOWED";
    message = `ticket ${ticket.id} must use fork_context=false`;
  } else if (ticket.work_unit.kind === "deliberative" && ticket.coordination.mode !== "checkpointed") {
    code = "COORDINATION_REQUIRED";
    message = `ticket ${ticket.id} is deliberative and requires checkpointed coordination`;
  } else if (Number(ticket.attempt || 0) >= Number(ticket.max_attempts || 1)) {
    code = "ATTEMPT_BUDGET_EXHAUSTED";
    message = `ticket ${ticket.id} exhausted its attempt budget`;
  } else if (!ticket.selection || !["user", "ops-config", "baton-recommendation"].includes(ticket.selection.confirmed_by) || ticket.selection.selected_model_id !== ticket.model_id) {
    code = "MODEL_SELECTION_NOT_CONFIRMED";
    message = `ticket ${ticket.id} has no valid Baton-recommended or ops-config model selection`;
  } else {
    const availability = availabilityForRoute(cwd, { host, routeId: ticket.route_id }, at, env);
    if ((availability.status === "exhausted" || availability.status === "probe_due") && !availability.probe_available) {
      code = availability.evidence_kind === "rate_limit" ? "MODEL_RATE_LIMITED" : "MODEL_QUOTA_EXHAUSTED";
      message = `ticket ${ticket.id} route ${ticket.route_id} is unavailable until ${availability.reset_at || availability.next_probe_at || "a later probe"}`;
    }
  }
  if (!code && ticket.route_id && ticket.selection && ticket.selection.selected_model_id === ticket.model_id) {
    const catalog = readRouteSnapshot(cwd, { host, env });
    const route = catalog?.routes.find((item) => !item.disabled && item.route_id === ticket.route_id);
    if (!catalog) {
      code = "ROUTE_SNAPSHOT_REQUIRED";
      message = `ticket ${ticket.id} requires a CLI model catalog captured by baton config`;
    } else {
      const config = loadConfig(cwd, { env });
      // Validate the ticket's captured host profile; never borrow another CLI.
      const profileHost = capturedHost!;
      const profile = cliProfileForHost(config, profileHost);
      if (catalog.cli !== profileHost) {
        code = "CLI_CATALOG_HOST_MISMATCH";
        message = `ticket ${ticket.id} requires a ${profileHost} catalog snapshot`;
      } else {
        const configured = configuredCodingModelsForHost(config, profileHost);
        const configuredRoute = isCompiledApplyTicket(ticket)
          ? configured.some((item) => item === ticket.route_id
            || item === ticket.model_id
            || routeVariantBase(item).base === ticket.route_id)
          : configured.includes(ticket.route_id);
        if (!configuredRoute) {
          code = "CLI_MODEL_NOT_CONFIGURED";
          message = `ticket ${ticket.id} model ${ticket.route_id} is not in cli.${profileHost}.coding_models`;
        }
      }
    }
    if (!code && !route) {
      code = "CLI_MODEL_UNAVAILABLE";
      message = `ticket ${ticket.id} model ${ticket.route_id} is absent from the active CLI model catalog`;
    } else if (!code && ticket.reasoning_effort && !route!.reasoning_efforts.includes(ticket.reasoning_effort)) {
      code = "CLI_REASONING_EFFORT_UNAVAILABLE";
      message = `ticket ${ticket.id} reasoning effort ${ticket.reasoning_effort} was not returned for ${ticket.route_id}`;
    } else if (!code && ticket.service_tier
      && !route!.service_tiers.includes(ticket.service_tier)
      && !route!.additional_speed_tiers.includes(ticket.service_tier)) {
      code = "CLI_SERVICE_TIER_UNAVAILABLE";
      message = `ticket ${ticket.id} service tier ${ticket.service_tier} was not returned for ${ticket.route_id}`;
    }
  }
  if (!code && !ticket.receipt_id) {
    code = "RECEIPT_REQUIRED";
    message = `ticket ${ticket.id} has no Delegation Receipt`;
  } else if (!code) {
    let receipt: DelegationReceipt;
    try {
      receipt = readReceipt(cwd, ticket.receipt_id, env);
      const expectedReceiptHost = ticket.target_host || ticket.dispatch_host || ticket.host;
      if (receipt.ticket_id !== ticket.id
        || (expectedReceiptHost ? receipt.host !== expectedReceiptHost : Boolean(receipt.host && receipt.host !== host))
        || receipt.route.route_id !== ticket.route_id
        || !receiptModeMatches(ticket, receipt)
        || !receipt.selection
        || receipt.selection.approval_id !== ticket.selection!.approval_id
        || receipt.selection.selected_model_id !== ticket.model_id) {
        code = "RECEIPT_MISMATCH";
        message = `ticket ${ticket.id} does not match its Delegation Receipt`;
      }
    } catch (error) {
      code = "RECEIPT_INVALID";
      message = error instanceof Error ? error.message : String(error);
    }
    if (!code && ticket.mode === "commit-only") {
      const verdict = await auditPreparedCommitAsync(cwd, receipt!.commit_baseline!, safetyOptions);
      if (!verdict.accepted) {
        code = "COMMIT_BASELINE_STALE";
        message = verdict.violations.map((item) => item.code).join(", ");
      }
    }
  }
  if (!code && isCompiledApplyTicket(ticket)) {
    try {
      const compiled = validateCompiledTicket(cwd, ticket, host, env);
      if (compiled) {
        const readiness = compiledUnitReady(compiled);
        if (!readiness.ready) {
          code = readiness.code || "COMPILED_DEPENDENCY_BLOCKED";
          message = readiness.message || `ticket ${ticket.id} is not ready in its compiled ApplyRun`;
        }
      }
    } catch (error) {
      code = error instanceof DispatchError ? error.code : "COMPILED_LINEAGE_MISMATCH";
      message = error instanceof Error ? error.message : String(error);
    }
  }
  if (!code) return null;
  const finalMessage = message || `ticket ${ticket.id} cannot be dispatched`;
  transition(ticket, "queued", "errored", { at, event: "dispatch_blocked", detail: { error_code: code } });
  ticket.error = { code, message: finalMessage };
  ticket.finished_at = at;
  writeSpawn(cwd, ticket, env);
  return { ticket_id: ticket.id, code, message: finalMessage };
}
