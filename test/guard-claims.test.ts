import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeGuardClaimForTurn,
  claimGuardTurn,
  guardClaimsPath,
  issueGuardContinuationClaim,
  issueGuardClaim,
  readGuardClaimState,
} from "../src/lib/guard-claims.js";
import { evaluatePreToolUse, HOST_GUARD_REASONS, type HostGuardState } from "../src/lib/host-guard.js";

describe("Codex guard turn claims", () => {
  it("persists only a digest, consumes once, and keeps the turn binding", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claims-"));
    const issued = issueGuardClaim({
      cwd,
      ticket_id: "spn-0001",
      reservation_id: "reservation-1",
      attempt: 1,
      host: "codex",
      now: "2026-08-26T00:00:00.000Z",
    });
    const persisted = fs.readFileSync(guardClaimsPath(cwd), "utf8");
    assert.doesNotMatch(persisted, new RegExp(issued.token));
    const claimed = claimGuardTurn(cwd, {
      token: issued.token,
      host: "codex",
      turn_id: "turn-1",
      now: "2026-08-26T00:00:01.000Z",
    });
    assert.equal(claimed.ok, true);
    assert.equal(activeGuardClaimForTurn(cwd, {
      host: "codex",
      turn_id: "turn-1",
      now: "2026-08-26T00:00:02.000Z",
    })?.ticket_id, "spn-0001");
    const replay = claimGuardTurn(cwd, {
      token: issued.token,
      host: "codex",
      turn_id: "turn-1",
      now: "2026-08-26T00:00:02.000Z",
    });
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.code, "REPLAY");
    // The launch token is expired by this point, but its consumed turn
    // binding remains usable until dispatch releases the ticket attempt.
    assert.equal(activeGuardClaimForTurn(cwd, {
      host: "codex",
      turn_id: "turn-1",
      now: "2026-08-26T00:02:00.000Z",
    })?.ticket_id, "spn-0001");
    assert.equal(readGuardClaimState(cwd).error, null);
  });

  it("rejects expiry and turn/host conflicts", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claims-expired-"));
    const issued = issueGuardClaim({
      cwd,
      ticket_id: "spn-0002",
      attempt: 1,
      host: "codex",
      now: "2026-08-26T00:00:00.000Z",
      ttl_ms: 100,
    });
    const expired = claimGuardTurn(cwd, {
      token: issued.token,
      host: "codex",
      turn_id: "turn-expired",
      now: "2026-08-26T00:00:00.200Z",
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.code, "EXPIRED");

    const conflict = issueGuardClaim({
      cwd,
      ticket_id: "spn-0003",
      attempt: 1,
      host: "codex",
      now: "2026-08-26T00:00:00.000Z",
    });
    const wrongHost = claimGuardTurn(cwd, {
      token: conflict.token,
      host: "claude",
      turn_id: "turn-conflict",
      now: "2026-08-26T00:00:01.000Z",
    });
    assert.equal(wrongHost.ok, false);
    if (!wrongHost.ok) assert.equal(wrongHost.code, "CONFLICT");
  });

  it("requires a worker claim before a guarded mutation and binds the turn", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claim-hook-"));
    const ticket = {
      id: "spn-0004",
      reservation_id: null,
      attempt: 1,
      status: "running",
      mode: "write",
      read_only: false,
      agent_id: null,
      host: "codex",
      dispatch_host: "codex",
      receipt_id: null,
      allowed_operations: ["write"],
      write_allowlist: ["src/index.ts"],
    };
    const state: HostGuardState = { active: true, initialized: true, tickets: [ticket], bindings: [], state_error: null };
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch" },
      cwd,
      turn_id: "turn-worker",
      agent_type: "worker",
    };
    const before = evaluatePreToolUse(event, { cwd, state, host: "codex", guard_mode: "enforce" });
    assert.equal(before.allowed, false);
    assert.equal(before.reason, HOST_GUARD_REASONS.claim_required);
    const issued = issueGuardClaim({ cwd, ticket_id: ticket.id, attempt: 1, host: "codex" });
    const after = evaluatePreToolUse({ ...event, baton_claim: issued.token }, { cwd, state, host: "codex", guard_mode: "enforce" });
    assert.equal(after.allowed, true);
    assert.equal(after.ticket_id, ticket.id);
    const continuation = evaluatePreToolUse(event, { cwd, state, host: "codex", guard_mode: "enforce" });
    assert.equal(continuation.allowed, true);
    const replay = evaluatePreToolUse({ ...event, baton_claim: issued.token, turn_id: "turn-next" }, { cwd, state, host: "codex", guard_mode: "enforce" });
    assert.equal(replay.allowed, false);
    assert.equal(replay.reason, HOST_GUARD_REASONS.claim_conflict);
  });

  it("consumes a claim command in PreToolUse using the payload turn_id", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claim-control-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claim-bin-"));
    fs.writeFileSync(path.join(bin, "baton"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { PATH: bin };
    const ticket = {
      id: "spn-control",
      reservation_id: null,
      attempt: 1,
      status: "running",
      mode: "write",
      read_only: false,
      agent_id: null,
      host: "codex",
      dispatch_host: "codex",
      receipt_id: null,
      allowed_operations: ["write"],
      write_allowlist: ["src/index.ts"],
    };
    const state: HostGuardState = { active: true, initialized: true, tickets: [ticket], bindings: [], state_error: null };
    const issued = issueGuardClaim({ cwd, ticket_id: ticket.id, attempt: 1, host: "codex", env });
    const claim = evaluatePreToolUse({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `baton guard claim --baton-claim ${issued.token}` },
      cwd,
      turn_id: "turn-control",
      agent_type: "worker",
    }, { cwd, env, executablePath: path.join(bin, "baton"), state, host: "codex", guard_mode: "enforce" });
    assert.equal(claim.allowed, true);
    assert.equal(claim.ticket_id, ticket.id);
    const mutation = evaluatePreToolUse({
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch" },
      cwd,
      turn_id: "turn-control",
      agent_type: "worker",
    }, { cwd, env, state, host: "codex", guard_mode: "enforce" });
    assert.equal(mutation.allowed, true);
  });

  it("consumes a dispatching claim without authorizing mutation until bind", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claim-dispatching-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claim-dispatching-bin-"));
    const executablePath = path.join(bin, "baton");
    fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { PATH: bin };
    const ticket = {
      id: "spn-dispatching-claim",
      reservation_id: "reservation-dispatching",
      attempt: 1,
      status: "dispatching",
      mode: "write",
      read_only: false,
      agent_id: null,
      host: "codex",
      dispatch_host: "codex",
      receipt_id: null,
      allowed_operations: ["write"],
      write_allowlist: ["src/index.ts"],
    };
    const state: HostGuardState = { active: true, initialized: true, tickets: [ticket], bindings: [], state_error: null };
    const issued = issueGuardClaim({ cwd, ticket_id: ticket.id, reservation_id: ticket.reservation_id, attempt: 1, host: "codex", env });
    const options = { cwd, env, executablePath, state, host: "codex" as const, guard_mode: "enforce" as const };
    const claim = evaluatePreToolUse({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `baton guard claim --baton-claim ${issued.token}` }, cwd, turn_id: "turn-dispatching", agent_type: "worker" }, options);
    assert.equal(claim.allowed, true);
    const mutation = () => evaluatePreToolUse({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" }, cwd, turn_id: "turn-dispatching", agent_type: "worker" }, options);
    assert.equal(mutation().allowed, false);
    ticket.status = "running";
    assert.equal(mutation().allowed, true);
  });

  it("requires an explicit continuation and supersedes the previous turn", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claims-continuation-"));
    const first = issueGuardClaim({
      cwd,
      ticket_id: "spn-continuation",
      attempt: 1,
      host: "codex",
      now: "2026-08-26T00:00:00.000Z",
      ttl_ms: 100,
    });
    assert.equal(claimGuardTurn(cwd, {
      token: first.token,
      host: "codex",
      turn_id: "turn-a",
      now: "2026-08-26T00:00:00.050Z",
    }).ok, true);
    const branch = issueGuardClaim({
      cwd,
      ticket_id: "spn-continuation",
      attempt: 1,
      host: "codex",
      now: "2026-08-26T00:00:01.000Z",
    });
    const branchClaim = claimGuardTurn(cwd, {
      token: branch.token,
      host: "codex",
      turn_id: "turn-b",
      now: "2026-08-26T00:00:01.010Z",
    });
    assert.equal(branchClaim.ok, false);
    if (!branchClaim.ok) assert.equal(branchClaim.code, "CONFLICT");

    const continuation = issueGuardContinuationClaim({
      cwd,
      ticket_id: "spn-continuation",
      attempt: 1,
      host: "codex",
      predecessor_turn_id: "turn-a",
      now: "2026-08-26T00:00:01.000Z",
    });
    assert.throws(() => issueGuardContinuationClaim({
      cwd,
      ticket_id: "spn-continuation",
      attempt: 1,
      host: "codex",
      predecessor_turn_id: "turn-a",
      now: "2026-08-26T00:00:01.001Z",
    }), /already pending/);
    assert.equal(claimGuardTurn(cwd, {
      token: continuation.token,
      host: "codex",
      turn_id: "turn-b",
      now: "2026-08-26T00:00:01.010Z",
    }).ok, true);
    assert.equal(activeGuardClaimForTurn(cwd, { host: "codex", turn_id: "turn-a" }), null);
    assert.equal(activeGuardClaimForTurn(cwd, { host: "codex", turn_id: "turn-b" })?.ticket_id, "spn-continuation");
  });

  it("recovers a stale state lock before a terminal cleanup/issue", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-claims-lock-"));
    const first = issueGuardClaim({ cwd, ticket_id: "spn-lock", attempt: 1, host: "codex" });
    const lock = `${guardClaimsPath(cwd)}.lock`;
    fs.writeFileSync(lock, "stale\n", "utf8");
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(lock, old, old);
    assert.doesNotThrow(() => issueGuardClaim({ cwd, ticket_id: "spn-lock-2", attempt: 1, host: "codex" }));
    assert.equal(fs.existsSync(lock), false);
    assert.ok(first.token);
  });
});
