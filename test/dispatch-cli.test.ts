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
});
