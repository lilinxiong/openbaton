import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindAgent,
  DispatchError,
  deferDispatch,
  finishAgent,
  reserveNext,
  withDispatchLockAsync,
} from "../src/lib/dispatch.js";
import { markRouteExhausted } from "../src/lib/model-availability.js";
import { buildReadOnlyReceipt, buildWriteReceipt, writeReceipt } from "../src/lib/receipt.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { captureBaseline } from "../src/lib/safety.js";
import { buildSpawnTicket, nextSpawnId, readSpawn, writeSpawn, type SpawnTicket } from "../src/lib/spawn.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";

const HOST = "alpha";
const ROUTE = `${HOST}/diagnostics`;

function workspace(prefix = "baton-cross-tree-diagnostics-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(): string {
  const cwd = workspace("baton-cross-tree-diagnostics-repo-");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "diagnostics@example.invalid");
  git(cwd, "config", "user.name", "Diagnostics");
  fs.writeFileSync(path.join(cwd, "allowed.txt"), "baseline\n", "utf8");
  fs.writeFileSync(path.join(cwd, "foreign.txt"), "baseline\n", "utf8");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "baseline");
  return cwd;
}

function selection() {
  return {
    host: HOST,
    proposal_id: "proposal-cross-tree-diagnostics",
    approval_id: "approval-cross-tree-diagnostics",
    approved_at: "2026-08-27T00:00:00.000Z",
    confirmed_by: "baton-recommendation" as const,
    catalog_fingerprint: "cross-tree-diagnostics-catalog",
    recommended_model_id: ROUTE,
    selected_model_id: ROUTE,
    changed_by_user: false,
  };
}

function prepare(cwd: string, env: NodeJS.ProcessEnv): void {
  configureCli(cwd, env, HOST, [ROUTE]);
  publishRouteSnapshot(cwd, {
    models: [{
      id: ROUTE,
      route_id: ROUTE,
      provider: HOST,
      supportedReasoningEfforts: ["low"],
      defaultReasoningEffort: "low",
    }],
  }, new Date("2026-08-27T00:00:00.000Z"), { cli: HOST, host: HOST, env });
}

function queuedTicket(cwd: string, env: NodeJS.ProcessEnv, ordinalTime = 0): SpawnTicket {
  const createdAt = new Date(Date.parse("2026-08-27T00:00:00.000Z") + ordinalTime * 1_000).toISOString();
  const id = nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    cwd,
    env,
    id,
    description: "cross-tree diagnostic worker",
    prompt: "cross-tree diagnostic worker",
    modelId: ROUTE,
    routeId: ROUTE,
    taskKind: "concrete",
    selection: selection(),
    targetHost: HOST,
    now: createdAt,
  });
  const receipt = buildReadOnlyReceipt({
    ticketId: id,
    card: { id: ROUTE, strengths: "fixture", route_id: ROUTE, provider: HOST },
    issuedAt: createdAt,
    selection: ticket.selection,
    host: HOST,
  });
  ticket.receipt_id = receipt.receipt_id;
  writeReceipt(cwd, receipt, env);
  writeSpawn(cwd, ticket, env);
  return ticket;
}

