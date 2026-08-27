import fs from "node:fs";
import path from "node:path";
import { receiptsDir, spawnsDir } from "./paths.js";
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

function activeWriteScopes(cwd: string, env?: NodeJS.ProcessEnv): PendingWriteScope[] {
  const scopes: PendingWriteScope[] = [];
  for (const ticket of listSpawns(cwd, env)) {
    if (!ticket.receipt_id) continue;
    if (
      (ticket.status === "completed" || ticket.status === "errored" || ticket.status === "timed_out" || ticket.status === "closed")
      && ticket.execution_handle === null
    ) continue;
    // A terminal ticket still owns its path until the dispatch slot is
    // explicitly released. This closes the race between completion and the
    // next wave's materialization.
    if (ticket.slot_released_at) continue;
    try {
      const receipt = readReceipt(cwd, ticket.receipt_id, env);
      if ((ticket.mode === "write" || receipt.execution.mode === "write") && receipt.scope.write_allowlist.length) {
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
    const baseline = await captureWrite(cwd, safety);
    planned.receipt = buildWriteReceipt({ base: planned.receipt, baseline, writeAllowlist, allowedOperations });
    planned.ticket.mode = "write";
    planned.ticket.read_only = false;
    planned.ticket.receipt_id = planned.receipt.receipt_id;
  } else if (planned.ticket.mode === "commit-only" && !planned.receipt.commit_baseline) {
    const baseline = await captureCommit(cwd, safety);
    applyCommitBaselineToPlan(planned, baseline);
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
