import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { withHome, fakeEnv } from "./home.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { configureCodex } from "./configure.js";

function sink() { return { write() { return true; } }; }
function capture() {
  const chunks: string[] = [];
  return {
    write(value: unknown) { chunks.push(String(value)); return true; },
    text() { return chunks.join(""); },
  };
}
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }); }
function fixture(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-write-dispatch-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "validation@example.invalid");
  git(cwd, "config", "user.name", "Validation");
  fs.writeFileSync(path.join(cwd, "allowed.txt"), "BASE_ALLOWED\n");
  fs.writeFileSync(path.join(cwd, "denied.txt"), "BASE_DENIED\n");
  git(cwd, "add", "allowed.txt", "denied.txt");
  git(cwd, "commit", "-q", "-m", "baseline");
  return cwd;
}

function readTicket(cwd: string, id: string) {
  return JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), id + ".json"), "utf8"));
}

function syncModel(cwd: string) {
  publishRouteSnapshot(cwd, { models: [{ id: "k3[1m]", provider: "kimi" }] });
}

async function approvedSpawn(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<void> {
  configureCodex(cwd, env, ["kimi/k3[1m]"]);
  const automaticArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--model") {
      index += 1;
      continue;
    }
    automaticArgs.push(args[index]);
  }
  const proposalOut = capture();
  const proposed = await run([...automaticArgs, "--json"], { cwd, env, stdout: proposalOut, stderr: proposalOut });
  assert.equal(proposed, 0, proposalOut.text());
  const approval = JSON.parse(proposalOut.text());
  assert.equal(approval.status, "approved");
  assert.equal(approval.approvals[0].confirmed_by, "baton-recommendation");
}

