import fs from "node:fs";
import { codexHooksStatus, installCodexHooks } from "../lib/codex-hooks.js";
import { claudeHooksStatus, installClaudeHooks } from "../lib/claude-hooks.js";
import { grokHooksStatus, installGrokHooks } from "../lib/grok-hooks.js";
import { recordHookObservation } from "../lib/hook-observation.js";
import {
  evaluatePreToolUse,
  evaluateSubagentStart,
  HOST_GUARD_REASONS,
  normalizeHookInput,
  type GuardDecision,
  type HookInput,
  type HostGuardOptions,
} from "../lib/host-guard.js";
import type { WritableLike } from "../types.js";
import { listCliAdapters } from "../adapters/registry.js";
import { loadConfig } from "../lib/config.js";

/** Hosts that expose a hook surface Baton can enforce the director boundary on. */
export const GUARD_HOSTS = listCliAdapters()
  .filter((adapter) => adapter.host.guard)
  .map((adapter) => adapter.host.id);
export type GuardHostId = (typeof GUARD_HOSTS)[number];

function parseGuardHost(value: string | undefined): GuardHostId {
  const host = String(value || "codex").trim().toLowerCase();
  if ((GUARD_HOSTS as readonly string[]).includes(host)) return host as GuardHostId;
  throw new Error(`invalid guard host: ${value} (expected ${GUARD_HOSTS.join("|")})`);
}

function hostFlag(args: string[]): GuardHostId {
  const index = args.indexOf("--host");
  return parseGuardHost(index >= 0 ? args[index + 1] : undefined);
}

function valueFlag(args: string[], ...names: string[]): string | null {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1]) return String(args[index + 1]).trim() || null;
  }
  return null;
}

