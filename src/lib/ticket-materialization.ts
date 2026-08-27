import fs from "node:fs";
import path from "node:path";
import { receiptsDir, spawnsDir } from "./paths.js";
import { buildWriteReceipt, writeReceipt } from "./receipt.js";
import {
  captureBaselineAsync,
  captureCommitBaselineAsync,
  type AsyncSafetyOptions,
  type CommitBaseline,
  type GitBaseline,
  type SafetyOperation,
} from "./safety.js";
import { writeSpawn, type SpawnTicket, type StandalonePlan } from "./spawn.js";
import { applyCommitBaselineToPlan } from "./ops-dispatch.js";

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
  const safety = options.safety || {};
  const captureWrite = options.captureBaseline || ((root: string, input: AsyncSafetyOptions) => captureBaselineAsync(root, new Date(), input));
  const captureCommit = options.captureCommitBaseline || ((root: string, input: AsyncSafetyOptions) => captureCommitBaselineAsync(root, new Date(), input));
  const receiptWriter = options.writeReceipt || writeReceipt;
  const spawnWriter = options.writeSpawn || writeSpawn;
  const writeAllowlist = options.writeAllowlist || [];
  const allowedOperations = options.allowedOperations || ["write", "create"];

  if (writeAllowlist.length) {
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
