/**
 * Shared helpers for worktree lifecycle modules. Split from
 * worktree-lifecycle.ts (leaf).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Hex } from "./json-utils.js";
import type { GitProcessOptions } from "./git-safety-process.js";

export const MAX_SUMMARY_BYTES = 256 * 1024;
export const MAX_CHANGED_PATHS = 100;
import { WorktreeExecutionError } from "./worktree-execution.js";
import type {
  WorktreeIsolationStatus,
  WorktreeStatusTicket,
} from "./worktree-lifecycle.js";
import type { WorktreeRecord } from "./worktree-execution.js";
import { WorktreeLifecycleError } from "./worktree-lifecycle.js";
import { runGitProcess } from "./git-safety-process.js";

export function timestamp(value?: string | number | Date): string {
  const result = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new WorktreeLifecycleError("lifecycle timestamp is invalid", "WORKTREE_CLEANUP_NOT_READY");
  return result.toISOString();
}

export function sha(value: string): string { return sha256Hex(value); }
export function within(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export function missing(error: unknown): boolean { return error instanceof WorktreeExecutionError && error.code === "WORKTREE_RECORD_MISSING"; }

export async function boundedOutput(cwd: string, args: string[], spawn?: GitProcessOptions["spawn"]): Promise<{ bytes: Buffer; truncated: boolean }> {
  let bytes = Buffer.alloc(0);
  let truncated = false;
  await runGitProcess({
    cwd,
    args,
    spawn,
    onStdout(chunk) {
      if (bytes.length >= MAX_SUMMARY_BYTES) { truncated = true; return; }
      const remaining = MAX_SUMMARY_BYTES - bytes.length;
      bytes = Buffer.concat([bytes, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) truncated = true;
    },
  });
  return { bytes, truncated };
}

export function canonicalPotentialPath(value: string): string {
  const absolute = path.resolve(value);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), path.relative(existing, absolute));
}

export async function registeredWorktreeRoots(repositoryRoot: string, spawn?: GitProcessOptions["spawn"]): Promise<Set<string>> {
  const output = await boundedOutput(repositoryRoot, ["worktree", "list", "--porcelain", "-z"], spawn);
  if (output.truncated) throw new WorktreeLifecycleError("Git worktree registry exceeds the bounded recovery payload", "WORKTREE_LIFECYCLE_IDENTITY_MISMATCH");
  const result = new Set<string>();
  for (const field of output.bytes.toString("utf8").split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    const raw = field.slice("worktree ".length);
    result.add(canonicalPotentialPath(raw));
  }
  return result;
}

export function rootState(executionRoot: string): WorktreeIsolationStatus["root_state"] {
  if (!fs.existsSync(executionRoot)) return "absent";
  const stat = fs.lstatSync(executionRoot);
  if (stat.isSymbolicLink()) return "symlink";
  return stat.isDirectory() ? "directory" : "other";
}

export function ticketFor(record: WorktreeRecord, tickets: readonly WorktreeStatusTicket[]): WorktreeStatusTicket | undefined {
  return tickets.find((ticket) => ticket.rolling_unit_lineage?.run_id === record.run_id
    && ticket.rolling_unit_lineage?.unit_key === record.unit_key
    && ticket.rolling_unit_lineage?.unit_version === record.unit_version);
}

export function nativeLiveness(record: WorktreeRecord, tickets: readonly WorktreeStatusTicket[]): WorktreeIsolationStatus["native_liveness"] {
  const ticket = ticketFor(record, tickets);
  if (ticket && ["completed", "errored", "timed_out", "closed"].includes(ticket.status)) return "terminal";
  const probed = ticket?.liveness?.state;
  if (probed === "running" || probed === "pending_init") return "running";
  if (probed === "shutdown" || probed === "interrupted" || probed === "not_found") return "missing";
  if (record.lifecycle_state === "worker_active") return record.native_handle ? "unknown" : "missing";
  if (record.lifecycle_state === "terminal_awaiting_audit") return "terminal";
  return "none";
}
