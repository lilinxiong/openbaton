import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { withHome, fakeEnv } from "./home.js";

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

describe("dispatch CLI", () => {
  it("queues tickets, binds a real agent, completes it, and refills FIFO", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init", "--tools", "codex"], { cwd, env })).code, 0);
      assert.equal((await command(["spawn", "implement first unit", "--model", "k3"], { cwd, env })).code, 0);
      assert.equal((await command(["spawn", "implement second unit", "--model", "k3"], { cwd, env })).code, 0);
      const ticket = JSON.parse(fs.readFileSync(path.join(cwd, ".baton", "spawns", "spn-0001.json"), "utf8"));
      assert.equal(ticket.receipt_id, "rcpt-spn-0001-a1");
      const receipt = JSON.parse(fs.readFileSync(path.join(cwd, ".baton", "receipts", `${ticket.receipt_id}.json`), "utf8"));
      assert.equal(receipt.route.route_id, "kimi/k3[1m]");
      assert.equal(receipt.retry.fallback, "none");

      const first = await command(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(first.code, 0, first.stderr);
      const reserved = JSON.parse(first.stdout);
      assert.deepEqual(reserved.reserved.map((item) => item.ticket_id), ["spn-0001"]);
      assert.equal(reserved.reserved[0].model, "kimi/k3[1m]");
      assert.equal(reserved.reserved[0].reasoning_effort, "max");
      assert.equal(reserved.reserved[0].fork_context, false);
      assert.deepEqual(reserved.snapshot.queued, ["spn-0002"]);

      const bound = await command(["dispatch", "bind", "spn-0001", "--agent-id", "agent-real-1", "--host", "codex", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(bound.code, 0, bound.stderr);
      assert.equal(JSON.parse(bound.stdout).ticket.status, "running");

      const completed = await command(["dispatch", "complete", "spn-0001", "--text", "first done", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(completed.code, 0, completed.stderr);
      assert.equal(JSON.parse(completed.stdout).ticket.status, "completed");

      const second = await command(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env });
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(JSON.parse(second.stdout).reserved.map((item) => item.ticket_id), ["spn-0002"]);
    });
  });

  it("blocks a card with no executable route and forbids manual conclude on schema v2", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      await command(["init", "--tools", "codex"], { cwd, env });
      await command(["spawn", "implement omnimodal unit", "--model", "mimo-v2.5"], { cwd, env });
      const blocked = await command(["dispatch", "next", "--host", "codex", "--capacity", "6", "--json"], { cwd, env });
      assert.equal(blocked.code, 1);
      assert.equal(JSON.parse(blocked.stdout).blocked[0].code, "NO_EXECUTABLE_ROUTE");

      const conclude = await command(["conclude", "spn-0001", "--text", "fake completion"], { cwd, env });
      assert.equal(conclude.code, 1);
      assert.match(conclude.stderr, /bound host agent/);
      const ticket = JSON.parse(fs.readFileSync(path.join(cwd, ".baton", "spawns", "spn-0001.json"), "utf8"));
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.conclusion, null);
    });
  });

  it("remembers dispatch next --capacity for later bind/complete/status/recover without repeating it", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dispatch-cli-"));
      const env = fakeEnv(home);
      assert.equal((await command(["init", "--tools", "codex"], { cwd, env })).code, 0);
      assert.equal((await command(["spawn", "implement first unit", "--model", "k3"], { cwd, env })).code, 0);
      assert.equal((await command(["spawn", "implement second unit", "--model", "k3"], { cwd, env })).code, 0);
      assert.equal((await command(["spawn", "implement third unit", "--model", "k3"], { cwd, env })).code, 0);

      const next = await command(["dispatch", "next", "--host", "codex", "--capacity", "2", "--json"], { cwd, env });
      assert.equal(next.code, 0, next.stderr);
      assert.deepEqual(JSON.parse(next.stdout).reserved.map((item) => item.ticket_id), ["spn-0001", "spn-0002"]);

      // Capacity is persisted under ignored Baton runtime state.
      const stateFile = path.join(cwd, ".baton", "runs", "dispatch.json");
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
      assert.equal(JSON.parse(completed.stdout).snapshot.available, 1);

      const recovered = await command(["dispatch", "recover", "--json"], { cwd, env });
      assert.equal(recovered.code, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).snapshot.capacity, 2);
    });
  });
});
