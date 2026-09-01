import fs from "node:fs";
import path from "node:path";
import { compiledApplyRunsDir, receiptsDir, spawnsDir } from "./paths.js";
import { buildWriteReceipt, readReceipt, writeReceipt } from "./receipt.js";
import {
  captureBaselineAsync,
  captureCommitBaselineAsync,
  type AsyncSafetyOptions,
  type CommitBaseline,
  type GitBaseline,
  type SafetyOperation,
} from "./safety.js";
import { listSpawns, writeSpawn, type SpawnTicket, type StandalonePlan } from "./spawn.js";
import { applyCommitBaselineToPlan } from "./ops-dispatch.js";
import { assertDisjointWriteScopes, writePathsOverlap, type WriteScopeDeclaration } from "./apply-scope.js";
import { APPLY_RUN_STATE_TEMP_FILE_PREFIX } from "./apply-run.js";
import { extractExactExecutionRootIdentity } from "../adapters/contract.js";
import { resolveWorktreeTopology } from "./worktree-topology.js";

/** Dependencies are injectable so Git/stream/race failures can be tested
 * without weakening the production stable-observation boundary. */
export interface TicketMaterializationDependencies {
  captureBaseline?: (cwd: string, options: AsyncSafetyOptions) => Promise<GitBaseline>;
  captureCommitBaseline?: (cwd: string, options: AsyncSafetyOptions) => Promise<CommitBaseline>;
  writeReceipt?: typeof writeReceipt;
  writeSpawn?: typeof writeSpawn;
}

export interface TicketMaterializationOptions extends TicketMaterializationDependencies {
  env?: NodeJS.ProcessEnv;
  safety?: AsyncSafetyOptions;
  writeAllowlist?: string[];
  allowedOperations?: SafetyOperation[];
}

export interface PendingWriteScope extends WriteScopeDeclaration {
  ticket_id?: string;
}

/** One immutable plan/Receipt pair supplied to the atomic batch writer. */
export interface TicketMaterializationBatchEntry {
  planned: Extract<StandalonePlan, { director_local: false }>;
  writeAllowlist?: string[];
  allowedOperations?: SafetyOperation[];
}

export interface TicketMaterializationBatchOptions extends TicketMaterializationDependencies {
  env?: NodeJS.ProcessEnv;
  safety?: AsyncSafetyOptions;
  /** Called only after every Receipt and ticket has been persisted. */
  onComplete?: (tickets: SpawnTicket[]) => void | Promise<void>;
}

function activeWriteScopes(cwd: string, env?: NodeJS.ProcessEnv): PendingWriteScope[] {
  const scopes: PendingWriteScope[] = [];
  for (const ticket of listSpawns(cwd, env)) {
    if (!ticket.receipt_id) continue;
    // A terminal ticket with no native handle never acquired worker-owned
    // workspace scope. Ignore its historical Receipt even if an older record
    // predates slot_released_at normalization.
    if (["completed", "errored", "timed_out", "closed"].includes(ticket.status) && !ticket.execution_handle) continue;
    // A terminal ticket still owns its path until the dispatch slot is
    // explicitly released. This closes the race between completion and the
    // next wave's materialization.
    if (ticket.slot_released_at) continue;
    try {
      const receipt = readReceipt(cwd, ticket.receipt_id, env);
      if (
        (ticket.mode === "write" || ticket.mode === "commit-only"
          || receipt.execution.mode === "write" || receipt.execution.mode === "commit-only")
        && receipt.scope.write_allowlist.length
      ) {
        scopes.push({ key: ticket.id, ticket_id: ticket.id, write_paths: receipt.scope.write_allowlist });
      }
    } catch {
      // A malformed receipt is rejected by the normal ticket lifecycle. It
      // cannot safely be treated as an empty scope here.
      throw new Error(`WRITE_SCOPE_CONFLICT: unable to inspect active write ticket ${ticket.id}`);
    }
  }
  return scopes;
}

/**
 * Validate the complete write wave and all currently owned write scopes.
 * Callers must invoke this before their first materialization so a rejected
 * wave leaves no partially-created tickets or Receipts.
 */
export function assertWriteScopesAvailable(cwd: string, scopes: PendingWriteScope[], env?: NodeJS.ProcessEnv): void {
  assertDisjointWriteScopes(scopes);
  const active = activeWriteScopes(cwd, env);
  for (const incoming of scopes) {
    for (const existing of active) {
      for (const incomingPath of incoming.write_paths) {
        for (const existingPath of existing.write_paths) {
          if (writePathsOverlap(incomingPath, existingPath)) {
            throw new Error(`WRITE_SCOPE_CONFLICT: ${incoming.key}:${incomingPath} overlaps active ${existing.key}:${existingPath}`);
          }
        }
      }
    }
  }
}

function removeIfNew(file: string, existed: boolean): void {
  if (!existed && fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch { /* preserve the original materialization error */ }
  }
}

