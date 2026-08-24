import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluatePreToolUse,
  evaluateSubagentStart,
  HOST_GUARD_REASONS,
  isBatonControlPlaneCommand,
  type HostGuardState,
} from "../src/lib/host-guard.js";
import { currentBatonHookTargets } from "../src/lib/codex-hooks.js";

function state(tickets: HostGuardState["tickets"] = []): HostGuardState {
  return { active: true, initialized: true, tickets, bindings: [], state_error: null };
}

function event(tool_name: string, tool_input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { hook_event_name: "PreToolUse", tool_name, tool_input, cwd: "/workspace", ...extra };
}

const readTicket = {
  id: "spn-0001",
  status: "running",
  mode: "read-only",
  read_only: true,
  agent_id: "native-1",
  host: "codex",
  dispatch_host: "codex",
  receipt_id: "rcpt-spn-0001-a1",
  allowed_operations: ["read"],
  write_allowlist: [],
};

const writeTicket = {
  id: "spn-0002",
  status: "running",
  mode: "write",
  read_only: false,
  agent_id: "native-2",
  host: "codex",
  dispatch_host: "codex",
  receipt_id: "rcpt-spn-0002-a1",
  allowed_operations: ["write", "create"],
  write_allowlist: ["src/index.ts"],
};

describe("Baton Codex host guard", () => {
  it("denies direct director shell and code writes with deterministic JSON reasons", () => {
    const directShell = evaluatePreToolUse(event("Bash", { command: "git status" }), { state: state() });
    assert.equal(directShell.allowed, false);
    assert.equal(directShell.reason, HOST_GUARD_REASONS.director_shell);
    assert.deepEqual(directShell.output, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: HOST_GUARD_REASONS.director_shell,
      },
    });

    const patch = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }), { state: state() });
    assert.equal(patch.allowed, false);
    assert.equal(patch.reason, HOST_GUARD_REASONS.director_code_write);
    assert.equal((patch.output.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
  });

  it("allows only standalone Baton control-plane commands on the director", () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-control-bare-"));
    const bare = path.join(bareDir, "baton");
    fs.writeFileSync(bare, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bare, 0o755);
    assert.equal(isBatonControlPlaneCommand("baton dispatch next --host codex --json", { env: { PATH: bareDir } }), true);
    const current = currentBatonHookTargets()[0];
    assert.ok(current);
    assert.equal(isBatonControlPlaneCommand(current.executable + " guard status"), true);
    assert.equal(isBatonControlPlaneCommand("/tmp/baton guard status"), false);
    assert.equal(isBatonControlPlaneCommand("baton dispatch next; rm -rf src"), false);
    assert.equal(isBatonControlPlaneCommand("baton guard status\nrm -rf src"), false);
    assert.equal(isBatonControlPlaneCommand("echo baton dispatch next"), false);
    const allowed = evaluatePreToolUse(event("Bash", { command: current.executable + " guard status" }), { state: state() });
    assert.equal(allowed.allowed, true);
  });

  it("trusts configured bare Baton and current runtime/entry pairs only", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-control-plane-"));
    const runtime = path.join(cwd, "runtime");
    const entry = path.join(cwd, "bin", "baton.ts");
    const bareDir = path.join(cwd, "bin-on-path");
    const bare = path.join(bareDir, "baton");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(bareDir, { recursive: true });
    fs.writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(runtime, 0o755);
    fs.writeFileSync(entry, "export {}\n");
    fs.writeFileSync(bare, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bare, 0o755);
    const env = { PATH: bareDir };
    assert.equal(isBatonControlPlaneCommand("baton guard status", { env }), true);
    assert.equal(isBatonControlPlaneCommand(runtime + " " + entry + " guard status", {
      env,
      runtimePath: runtime,
      entryPath: entry,
    }), true);
    assert.equal(isBatonControlPlaneCommand("/tmp/baton guard status", { env }), false);
  });

  it("permits a reserved Agent call but denies the spawn-to-bind race", () => {
    const reserved = state([{
      ...readTicket,
      status: "dispatching",
      agent_id: null,
    }]);
    const spawn = evaluatePreToolUse(event("Agent", { prompt: "work for spn-0001" }), { state: reserved });
    assert.equal(spawn.allowed, true);
    assert.equal(spawn.ticket_id, "spn-0001");

    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "native-1",
      agent_type: "worker",
      session_id: "parent-session",
    }, { state: reserved });
    assert.equal(start.allowed, true);
    assert.match(String(start.output.hookSpecificOutput && (start.output.hookSpecificOutput as Record<string, unknown>).additionalContext), /PENDING_BIND/);

    const beforeBind = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: reserved });
    assert.equal(beforeBind.allowed, false);
    assert.equal(beforeBind.reason, HOST_GUARD_REASONS.spawn_bind_pending);
  });

  it("persists a SubagentStart turn association and maps release-shaped PreToolUse after bind", () => {
    const reserved = state([{ ...readTicket, status: "dispatching", agent_id: null }]);
    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      turn_id: "child-turn-1",
      agent_id: "native-1",
      agent_type: "worker",
      session_id: "root-turn",
    }, { state: reserved });
    assert.equal(start.allowed, true);
    assert.deepEqual(reserved.bindings, [{
      ticket_id: "spn-0001",
      agent_id: "native-1",
      turn_id: "child-turn-1",
      session_id: "root-turn",
      agent_type: "worker",
      state: "pending",
      observed_at: reserved.bindings[0].observed_at,
    }]);

    const beforeBind = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      turn_id: "child-turn-1",
      agent_type: "worker",
    }), { state: reserved });
    assert.equal(beforeBind.allowed, false);
    assert.equal(beforeBind.reason, HOST_GUARD_REASONS.spawn_bind_pending);

    reserved.tickets[0] = { ...reserved.tickets[0], status: "running", agent_id: "native-1" };
    const afterBind = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      turn_id: "child-turn-1",
      agent_type: "worker",
    }), { state: reserved });
    assert.equal(afterBind.allowed, true);
    assert.equal(afterBind.ticket_id, "spn-0001");
  });

  it("uses agent_id for current-source payloads and never lets the root turn borrow a child", () => {
    const bound = state([readTicket]);
    const currentSource = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      agent_id: "native-1",
      agent_type: "worker",
    }), { state: bound });
    assert.equal(currentSource.allowed, true);

    bound.bindings.push({
      ticket_id: "spn-0001",
      agent_id: "native-1",
      turn_id: "child-turn-1",
      session_id: "root-turn",
      agent_type: "worker",
      state: "bound",
      observed_at: "2026-08-24T00:00:00.000Z",
    });
    const root = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      turn_id: "root-turn",
      agent_type: "root",
    }), { state: bound });
    assert.equal(root.allowed, false);
    assert.equal(root.reason, HOST_GUARD_REASONS.director_shell);

    const rootBorrow = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      turn_id: "child-turn-1",
      agent_type: "root",
    }), { state: bound });
    assert.equal(rootBorrow.allowed, false);
    assert.equal(rootBorrow.reason, HOST_GUARD_REASONS.agent_identity_mismatch);
  });

  it("requires the reserved ticket in Agent task text when reservations are ambiguous", () => {
    const first = { ...readTicket, id: "spn-0001", status: "dispatching", agent_id: null };
    const second = { ...writeTicket, id: "spn-0002", status: "dispatching", agent_id: null };
    const ambiguous = evaluatePreToolUse(event("Agent", { prompt: "implement the change" }), {
      state: state([first, second]),
    });
    assert.equal(ambiguous.allowed, false);
    assert.equal(ambiguous.reason, HOST_GUARD_REASONS.ambiguous_reserved_ticket);

    const explicit = evaluatePreToolUse(event("Agent", { prompt: "implement spn-0002 change" }), {
      state: state([first, second]),
    });
    assert.equal(explicit.allowed, true);
    assert.equal(explicit.ticket_id, "spn-0002");
  });

  it("fails closed on malformed guard state", () => {
    const malformed = evaluatePreToolUse(event("Bash", { command: "npm test" }), {
      state: {
        active: true,
        initialized: true,
        tickets: [],
        bindings: [{} as never],
        state_error: null,
      },
    });
    assert.equal(malformed.allowed, false);
    assert.equal(malformed.reason, HOST_GUARD_REASONS.state_unavailable);
  });

  it("requires a bound identity and Receipt mode for worker writes", () => {
    const bound = state([readTicket, writeTicket]);
    const workerRead = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: bound });
    assert.equal(workerRead.allowed, true);

    const readPatch = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }, { agent_id: "native-1" }), { state: bound });
    assert.equal(readPatch.allowed, false);
    assert.equal(readPatch.reason, HOST_GUARD_REASONS.write_receipt_required);

    const writePatch = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }, { agent_id: "native-2" }), { state: bound });
    assert.equal(writePatch.allowed, true);
    const noIdentity = evaluatePreToolUse(event("Bash", { command: "npm test" }), { state: bound });
    assert.equal(noIdentity.allowed, false);
    assert.equal(noIdentity.reason, HOST_GUARD_REASONS.director_shell);
    const wrongIdentity = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-unknown" }), { state: bound });
    assert.equal(wrongIdentity.allowed, false);
    assert.equal(wrongIdentity.reason, HOST_GUARD_REASONS.agent_identity_mismatch);
  });

  it("does not permit child agents from a bound worker or unsupported identity-free starts", () => {
    const bound = state([readTicket]);
    const nested = evaluatePreToolUse(event("Agent", { prompt: "spawn another" }, { agent_id: "native-1" }), { state: bound });
    assert.equal(nested.allowed, false);
    assert.equal(nested.reason, HOST_GUARD_REASONS.nested_agent);
    const missingIdentity = evaluateSubagentStart({ hook_event_name: "SubagentStart", cwd: "/workspace" }, { state: bound });
    assert.equal(missingIdentity.allowed, false);
    assert.equal(missingIdentity.reason, HOST_GUARD_REASONS.agent_identity_required);
  });
});

