import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { dispatchStatePath, receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { withHome, fakeEnv } from "./home.js";
import { configureCodex } from "./configure.js";

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
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--model") {
      index += 1;
      continue;
    }
    automatic.push(argv[index]);
  }
  return command([...automatic, "--json"], options);
}

describe("dispatch CLI", () => {
  it("queues tickets, binds a real agent, completes it, and refills FIFO", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "implement first unit", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);
      assert.equal((await approvedSpawn(["spawn", "implement second unit", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);
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
      assert.deepEqual(reserved.snapshot.queued, ["spn-0002"]);

      const bound = await command(["dispatch", "bind", "spn-0001", "--agent-id", "agent-real-1", "--host", "codex", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(bound.code, 0, bound.stderr);
      assert.equal(JSON.parse(bound.stdout).ticket.status, "running");

      const completed = await command(["dispatch", "complete", "spn-0001", "--text", "first done", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(completed.code, 0, completed.stderr);
      assert.equal(JSON.parse(completed.stdout).ticket.status, "completed");
      assert.equal(JSON.parse(completed.stdout).snapshot.available, 0);

      const released = await command(["dispatch", "release", "spn-0001", "--agent-id", "agent-real-1", "--json"], { cwd, env });
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
      const spawned = await approvedSpawn(["spawn", "implement first unit", "--dispatch", "--capacity", "1"], { cwd, env });
      assert.equal(spawned.code, 0, spawned.stderr || spawned.stdout);
      const payload = JSON.parse(spawned.stdout);
      assert.equal(payload.tickets[0].id, "spn-0001");
      assert.equal(payload.reserved.length, 1);
      assert.equal(payload.reserved[0].ticket_id, "spn-0001");
      assert.equal(payload.reserved[0].model, "kimi/k3[1m]");
      assert.match(payload.reserved[0].prompt, /Baton work unit/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0001.json"), "utf8")).status, "dispatching");

      const bound = await command(["dispatch", "bind", "spn-0001", "--agent-id", "agent-compact", "--host", "codex", "--json"], { cwd, env });
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
      const disabled = await command(["spawn", "implement omnimodal unit", "--model", "mimo-v2.5"], { cwd, env });
      assert.equal(disabled.code, 1);
      assert.match(disabled.stderr, /MODEL_SELECTION_REMOVED/);
      const bareAlias = await command(["spawn", "implement complex unit", "--model", "k3[1m]"], { cwd, env });
      assert.equal(bareAlias.code, 1);
      assert.match(bareAlias.stderr, /MODEL_SELECTION_REMOVED/);
      assert.equal((await approvedSpawn(["spawn", "implement complex unit", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);

      const conclude = await command(["conclude", "spn-0001", "--text", "fake completion"], { cwd, env });
      assert.equal(conclude.code, 1);
      assert.match(conclude.stderr, /bound host agent/);
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
      assert.equal((await approvedSpawn(["spawn", "implement first unit", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);
      assert.equal((await approvedSpawn(["spawn", "implement second unit", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);
      assert.equal((await approvedSpawn(["spawn", "implement third unit", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);

      const next = await command(["dispatch", "next", "--host", "codex", "--capacity", "2", "--json"], { cwd, env });
      assert.equal(next.code, 0, next.stderr);
      assert.deepEqual(JSON.parse(next.stdout).reserved.map((item) => item.ticket_id), ["spn-0001", "spn-0002"]);

      // Capacity is persisted under ignored Baton runtime state.
      const stateFile = dispatchStatePath(cwd);
      assert.ok(fs.existsSync(stateFile));
      assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).capacity, 2);

      // Every following command is a fresh process (restart) and omits --capacity.
      const status = await command(["dispatch", "status", "--json"], { cwd, env });
      assert.equal(status.code, 0, status.stderr);
      const snap = JSON.parse(status.stdout);
      assert.equal(snap.capacity, 2);
      assert.equal(snap.active, 2);
      assert.equal(snap.available, 0);

      const bound = await command(["dispatch", "bind", "spn-0001", "--agent-id", "agent-1", "--json"], { cwd, env });
      assert.equal(bound.code, 0, bound.stderr);
      assert.equal(JSON.parse(bound.stdout).snapshot.capacity, 2);

      const completed = await command(["dispatch", "complete", "spn-0001", "--text", "done", "--json"], { cwd, env });
      assert.equal(completed.code, 0, completed.stderr);
      assert.equal(JSON.parse(completed.stdout).snapshot.capacity, 2);
      assert.equal(JSON.parse(completed.stdout).snapshot.available, 0);

      const released = await command(["dispatch", "release", "spn-0001", "--agent-id", "agent-1", "--json"], { cwd, env });
      assert.equal(released.code, 0, released.stderr);
      assert.equal(JSON.parse(released.stdout).snapshot.available, 1);

      const recovered = await command(["dispatch", "recover", "--json"], { cwd, env });
      assert.equal(recovered.code, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).snapshot.capacity, 2);
    });
  });

  it("records checkpoint progress and treats host saturation as FIFO backpressure", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      await command(["init"], { cwd, env });
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "analyze the lifecycle", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);
      assert.equal((await command(["dispatch", "next", "--host", "codex", "--capacity", "2", "--json"], { cwd, env })).code, 0);

      const deferred = await command(["dispatch", "defer", "spn-0001", "--code", "AGENT_LIMIT_REACHED", "--observed-capacity", "1", "--json"], { cwd, env });
      assert.equal(deferred.code, 0, deferred.stderr);
      assert.equal(JSON.parse(deferred.stdout).ticket.status, "queued");
      assert.equal(JSON.parse(fs.readFileSync(dispatchStatePath(cwd), "utf8")).capacity, 1);

      await command(["dispatch", "next", "--host", "codex", "--json"], { cwd, env });
      await command(["dispatch", "bind", "spn-0001", "--agent-id", "agent-thinking", "--json"], { cwd, env });
      const progress = await command([
        "dispatch", "progress", "spn-0001", "--phase", "working", "--text", "mapped current states",
        "--next", "check restart recovery", "--needs-input", "--json",
      ], { cwd, env });
      assert.equal(progress.code, 0, progress.stderr);
      const body = JSON.parse(progress.stdout);
      assert.equal(body.ticket.work_unit.kind, "deliberative");
      assert.equal(body.ticket.coordination.mode, "checkpointed");
      assert.equal(body.ticket.progress.needs_director, true);
    });
  });

  it("uses exact-agent probes as liveness evidence and rejects time-only timeout", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      await command(["init"], { cwd, env });
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "build the Android target", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);
      assert.equal((await command(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env })).code, 0);
      assert.equal((await command(["dispatch", "bind", "spn-0001", "--agent-id", "agent-build", "--json"], { cwd, env })).code, 0);

      const live = await command([
        "dispatch", "probe", "spn-0001", "--agent-id", "agent-build", "--state", "running", "--activity", "status", "--json",
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
        "dispatch", "probe", "spn-0001", "--agent-id", "agent-build", "--state", "not_found", "--json",
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

  it("defaults dispatch host to the active CLI and rejects unknown hosts", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-host-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init"], { cwd, env })).code, 0);
      publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
      assert.equal((await approvedSpawn(["spawn", "implement first unit", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);
      assert.equal((await approvedSpawn(["spawn", "implement second unit", "--model", "kimi/k3[1m]"], { cwd, env })).code, 0);

      const first = await command(["dispatch", "next", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(first.code, 0, first.stderr);
      const firstTicket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0001.json"), "utf8"));
      assert.equal(firstTicket.dispatch_host, "codex");

      const second = await command(["dispatch", "next", "--host", "grok", "--capacity", "2", "--json"], { cwd, env });
      assert.equal(second.code, 1, second.stderr);
      const secondTicket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), "spn-0002.json"), "utf8"));
      assert.equal(secondTicket.dispatch_host, undefined);
      assert.equal(secondTicket.status, "queued");
      assert.equal(secondTicket.error, null);

      const bad = await command(["dispatch", "next", "--host", "not-a-registered-host", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /invalid host/);
    });
  });
});
