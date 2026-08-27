import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { finishAgent } from "../src/lib/dispatch.js";
import { collectGitSafetyFacts } from "../src/lib/git-safety-facts.js";
import { receiptsDir, spawnsDir } from "../src/lib/paths.js";
import { withHome, fakeEnv } from "./home.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { configureCodex } from "./configure.js";
import { recordNativeIdentity, recordPendingReservation } from "../src/lib/host-identity.js";
import { readModelAvailability } from "../src/lib/model-availability.js";
import { readRouteHealth } from "../src/lib/route-health.js";

const CODEX_HOOK_AGENT_ID = "codex-hook-agent-write";
const CODEX_TASK_NAME = "codex-task-write";

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
  let hasHost = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--host") hasHost = true;
    automaticArgs.push(args[index]);
  }
  if (!hasHost) automaticArgs.push("--host", "codex");
  const proposalOut = capture();
  const proposed = await run([...automaticArgs, "--json"], { cwd, env, stdout: proposalOut, stderr: proposalOut });
  assert.equal(proposed, 0, proposalOut.text());
  const approval = JSON.parse(proposalOut.text());
  assert.equal(approval.status, "approved");
  assert.equal(approval.approvals[0].confirmed_by, "baton-recommendation");
}

function observeCodexDispatch(cwd: string, env: NodeJS.ProcessEnv, id: string): void {
  const ticket = readTicket(cwd, id);
  const pending = recordPendingReservation(cwd, {
    schema: 1,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: "codex",
  }, {}, undefined, env);
  recordNativeIdentity(cwd, pending, CODEX_HOOK_AGENT_ID, "hook", {}, undefined, env);
}

