import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnsDir } from "./paths.js";
import { matchModelCard, requireCardId } from "./cards.js";
import {
  buildReadOnlyReceipt,
  normalizeCompiledApplyLineage,
  normalizeRollingUnitLineage,
  writeReceipt,
  type CompiledApplyLineage,
  type DelegationReceipt,
  type ExecutionMode,
  type RollingUnitLineage,
} from "./receipt.js";
import type { CodedError, ModelCard, ModelSelectionApproval, UnknownRecord } from "../types.js";
import {
  extractExactExecutionRootIdentity,
  sameExactExecutionRootIdentity,
  type ExactExecutionRootIdentity,
  type NativeExecutionHandleKind,
} from "../adapters/contract.js";
import {
  assertSessionScope,
  sessionScope,
  sessionUidFromEnv,
  SessionScopeError,
  type SessionScope,
  type SessionUid,
} from "./session-scope.js";
export {
  assertSessionScope,
  sessionScope,
  sessionUidFromEnv,
  SessionScopeError,
  type SessionScope,
  type SessionUid,
} from "./session-scope.js";
import {
  buildWorkerPrompt,
  compileWorkUnit,
  compileRollingWorkUnit,
  coordinationFor,
  type CoordinationPolicy,
  type RollingWorkUnitContract,
  type WorkUnitContract,
  type WorkUnitKind,
} from "./work-unit.js";
import { readJsonFile, writeJsonAtomic } from "./json-utils.js";

export type TicketStatus = "queued" | "dispatching" | "running" | "completed" | "errored" | "timed_out" | "closed" | "done";

export interface TicketError {
  code: string;
  message: string;
}

export interface TicketHistoryEntry extends UnknownRecord {
  event: string;
  at: string;
}

export type TicketProgressPhase = "starting" | "working" | "waiting" | "blocked" | "checkpoint";

export interface TicketProgress {
  sequence: number;
  phase: TicketProgressPhase;
  summary: string;
  next_step: string | null;
  blocker: string | null;
  needs_director: boolean;
  reported_at: string;
}

export type AgentProbeState = "pending_init" | "running" | "interrupted" | "shutdown" | "not_found";
export type AgentProbeActivity = "status" | "output" | "heartbeat";

export type ExecutionHandleSource = "native-return" | "manual";

/** Host-neutral native child handle. */
export interface NativeExecutionHandle extends Partial<ExactExecutionRootIdentity> {
  kind: NativeExecutionHandleKind;
  value: string;
  source: ExecutionHandleSource;
}

/** Host-observed liveness is separate from business progress and terminal state. */
export interface TicketLiveness {
  sequence: number;
  execution_handle: NativeExecutionHandle;
  /** Host-reported lifecycle state for the bound opaque handle. */
  state: AgentProbeState;
  activity: AgentProbeActivity;
  observed_at: string;
}

export interface SpawnTicket extends UnknownRecord, Partial<ExactExecutionRootIdentity> {
  schema_version: number;
  id: string;
  session_uid: string;
  session_ordinal: number;
  description: string;
  prompt: string;
  work_unit: WorkUnitContract;
  coordination: CoordinationPolicy;
  progress: TicketProgress | null;
  liveness: TicketLiveness | null;
  model_id: string;
  route_id: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  fork_context: false;
  mode: ExecutionMode;
  read_only: boolean;
  source: string;
  openspec: UnknownRecord | null;
  queue: string;
  status: TicketStatus;
  attempt: number;
  max_attempts: number;
  /** Opaque identity for one dispatch attempt. It is unrelated to the ticket id format. */
  reservation_id?: string;
  /** Optional host diagnostic. Dispatch lifecycle is keyed by execution_handle. */
  execution_handle: NativeExecutionHandle | null;
  host: string | null;
  /** Requested runtime host captured before dispatch; unlike `host`, this is
   * present before a worker binds and is immutable across queue transitions. */
  target_host?: string;
  error: TicketError | null;
  conclusion: string | null;
  receipt_id: string | null;
  selection: ModelSelectionApproval | null;
  created_at: string;
  updated_at: string;
  history: TicketHistoryEntry[];
  dispatch_host?: string;
  dispatch_requested_at?: string;
  started_at?: string;
  finished_at?: string;
  slot_released_at?: string;
  safety_verdict?: UnknownRecord;
  successor_from_ticket_id?: string;
  successor_reason?: string;
  successor_id?: string;
  quota_diagnostic?: UnknownRecord;
  /** Routing constraints captured by selection when available; successors may not relax them. */
  routing_requirements?: {
    required_reasoning_effort?: string | null;
    estimated_context_tokens?: number | null;
  };
  /** Omitted by legacy/manual tickets; compiled tickets carry this immutable identity. */
  compiled_apply_lineage?: CompiledApplyLineage;
  /** Omitted by legacy/manual and compiled tickets; rolling tickets carry this immutable identity. */
  rolling_unit_lineage?: RollingUnitLineage;
}


export * from "./spawn/normalize.js";
export * from "./spawn/store.js";
export * from "./spawn/build.js";