export const CODEX_GUARD_GUIDANCE = [
  "Codex hooks are non-managed until trusted.",
  "Open Codex `/hooks`, review the single scoped Baton-owned PreToolUse entry, and trust it when guard mode is enforce.",
  "Native task attachment does not depend on SubagentStart or Agent/spawn_agent interception.",
  "When guard mode is off, no Baton-owned Codex hooks are required; Receipt and terminal audit remain the safety evidence.",
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
  return String(normalizeHookInput(value).hook_event_name || "");
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
  if (isRecord(input)) {
    const host = String(options.host || "codex").trim().toLowerCase();
    const normalized = normalizeHookInput(input, host);
    const cwd = String(normalized.cwd || options.cwd || "").trim();
    if (cwd) {
      try {
        recordHookObservation(cwd, host, String(normalized.hook_event_name || "unknown"), options.now, options.env);
      } catch {
        // Observation is diagnostic telemetry; the guard decision remains
        // governed by the configured enforce/off posture.
      }
    }
  }
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
/** Both guard hosts share the same hook contract and decision policy. */
export const evaluateHostHook = evaluateCodexHook;

function jsonInput(raw: string, options: HostGuardOptions): GuardDecision {
  try {
    return evaluateCodexHook(JSON.parse(raw), options);
  } catch {
    return invalidHookDecision(options);
  }
}

type GuardStatus =
  | ReturnType<typeof codexHooksStatus>
  | ReturnType<typeof claudeHooksStatus>
  | ReturnType<typeof grokHooksStatus>;

function configuredGuardMode(host: GuardHostId, cwd: string, env: NodeJS.ProcessEnv): "enforce" | "off" {
  try {
    const profile = loadConfig(cwd, { env }).cli[host];
    return profile?.guard_mode === "off" ? "off" : "enforce";
  } catch {
    // Missing/unreadable config is a conservative enforce posture.
    return "enforce";
  }
}

function guardStatusFor(host: GuardHostId, options: { cwd: string; env: NodeJS.ProcessEnv; guardMode: "enforce" | "off" }): GuardStatus {
  if (host === "claude") return claudeHooksStatus(options);
  if (host === "grok") return grokHooksStatus(options);
  return codexHooksStatus({ ...options, guardMode: options.guardMode });
}

function installGuardFor(host: GuardHostId, options: { cwd: string; env: NodeJS.ProcessEnv; guardMode: "enforce" | "off" }) {
  if (host === "claude") return installClaudeHooks(options);
  if (host === "grok") return installGrokHooks(options);
  return installCodexHooks({ ...options, guardMode: options.guardMode });
}

function hostLabel(host: GuardHostId): string {
  if (host === "claude") return "Claude Code";
  if (host === "grok") return "Grok";
  return "Codex";
}

function printStatus(stdout: WritableLike, host: GuardHostId, status: GuardStatus, json: boolean): void {
  if (json) {
    stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  stdout.write(`${hostLabel(host)} Baton guard: ${status.installed ? "configured" : "missing"}; ${status.operational ? "operational" : "not operational"}\n`);
  stdout.write(`  hooks: ${status.display_path}\n`);
  stdout.write(`  events: ${status.events.length ? status.events.join(", ") : "none"}\n`);
  stdout.write(`  command: ${status.command || "none"}\n`);
  if ("guard_mode" in status) {
    const dispatch = status.core_dispatch_ready === "unknown"
      ? "unknown"
      : status.core_dispatch_ready ? "ready" : "not ready";
    const observation = status.recent_hook_observation === "unknown"
      ? "unknown"
      : status.recent_hook_observation ? "yes" : "no";
    stdout.write(`  guard mode: ${status.guard_mode}; core dispatch: ${dispatch}; hook coverage: ${status.coverage}; recent observation: ${observation}; audit-only: ${status.audit_only ? "yes" : "no"}\n`);
  }
  if (status.operational_error) stdout.write(`  error: ${status.operational_error}\n`);
  if (status.trust_required) stdout.write(`  trust: run ${status.trust_command} in ${hostLabel(host)}\n`);
  else stdout.write(`  trust: not required; ${host === "grok" ? "global Grok hooks apply directly" : "user settings hooks apply directly"} (review with ${status.trust_command})\n`);
  if (host === "claude") {
    stdout.write("  limitation: SubagentStart cannot cancel a child; PreToolUse is the enforcing gate\n");
  } else if (host === "grok") {
    stdout.write("  limitation: PreToolUse is the enforcing gate; vanilla OpenSpec apply is not rewritten\n");
  } else {
    stdout.write("  limitation: specialized tool paths may opt out of the default hook path\n");
  }
}

/** CLI entrypoint used by `baton guard status|install|claim|continuation|hook`. */
export function runGuard(args: string[], options: GuardCommandOptions): number {
  const env = options.env || process.env;
  const sub = args[0] || "status";
  const json = args.includes("--json");
  const host = hostFlag(args);
  const configuredMode = configuredGuardMode(host, options.cwd, env);
  if (sub === "status") {
    const status = guardStatusFor(host, { cwd: options.cwd, env, guardMode: configuredMode });
    printStatus(options.stdout, host, status, json);
    return status.operational ? 0 : 1;
  }
  if (sub === "install") {
    const result = installGuardFor(host, { cwd: options.cwd, env, guardMode: configuredMode });
    if (json) options.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      options.stdout.write(`${hostLabel(host)} Baton guard: ${result.action} at ${result.display_path}\n`);
      if (result.trust_required) options.stdout.write(`  trust: run ${result.trust_command} in ${hostLabel(host)}\n`);
      else options.stdout.write(`  trust: not required; ${host === "grok" ? "global Grok hooks apply directly" : "user settings hooks apply directly"} (review with ${result.trust_command})\n`);
      if (host === "claude") {
        options.stdout.write("  limitation: SubagentStart cannot cancel a child; PreToolUse is the enforcing gate\n");
      } else if (host === "grok") {
        options.stdout.write("  limitation: PreToolUse is the enforcing gate; vanilla OpenSpec apply is not rewritten\n");
      } else {
        options.stdout.write("  limitation: specialized tool paths may opt out of the default hook path\n");
      }
    }
    return result.operational ? 0 : 1;
  }
  if (sub === "claim" || sub === "continuation") {
    if (host !== "codex") throw new Error(`${sub} is only supported for --host codex`);
    const token = valueFlag(args, "--token", "--baton-claim");
    const turnId = valueFlag(args, "--turn-id", "--turn_id");
    if (!token) throw new Error(`usage: baton guard ${sub} --baton-claim TOKEN [--turn-id TURN_ID] [--ticket-id ID] [--attempt N] [--reservation-id ID]`);
    // A direct CLI invocation has no authoritative native turn. It is only an
    // acknowledgement; the synchronous PreToolUse hook must consume the same
    // token with the real payload turn_id before any mutation is allowed.
    if (!turnId) {
      const acknowledgement = { ok: true, acknowledged: true, binding: false, control_plane: sub };
      options.stdout.write(`${JSON.stringify(acknowledgement)}\n`);
      return 0;
    }
    // A CLI caller cannot supply the authoritative native hook turn. Refuse
    // the legacy manual-binding form instead of allowing it to consume a
    // capability; only synchronous PreToolUse may bind the real turn_id.
    const error = new Error("BATON_GUARD_HOOK_TURN_REQUIRED: --turn-id is only accepted from the synchronous hook") as Error & { code: string };
    error.code = "BATON_GUARD_HOOK_TURN_REQUIRED";
    throw error;
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
    const decision = jsonInput(raw, { cwd: options.cwd, env, host, guard_mode: configuredMode });
    options.stdout.write(`${JSON.stringify(decision.output)}\n`);
    return decision.allowed ? 0 : 0;
  }
  throw new Error(`usage: baton guard status|install|claim|continuation|hook [--host ${GUARD_HOSTS.join("|")}] [--json]`);
}
