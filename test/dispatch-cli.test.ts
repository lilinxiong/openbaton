import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { hostDispatchStatePath, receiptsDir, runsDir, spawnsDir } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { withHome, fakeEnv } from "./home.js";
import { configureCodex } from "./configure.js";
import { parseDispatchReservationEnvelope } from "../src/lib/dispatch-reservation.js";
import { recordNativeIdentity, recordPendingReservation } from "../src/lib/host-identity.js";

function capture() {
  const chunks = [];
  return { write(value) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

async function command(argv, options) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(argv, { ...options, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function approvedSpawn(argv, options) {
  configureCodex(options.cwd, options.env, ["kimi/k3[1m]"]);
  const automatic = [];
  let hasHost = false;
  for (const arg of argv) {
    if (arg === "--host") hasHost = true;
    automatic.push(arg);
  }
  if (!hasHost) automatic.push("--host", "codex");
  return command([...automatic, "--json"], options);
}

function readTicket(cwd, id) {
  return JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${id}.json`), "utf8"));
}

function observeCodexDispatch(cwd, env, id, hookAgentId) {
  const ticket = readTicket(cwd, id);
  const pending = recordPendingReservation(cwd, {
    schema: 1,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: "codex",
  }, {}, undefined, env);
  recordNativeIdentity(cwd, pending, hookAgentId, "hook", {}, undefined, env);
}

describe("dispatch CLI", () => {
  it("queues tickets, binds a real agent, completes it, and refills FIFO", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "implement first unit", "--classification", "implementation"], { cwd, env })).code, 0);
      assert.equal((await approvedSpawn(["spawn", "implement second unit", "--classification", "implementation"], { cwd, env })).code, 0);
      const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0001.json"), "utf8"));
      assert.equal(ticket.receipt_id, "rcpt-spn-0001-a1");
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), `${ticket.receipt_id}.json`), "utf8"));
      assert.equal(receipt.route.route_id, "kimi/k3[1m]");
      assert.equal(receipt.retry.fallback, "none");

      const first = await command(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(first.code, 0, first.stderr);
      const reserved = JSON.parse(first.stdout);
      assert.deepEqual(reserved.reserved.map((item) => item.ticket_id), ["spn-0001"]);
      assert.equal(reserved.reserved[0].model, "kimi/k3[1m]");
      assert.equal(reserved.reserved[0].reasoning_effort, null);
      assert.equal(reserved.reserved[0].fork_context, false);
      assert.deepEqual(parseDispatchReservationEnvelope(reserved.reserved[0].prompt), reserved.reserved[0].reservation);
      assert.deepEqual(parseDispatchReservationEnvelope(reserved.reserved[0].description), reserved.reserved[0].reservation);
      assert.equal(reserved.reserved[0].reservation.ticket_id, "spn-0001");
      assert.deepEqual(reserved.snapshot.queued, ["spn-0002"]);

      observeCodexDispatch(cwd, env, "spn-0001", "codex-hook-dispatch-real");
      const bound = await command(["dispatch", "bind", "spn-0001", "--task-name", "codex-task-dispatch-real", "--host", "codex", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(bound.code, 0, bound.stderr);
      assert.equal(JSON.parse(bound.stdout).ticket.status, "running");

      const completed = await command(["dispatch", "complete", "spn-0001", "--text", "first done", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(completed.code, 0, completed.stderr);
      assert.equal(JSON.parse(completed.stdout).ticket.status, "completed");
      assert.equal(JSON.parse(completed.stdout).snapshot.available, 0);

      const released = await command(["dispatch", "release", "spn-0001", "--agent-id", "codex-hook-dispatch-real", "--json"], { cwd, env });
      assert.equal(released.code, 0, released.stderr);
      assert.equal(JSON.parse(released.stdout).snapshot.available, 1);

      const second = await command(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(JSON.parse(second.stdout).reserved.map((item) => item.ticket_id), ["spn-0002"]);
    });
  });

  it("spawn --dispatch reserves an ordinary subagent ticket and complete --release frees the slot", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-compact-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      const spawned = await approvedSpawn(["spawn", "implement first unit", "--classification", "implementation", "--dispatch", "--capacity", "1"], { cwd, env });
      assert.equal(spawned.code, 0, spawned.stderr || spawned.stdout);
      const payload = JSON.parse(spawned.stdout);
      assert.equal(payload.tickets[0].id, "spn-0001");
      assert.equal(payload.reserved.length, 1);
      assert.equal(payload.reserved[0].ticket_id, "spn-0001");
      assert.equal(payload.reserved[0].model, "kimi/k3[1m]");
      assert.match(payload.reserved[0].prompt, /Baton work unit/);
      assert.deepEqual(parseDispatchReservationEnvelope(payload.reserved[0].prompt), payload.reserved[0].reservation);
      assert.equal(JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0001.json"), "utf8")).status, "dispatching");

      observeCodexDispatch(cwd, env, "spn-0001", "codex-hook-dispatch-compact");
      const bound = await command(["dispatch", "bind", "spn-0001", "--task-name", "codex-task-dispatch-compact", "--host", "codex", "--json"], { cwd, env });
      assert.equal(bound.code, 0, bound.stderr);
      const completed = await command(["dispatch", "complete", "spn-0001", "--text", "first done", "--release", "--json"], { cwd, env });
      assert.equal(completed.code, 0, completed.stderr);
      const done = JSON.parse(completed.stdout);
      assert.equal(done.ticket.status, "completed");
      assert.ok(done.ticket.slot_released_at);
      assert.equal(done.snapshot.available, 1);
      assert.deepEqual(done.snapshot.awaiting_release, []);
    });
  });

  it("rejects runtime model overrides and forbids manual conclude on current tickets", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      await command(["init"], { cwd, env });
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      configureCodex(cwd, env, ["kimi/k3[1m]"]);
      const disabled = await command(["spawn", "implement omnimodal unit", "--host", "codex", "--classification", "implementation", "--model", "mimo-v2.5"], { cwd, env });
      assert.equal(disabled.code, 1);
      assert.match(disabled.stderr, /MODEL_SELECTION_REMOVED/);
      const bareAlias = await command(["spawn", "implement complex unit", "--host", "codex", "--classification", "implementation", "--model", "k3[1m]"], { cwd, env });
      assert.equal(bareAlias.code, 1);
      assert.match(bareAlias.stderr, /MODEL_SELECTION_REMOVED/);
      assert.equal((await approvedSpawn(["spawn", "implement complex unit", "--classification", "implementation"], { cwd, env })).code, 0);

      const conclude = await command(["conclude", "spn-0001", "--text", "fake completion"], { cwd, env });
      assert.equal(conclude.code, 1);
      assert.match(conclude.stderr, /LEGACY_CLI_SURFACE_REMOVED/);
      const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0001.json"), "utf8"));
      assert.equal(ticket.status, "queued");
      assert.equal(ticket.conclusion, null);
    });
  });

  it("remembers dispatch next --capacity for later bind/complete/status/recover without repeating it", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "implement first unit", "--classification", "implementation"], { cwd, env })).code, 0);
      assert.equal((await approvedSpawn(["spawn", "implement second unit", "--classification", "implementation"], { cwd, env })).code, 0);
      assert.equal((await approvedSpawn(["spawn", "implement third unit", "--classification", "implementation"], { cwd, env })).code, 0);

      const next = await command(["dispatch", "next", "--host", "codex", "--capacity", "2", "--json"], { cwd, env });
      assert.equal(next.code, 0, next.stderr);
      assert.deepEqual(JSON.parse(next.stdout).reserved.map((item) => item.ticket_id), ["spn-0001", "spn-0002"]);

      // Capacity is persisted under ignored Baton runtime state.
      const stateFile = hostDispatchStatePath(cwd, "codex");
      assert.ok(fs.existsSync(stateFile));
      assert.equal(fs.existsSync(path.join(runsDir(cwd), "dispatch.json")), false);
      assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).capacity, 2);

      // Every following command is a fresh process (restart) and omits --capacity.
      const status = await command(["dispatch", "status", "--json"], { cwd, env });
      assert.equal(status.code, 0, status.stderr);
      const snap = JSON.parse(status.stdout);
      assert.equal(snap.capacity, 2);
      assert.equal(snap.active, 2);
      assert.equal(snap.available, 0);

      observeCodexDispatch(cwd, env, "spn-0001", "codex-hook-dispatch-capacity");
      const bound = await command(["dispatch", "bind", "spn-0001", "--task-name", "codex-task-dispatch-capacity", "--host", "codex", "--json"], { cwd, env });
      assert.equal(bound.code, 0, bound.stderr);
      assert.equal(JSON.parse(bound.stdout).snapshot.capacity, 2);

      const completed = await command(["dispatch", "complete", "spn-0001", "--text", "done", "--json"], { cwd, env });
      assert.equal(completed.code, 0, completed.stderr);
      assert.equal(JSON.parse(completed.stdout).snapshot.capacity, 2);
      assert.equal(JSON.parse(completed.stdout).snapshot.available, 0);

      const released = await command(["dispatch", "release", "spn-0001", "--agent-id", "codex-hook-dispatch-capacity", "--json"], { cwd, env });
      assert.equal(released.code, 0, released.stderr);
      assert.equal(JSON.parse(released.stdout).snapshot.available, 1);

      const recovered = await command(["dispatch", "recover", "--json"], { cwd, env });
      assert.equal(recovered.code, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).snapshot.capacity, 2);
    });
  });

  it("records progress and treats host saturation as FIFO backpressure", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      await command(["init"], { cwd, env });
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "analyze the lifecycle", "--classification", "implementation"], { cwd, env })).code, 0);
      assert.equal((await command(["dispatch", "next", "--host", "codex", "--capacity", "2", "--json"], { cwd, env })).code, 0);

      const deferred = await command(["dispatch", "defer", "spn-0001", "--code", "AGENT_LIMIT_REACHED", "--observed-capacity", "1", "--json"], { cwd, env });
      assert.equal(deferred.code, 0, deferred.stderr);
      assert.equal(JSON.parse(deferred.stdout).ticket.status, "queued");
      assert.equal(JSON.parse(fs.readFileSync(hostDispatchStatePath(cwd, "codex"), "utf8")).capacity, 1);

      await command(["dispatch", "next", "--host", "codex", "--json"], { cwd, env });
      observeCodexDispatch(cwd, env, "spn-0001", "codex-hook-dispatch-thinking");
      await command(["dispatch", "bind", "spn-0001", "--task-name", "codex-task-dispatch-thinking", "--host", "codex", "--json"], { cwd, env });
      const progress = await command([
        "dispatch", "progress", "spn-0001", "--phase", "working", "--text", "mapped current states",
        "--next", "check restart recovery", "--needs-input", "--json",
      ], { cwd, env });
      assert.equal(progress.code, 0, progress.stderr);
      const body = JSON.parse(progress.stdout);
      assert.equal(body.ticket.work_unit.kind, "concrete");
      assert.equal(body.ticket.coordination.mode, "terminal-only");
      assert.equal(body.ticket.progress.needs_director, true);
    });
  });

  it("uses exact-agent probes as liveness evidence and rejects time-only timeout", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      await command(["init"], { cwd, env });
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "build the Android target", "--classification", "implementation"], { cwd, env })).code, 0);
      assert.equal((await command(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env })).code, 0);
      observeCodexDispatch(cwd, env, "spn-0001", "codex-hook-dispatch-build");
      assert.equal((await command(["dispatch", "bind", "spn-0001", "--task-name", "codex-task-dispatch-build", "--host", "codex", "--json"], { cwd, env })).code, 0);

      const live = await command([
        "dispatch", "probe", "spn-0001", "--agent-id", "codex-hook-dispatch-build", "--state", "running", "--activity", "status", "--json",
      ], { cwd, env });
      assert.equal(live.code, 0, live.stderr);
      const liveBody = JSON.parse(live.stdout);
      assert.equal(liveBody.ticket.status, "running");
      assert.equal(liveBody.ticket.liveness.state, "running");
      assert.equal(liveBody.ticket.progress, null);

      const timeOnly = await command([
        "dispatch", "timeout", "spn-0001", "--probe-sequence", String(liveBody.ticket.liveness.sequence), "--json",
      ], { cwd, env });
      assert.equal(timeOnly.code, 1);
      assert.match(timeOnly.stderr, /elapsed wait time is never timeout evidence/);

      const missing = await command([
        "dispatch", "probe", "spn-0001", "--agent-id", "codex-hook-dispatch-build", "--state", "not_found", "--json",
      ], { cwd, env });
      assert.equal(missing.code, 0, missing.stderr);
      const missingBody = JSON.parse(missing.stdout);
      const timedOut = await command([
        "dispatch", "timeout", "spn-0001", "--probe-sequence", String(missingBody.ticket.liveness.sequence), "--json",
      ], { cwd, env });
      assert.equal(timedOut.code, 0, timedOut.stderr);
      assert.equal(JSON.parse(timedOut.stdout).ticket.status, "timed_out");
    });
  });

  it("fails closed without a resolvable host and requires explicit --host", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-host-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "implement first unit", "--host", "codex", "--classification", "implementation"], { cwd, env })).code, 0);
      assert.equal((await approvedSpawn(["spawn", "implement second unit", "--host", "codex", "--classification", "implementation"], { cwd, env })).code, 0);

      const unresolved = await command(["dispatch", "next", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(unresolved.code, 1);
      assert.match(unresolved.stderr, /HOST_REQUIRED/);
      assert.match(unresolved.stderr, /--host/);
      assert.match(unresolved.stderr, /BATON_HOST/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0001.json"), "utf8")).status, "queued");

      const first = await command(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(first.code, 0, first.stderr);
      const reserved = JSON.parse(first.stdout);
      assert.deepEqual(reserved.reserved.map((item) => item.ticket_id), ["spn-0001"]);
      const firstTicket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0001.json"), "utf8"));
      assert.equal(firstTicket.dispatch_host, "codex");
      assert.equal(firstTicket.target_host, "codex");

      const mismatch = await command(["dispatch", "next", "--host", "grok", "--capacity", "2", "--json"], { cwd, env });
      assert.equal(mismatch.code, 1, mismatch.stderr);
      assert.match(mismatch.stderr + mismatch.stdout, /HOST_MISMATCH/);
      const secondTicket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0002.json"), "utf8"));
      assert.equal(secondTicket.dispatch_host, undefined);
      assert.equal(secondTicket.status, "queued");
      assert.equal(secondTicket.error, null);

      const hostlessPath = path.join(spawnsDir(cwd), "spn-0002.json");
      const hostless = JSON.parse(fs.readFileSync(hostlessPath, "utf8"));
      delete hostless.target_host;
      delete hostless.dispatch_host;
      hostless.host = null;
      if (hostless.selection) delete hostless.selection.host;
      fs.writeFileSync(hostlessPath, JSON.stringify(hostless, null, 2) + "\n");
      const hostlessReserve = await command(["dispatch", "next", "--host", "codex", "--capacity", "2", "--json"], { cwd, env });
      assert.equal(hostlessReserve.code, 1, hostlessReserve.stderr);
      const hostlessBody = JSON.parse(hostlessReserve.stdout);
      assert.deepEqual(hostlessBody.reserved, []);
      assert.equal(hostlessBody.blocked[0]?.ticket_id, "spn-0002");
      assert.equal(hostlessBody.blocked[0]?.code, "HOST_REQUIRED");
      assert.equal(JSON.parse(fs.readFileSync(hostlessPath, "utf8")).status, "queued");

      const stateFile = path.join(runsDir(cwd), "dispatch.json");
      const keyedStateFile = hostDispatchStatePath(cwd, "codex");
      for (const file of [stateFile, keyedStateFile]) {
        try { fs.unlinkSync(file); } catch { /* optional */ }
      }
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ capacity: 9 }, null, 2) + "\n");
      const status = await command(["dispatch", "status", "--host", "codex", "--json"], { cwd, env });
      assert.equal(status.code, 0, status.stderr);
      assert.notEqual(JSON.parse(status.stdout).capacity, 9);

      const bad = await command(["dispatch", "next", "--host", "not-a-registered-host", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /invalid host/);
    });
  });
});
