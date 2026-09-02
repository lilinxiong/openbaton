import { SpawnTicket } from "./spawn.js";
import { DispatchError } from "./dispatch-core.js";
import { HostId } from "./hosts.js";
import { DelegationReceipt } from "./receipt.js";
import { WorktreeRecord } from "./worktree-execution-types.js";
import { WORKTREE_RECORD_NAME } from "./paths.js";
import { parseWorktreeRecord } from "./worktree-execution-validation.js";
import { transitionPersistedWorktreeRecord } from "./worktree-execution.js";
import {
  resolveOwningRepository,
  resolveWorktreeTopology
} from "./worktree-topology.js";
import {
  ExactExecutionRootIdentity,
  extractExactExecutionRootIdentity
} from "../adapters/contract.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCliAdapter } from "../adapters/index.js";
/**
 * Exact execution-root verification for isolated worktree tickets. Split
 * from dispatch.ts.
 */

export function isolatedTicketIdentity(ticket: SpawnTicket): ExactExecutionRootIdentity | null {
  const mode = ticket.rolling_unit_lineage?.worktree_mode;
  const identity = extractExactExecutionRootIdentity(ticket);
  if (mode !== "isolated-worktree") {
    if (identity) throw new DispatchError(`ticket ${ticket.id} cannot carry exact-root identity in ${mode || "legacy"} mode`, "ISOLATED_EXECUTION_IDENTITY_FORBIDDEN", { ticketId: ticket.id });
    return null;
  }
  if (!identity) throw new DispatchError(`ticket ${ticket.id} has no complete exact-root identity`, "ISOLATED_EXECUTION_IDENTITY_PARTIAL", { ticketId: ticket.id });
  return identity;
}

export function requireExactRootAdapter(ticket: SpawnTicket, host: HostId, env: NodeJS.ProcessEnv): ExactExecutionRootIdentity | null {
  const identity = isolatedTicketIdentity(ticket);
  if (identity && getCliAdapter(host, env).host.exactExecutionRoot !== true) {
    throw new DispatchError(`adapter ${host} cannot guarantee exact execution-root dispatch`, "ADAPTER_EXACT_ROOT_UNSUPPORTED", { ticketId: ticket.id });
  }
  return identity;
}

/** Last physical gate before a public spawn request is returned or a handle is bound. */
export const EXACT_ROOT_GIT_MAX_BUFFER = 256 * 1024;