function ticketExecutionRoot(cwd: string, ticket: SpawnTicket, writeAllowlist: string[]): string {
  const worktreeMode = ticket.rolling_unit_lineage?.worktree_mode;
  let identity;
  try { identity = extractExactExecutionRootIdentity(ticket); }
  catch { throw new Error("ISOLATED_EXECUTION_IDENTITY_PARTIAL: ticket exact-root identity is invalid"); }
  if (worktreeMode !== "isolated-worktree") {
    if (identity) throw new Error("ISOLATED_EXECUTION_IDENTITY_FORBIDDEN: shared or legacy ticket carries exact-root identity");
    return cwd;
  }
  if (!identity) throw new Error("ISOLATED_EXECUTION_IDENTITY_PARTIAL: isolated ticket requires exact-root identity");
  const topology = resolveWorktreeTopology(identity.execution_root, writeAllowlist);
  if (topology.repositories.length !== 1
    || topology.repositories[0]!.repository_id !== identity.repository_id
    || topology.repositories[0]!.repository_root !== identity.execution_root) {
    throw new Error("EXECUTION_ROOT_SCOPE_ESCAPE: write scope does not belong to the isolated execution root");
  }
  return identity.execution_root;
}

function listTemporaryRunStateFiles(cwd: string, env?: NodeJS.ProcessEnv): Set<string> {
  const root = compiledApplyRunsDir(cwd, env);
  const found = new Set<string>();
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.startsWith(APPLY_RUN_STATE_TEMP_FILE_PREFIX)) found.add(file);
    }
  };
  visit(root);
  return found;
}

function removeNewTemporaryRunStateFiles(before: Set<string>, cwd: string, env?: NodeJS.ProcessEnv): void {
  for (const file of listTemporaryRunStateFiles(cwd, env)) {
    if (before.has(file)) continue;
    try { fs.unlinkSync(file); } catch { /* preserve the original materialization error */ }
  }
}

/**
 * Capture a complete stable baseline, construct the immutable Receipt, then
 * persist Receipt before the worker-ready spawn ticket. Any failure before
 * completion leaves neither artifact; a spawn write failure also removes a
 * Receipt created by this attempt.
 */
export async function materializeStandalonePlanAsync(
  cwd: string,
  planned: StandalonePlan,
  options: TicketMaterializationOptions = {},
): Promise<SpawnTicket> {
  if (planned.director_local === true) throw new Error("ops dispatch unexpectedly stayed on the director");
  // Validate session identity before constructing or persisting either
  // immutable artifact. This is intentionally independent of receipt mode.
  const sessionId = String((options.env || process.env).BATON_SESSION_ID || "").trim();
  if (!sessionId) throw new Error("BATON_SESSION_ID is required");
  const safety = options.safety || {};
  const captureWrite = options.captureBaseline || ((root: string, input: AsyncSafetyOptions) => captureBaselineAsync(root, new Date(), input));
  const captureCommit = options.captureCommitBaseline || ((root: string, input: AsyncSafetyOptions) => captureCommitBaselineAsync(root, new Date(), input));
  const receiptWriter = options.writeReceipt || writeReceipt;
  const spawnWriter = options.writeSpawn || writeSpawn;
  const writeAllowlist = options.writeAllowlist || [];
  const allowedOperations = options.allowedOperations || ["write", "create"];

  if (writeAllowlist.length) {
    // Keep a single-plan caller safe as well; batch callers additionally
    // preflight the complete wave so they cannot leave partial artifacts.
    assertWriteScopesAvailable(cwd, [{ key: planned.ticket.id, write_paths: writeAllowlist }], options.env);
    const baseline = await captureWrite(ticketExecutionRoot(cwd, planned.ticket, writeAllowlist), safety);
    planned.receipt = buildWriteReceipt({ base: planned.receipt, baseline, writeAllowlist, allowedOperations });
    planned.ticket.mode = "write";
    planned.ticket.read_only = false;
    planned.ticket.receipt_id = planned.receipt.receipt_id;
  } else if (planned.ticket.mode === "commit-only") {
    const baseline = planned.receipt.commit_baseline || await captureCommit(cwd, safety);
    // Commit-only staged paths are workspace-owned just like an explicit
    // write allowlist. Capture first, then reject overlap before either
    // immutable artifact is persisted.
    assertWriteScopesAvailable(cwd, [{ key: planned.ticket.id, write_paths: baseline.staged_paths }], options.env);
    if (!planned.receipt.commit_baseline) applyCommitBaselineToPlan(planned, baseline);
  }

  const receiptFile = path.join(receiptsDir(cwd, options.env), `${planned.receipt.receipt_id}.json`);
  const spawnFile = path.join(spawnsDir(cwd, options.env), `${planned.ticket.id}.json`);
  const receiptExisted = fs.existsSync(receiptFile);
  const spawnExisted = fs.existsSync(spawnFile);
  try {
    receiptWriter(cwd, planned.receipt, options.env);
    return spawnWriter(cwd, planned.ticket, options.env);
  } catch (error) {
    removeIfNew(receiptFile, receiptExisted);
    removeIfNew(spawnFile, spawnExisted);
    throw error;
  }
}

