/**
 * Production transport for the director-compiled `apply` protocol.
 *
 * The CLI owns argument parsing, while this module owns the small amount of
 * orchestration needed to connect a parsed invocation to the already existing
 * source, run, selection, dispatch, gate, and reconciliation APIs.  In
 * particular, this module never edits an OpenSpec artifact for a worker.
 */
import fs from "node:fs";
import path from "node:path";
import type { CompiledApplyInvocation } from "../../cli.js";
import {
  ingestInitialApplyExecutionPlan,
  ingestSuccessorApplyExecutionPlan,
  materializeCompiledApplyFrontier,
  type CompiledApplyFrontierResult,
  type CompiledApplyIngestionResult,
} from "./compiled.js";
import {
  deriveSafeReadyFrontier,
  type ApplyExecutionPlan,
  type ApplyPlanActiveOwnership,
} from "../apply-plan.js";
import {
  captureCompiledApplySourceFacts,
  type ApplySourceCaptureRequest,
  type CompiledApplySourceFacts,
} from "../apply-source.js";
import {
  deriveApplyTaskEligibility,
  reconcileApplyRun,
  acceptApplyGate,
  type ApplyTaskEligibility,
} from "./reconcile.js";
import {
  readApplyRun,
  readApplyRunPlanBody,
  type ApplyRunState,
  type ApplyRunTicketFact,
} from "./run.js";
import {
  resolveOpenSpecApplyInstructions,
  openspecCliAvailable,
  type OpenSpecApplyInstructions,
} from "../openspec.js";
import { resolveRuntimeHost, type HostId } from "../hosts.js";
import {
  configuredCodingModelsForHost,
  effectiveMaxConcurrentForHost,
  loadConfig,
} from "../config.js";
import { buildRouteCandidates } from "../routes.js";
import { cardsForAutomaticSelection } from "../route-health.js";
import {
  buildSelectionUnit,
  type SelectionCandidate,
  type SelectionUnit,
} from "../selection.js";
import { readModelAvailability, availabilityForRoute } from "../model-availability.js";
import { dispatchSnapshot } from "../dispatch.js";
import { listSpawns, type SpawnTicket } from "../spawn.js";
import { readReceipt } from "../receipt.js";
import { sessionScope } from "../session-scope.js";
import type { ModelCard } from "../../types.js";
import { requireHost } from "./compiled-shared.js";
import {
  acceptGateResult,
  persistPlan,
  reconcileResult
} from "./compiled-ops.js";
import {
  humanStatus,
  statusResult
} from "./compiled-status.js";

export interface CompiledApplyCliResult {
  code: string;
  operation: CompiledApplyInvocation["operation"];
  mode: CompiledApplyInvocation["mode"];
  run_id?: string;
  change?: string;
  host?: string;
  session_uid?: string;
  revision?: string;
  fingerprint?: string;
  [key: string]: unknown;
}

export class CompiledApplyCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompiledApplyCliError";
    this.code = code;
  }
}

export async function runCompiledApplyInvocation(input: CompiledApplyInvocation): Promise<CompiledApplyCliResult | string> {
  const host = requireHost(input);
  if (input.operation === "plan") return await persistPlan(input, host);
  if (input.mode === "status" || input.operation === "status") {
    const result = await statusResult(input, host);
    return input.json ? result : humanStatus(result);
  }
  if (input.mode === "accept-gate" || input.operation === "accept-gate") return acceptGateResult(input, host);
  return reconcileResult(input, host);
}

/** Stable production default retained as a replaceable test boundary in cli.ts. */
export const defaultCompiledApplyHandler = runCompiledApplyInvocation;
