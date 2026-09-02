import { spawnsDir } from "../paths.js";
import { readJsonFile } from "../json-utils.js";
import { recordRouteHealth } from "../route-health.js";
import {
  SpawnTicket,
  TicketError
} from "../spawn.js";
import {
  SESSION_UID_PATTERN,
  TerminalDispatchStatus,
  rawRecordHoldsSlot
} from "./core.js";
import fs from "node:fs";
import path from "node:path";
/**
 * Legacy-record compatibility blockers and route-health updates. Split from
 * dispatch.ts.
 */

export interface CompatibilityBlocker {
  readonly code: "UNATTRIBUTED_ACTIVE_RECORD";
  readonly file: string;
  readonly ticket_id: string | null;
  readonly status: string | null;
  readonly host: string | null;
  readonly reason: string;
}


/** Find legacy/current records which hold a slot but cannot be assigned safely. */
export function dispatchCompatibilityBlockers(cwd: string, env: NodeJS.ProcessEnv = process.env): CompatibilityBlocker[] {
  const dir = spawnsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  const blockers: CompatibilityBlocker[] = [];
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".json"))) {
    const file = path.join(dir, name);
    let value: unknown;
    try {
      value = readJsonFile(file) as unknown;
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (SESSION_UID_PATTERN.test(String(record.session_uid || "")) || !rawRecordHoldsSlot(record)) continue;
    blockers.push({
      code: "UNATTRIBUTED_ACTIVE_RECORD",
      file: path.relative(cwd, file).replaceAll("\\", "/"),
      ticket_id: typeof record.id === "string" ? record.id : null,
      status: typeof record.status === "string" ? record.status : null,
      host: typeof record.target_host === "string" ? record.target_host : typeof record.host === "string" ? record.host : null,
      reason: "active record has no valid root-agent-tree session_uid; reconciliation is required",
    });
  }
  return blockers;
}

/** Host-reported terminal failure, kept as structured evidence when the safety gate overrides it. */
export interface HostTerminalError {
  status: Exclude<TerminalDispatchStatus, "completed">;
  code: string;
  message: string;
}

export interface ScopeRejection extends TicketError {
  host_error?: HostTerminalError;
}

export function updateRouteHealth(cwd: string, ticket: SpawnTicket, status: TerminalDispatchStatus, error: HostTerminalError | null, at: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!ticket.route_id) return;
  const host = ticket.host || ticket.dispatch_host || ticket.target_host || ticket.selection?.host;
  if (!host) return;
  recordRouteHealth(cwd, {
    routeId: ticket.route_id,
    profile: ticket.reasoning_effort,
    host: String(host),
    taskText: ticket.prompt,
    terminalStatus: status,
    errorCode: error?.code || null,
    message: error?.message || null,
    now: new Date(at),
    env,
  });
}
