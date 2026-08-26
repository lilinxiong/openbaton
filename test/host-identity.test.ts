import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  hostIdentityStatePath,
  clearNativeIdentity,
  observedNativeIdentity,
  readHostIdentityState,
  recordNativeIdentity,
  recordPendingReservation,
  recordPendingReservationExclusive,
  nativeHookIdentity,
  nativeToolReturnIdentity,
  reservationContextMatchesForHost,
  resolveNativeWorkerIdentity,
} from "../src/lib/host-identity.js";
import { evaluatePreToolUse, evaluateSubagentStart, HOST_GUARD_REASONS, type HostGuardState } from "../src/lib/host-guard.js";
import { withDispatchReservationEnvelope } from "../src/lib/dispatch-reservation.js";

const cwd = process.cwd();

function envForTest(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "baton-identity-home-")) };
}

function reservation(index: number, host = "codex") {
  return {
    schema: 1 as const,
    reservation_id: `reservation-${host}-${index}`,
    ticket_id: `ticket-${host}-${index}`,
    attempt: 1,
    host,
  };
}

function reservedTicket(index: number, host: string) {
  const identity = reservation(index, host);
  return {
    id: identity.ticket_id,
    reservation_id: identity.reservation_id,
    attempt: identity.attempt,
    status: "dispatching",
    mode: "read-only",
    read_only: true,
    agent_id: null,
    host,
    dispatch_host: host,
    receipt_id: null,
    allowed_operations: ["read"],
    write_allowlist: [],
  };
}

function reservedAgentEvent(ticket: ReturnType<typeof reservedTicket>) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      prompt: withDispatchReservationEnvelope("run the reserved unit", {
        schema: 1,
        reservation_id: ticket.reservation_id!,
        ticket_id: ticket.id,
        attempt: ticket.attempt,
        host: ticket.host!,
      }),
    },
    cwd,
    transcript_path: `/tmp/${ticket.id}.json`,
    turn_id: `turn-${ticket.id}`,
  };
}

