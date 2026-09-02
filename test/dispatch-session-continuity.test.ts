import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindAgent, dispatchSnapshot, finishAgent, releaseAgent, reportAgentProbe, reserveNext } from "../src/lib/dispatch.js";
import { buildReadOnlyReceipt, buildWriteReceipt, writeReceipt } from "../src/lib/receipt.js";
import { markRouteExhausted } from "../src/lib/model-availability.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { captureBaseline } from "../src/lib/safety.js";
import { buildSpawnTicket, nextSpawnId, readSpawn, sessionUid, writeSpawn, type NativeExecutionHandle, type SpawnTicket } from "../src/lib/spawn.js";
import { SessionScopeError } from "../src/lib/session-scope.js";
import { spawnsDir } from "../src/lib/paths.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";
import type { ModelSelectionApproval } from "../src/types.js";

function newCwd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function queuedTicket(cwd: string, env: NodeJS.ProcessEnv, route = "alpha/default"): SpawnTicket {
  const id = nextSpawnId(cwd, "spn", env);
  return buildSpawnTicket({
    cwd,
    env,
    id,
    description: "session continuity test",
    prompt: "session continuity test",
    modelId: route,
    routeId: route,
    taskKind: "concrete",
    targetHost: "alpha",
  });
}

function dispatchingTicket(cwd: string, env: NodeJS.ProcessEnv): SpawnTicket {
  const ticket = queuedTicket(cwd, env);
  ticket.status = "dispatching";
  ticket.target_host = "alpha";
  ticket.dispatch_host = "alpha";
  ticket.dispatch_requested_at = ticket.created_at;
  ticket.attempt = 1;
  ticket.reservation_id = "reservation-session-continuity";
  ticket.history.push({ event: "dispatch_reserved", at: ticket.created_at });
  return ticket;
}

function gitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "baton@test"], { cwd });
  execFileSync("git", ["config", "user.name", "Baton Test"], { cwd });
  fs.writeFileSync(path.join(cwd, "allowed.txt"), "baseline\n");
  execFileSync("git", ["add", "allowed.txt"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd });
}

function selection(route: string): ModelSelectionApproval {
  return {
    host: "alpha",
    proposal_id: "proposal-session-continuity",
    approval_id: "approval-session-continuity",
    approved_at: "2026-08-27T00:00:00.000Z",
    confirmed_by: "baton-recommendation",
    catalog_fingerprint: "session-continuity-catalog",
    recommended_model_id: route,
    selected_model_id: route,
    changed_by_user: false,
  };
}

