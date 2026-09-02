/** Parent-owned, repository-serialized bundle integration lifecycle.
 *
 * Admission freezes the caller baseline, application uses isolated Git object
 * plumbing, resolution records a separate audited result, and acceptance is
 * the only phase allowed to apply the frozen result to the caller checkout.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertGitSafetyStabilityTokenUnchanged,
  captureStableSafetyFacts,
  consumeGitBinaryPaths,
  consumeGitRawTreeChanges,
  fingerprintGitSafetyStabilityToken,
  streamGitSafetyFact,
  type GitTreeChangeFact,
  type StableGitSafetyFacts,
} from "./git/safety-facts.js";
import { collectGitScalar, GitSafetyError, runGitProcess, type GitProcessOptions } from "./git/safety-process.js";
import { withOwnedLock, withOwnedLockAsync } from "./owned-lock.js";
import {
  integrationDestinationLockPath,
  integrationQueueLockPath,
  integrationRepositoryDir,
  rollingRunsDir,
} from "./paths.js";
import { readRollingExecutionRun } from "./rolling-run.js";
import { acceptRollingGate } from "./rolling-control.js";
import type { UnitVersion } from "./rolling-plan.js";
import type { ChangeBundleOperation } from "./worktree-execution.js";
import {
  INTEGRATION_RECORD_SCHEMA_VERSION,
  WorktreeExecutionError,
  fingerprintWorktreeRuntimeRecord,
  persistIntegrationRecord,
  readPersistedChangeBundleManifest,
  readPersistedIntegrationRecord,
  readPersistedWorktreeRecord,
  transitionPersistedWorktreeRecord,
  type ChangeBundleManifest,
  type IntegrationApplicationIntent,
  type IntegrationAcceptanceIntent,
  type IntegrationBeginAuthorization,
  type IntegrationConflict,
  type IntegrationQueueOrderProvenance,
  type IntegrationRecord,
  type IntegrationResolutionResult,
} from "./worktree-execution.js";
import { sha256Hex } from "./json-utils.js";

export type WorktreeIntegrationErrorCode =
  | "INTEGRATION_INPUT_INVALID"
  | "INTEGRATION_BUNDLE_NOT_READY"
  | "INTEGRATION_IDENTITY_MISMATCH"
  | "INTEGRATION_DESTINATION_BASELINE_MISMATCH"
  | "INTEGRATION_QUEUE_BLOCKED"
  | "INTEGRATION_QUEUE_CORRUPT"
  | "INTEGRATION_QUEUE_LINEAGE_MISSING"
  | "INTEGRATION_APPLICATION_FAILED"
  | "INTEGRATION_RESOLUTION_INVALID"
  | "INTEGRATION_ACCEPTANCE_FAILED"
  | "INTEGRATION_STATE_INVALID";

export class WorktreeIntegrationError extends Error {
  readonly code: WorktreeIntegrationErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(message: string, code: WorktreeIntegrationErrorCode, detail?: Record<string, unknown>) {
    super(message);
    this.name = "WorktreeIntegrationError";
    this.code = code;
    this.detail = detail;
  }
}

export interface IntegrationQueueInput {
  repository_root: string;
  run_id: string;
  repository_id?: string;
  bundle_id: string;
  /** Exact tree expected before this bundle, including visible dirty content. */
  expected_before_tree?: string;
  /** Parent-authorized stable queue position. Occupied positions fail closed. */
  order_override?: number;
  idempotency_key?: string;
  env?: NodeJS.ProcessEnv;
  at?: string | number | Date;
}

export interface BeginWorktreeIntegrationInput extends IntegrationQueueInput {
  expected_before_tree: string;
  spawn?: GitProcessOptions["spawn"];
}

export interface ApplyWorktreeIntegrationInput {
  repository_root: string;
  run_id: string;
  repository_id: string;
  bundle_id: string;
  idempotency_key?: string;
  env?: NodeJS.ProcessEnv;
  at?: string | number | Date;
  spawn?: GitProcessOptions["spawn"];
}

export interface ResolveWorktreeIntegrationInput extends ApplyWorktreeIntegrationInput {
  resolved_tree: string;
  conclusion: string;
}

export interface AcceptWorktreeIntegrationInput extends ApplyWorktreeIntegrationInput {
  conclusion: string;
}

export interface IntegrationQueueResult {
  record: IntegrationRecord;
  queue: IntegrationRecord[];
  replayed: boolean;
}

export interface BeginWorktreeIntegrationResult extends IntegrationQueueResult {
  bundle: ChangeBundleManifest;
}

export interface ApplyWorktreeIntegrationResult {
  record: IntegrationRecord;
  bundle: ChangeBundleManifest;
  replayed: boolean;
}

export interface ResolveWorktreeIntegrationResult extends ApplyWorktreeIntegrationResult {
  resolution: IntegrationResolutionResult;
}

export interface AcceptWorktreeIntegrationResult extends ApplyWorktreeIntegrationResult {
  accepted_gate_refs: string[];
}


export { listIntegrationQueue, enqueueWorktreeIntegration } from "./worktree/integration-queue.js";
export { beginWorktreeIntegration } from "./worktree/integration-begin.js";
export { applyWorktreeIntegration } from "./worktree/integration-apply.js";
export { resolveWorktreeIntegration } from "./worktree/integration-resolve.js";
export { acceptWorktreeIntegration } from "./worktree/integration-accept.js";