describe("host identity ledger", () => {
  it("keeps earlier observations when a later reservation is recorded", () => {
    const env = envForTest();
    const first = recordPendingReservation(cwd, reservation(1), {}, undefined, env);
    recordNativeIdentity(cwd, first, "codex-agent-1", "hook", {}, undefined, env);
    recordPendingReservation(cwd, reservation(2), {}, undefined, env);

    const state = readHostIdentityState(cwd, env).state;
    assert.deepEqual(state.pending.map((item) => item.ticket_id), ["ticket-codex-2"]);
    assert.deepEqual(state.observed.map((item) => item.agent_id), ["codex-agent-1"]);
  });

  it("keeps contradictory identities fail-closed instead of overwriting evidence", () => {
    const env = envForTest();
    const pending = recordPendingReservation(cwd, reservation(3), {}, undefined, env);
    recordNativeIdentity(cwd, pending, "codex-agent-a", "hook", {}, undefined, env);
    recordNativeIdentity(cwd, pending, "codex-agent-b", "hook", {}, undefined, env);

    assert.equal(observedNativeIdentity(cwd, {
      ticket_id: pending.ticket_id,
      host: pending.host,
      reservation_id: pending.reservation_id,
      attempt: pending.attempt,
    }, env), null);
    assert.equal(readHostIdentityState(cwd, env).state.observed.length, 2);
  });

  it("serializes concurrent ledger writers without losing observations", async () => {
    const env = envForTest();
    const modulePath = path.join(cwd, "src/lib/host-identity.ts");
    const script = `
      import { recordPendingReservation, recordNativeIdentity } from ${JSON.stringify(modulePath)};
      const index = Number(process.env.BATON_WORKER_INDEX);
      const identity = { schema: 1, reservation_id: "concurrent-r-" + index, ticket_id: "concurrent-t-" + index, attempt: 1, host: "codex" };
      const pending = recordPendingReservation(${JSON.stringify(cwd)}, identity, {}, undefined, process.env);
      recordNativeIdentity(${JSON.stringify(cwd)}, pending, "concurrent-agent-" + index, "hook", {}, undefined, process.env);
    `;
    const workers = Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
      const child = spawn("bun", ["-e", script], {
        cwd,
        env: { ...env, BATON_WORKER_INDEX: String(index) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
    }));
    await Promise.all(workers);

    const state = readHostIdentityState(cwd, env).state;
    assert.equal(state.pending.length, 0);
    assert.equal(state.observed.length, 8);
    assert.ok(fs.existsSync(hostIdentityStatePath(cwd, env)));
  });

  it("accepts Codex task-name attachment and Cursor tool identity", () => {
    assert.equal(resolveNativeWorkerIdentity("codex", { callerIdentity: "task-token" }).code, "OK");
    assert.equal(resolveNativeWorkerIdentity("claude", { callerIdentity: "tool-token" }).code, "AGENT_IDENTITY_REQUIRED");
    assert.equal(resolveNativeWorkerIdentity("grok", { callerIdentity: "tool-token" }).code, "AGENT_IDENTITY_REQUIRED");
    assert.equal(resolveNativeWorkerIdentity("cursor", { callerIdentity: "tool-token" }).identity, "tool-token");
    assert.equal(resolveNativeWorkerIdentity("codex", {
      callerIdentity: "tool-token",
      observedIdentity: "forged-hook",
    }).code, "AGENT_IDENTITY_MISMATCH");
    assert.equal(resolveNativeWorkerIdentity("cursor", {
      observedIdentity: "copied-task",
    }).code, "AGENT_IDENTITY_MISMATCH");
  });

  it("uses only the current Codex identity carriers", () => {
    assert.equal(nativeHookIdentity("codex", { agent_id: "hook-agent" }), "hook-agent");
    assert.equal(nativeHookIdentity("codex", { agentId: "legacy-agent" }), null);
    assert.equal(nativeHookIdentity("codex", { tool_input: { agent_id: "nested-agent" } }), null);
    assert.equal(nativeToolReturnIdentity("codex", { task_name: "native-task" }), "native-task");
    assert.equal(nativeToolReturnIdentity("codex", { taskName: "native-task-alias" }), "native-task-alias");
  });

  it("matches Codex parent session and optional transcript without comparing turns", () => {
    const env = envForTest();
    const reservationContext = {
      session_id: "parent-session",
      transcript_path: "/tmp/parent-transcript.jsonl",
      turn_id: "parent-turn",
    };
    const pending = {
      ...recordPendingReservation(cwd, reservation(22), reservationContext, undefined, env),
    };
    assert.equal(pending.turn_id, null);
    assert.equal(Object.hasOwn(pending, "thread_id"), false);
    assert.equal(reservationContextMatchesForHost("codex", pending, {
      session_id: "parent-session",
      transcript_path: "/tmp/parent-transcript.jsonl",
      turn_id: "child-turn",
    }), true);
    assert.equal(reservationContextMatchesForHost("codex", pending, {
      session_id: "different-session",
      transcript_path: "/tmp/parent-transcript.jsonl",
      turn_id: "child-turn",
    }), false);
    assert.equal(reservationContextMatchesForHost("codex", pending, {
      session_id: "parent-session",
      turn_id: "child-turn",
    }), true);
    assert.equal(reservationContextMatchesForHost("codex", pending, {
      session_id: "parent-session",
      transcript_path: "/tmp/child-transcript.jsonl",
      turn_id: "child-turn",
    }), false);
  });

  it("requires causal lifecycle context instead of guessing the sole pending reservation", () => {
    const first = reservedTicket(20, "codex");
    const state: HostGuardState = { active: true, initialized: true, tickets: [first], bindings: [] };
    assert.equal(evaluatePreToolUse({
      ...reservedAgentEvent(first),
      session_id: "parent-session",
      tool_use_id: "agent-call-20",
    }, { state, host: "codex" }).allowed, true);

    const copied = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd,
      agent_id: "codex-agent-20",
      session_id: "different-session",
      description: withDispatchReservationEnvelope("copied", {
        schema: 1,
        reservation_id: first.reservation_id!,
        ticket_id: first.id,
        attempt: first.attempt,
        host: "codex",
      }),
    }, { state, host: "codex" });
    assert.equal(copied.allowed, false);

    const nestedCallerIdentity = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd,
      session_id: "parent-session",
      tool_input: { agent_id: "caller-forged" },
    }, { state, host: "codex" });
    assert.equal(nestedCallerIdentity.allowed, false);
    assert.equal(nestedCallerIdentity.reason, HOST_GUARD_REASONS.invalid_input);

    const correlated = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd,
      agent_id: "codex-agent-20",
      session_id: "parent-session",
      transcript_path: `/tmp/${first.id}.json`,
      turn_id: "child-turn",
    }, { state, host: "codex" });
    assert.equal(correlated.allowed, false);
    assert.equal(correlated.reason, HOST_GUARD_REASONS.invalid_input);
  });

  it("clears only current reservation state without extra metadata", () => {
    const env = envForTest();
    const pending = recordPendingReservation(cwd, reservation(21), { session_id: "session-21" }, undefined, env);
    clearNativeIdentity(cwd, {
      ticket_id: pending.ticket_id,
      host: pending.host,
      reservation_id: pending.reservation_id,
      attempt: pending.attempt,
    }, env);
    const cleared = readHostIdentityState(cwd, env).state;
    assert.deepEqual(cleared.pending, []);
    assert.deepEqual(cleared.observed, []);
    const reseeded = recordPendingReservationExclusive(cwd, reservation(21), { session_id: "session-21" }, null, undefined, env);
    assert.ok(reseeded);
    assert.deepEqual(Object.keys(readHostIdentityState(cwd, env).state).sort(), ["observed", "pending", "schema"]);
  });

  it("scopes the short handshake per host and releases Codex for parallel work after observation", () => {
    const codexFirst = reservedTicket(10, "codex");
    const codexSecond = reservedTicket(11, "codex");
    const claude = reservedTicket(12, "claude");
    const state: HostGuardState = { active: true, initialized: true, tickets: [codexFirst, codexSecond, claude], bindings: [] };

    assert.equal(evaluatePreToolUse({
      ...reservedAgentEvent(codexFirst),
      session_id: "codex-session",
      turn_id: "codex-turn",
    }, { state, host: "codex" }).allowed, true);
    // A Claude handshake must not be blocked by a pending Codex observation.
    assert.equal(evaluatePreToolUse(reservedAgentEvent(claude), { state, host: "claude" }).allowed, true);
    const codexBlocked = evaluatePreToolUse(reservedAgentEvent(codexSecond), { state, host: "codex" });
    assert.equal(codexBlocked.allowed, true);

    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd,
      agent_id: "codex-agent-10",
      agent_type: "worker",
      session_id: "codex-session",
      turn_id: "child-turn",
      transcript_path: `/tmp/${codexFirst.id}.json`,
    }, { state, host: "codex" });
    assert.equal(start.allowed, false);
    assert.equal(start.reason, HOST_GUARD_REASONS.invalid_input);
    state.tickets[0] = { ...state.tickets[0], status: "running", agent_id: "codex-agent-10" };
    const workerRead = evaluatePreToolUse({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      cwd,
      agent_id: "codex-agent-10",
    }, { state, host: "codex" });
    assert.equal(workerRead.allowed, true);
    assert.equal(evaluatePreToolUse(reservedAgentEvent(codexSecond), { state, host: "codex" }).allowed, true);
  });
});