/**
 * Persist a compiled frontier as one failure-atomic batch. Baselines are
 * captured for every write unit before the first artifact is created; each
 * Receipt is then written immediately before its ticket. Existing standalone
 * callers continue to use materializeStandalonePlanAsync unchanged.
 */
export async function materializeStandalonePlansBatchAsync(
  cwd: string,
  entries: TicketMaterializationBatchEntry[],
  options: TicketMaterializationBatchOptions = {},
): Promise<SpawnTicket[]> {
  if (!entries.length) return [];
  const env = options.env;
  const safety = options.safety || {};
  const captureWrite = options.captureBaseline || ((root: string, input: AsyncSafetyOptions) => captureBaselineAsync(root, new Date(), input));
  const captureCommit = options.captureCommitBaseline || ((root: string, input: AsyncSafetyOptions) => captureCommitBaselineAsync(root, new Date(), input));
  const receiptWriter = options.writeReceipt || writeReceipt;
  const spawnWriter = options.writeSpawn || writeSpawn;
  const temporaryRunStateFiles = listTemporaryRunStateFiles(cwd, env);
  const scopes: PendingWriteScope[] = entries.map((entry) => {
    const allowlist = entry.writeAllowlist || [];
    return { key: entry.planned.ticket.id, ticket_id: entry.planned.ticket.id, write_paths: allowlist };
  }).filter((scope) => scope.write_paths.length);
  assertWriteScopesAvailable(cwd, scopes, env);

  // Capture all mutable baselines before writing anything. This is what makes
  // a failure in a later source/baseline observation leave no leaked pair.
  const prepared = [] as Array<{ entry: TicketMaterializationBatchEntry; receipt: import("./receipt.js").DelegationReceipt; receiptFile: string; spawnFile: string; receiptExisted: boolean; spawnExisted: boolean }>;
  for (const entry of entries) {
    const planned = entry.planned;
    if (planned.director_local) throw new Error("compiled materialization cannot persist a director-local unit");
    const writeAllowlist = entry.writeAllowlist || [];
    const allowedOperations = entry.allowedOperations || ["write", "create"];
    if (writeAllowlist.length) {
      const baseline = await captureWrite(ticketExecutionRoot(cwd, planned.ticket, writeAllowlist), safety);
      planned.receipt = buildWriteReceipt({ base: planned.receipt, baseline, writeAllowlist, allowedOperations });
      planned.ticket.mode = "write";
      planned.ticket.read_only = false;
      planned.ticket.receipt_id = planned.receipt.receipt_id;
    } else if (planned.ticket.mode === "commit-only") {
      const baseline = planned.receipt.commit_baseline || await captureCommit(cwd, safety);
      assertWriteScopesAvailable(cwd, [{ key: planned.ticket.id, ticket_id: planned.ticket.id, write_paths: baseline.staged_paths }], env);
      if (!planned.receipt.commit_baseline) applyCommitBaselineToPlan(planned, baseline);
    }
    const receiptFile = path.join(receiptsDir(cwd, env), `${planned.receipt.receipt_id}.json`);
    const spawnFile = path.join(spawnsDir(cwd, env), `${planned.ticket.id}.json`);
    prepared.push({ entry, receipt: planned.receipt, receiptFile, spawnFile, receiptExisted: fs.existsSync(receiptFile), spawnExisted: fs.existsSync(spawnFile) });
  }

  const written: typeof prepared = [];
  const tickets: SpawnTicket[] = [];
  try {
    for (const item of prepared) {
      const planned = item.entry.planned;
      receiptWriter(cwd, item.receipt, env);
      // Keep the exact Receipt instance returned by the writer on the plan;
      // custom writers may normalize it before persistence.
      planned.receipt = item.receipt;
      tickets.push(spawnWriter(cwd, planned.ticket, env));
      written.push(item);
    }
    if (options.onComplete) await options.onComplete(tickets);
    return tickets;
  } catch (error) {
    for (const item of [...written, ...prepared.slice(written.length)]) {
      removeIfNew(item.receiptFile, item.receiptExisted);
      removeIfNew(item.spawnFile, item.spawnExisted);
    }
    removeNewTemporaryRunStateFiles(temporaryRunStateFiles, cwd, env);
    throw error;
  }
}

export const materializeBatchAsync = materializeStandalonePlansBatchAsync;
export const materializeCompiledApplyBatchAsync = materializeStandalonePlansBatchAsync;
export const materializePlansBatchAsync = materializeStandalonePlansBatchAsync;
