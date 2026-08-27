import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindAgent,
  dispatchSnapshot,
  finishAgent,
  releaseAgent,
  reportAgentProbe,
  reportAgentProgress,
  withDispatchLockAsync,
} from "../src/lib/dispatch.js";
import { withActivationLockAsync } from "../src/lib/activation.js";
import { buildReadOnlyReceipt, buildWriteReceipt, writeReceipt } from "../src/lib/receipt.js";
import { captureBaseline, type GitBaseline } from "../src/lib/safety.js";
import { activationLockPath, dispatchLockPath, globalActivationLockPath, spawnsDir } from "../src/lib/paths.js";
import { buildSpawnTicket, nextSpawnId, readSpawn, writeSpawn, type SpawnTicket } from "../src/lib/spawn.js";
import { SessionScopeError } from "../src/lib/session-scope.js";
import { fakeEnv, withHome } from "./home.js";
import type { ModelSelectionApproval } from "../src/types.js";

const HOST = "alpha";
const ROUTE = "alpha/default";

function newCwd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repositoryFixture(): string {
  const cwd = newCwd("baton-cross-tree-runtime-");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "baton@test");
  git(cwd, "config", "user.name", "Baton Test");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".baton/\n");
  fs.writeFileSync(path.join(cwd, "owner.txt"), "owner baseline\n");
  fs.writeFileSync(path.join(cwd, "peer.txt"), "peer baseline\n");
  fs.writeFileSync(path.join(cwd, "foreign.txt"), "foreign baseline\n");
  git(cwd, "add", ".gitignore", "owner.txt", "peer.txt", "foreign.txt");
  git(cwd, "commit", "-q", "-m", "baseline");
  return cwd;
}

function selection(): ModelSelectionApproval {
  return {
    host: HOST,
    proposal_id: "proposal-cross-tree-runtime",
    approval_id: "approval-cross-tree-runtime",
    approved_at: "2026-08-27T00:00:00.000Z",
    confirmed_by: "baton-recommendation",
    catalog_fingerprint: "cross-tree-runtime-catalog",
    recommended_model_id: ROUTE,
    selected_model_id: ROUTE,
    changed_by_user: false,
  };
}

function dispatchingTicket(cwd: string, env: NodeJS.ProcessEnv, taskKind: "concrete" | "deliberative" = "concrete"): SpawnTicket {
  const id = nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    cwd,
    env,
    id,
    description: "cross-tree runtime boundary regression",
    prompt: "cross-tree runtime boundary regression",
    modelId: ROUTE,
    routeId: ROUTE,
    taskKind,
    selection: selection(),
    targetHost: HOST,
    now: "2026-08-27T00:00:00.000Z",
  });
  ticket.status = "dispatching";
  ticket.dispatch_host = HOST;
  ticket.dispatch_requested_at = ticket.created_at;
  ticket.attempt = 1;
  ticket.reservation_id = `reservation-${id}`;
  ticket.history.push({ event: "dispatch_reserved", at: ticket.created_at });
  writeSpawn(cwd, ticket, env);
  return ticket;
}