async function boundWriteTicket(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await run(["init"], { cwd, env, stdout: sink(), stderr: sink() });
  syncModel(cwd);
  await approvedSpawn(cwd, env, ["spawn", "implement allowed file", "--classification", "implementation", "--write-path", "allowed.txt", "--write-ops", "write"]);
  await run(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
  observeCodexDispatch(cwd, env, "spn-0001");
  await run(["dispatch", "bind", "spn-0001", "--host", "codex", "--task-name", CODEX_TASK_NAME, "--json"], { cwd, env, stdout: sink(), stderr: sink() });
}

function receiptFile(cwd: string, id: string): string {
  const ticket = readTicket(cwd, id);
  return path.join(receiptsDir(cwd), `${ticket.receipt_id}.json`);
}

async function reportMissingWriteAgent(cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const out = capture();
  const code = await run([
    "dispatch", "probe", "spn-0001", "--task-name", CODEX_TASK_NAME, "--state", "not_found", "--json",
  ], { cwd, env, stdout: out, stderr: out });
  assert.equal(code, 0, out.text());
  return JSON.parse(out.text()).ticket.liveness.sequence;
}

describe("write dispatch safety integration", () => {
  it("audits an algorithm-less legacy Receipt through the dispatch boundary", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      const legacyFacts = await collectGitSafetyFacts(cwd, { indexControlAlgorithm: "legacy-json-sorted-v1" });
      const file = receiptFile(cwd, "spn-0001");
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      receipt.baseline.index_control_checksum = legacyFacts.indexControl.checksum;
      delete receipt.baseline.index_control_algorithm;
      delete receipt.baseline.index_control_entry_count;
      fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "LEGACY_WORKER_ALLOWED\n");
      await finishAgent(cwd, "spn-0001", { status: "completed", conclusion: "legacy accepted", env });
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.status, "completed");
      assert.equal(ticket.safety_verdict.accepted, true);
    });
  });

  it("rejects a v2 Receipt when the streamed entry count no longer matches", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      const file = receiptFile(cwd, "spn-0001");
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      receipt.baseline.index_control_entry_count += 1;
      fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      await run(["dispatch", "complete", "spn-0001", "--text", "must reject", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error.code, "WRITE_SCOPE_VIOLATION");
      assert.ok(ticket.safety_verdict.violations.some((item: { code: string }) => item.code === "E_INDEX_MUTATION"));
    });
  });

  it("fails closed before a verdict when a persisted Receipt names an unknown algorithm", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      const file = receiptFile(cwd, "spn-0001");
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      receipt.baseline.index_control_algorithm = "future-v3";
      fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
      await assert.rejects(
        () => finishAgent(cwd, "spn-0001", { status: "completed", conclusion: "must reject", env }),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INDEX_CONTROL_ALGORITHM_UNSUPPORTED",
      );
      assert.equal(readTicket(cwd, "spn-0001").status, "running");
    });
  });

  it("completes an allowlisted write after the parent gate passes", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await run(["init"], { cwd, env, stdout: sink(), stderr: sink() });
      syncModel(cwd);
      await approvedSpawn(cwd, env, ["spawn", "implement allowed file", "--classification", "implementation", "--write-path", "allowed.txt", "--write-ops", "write"]);
      await run(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      observeCodexDispatch(cwd, env, "spn-0001");
      await run(["dispatch", "bind", "spn-0001", "--host", "codex", "--task-name", CODEX_TASK_NAME, "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      await run(["dispatch", "complete", "spn-0001", "--host", "codex", "--text", "write accepted", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
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
      await approvedSpawn(cwd, env, ["spawn", "implement allowed file", "--classification", "implementation", "--write-path", "allowed.txt", "--write-ops", "write"]);
      await run(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      observeCodexDispatch(cwd, env, "spn-0001");
      await run(["dispatch", "bind", "spn-0001", "--host", "codex", "--task-name", CODEX_TASK_NAME, "--json"], { cwd, env, stdout: sink(), stderr: sink() });
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
      await approvedSpawn(cwd, env, ["spawn", "survey the repository structure", "--classification", "implementation"]);
      assert.ok(fs.existsSync(path.join(receiptsDir(cwd), "rcpt-spn-0001-a1.json")));
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));

      await approvedSpawn(cwd, env, ["spawn", "implement allowed file", "--classification", "implementation", "--write-path", "allowed.txt", "--write-ops", "write"]);
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(cwd), "rcpt-spn-0002-a1.json"), "utf8"));
      assert.deepEqual(receipt.baseline.dirty_entries, []);

      await run(["dispatch", "next", "--host", "codex", "--capacity", "2", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      observeCodexDispatch(cwd, env, "spn-0002");
      await run(["dispatch", "bind", "spn-0002", "--host", "codex", "--task-name", CODEX_TASK_NAME, "--json"], { cwd, env, stdout: sink(), stderr: sink() });
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
      assert.deepEqual(snap.awaiting_release, [{
      ticket_id: "spn-0001",
        execution_handle: { kind: "task_name", value: CODEX_TASK_NAME, source: "native-return" },
        agent_id: CODEX_HOOK_AGENT_ID,
        status: "errored",
      }]);
      await run(["dispatch", "release", "spn-0001", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
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

  it("creates an immutable queued successor only for quota exhaustion with a clean write baseline", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      configureCodex(cwd, env, ["kimi/k3[1m]", "kimi/k2[1m]"]);
      publishRouteSnapshot(cwd, { models: [
        { id: "k3[1m]", provider: "kimi" },
        { id: "k2[1m]", provider: "kimi" },
      ] }, new Date(), { cli: "codex", host: "codex", env });
      const out = capture();
      const code = await run([
        "dispatch", "fail", "spn-0001", "--code", "MODEL_QUOTA_EXHAUSTED",
        "--remaining-percent", "0", "--message", "model quota exhausted", "--json",
      ], { cwd, env, stdout: out, stderr: out });
      assert.equal(code, 0, out.text());
      const oldTicket = readTicket(cwd, "spn-0001");
      assert.equal(oldTicket.status, "errored");
      assert.equal(oldTicket.fallback_reason, "QUOTA_EXHAUSTED_SUCCESSOR_CREATED");
      assert.equal(oldTicket.fallback_successor_id, "spn-0002");
      const successor = readTicket(cwd, "spn-0002");
      assert.equal(successor.status, "queued");
      assert.equal(successor.fallback_from_ticket_id, "spn-0001");
      assert.equal(successor.route_id, "kimi/k2[1m]");
      assert.equal(successor.receipt_id, "rcpt-spn-0002-a1");
    });
  });

  it("requires reconciliation instead of falling back after an allowed workspace mutation", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      configureCodex(cwd, env, ["kimi/k3[1m]", "kimi/k2[1m]"]);
      publishRouteSnapshot(cwd, { models: [
        { id: "k3[1m]", provider: "kimi" },
        { id: "k2[1m]", provider: "kimi" },
      ] }, new Date(), { cli: "codex", host: "codex", env });
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "AUTHORIZED_MUTATION\n");
      const out = capture();
      assert.equal(await run([
        "dispatch", "fail", "spn-0001", "--host", "codex",
        "--code", "MODEL_QUOTA_EXHAUSTED", "--remaining-percent", "0",
        "--message", "model quota exhausted", "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const ticket = readTicket(cwd, "spn-0001");
      assert.equal(ticket.safety_verdict.accepted, true);
      assert.equal(ticket.fallback_reason, "FALLBACK_REQUIRES_RECONCILIATION");
      assert.equal(fs.existsSync(path.join(spawnsDir(cwd), "spn-0002.json")), false);
    });
  });

  it("re-runs successor effort hard gates in Coding priority order", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await boundWriteTicket(cwd, env);
      configureCodex(cwd, env, ["kimi/k3[1m]", "kimi/k2[1m]", "kimi/k1[1m]"]);
      publishRouteSnapshot(cwd, { models: [
        { id: "k3[1m]", provider: "kimi", supportedReasoningEfforts: [{ id: "high" }] },
        { id: "k2[1m]", provider: "kimi", supportedReasoningEfforts: [{ id: "low" }] },
        { id: "k1[1m]", provider: "kimi", supportedReasoningEfforts: [{ id: "high" }] },
      ] }, new Date(), { cli: "codex", host: "codex", env });
      const ticketFile = path.join(spawnsDir(cwd), "spn-0001.json");
      const ticket = JSON.parse(fs.readFileSync(ticketFile, "utf8"));
      ticket.routing_requirements = { required_reasoning_effort: "high", estimated_context_tokens: 1 };
      fs.writeFileSync(ticketFile, `${JSON.stringify(ticket, null, 2)}\n`);

      const out = capture();
      assert.equal(await run([
        "dispatch", "fail", "spn-0001", "--host", "codex",
        "--code", "MODEL_QUOTA_EXHAUSTED", "--remaining-percent", "0",
        "--message", "model quota exhausted", "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      assert.equal(readTicket(cwd, "spn-0002").route_id, "kimi/k1[1m]");
    });
  });

  it("keeps generic throttling, network, and timeout errors out of durable availability", async () => {
    await withHome(async (home) => {
      const env = fakeEnv(home);
      for (const errorCode of ["UPSTREAM_429", "NETWORK_ERROR", "AGENT_TIMEOUT"]) {
        const cwd = fixture();
        await boundWriteTicket(cwd, env);
        const availabilityBeforeFailure = readModelAvailability(cwd, env);
        const out = capture();
        assert.equal(await run([
          "dispatch", "fail", "spn-0001", "--host", "codex",
          "--code", errorCode, "--message", `${errorCode} transient failure`, "--json",
        ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
        assert.equal(readRouteHealth(cwd, env).records.some((record) => record.route_id === "kimi/k3[1m]"), true);
        assert.deepEqual(readModelAvailability(cwd, env), availabilityBeforeFailure);
      }
      assert.equal(readModelAvailability(process.cwd(), env).records.some((record) => record.status === "exhausted"), false);
    });
  });
});