describe("host guard host scoping", () => {
  const claudeTicket = { ...readTicket, id: "spn-0100", agent_id: "a1c6c56", host: "claude", dispatch_host: "claude" };
  const claudeReserved = { ...claudeTicket, id: "spn-0101", status: "dispatching", agent_id: null };

  it("serves only the requesting host's running ticket", () => {
    const both = state([readTicket, claudeTicket]);
    // The Claude guard accepts its own bound worker.
    const own = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "a1c6c56" }), { state: both, host: "claude" });
    assert.equal(own.allowed, true);
    assert.equal(own.ticket_id, "spn-0100");
    // The same guard must not satisfy itself with a Codex ticket.
    const foreign = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: both, host: "claude" });
    assert.equal(foreign.allowed, false);
    // And the Codex guard must not accept a Claude worker.
    const reverse = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "a1c6c56" }), { state: both, host: "codex" });
    assert.equal(reverse.allowed, false);
  });

  it("gates child agents against reservations from the same host only", () => {
    const claudeOnly = state([claudeReserved]);
    const allowed = evaluatePreToolUse(event("Agent", { prompt: "run the ticket" }), { state: claudeOnly, host: "claude" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.ticket_id, "spn-0101");
    // A Codex guard sees no reservation of its own, so it fails closed.
    const denied = evaluatePreToolUse(event("Agent", { prompt: "run the ticket" }), { state: claudeOnly, host: "codex" });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, HOST_GUARD_REASONS.no_reserved_ticket);
  });

  it("records a SubagentStart identity only for its own host reservation", () => {
    const claudeOnly = state([claudeReserved]);
    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "a2a931ffa6c987fbd",
      agent_type: "baton-probe",
    }, { state: claudeOnly, host: "claude" });
    assert.equal(start.allowed, true);
    assert.equal(start.ticket_id, "spn-0101");
    assert.equal(start.agent_id, "a2a931ffa6c987fbd");
    // SubagentStart cannot cancel, so it only reports the pending bind.
    assert.equal(start.output.hookSpecificOutput?.additionalContext, "BATON_GUARD_SUBAGENT_PENDING_BIND");

    const wrongHost = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "a2a931ffa6c987fbd",
      agent_type: "baton-probe",
    }, { state: state([claudeReserved]), host: "codex" });
    assert.equal(wrongHost.allowed, false);
    assert.equal(wrongHost.reason, HOST_GUARD_REASONS.no_reserved_ticket);
  });

  it("keeps the legacy unqualified hook install scoped to Codex", () => {
    const both = state([readTicket, claudeTicket]);
    const legacy = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: both });
    assert.equal(legacy.allowed, true);
    assert.equal(legacy.ticket_id, "spn-0001");
  });
});