export function verifyExactExecutionRoot(
  cwd: string,
  ticket: SpawnTicket,
  receipt: DelegationReceipt,
  host: HostId,
  env: NodeJS.ProcessEnv,
  requireClean = true,
): WorktreeRecord | null {
  const identity = requireExactRootAdapter(ticket, host, env);
  if (!identity) return null;
  let root: string;
  try { root = fs.realpathSync(identity.execution_root); }
  catch (cause) { throw new DispatchError(`execution root is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, "EXECUTION_ROOT_DRIFT", { ticketId: ticket.id }); }
  if (fs.lstatSync(identity.execution_root).isSymbolicLink()
    || root === fs.realpathSync(cwd)
    || !fs.statSync(root).isDirectory()) {
    throw new DispatchError(`ticket ${ticket.id} execution root was rewritten or aliases the caller checkout`, "EXECUTION_ROOT_REWRITE", { ticketId: ticket.id });
  }
  const recordFile = path.join(path.dirname(root), WORKTREE_RECORD_NAME);
  let record: WorktreeRecord;
  try { record = parseWorktreeRecord(fs.readFileSync(recordFile, "utf8")); }
  catch (cause) { throw new DispatchError(`ticket ${ticket.id} worktree record is unavailable or invalid: ${cause instanceof Error ? cause.message : String(cause)}`, "WORKTREE_RECORD_DRIFT", { ticketId: ticket.id }); }
  const lineage = ticket.rolling_unit_lineage!;
  if (record.record_id !== identity.worktree_record_id
    || record.execution_mode !== "isolated-worktree"
    || record.repository_id !== identity.repository_id
    || record.git_common_dir_identity !== identity.git_common_dir_identity
    || record.execution_root !== identity.execution_root
    || record.base_tree !== identity.base_tree
    || record.run_id !== lineage.run_id
    || record.unit_key !== lineage.unit_key
    || record.unit_version !== lineage.unit_version
    || record.setup_state !== "verified"
    || record.lifecycle_state !== "preparing") {
    throw new DispatchError(`ticket ${ticket.id} worktree record lineage drifted before native spawn`, "WORKTREE_RECORD_DRIFT", { ticketId: ticket.id });
  }
  let owner;
  try { owner = resolveOwningRepository(root, ".").repository; }
  catch (cause) { throw new DispatchError(`ticket ${ticket.id} execution-root repository cannot be verified: ${cause instanceof Error ? cause.message : String(cause)}`, "EXECUTION_ROOT_REPOSITORY_DRIFT", { ticketId: ticket.id }); }
  if (owner.repository_root !== root
    || owner.repository_id !== identity.repository_id
    || owner.git_common_dir_identity !== identity.git_common_dir_identity
    || owner.git_common_dir !== record.git_common_dir) {
    throw new DispatchError(`ticket ${ticket.id} execution-root repository identity drifted`, "EXECUTION_ROOT_REPOSITORY_DRIFT", { ticketId: ticket.id });
  }
  try {
    const git = (args: string[]) => execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      maxBuffer: EXACT_ROOT_GIT_MAX_BUFFER,
    }).trim();
    if (git(["rev-parse", "HEAD^{tree}"]) !== identity.base_tree
      || git(["write-tree"]) !== identity.base_tree
      || (requireClean && git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "")) {
      throw new Error("immutable base tree or worktree content changed");
    }
  } catch (cause) {
    throw new DispatchError(`ticket ${ticket.id} execution-root base drifted: ${cause instanceof Error ? cause.message : String(cause)}`, "EXECUTION_ROOT_BASE_DRIFT", { ticketId: ticket.id });
  }
  try {
    const topology = receipt.scope.write_allowlist.length
      ? resolveWorktreeTopology(root, receipt.scope.write_allowlist)
      : null;
    if (topology && (topology.repositories.length !== 1
      || topology.repositories[0]!.repository_id !== identity.repository_id
      || topology.repositories[0]!.repository_root !== root)) {
      throw new Error("scope resolves outside the isolated repository root");
    }
  } catch (cause) {
    throw new DispatchError(`ticket ${ticket.id} scope escapes its execution root: ${cause instanceof Error ? cause.message : String(cause)}`, "EXECUTION_ROOT_SCOPE_ESCAPE", { ticketId: ticket.id });
  }
  return record;
}

export function transitionExactRootRecord(
  _cwd: string,
  ticket: SpawnTicket,
  key: string,
  toState: "worker_active" | "terminal_awaiting_audit" | "rejected",
  at: string,
  nativeHandle: string | null,
  retentionReasons: Array<"live_native_handle" | "terminal_unreleased_ticket" | "pending_audit" | "rejected_result_evidence">,
  env: NodeJS.ProcessEnv,
): void {
  const identity = isolatedTicketIdentity(ticket);
  if (!identity) return;
  const record = parseWorktreeRecord(fs.readFileSync(path.join(path.dirname(identity.execution_root), WORKTREE_RECORD_NAME), "utf8"));
  transitionPersistedWorktreeRecord(record.repository_root, record.run_id, record.unit_key, record.attempt_id, {
    idempotency_key: key,
    phase: "native_execution",
    to_state: toState,
    recorded_at: at,
    native_handle: nativeHandle,
    retention_reasons: retentionReasons,
  }, env);
}

export function retainTerminalExactRoot(ticket: SpawnTicket, at: string, env: NodeJS.ProcessEnv): void {
  if (!isolatedTicketIdentity(ticket)) return;
  if (!ticket.execution_handle) {
    transitionExactRootRecord("", ticket, `native-aborted-${ticket.id}-${ticket.attempt}`, "rejected", at,
      null, ["rejected_result_evidence"], env);
    return;
  }
  transitionExactRootRecord("", ticket, `native-terminal-${ticket.id}-${ticket.attempt}`, "terminal_awaiting_audit", at,
    `${ticket.execution_handle.kind}:${ticket.execution_handle.value}`,
    ["pending_audit", "terminal_unreleased_ticket"], env);
}
