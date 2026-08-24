import fs from "node:fs";
import { codexHooksStatus, installCodexHooks } from "../lib/codex-hooks.js";
import {
  evaluatePreToolUse,
  evaluateSubagentStart,
  HOST_GUARD_REASONS,
  type GuardDecision,
  type HookInput,
  type HostGuardOptions,
} from "../lib/host-guard.js";
import type { WritableLike } from "../types.js";

export const CODEX_GUARD_GUIDANCE = [
  "Codex hooks are non-managed until trusted.",
  "Open Codex `/hooks`, review the Baton-owned PreToolUse/SubagentStart entry, and trust it.",
  "The guard fails closed for director shell/code-write calls until a Baton ticket is reserved and bound to a native subagent.",
  "Some specialized tool paths may opt out of the default Codex hook path; keep Receipt and parent Git audits enabled.",
].join(" ");

export interface GuardCommandOptions {
  cwd: string;
  stdout: WritableLike;
  stderr?: WritableLike;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookEvent(value: unknown): string {
  return isRecord(value) && typeof value.hook_event_name === "string" ? value.hook_event_name : "";
}

function invalidHookDecision(options: HostGuardOptions): GuardDecision {
  return evaluatePreToolUse({ hook_event_name: "PreToolUse" }, {
    ...options,
    state: options.state || {
      active: true,
      initialized: true,
      tickets: [],
      bindings: [],
      state_error: null,
    },
  });
}

/** Convert one official Codex hook stdin object into the contract JSON. */
export function evaluateCodexHook(input: unknown, options: HostGuardOptions = {}): GuardDecision {
  if (!isRecord(input)) return invalidHookDecision(options);
  const event = hookEvent(input);
  if (event === "PreToolUse") return evaluatePreToolUse(input as HookInput, options);
  if (event === "SubagentStart") return evaluateSubagentStart(input as HookInput, options);
  return {
    allowed: false,
    event: event || "unknown",
    reason: HOST_GUARD_REASONS.invalid_input,
    ticket_id: null,
    agent_id: null,
    output: {
      decision: "block",
      reason: HOST_GUARD_REASONS.invalid_input,
    },
  };
}

export const handleCodexHook = evaluateCodexHook;
export const runCodexHook = evaluateCodexHook;

function jsonInput(raw: string, options: HostGuardOptions): GuardDecision {
  try {
    return evaluateCodexHook(JSON.parse(raw), options);
  } catch {
    return invalidHookDecision(options);
  }
}

function printStatus(stdout: WritableLike, status: ReturnType<typeof codexHooksStatus>, json: boolean): void {
  if (json) {
    stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  stdout.write(`Codex Baton guard: ${status.installed ? "configured" : "missing"}; ${status.operational ? "operational" : "not operational"}\n`);
  stdout.write(`  hooks: ${status.display_path}\n`);
  stdout.write(`  events: ${status.events.length ? status.events.join(", ") : "none"}\n`);
  stdout.write(`  command: ${status.command || "none"}\n`);
  if (status.operational_error) stdout.write(`  error: ${status.operational_error}\n`);
  stdout.write(`  trust: run ${status.trust_command} in Codex\n`);
  stdout.write("  limitation: specialized tool paths may opt out of the default hook path\n");
}

/** CLI entrypoint used by `baton guard status|install|hook`. */
export function runGuard(args: string[], options: GuardCommandOptions): number {
  const env = options.env || process.env;
  const sub = args[0] || "status";
  const json = args.includes("--json");
  if (sub === "status") {
    const status = codexHooksStatus({ cwd: options.cwd, env });
    printStatus(options.stdout, status, json);
    return status.operational ? 0 : 1;
  }
  if (sub === "install") {
    const result = installCodexHooks({ cwd: options.cwd, env });
    if (json) options.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      options.stdout.write(`Codex Baton guard: ${result.action} at ${result.display_path}\n`);
      options.stdout.write(`  trust: run ${result.trust_command} in Codex\n`);
      options.stdout.write("  limitation: specialized tool paths may opt out of the default hook path\n");
    }
    return result.operational ? 0 : 1;
  }
  if (sub === "hook") {
    const inputIndex = args.indexOf("--input");
    let raw = inputIndex >= 0 ? args[inputIndex + 1] || "" : options.stdin;
    if (raw == null) {
      try {
        raw = fs.readFileSync(0, "utf8");
      } catch {
        raw = "";
      }
    }
    const decision = jsonInput(raw, { cwd: options.cwd, env });
    options.stdout.write(`${JSON.stringify(decision.output)}\n`);
    return decision.allowed ? 0 : 0;
  }
  throw new Error("usage: baton guard status|install|hook [--json]");
}