async function boundWriteTicket(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await run(["init"], { cwd, env, stdout: sink(), stderr: sink() });
  syncModel(cwd);
  await approvedSpawn(cwd, env, ["spawn", "implement allowed file", "--model", "kimi/k3[1m]", "--write-path", "allowed.txt", "--write-ops", "write"]);
  await run(["dispatch", "next", "--capacity", "1", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
  await run(["dispatch", "bind", "spn-0001", "--agent-id", "agent-write", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
}

async function reportMissingWriteAgent(cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const out = capture();
  const code = await run([
    "dispatch", "probe", "spn-0001", "--agent-id", "agent-write", "--state", "not_found", "--json",
  ], { cwd, env, stdout: out, stderr: out });
  assert.equal(code, 0, out.text());
  return JSON.parse(out.text()).ticket.liveness.sequence;
}

describe("write dispatch safety integration", () => {
  it("completes an allowlisted write after the parent gate passes", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await run(["init"], { cwd, env, stdout: sink(), stderr: sink() });
      syncModel(cwd);
      await approvedSpawn(cwd, env, ["spawn", "implement allowed file", "--model", "kimi/k3[1m]", "--write-path", "allowed.txt", "--write-ops", "write"]);
      await run(["dispatch", "next", "--capacity", "1", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["dispatch", "bind", "spn-0001", "--agent-id", "agent-write", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      await run(["dispatch", "complete", "spn-0001", "--text", "write accepted", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.status, "completed");
      assert.equal(ticket.safety_verdict.accepted, true);
      assert.equal(ticket.conclusion, "write accepted");
    });
  });

  it("reproduces V-06 and rejects an out-of-scope write before accepting conclusion", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await run(["init"], { cwd, env, stdout: sink(), stderr: sink() });
      syncModel(cwd);
      await approvedSpawn(cwd, env, ["spawn", "implement allowed file", "--model", "kimi/k3[1m]", "--write-path", "allowed.txt", "--write-ops", "write"]);
      await run(["dispatch", "next", "--capacity", "1", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["dispatch", "bind", "spn-0001", "--agent-id", "agent-write", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      fs.appendFileSync(path.join(cwd, "denied.txt"), "WORKER_OUT_OF_SCOPE\n");
      await run(["dispatch", "complete", "spn-0001", "--text", "must be rejected", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error.code, "WRITE_SCOPE_VIOLATION");
      assert.equal(ticket.conclusion, null);
      assert.ok(ticket.safety_verdict.violations.some((item) => item.path === "denied.txt"));
    });
  });

  it("keeps global Baton runtime out of a later write baseline (read-only ticket, then write ticket)", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await run(["init"], { cwd, env, stdout: sink(), stderr: sink() });
      syncModel(cwd);
      await approvedSpawn(cwd, env, ["spawn", "survey the repository structure", "--model", "kimi/k3[1m]"]);
      assert.ok(fs.existsSync(path.join(receiptsDir(cwd), "rcpt-spn-0001-a1.json")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));

      await approvedSpawn(cwd, env, ["spawn", "implement allowed file", "--model", "kimi/k3[1m]", "--write-path", "allowed.txt", "--write-ops", "write"]);
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), "rcpt-spn-0002-a1.json"), "utf8"));
      assert.deepEqual(receipt.baseline.dirty_entries, []);

      await run(["dispatch", "next", "--capacity", "2", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["dispatch", "bind", "spn-0002", "--agent-id", "agent-write", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      await run(["dispatch", "complete", "spn-0002", "--text", "write accepted", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      assert.equal(readTicket(cwd, "spn-0002").status, "completed");
    });
  });

  it("audits a failed write ticket and keeps its slot until host close is confirmed", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      fs.appendFileSync(path.join(cwd, "denied.txt"), "WORKER_OUT_OF_SCOPE\n");
      const out = capture();
      const code = await run(["dispatch", "fail", "spn-0001", "--code", "WORKER_CRASHED", "--message", "worker process died", "--text", "late conclusion", "--json"], { cwd, env, stdout: out, stderr: out });
      assert.equal(code, 0, out.text());
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error.code, "WRITE_SCOPE_VIOLATION");
      assert.deepEqual(ticket.error.host_error, { status: "errored", code: "WORKER_CRASHED", message: "worker process died" });
      assert.equal(ticket.conclusion, null);
      assert.ok(ticket.safety_verdict.violations.some((item) => item.path === "denied.txt"));
      assert.ok(ticket.history.some((entry) => entry.event === "safety_gate_rejected" && entry.host_error_code === "WORKER_CRASHED"));
      // Terminal business state does not prove that close_agent released the host thread.
      const status = capture();
      await run(["dispatch", "status", "--json"], { cwd, env, stdout: status, stderr: status });
      let snap = JSON.parse(status.text());
      assert.equal(snap.active, 1);
      assert.deepEqual(snap.awaiting_release, [{ ticket_id: "spn-0001", agent_id: "agent-write", status: "errored" }]);
      await run(["dispatch", "release", "spn-0001", "--agent-id", "agent-write", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      const released = capture();
      await run(["dispatch", "status", "--json"], { cwd, env, stdout: released, stderr: released });
      snap = JSON.parse(released.text());
      assert.equal(snap.active, 0);
      assert.equal(snap.counts.errored, 1);
    });
  });

  it("audits a timed-out write ticket and preserves AGENT_TIMEOUT as structured evidence", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      fs.appendFileSync(path.join(cwd, "denied.txt"), "WORKER_OUT_OF_SCOPE\n");
      const probeSequence = await reportMissingWriteAgent(cwd, env);
      const out = capture();
      const code = await run([
        "dispatch", "timeout", "spn-0001", "--probe-sequence", String(probeSequence),
        "--message", "host probe reported the agent missing", "--json",
      ], { cwd, env, stdout: out, stderr: out });
      assert.equal(code, 0, out.text());
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error.code, "WRITE_SCOPE_VIOLATION");
      assert.deepEqual(ticket.error.host_error, { status: "timed_out", code: "AGENT_TIMEOUT", message: "host probe reported the agent missing" });
      assert.equal(ticket.conclusion, null);
    });
  });

  it("audits a closed write ticket and converts out-of-scope writes into WRITE_SCOPE_VIOLATION", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      fs.appendFileSync(path.join(cwd, "denied.txt"), "WORKER_OUT_OF_SCOPE\n");
      const out = capture();
      const code = await run(["dispatch", "close", "spn-0001", "--json"], { cwd, env, stdout: out, stderr: out });
      assert.equal(code, 0, out.text());
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error.code, "WRITE_SCOPE_VIOLATION");
      assert.deepEqual(ticket.error.host_error, { status: "closed", code: "AGENT_CLOSED", message: "AGENT_CLOSED" });
    });
  });

  it("retains the original terminal status and error for accepted-scope host errors", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      const probeSequence = await reportMissingWriteAgent(cwd, env);
      const out = capture();
      const code = await run([
        "dispatch", "timeout", "spn-0001", "--probe-sequence", String(probeSequence),
        "--message", "host probe reported the agent missing", "--json",
      ], { cwd, env, stdout: out, stderr: out });
      assert.equal(code, 0, out.text());
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.status, "timed_out");
      assert.deepEqual(ticket.error, { code: "AGENT_TIMEOUT", message: "host probe reported the agent missing" });
      assert.equal(ticket.safety_verdict.accepted, true);
    });
  });
});