function dispatchingWriteTicket(
  cwd: string,
  env: NodeJS.ProcessEnv,
  baseline: GitBaseline,
  writeAllowlist: string[],
  handleValue: string,
): SpawnTicket {
  const id = nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    cwd,
    env,
    id,
    description: "cross-tree terminal audit regression",
    prompt: "cross-tree terminal audit regression",
    modelId: ROUTE,
    routeId: ROUTE,
    taskKind: "concrete",
    selection: selection(),
    targetHost: HOST,
    now: "2026-08-27T00:00:00.000Z",
  });
  const base = buildReadOnlyReceipt({
    ticketId: id,
    card: { id: ROUTE, strengths: "fixture", route_id: ROUTE, provider: HOST },
    issuedAt: ticket.created_at,
    selection: ticket.selection,
    host: HOST,
  });
  const receipt = buildWriteReceipt({
    base,
    baseline,
    writeAllowlist,
    allowedOperations: ["write"],
  });
  ticket.receipt_id = receipt.receipt_id;
  ticket.mode = "write";
  ticket.read_only = false;
  ticket.status = "dispatching";
  ticket.dispatch_host = HOST;
  ticket.dispatch_requested_at = ticket.created_at;
  ticket.attempt = 1;
  ticket.reservation_id = `reservation-${id}`;
  ticket.history.push({ event: "dispatch_reserved", at: ticket.created_at });
  writeReceipt(cwd, receipt, env);
  writeSpawn(cwd, ticket, env);
  return bindAgent(cwd, id, {
    executionHandle: { kind: "alpha-task", value: handleValue, source: "native-return" },
    host: HOST,
    env,
    now: "2026-08-27T00:00:01.000Z",
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function isSessionMismatch(error: unknown): boolean {
  return error instanceof SessionScopeError && error.code === "SESSION_SCOPE_MISMATCH";
}

describe("cross-tree runtime safety boundaries", () => {
  it("uses one canonical repository baseline for two sessions", () => withHome((home) => {
    const cwd = repositoryFixture();
    const firstEnv = fakeEnv(home, { BATON_SESSION_ID: "repository-baseline-first" });
    const secondEnv = fakeEnv(home, { BATON_SESSION_ID: "repository-baseline-second" });
    try {
      const capturedAt = new Date("2026-08-27T00:00:00.000Z");
      const first = captureBaseline(cwd, capturedAt);
      const second = captureBaseline(cwd, capturedAt);

      assert.notEqual(firstEnv.BATON_SESSION_ID, secondEnv.BATON_SESSION_ID);
      assert.deepEqual(second, first, "session identity must not fork the repository safety baseline");
      assert.equal(first.repo_root, fs.realpathSync(cwd));
      assert.equal(first.head, git(cwd, "rev-parse", "HEAD").trim());
      assert.deepEqual(first.dirty_entries, []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("keeps terminal safety audit workspace-wide across two session trees", async () => withHome(async (home) => {
    const cwd = repositoryFixture();
    const ownerEnv = fakeEnv(home, { BATON_SESSION_ID: "terminal-audit-owner" });
    const peerEnv = fakeEnv(home, { BATON_SESSION_ID: "terminal-audit-peer" });
    try {
      const capturedAt = new Date("2026-08-27T00:00:00.000Z");
      const ownerBaseline = captureBaseline(cwd, capturedAt);
      const peerBaseline = captureBaseline(cwd, capturedAt);
      const owner = dispatchingWriteTicket(cwd, ownerEnv, ownerBaseline, ["owner.txt"], "owner-terminal");
      const peer = dispatchingWriteTicket(cwd, peerEnv, peerBaseline, ["peer.txt"], "peer-terminal");
      assert.notEqual(owner.session_uid, peer.session_uid);

      // The peer's allowlisted dirt belongs to its own audit; unrelated dirt
      // must still be visible to the owner's terminal safety gate.
      fs.appendFileSync(path.join(cwd, "peer.txt"), "peer session write\n");
      fs.appendFileSync(path.join(cwd, "foreign.txt"), "unaffiliated write\n");
      const finished = await finishAgent(cwd, owner.id, {
        status: "completed",
        conclusion: "terminal audit should reject foreign repository dirt",
        host: HOST,
        env: ownerEnv,
        now: "2026-08-27T00:00:02.000Z",
      });

      assert.equal(finished.status, "errored");
      assert.equal(finished.error?.code, "WRITE_SCOPE_VIOLATION");
      assert.equal((finished.safety_verdict as { accepted?: boolean } | undefined)?.accepted, false);
      assert.ok(
        ((finished.safety_verdict as { violations?: Array<{ path?: string }> } | undefined)?.violations || [])
          .some((violation) => violation.path === "foreign.txt"),
      );
      assert.equal(readSpawn(cwd, peer.id, peerEnv).status, "running");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("serializes activation mutations across two sessions at host and project scope", async () => withHome(async (home) => {
    const cwd = newCwd("baton-cross-tree-activation-lock-");
    const firstEnv = fakeEnv(home, { BATON_SESSION_ID: "activation-first" });
    const secondEnv = fakeEnv(home, { BATON_SESSION_ID: "activation-second" });
    const order: string[] = [];
    try {
      await withActivationLockAsync(cwd, firstEnv, async () => {
        order.push("first-entered");
        assert.equal(fs.existsSync(globalActivationLockPath(HOST, firstEnv)), true);
        assert.equal(fs.existsSync(activationLockPath(cwd, firstEnv, HOST)), true);
        await assert.rejects(
          withActivationLockAsync(cwd, secondEnv, async () => {
            order.push("second-entered-while-held");
          }, { host: HOST, scope: "both" }),
          (error: unknown) => errorCode(error) === "ACTIVATION_LOCK_BUSY",
        );
        assert.deepEqual(order, ["first-entered"]);
      }, { host: HOST, scope: "both" });

      await withActivationLockAsync(cwd, secondEnv, async () => {
        order.push("second-entered-after-release");
      }, { host: HOST, scope: "both" });
      assert.deepEqual(order, ["first-entered", "second-entered-after-release"]);
      assert.equal(fs.existsSync(globalActivationLockPath(HOST, firstEnv)), false);
      assert.equal(fs.existsSync(activationLockPath(cwd, firstEnv, HOST)), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("serializes workspace dispatch mutations across two sessions", async () => withHome(async (home) => {
    const cwd = newCwd("baton-cross-tree-dispatch-lock-");
    const firstEnv = fakeEnv(home, { BATON_SESSION_ID: "dispatch-first" });
    const secondEnv = fakeEnv(home, { BATON_SESSION_ID: "dispatch-second" });
    const order: string[] = [];
    try {
      await withDispatchLockAsync(cwd, async () => {
        order.push("first-entered");
        assert.equal(fs.existsSync(dispatchLockPath(cwd, firstEnv)), true);
        await assert.rejects(
          withDispatchLockAsync(cwd, async () => {
            order.push("second-entered-while-held");
          }, { env: secondEnv }),
          (error: unknown) => errorCode(error) === "DISPATCH_LOCKED",
        );
        assert.deepEqual(order, ["first-entered"]);
      }, { env: firstEnv });

      await withDispatchLockAsync(cwd, async () => {
        order.push("second-entered-after-release");
      }, { env: secondEnv });
      assert.deepEqual(order, ["first-entered", "second-entered-after-release"]);
      assert.equal(fs.existsSync(dispatchLockPath(cwd, firstEnv)), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("keeps progress and liveness ticket-scoped while preserving both signals", () => withHome((home) => {
    const cwd = newCwd("baton-cross-tree-progress-");
    const ownerEnv = fakeEnv(home, { BATON_SESSION_ID: "progress-owner" });
    const otherEnv = fakeEnv(home, { BATON_SESSION_ID: "progress-other" });
    try {
      const ticket = dispatchingTicket(cwd, ownerEnv, "deliberative");
      const handle = { kind: "alpha-task" as const, value: "progress-handle", source: "native-return" as const };
      const bound = bindAgent(cwd, ticket.id, { executionHandle: handle, host: HOST, env: ownerEnv });
      assert.equal(bound.status, "running");
      assert.equal(bound.liveness?.sequence, 1);

      const file = path.join(spawnsDir(cwd, ownerEnv), `${ticket.id}.json`);
      const before = fs.readFileSync(file, "utf8");
      assert.throws(() => reportAgentProgress(cwd, ticket.id, {
        phase: "working",
        summary: "forged progress from another root",
        host: HOST,
        env: otherEnv,
      }), isSessionMismatch);
      assert.equal(fs.readFileSync(file, "utf8"), before);
      assert.throws(() => reportAgentProbe(cwd, ticket.id, {
        executionHandle: handle,
        state: "running",
        activity: "heartbeat",
        host: HOST,
        env: otherEnv,
      }), isSessionMismatch);
      assert.equal(fs.readFileSync(file, "utf8"), before);

      const progressed = reportAgentProgress(cwd, ticket.id, {
        phase: "working",
        summary: "owner progress",
        nextStep: "owner probe",
        host: HOST,
        env: ownerEnv,
        now: "2026-08-27T00:01:00.000Z",
      });
      assert.equal(progressed.progress?.sequence, 1);
      assert.equal(progressed.progress?.phase, "working");
      assert.equal(progressed.liveness?.sequence, 2);
      assert.equal(progressed.liveness?.activity, "output");

      const probed = reportAgentProbe(cwd, ticket.id, {
        executionHandle: handle,
        state: "running",
        activity: "heartbeat",
        host: HOST,
        env: ownerEnv,
        now: "2026-08-27T00:01:01.000Z",
      });
      assert.equal(probed.progress?.sequence, 1, "liveness must not erase business progress");
      assert.equal(probed.liveness?.sequence, 3);
      assert.equal(probed.liveness?.activity, "heartbeat");
      assert.deepEqual(
        probed.history.filter((entry) => entry.event === "agent_progress" || entry.event === "agent_probe").map((entry) => entry.event),
        ["agent_progress", "agent_probe"],
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));

  it("keeps release ownership and slot lifecycle unchanged across two sessions", async () => withHome(async (home) => {
    const cwd = newCwd("baton-cross-tree-release-");
    const ownerEnv = fakeEnv(home, { BATON_SESSION_ID: "release-owner" });
    const otherEnv = fakeEnv(home, { BATON_SESSION_ID: "release-other" });
    try {
      const queued = dispatchingTicket(cwd, ownerEnv);
      const handle = { kind: "alpha-task" as const, value: "release-handle", source: "native-return" as const };
      bindAgent(cwd, queued.id, { executionHandle: handle, host: HOST, env: ownerEnv });
      assert.equal(dispatchSnapshot(cwd, { capacity: 2, host: HOST, env: ownerEnv }).active, 1);

      const file = path.join(spawnsDir(cwd, ownerEnv), `${queued.id}.json`);
      const before = fs.readFileSync(file, "utf8");
      assert.throws(() => releaseAgent(cwd, queued.id, {
        executionHandle: handle,
        host: HOST,
        env: otherEnv,
      }), isSessionMismatch);
      assert.equal(fs.readFileSync(file, "utf8"), before);

      const finished = await finishAgent(cwd, queued.id, {
        status: "completed",
        conclusion: "terminal result",
        host: HOST,
        env: ownerEnv,
        now: "2026-08-27T00:02:00.000Z",
      });
      assert.equal(finished.status, "completed");
      const awaitingRelease = dispatchSnapshot(cwd, { capacity: 2, host: HOST, env: ownerEnv });
      assert.equal(awaitingRelease.active, 1);
      assert.deepEqual(awaitingRelease.awaiting_release.map((item) => item.ticket_id), [queued.id]);

      const terminalBeforeOtherRelease = fs.readFileSync(file, "utf8");
      assert.throws(() => releaseAgent(cwd, queued.id, {
        executionHandle: handle,
        host: HOST,
        env: otherEnv,
      }), isSessionMismatch);
      assert.equal(fs.readFileSync(file, "utf8"), terminalBeforeOtherRelease);

      const released = releaseAgent(cwd, queued.id, {
        executionHandle: handle,
        host: HOST,
        env: ownerEnv,
        now: "2026-08-27T00:02:01.000Z",
      });
      assert.ok(released.slot_released_at);
      assert.equal(dispatchSnapshot(cwd, { capacity: 2, host: HOST, env: ownerEnv }).active, 0);
      const releaseEvents = released.history.filter((entry) => entry.event === "agent_slot_released");
      const repeated = releaseAgent(cwd, queued.id, {
        executionHandle: handle,
        host: HOST,
        env: ownerEnv,
        now: "2026-08-27T00:03:00.000Z",
      });
      assert.equal(repeated.slot_released_at, released.slot_released_at);
      assert.deepEqual(repeated.history.filter((entry) => entry.event === "agent_slot_released"), releaseEvents);
      assert.equal(dispatchSnapshot(cwd, { capacity: 2, host: HOST, env: ownerEnv }).available, 2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }));
});