describe("dispatch session continuity", () => {
  it("keeps root and descendant tickets in one immutable tree", () => withHome((home) => {
    const cwd = newCwd("baton-dispatch-session-root-");
    const env = fakeEnv(home, { BATON_SESSION_ID: "root-agent-tree" });
    const rootTicket = queuedTicket(cwd, env);
    writeSpawn(cwd, rootTicket, env);
    const directDescendant = queuedTicket(cwd, env);
    writeSpawn(cwd, directDescendant, env);
    const nestedDescendant = queuedTicket(cwd, env);
    writeSpawn(cwd, nestedDescendant, env);

    assert.equal(rootTicket.session_uid, sessionUid(env));
    assert.deepEqual(
      [rootTicket, directDescendant, nestedDescendant].map((ticket) => ticket.session_uid),
      [rootTicket.session_uid, rootTicket.session_uid, rootTicket.session_uid],
    );
    assert.deepEqual(
      [rootTicket, directDescendant, nestedDescendant].map((ticket) => ticket.session_ordinal),
      [1, 2, 3],
    );
  }));

  it("rejects a capacity-sensitive dispatch without a tree identity before mutation", async () => withHome(async (home) => {
    const cwd = newCwd("baton-dispatch-session-missing-");
    const env = fakeEnv(home, { BATON_SESSION_ID: "" });
    await assert.rejects(
      reserveNext(cwd, { capacity: 2, host: "alpha", env }),
      (error: unknown) => error instanceof SessionScopeError && error.code === "SESSION_SCOPE_REQUIRED",
    );
    assert.equal(fs.existsSync(spawnsDir(cwd, env)), false);
    assert.throws(() => dispatchSnapshot(cwd, { capacity: 2, host: "alpha", env }), (error: unknown) => (
      error instanceof SessionScopeError && error.code === "SESSION_SCOPE_REQUIRED"
    ));
  }));

  it("rejects a mismatched lifecycle caller without changing the target ticket", () => withHome((home) => {
    const cwd = newCwd("baton-dispatch-session-mismatch-");
    const ownerEnv = fakeEnv(home, { BATON_SESSION_ID: "owner-tree" });
    const otherEnv = fakeEnv(home, { BATON_SESSION_ID: "other-tree" });
    const ticket = queuedTicket(cwd, ownerEnv);
    writeSpawn(cwd, ticket, ownerEnv);
    const file = path.join(spawnsDir(cwd, ownerEnv), `${ticket.id}.json`);
    const before = fs.readFileSync(file, "utf8");

    assert.throws(() => bindAgent(cwd, ticket.id, {
      executionHandle: { kind: "alpha-task", value: "other-handle", source: "manual" },
      host: "alpha",
      env: otherEnv,
    }), (error: unknown) => error instanceof SessionScopeError && error.code === "SESSION_SCOPE_MISMATCH");
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(readSpawn(cwd, ticket.id, ownerEnv).status, "queued");
  }));

  it("does not let a forged later environment value rewrite a captured ticket", () => withHome((home) => {
    const cwd = newCwd("baton-dispatch-session-forged-");
    const ownerEnv = fakeEnv(home, { BATON_SESSION_ID: "owner-tree" });
    const ticket = queuedTicket(cwd, ownerEnv);
    writeSpawn(cwd, ticket, ownerEnv);
    const file = path.join(spawnsDir(cwd, ownerEnv), `${ticket.id}.json`);
    const before = fs.readFileSync(file, "utf8");
    const forgedLaterEnv = { ...ownerEnv, BATON_SESSION_ID: "forged-later-value" };
    ticket.status = "dispatching";

    assert.throws(() => writeSpawn(cwd, ticket, forgedLaterEnv), (error: unknown) => (
      error instanceof SessionScopeError && error.code === "SESSION_SCOPE_MISMATCH"
    ));
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(readSpawn(cwd, ticket.id, ownerEnv).status, "queued");
  }));

  it("rejects an errored finish without explicit failure evidence", async () => withHome(async (home) => {
    const cwd = newCwd("baton-dispatch-session-fail-evidence-");
    const env = fakeEnv(home, { BATON_SESSION_ID: "fail-evidence-tree" });
    const ticket = dispatchingTicket(cwd, env);
    writeSpawn(cwd, ticket, env);

    await assert.rejects(
      finishAgent(cwd, ticket.id, { status: "errored", host: "alpha", env }),
      (error: unknown) => (error as { code?: string }).code === "ERROR_CODE_REQUIRED",
    );
    await assert.rejects(
      finishAgent(cwd, ticket.id, { status: "errored", errorCode: "NATIVE_EXECUTION_FAILED", errorMessage: "  ", host: "alpha", env }),
      (error: unknown) => (error as { code?: string }).code === "ERROR_MESSAGE_REQUIRED",
    );
    assert.equal(readSpawn(cwd, ticket.id, env).status, "dispatching");
  }));

  it("reconnects to the persisted native handle and completes the same ticket", async () => withHome(async (home) => {
    const cwd = newCwd("baton-dispatch-session-reconnect-");
    const env = fakeEnv(home, { BATON_SESSION_ID: "reconnect-tree" });
    const ticket = dispatchingTicket(cwd, env);
    writeSpawn(cwd, ticket, env);
    const bound = bindAgent(cwd, ticket.id, {
      executionHandle: { kind: "alpha-task", value: "reconnect-handle", source: "native-return" },
      host: "alpha",
      env,
    });
    const reconnectHandle = structuredClone(readSpawn(cwd, ticket.id, env).execution_handle) as NativeExecutionHandle;
    assert.deepEqual(reconnectHandle, bound.execution_handle);
    const probed = reportAgentProbe(cwd, ticket.id, {
      executionHandle: reconnectHandle,
      state: "running",
      host: "alpha",
      env,
    });
    assert.equal(probed.liveness?.execution_handle.value, "reconnect-handle");
    const completed = await finishAgent(cwd, ticket.id, {
      status: "completed",
      conclusion: "reconnected and completed",
      host: "alpha",
      env,
    });
    assert.equal(completed.status, "completed");
    const released = releaseAgent(cwd, ticket.id, { executionHandle: reconnectHandle, host: "alpha", env });
    assert.equal(released.slot_released_at !== undefined, true);
    assert.equal(readSpawn(cwd, ticket.id, env).session_uid, ticket.session_uid);
  }));

  it("creates a quota successor in the originating session with the next ordinal", async () => withHome(async (home) => {
    const cwd = newCwd("baton-dispatch-session-successor-");
    gitRepo(cwd);
    const env = fakeEnv(home, { BATON_SESSION_ID: "quota-tree" });
    const exhaustedRoute = "alpha/first";
    const successorRoute = "alpha/second";
    configureCli(cwd, env, "alpha", [exhaustedRoute, successorRoute]);
    publishRouteSnapshot(cwd, {
      models: [
        { id: exhaustedRoute, route_id: exhaustedRoute, provider: "alpha", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" },
        { id: successorRoute, route_id: successorRoute, provider: "alpha", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
      ],
    }, new Date("2026-08-27T00:00:00.000Z"), { cli: "alpha", host: "alpha", env });
    const id = nextSpawnId(cwd, "spn", env);
    const approved = selection(exhaustedRoute);
    const ticket = buildSpawnTicket({
      cwd,
      env,
      id,
      description: "quota successor continuity",
      prompt: "quota successor continuity",
      modelId: exhaustedRoute,
      routeId: exhaustedRoute,
      taskKind: "concrete",
      selection: approved,
      targetHost: "alpha",
    });
    const baseReceipt = buildReadOnlyReceipt({
      ticketId: id,
      card: { id: exhaustedRoute, strengths: "fixture", route_id: exhaustedRoute, provider: "alpha" },
      issuedAt: ticket.created_at,
      selection: approved,
      host: "alpha",
    });
    const receipt = buildWriteReceipt({
      base: baseReceipt,
      baseline: captureBaseline(cwd),
      writeAllowlist: ["allowed.txt"],
      allowedOperations: ["write"],
    });
    ticket.receipt_id = receipt.receipt_id;
    ticket.mode = "write";
    ticket.read_only = false;
    ticket.status = "running";
    ticket.host = "alpha";
    ticket.target_host = "alpha";
    ticket.started_at = ticket.created_at;
    ticket.execution_handle = { kind: "alpha-task", value: "quota-handle", source: "native-return" };
    ticket.routing_requirements = { required_reasoning_effort: "high", estimated_context_tokens: null };
    Object.assign(ticket, {
      successor_exclusion_matrix: [{ codes: ["OLD"], reasons: ["old attempt"] }],
      successor_safety_verdict: { accepted: false },
      replan_required: true,
      replan_reason: "OLD_REPLAN",
      semantic_replan_reason: "OLD_SEMANTIC_REPLAN",
      plan_insufficient_evidence: { file: "old.ts", symbol: "old", missing_decision: "old" },
      plan_insufficient_host_error: { code: "OLD_HOST_ERROR" },
    });
    ticket.history.push({ event: "agent_bound", at: ticket.created_at });
    writeReceipt(cwd, receipt, env);
    writeSpawn(cwd, ticket, env);
    markRouteExhausted(cwd, { host: "alpha", routeId: exhaustedRoute }, {
      reason: "MODEL_QUOTA_EXHAUSTED",
      resetAt: "2026-09-01T00:00:00.000Z",
      now: "2026-08-27T00:01:00.000Z",
      env,
    });

    const finished = await finishAgent(cwd, ticket.id, {
      status: "errored",
      errorCode: "MODEL_QUOTA_EXHAUSTED",
      errorMessage: "model quota exhausted",
      remainingPercent: 0,
      resetAt: "2026-09-01T00:00:00.000Z",
      host: "alpha",
      now: "2026-08-27T00:02:00.000Z",
      env,
    });
    assert.equal(finished.status, "errored");
    assert.equal(finished.successor_id !== undefined, true);
    const successor = readSpawn(cwd, finished.successor_id!, env);
    assert.equal(successor.session_uid, ticket.session_uid);
    assert.equal(successor.session_ordinal, ticket.session_ordinal + 1);
    assert.equal(successor.successor_from_ticket_id, ticket.id);
    assert.equal(successor.route_id, successorRoute);
    assert.equal(successor.reasoning_effort, "high");
    assert.equal(successor.status, "queued");
    for (const field of [
      "successor_exclusion_matrix", "successor_safety_verdict", "replan_required", "replan_reason",
      "semantic_replan_reason", "plan_insufficient_evidence", "plan_insufficient_host_error",
    ]) assert.equal(successor[field], undefined, field);
  }));

  it("keeps ordinals independent and contiguous for interleaved sessions", () => withHome((home) => {
    const cwd = newCwd("baton-dispatch-session-ordinals-");
    const firstEnv = fakeEnv(home, { BATON_SESSION_ID: "first-tree" });
    const secondEnv = fakeEnv(home, { BATON_SESSION_ID: "second-tree" });
    const first = queuedTicket(cwd, firstEnv);
    writeSpawn(cwd, first, firstEnv);
    const second = queuedTicket(cwd, secondEnv);
    writeSpawn(cwd, second, secondEnv);
    const firstAgain = queuedTicket(cwd, firstEnv);
    writeSpawn(cwd, firstAgain, firstEnv);
    const secondAgain = queuedTicket(cwd, secondEnv);
    writeSpawn(cwd, secondAgain, secondEnv);

    assert.deepEqual([first.session_ordinal, firstAgain.session_ordinal], [1, 2]);
    assert.deepEqual([second.session_ordinal, secondAgain.session_ordinal], [1, 2]);
    assert.notEqual(first.session_uid, second.session_uid);
    assert.equal(nextSpawnId(cwd, "os", firstEnv), `os-${first.session_uid}-0003`);
    assert.equal(nextSpawnId(cwd, "os", secondEnv), `os-${second.session_uid}-0003`);
  }));

  it("does not reuse an ordinal hidden by a corrupt current-session ticket", () => withHome((home) => {
    const cwd = newCwd("baton-dispatch-session-corrupt-ordinal-");
    const env = fakeEnv(home, { BATON_SESSION_ID: "corrupt-ordinal-tree" });
    const uid = sessionUid(env);
    const directory = spawnsDir(cwd, env);
    fs.mkdirSync(directory, { recursive: true });
    const corruptPath = path.join(directory, `spn-${uid}-0007.json`);
    const corruptBytes = "{\"schema_version\":8,\"corrupt\":true}\n";
    fs.writeFileSync(corruptPath, corruptBytes);

    const id = nextSpawnId(cwd, "spn", env);
    assert.equal(id, `spn-${uid}-0008`);
    const next = buildSpawnTicket({ cwd, env, id, description: "after corrupt ticket", prompt: "after corrupt ticket", modelId: "alpha/default", routeId: "alpha/default", taskKind: "concrete", targetHost: "alpha" });
    writeSpawn(cwd, next, env);
    assert.equal(fs.readFileSync(corruptPath, "utf8"), corruptBytes);
  }));
});