function writeDispatchingTicket(cwd: string, env: NodeJS.ProcessEnv): SpawnTicket {
  const id = nextSpawnId(cwd, "spn", env);
  const ticket = buildSpawnTicket({
    cwd,
    env,
    id,
    description: "cross-tree safety diagnostic worker",
    prompt: "cross-tree safety diagnostic worker",
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
    baseline: captureBaseline(cwd, new Date(ticket.created_at)),
    writeAllowlist: ["allowed.txt"],
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
  return ticket;
}

describe("cross-tree diagnostic failure classes", () => {
  it("reports workspace dispatch-lock contention as DISPATCH_LOCKED", async () => withHome(async (home) => {
    const cwd = workspace();
    const first = fakeEnv(home, { BATON_SESSION_ID: "diagnostic-lock-first" });
    const second = fakeEnv(home, { BATON_SESSION_ID: "diagnostic-lock-second" });
    await withDispatchLockAsync(cwd, async () => {
      await assert.rejects(
        withDispatchLockAsync(cwd, async () => undefined, { env: second }),
        (error: unknown) => error instanceof DispatchError
          && error.code === "DISPATCH_LOCKED"
          && error.code !== "WRITE_SCOPE_VIOLATION"
          && error.code !== "MODEL_QUOTA_EXHAUSTED"
          && error.code !== "AGENT_LIMIT_REACHED",
      );
    }, { env: first });
  }));

  it("reports cross-tree filesystem ownership as WRITE_SCOPE_VIOLATION", async () => withHome(async (home) => {
    const cwd = repository();
    const env = fakeEnv(home, { BATON_SESSION_ID: "diagnostic-safety-tree" });
    prepare(cwd, env);
    const ticket = writeDispatchingTicket(cwd, env);
    const bound = bindAgent(cwd, ticket.id, {
      executionHandle: { kind: "alpha-task", value: "safety-diagnostic", source: "native-return" },
      host: HOST,
      env,
      now: "2026-08-27T00:00:01.000Z",
    });
    assert.equal(bound.status, "running");
    fs.appendFileSync(path.join(cwd, "foreign.txt"), "unowned change\n", "utf8");

    const finished = await finishAgent(cwd, ticket.id, {
      status: "completed",
      conclusion: "must be rejected by the workspace safety gate",
      host: HOST,
      env,
      now: "2026-08-27T00:00:02.000Z",
    });
    assert.equal(finished.status, "errored");
    assert.equal(finished.error?.code, "WRITE_SCOPE_VIOLATION");
    assert.equal((finished.safety_verdict as { accepted?: boolean }).accepted, false);
    assert.notEqual(finished.error?.code, "DISPATCH_LOCKED");
    assert.notEqual(finished.error?.code, "MODEL_QUOTA_EXHAUSTED");
    assert.notEqual(finished.error?.code, "AGENT_LIMIT_REACHED");
  }));

  it("reports host/profile model exhaustion as MODEL_QUOTA_EXHAUSTED", async () => withHome(async (home) => {
    const cwd = workspace();
    const env = fakeEnv(home, { BATON_SESSION_ID: "diagnostic-quota-tree" });
    prepare(cwd, env);
    const ticket = queuedTicket(cwd, env);
    markRouteExhausted(cwd, { host: HOST, routeId: ROUTE }, {
      reason: "MODEL_QUOTA_EXHAUSTED",
      resetAt: "2026-09-01T00:00:00.000Z",
      now: "2026-08-27T00:01:00.000Z",
      env,
    });

    const result = await reserveNext(cwd, {
      capacity: 1,
      limit: 1,
      host: HOST,
      now: "2026-08-27T00:02:00.000Z",
      env,
    });
    assert.deepEqual(result.reserved, []);
    assert.deepEqual(result.blocked.map((item) => item.code), ["MODEL_QUOTA_EXHAUSTED"]);
    const rejected = readSpawn(cwd, ticket.id, env);
    assert.equal(rejected.status, "errored");
    assert.equal(rejected.error?.code, "MODEL_QUOTA_EXHAUSTED");
    assert.notEqual(rejected.error?.code, "DISPATCH_LOCKED");
    assert.notEqual(rejected.error?.code, "WRITE_SCOPE_VIOLATION");
    assert.notEqual(rejected.error?.code, "AGENT_LIMIT_REACHED");
  }));

  it("reports a full root tree as AGENT_LIMIT_REACHED backpressure", async () => withHome(async (home) => {
    const cwd = workspace();
    const env = fakeEnv(home, { BATON_SESSION_ID: "diagnostic-capacity-tree" });
    prepare(cwd, env);
    const active = queuedTicket(cwd, env, 0);
    const queued = queuedTicket(cwd, env, 1);
    const first = await reserveNext(cwd, {
      capacity: 1,
      limit: 1,
      host: HOST,
      now: "2026-08-27T00:02:00.000Z",
      env,
    });
    assert.deepEqual(first.reserved.map((item) => item.ticket_id), [active.id]);

    const full = await reserveNext(cwd, {
      capacity: 1,
      limit: 1,
      host: HOST,
      now: "2026-08-27T00:03:00.000Z",
      env,
    });
    assert.deepEqual(full.reserved, []);
    assert.deepEqual(full.blocked, []);
    assert.equal(full.snapshot.active, 1);
    assert.equal(full.snapshot.available, 0);
    assert.deepEqual(full.snapshot.queued, [queued.id]);
    assert.notEqual(full.blocked[0]?.code, "DISPATCH_LOCKED");
    assert.notEqual(full.blocked[0]?.code, "WRITE_SCOPE_VIOLATION");
    assert.notEqual(full.blocked[0]?.code, "MODEL_QUOTA_EXHAUSTED");

    const deferred = deferDispatch(cwd, active.id, {
      code: "AGENT_LIMIT_REACHED",
      message: "native root tree is at capacity",
      host: HOST,
      env,
      now: "2026-08-27T00:04:00.000Z",
    });
    assert.equal(deferred.status, "queued");
    assert.equal(deferred.error, null);
    const last = deferred.history.at(-1) as { event?: string; error_code?: string };
    assert.equal(last.event, "dispatch_deferred");
    assert.equal(last.error_code, "AGENT_LIMIT_REACHED");
  }));
});
