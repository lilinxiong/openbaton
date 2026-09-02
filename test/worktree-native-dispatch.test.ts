import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDispatch } from "../src/commands/dispatch.js";
import { bindAgent, finishAgent, releaseAgent, reportAgentProbe, reserveNext } from "../src/lib/dispatch.js";
import { collectGitSafetyFacts } from "../src/lib/git/safety-facts.js";
import { markRouteAvailable } from "../src/lib/model-availability.js";
import { worktreeExecutionRootPath, worktreeRecordPath } from "../src/lib/paths.js";
import { buildReadOnlyReceipt, buildWriteReceipt, writeReceipt } from "../src/lib/receipt.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { captureBaseline } from "../src/lib/safety.js";
import { buildSpawnTicket, nextSpawnId, readSpawn, writeSpawn } from "../src/lib/spawn.js";
import { readPersistedWorktreeRecord } from "../src/lib/worktree-execution.js";
import { cleanupWorktreeAttempt, recoverWorktreeRun } from "../src/lib/worktree-lifecycle.js";
import { setupDetachedWorktree } from "../src/lib/worktree/setup.js";
import { resolveOwningRepository } from "../src/lib/worktree/topology.js";
import { configureCli } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";

const HOST = "codex";
const ROUTE = "codex/exact-root";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(home: string, session: string, writePath = "tracked.txt") {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "baton-native-root-"));
  const cwd = path.join(outer, "repo");
  fs.mkdirSync(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
  if (writePath.startsWith("caller-link/")) fs.symlinkSync(cwd, path.join(cwd, "caller-link"), "dir");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "base"]);
  const env = fakeEnv(home, {
    BATON_SESSION_ID: session,
    BATON_ADAPTER_PATHS: path.resolve("adapters/codex"),
  });
  configureCli(cwd, env, HOST, [ROUTE]);
  publishRouteSnapshot(cwd, {
    models: [{ id: ROUTE, route_id: ROUTE, provider: HOST, supportedReasoningEfforts: [] }],
  }, new Date("2026-09-01T00:00:00.000Z"), { cli: HOST, host: HOST, env });
  markRouteAvailable(cwd, { host: HOST, routeId: ROUTE }, { now: "2026-09-01T00:00:00.000Z", env });
  const repository = resolveOwningRepository(cwd, "tracked.txt").repository;
  const runId = `run-${session}`;
  const unitKey = "unit-native";
  const attemptId = "attempt-native";
  const executionRoot = worktreeExecutionRootPath(cwd, runId, unitKey, attemptId, env);
  const setup = await setupDetachedWorktree({
    repository_root: cwd,
    repository_id: repository.repository_id,
    git_common_dir: repository.git_common_dir,
    git_common_dir_identity: repository.git_common_dir_identity,
    execution_root: executionRoot,
    run_id: runId,
    unit_key: unitKey,
    unit_version: 1,
    attempt_id: attemptId,
    env,
  });
  const exactRoot = {
    repository_id: setup.record.repository_id,
    git_common_dir_identity: setup.record.git_common_dir_identity,
    execution_root: setup.record.execution_root,
    base_tree: setup.record.base_tree,
    worktree_record_id: setup.record.record_id,
  };
  const lineage = {
    schema_version: 1 as const,
    run_id: runId,
    unit_key: unitKey,
    unit_version: 1,
    unit_fingerprint: "a".repeat(64),
    task_keys: ["task-native"],
    mode: "patch-only" as const,
    worktree_mode: "isolated-worktree" as const,
    ...exactRoot,
  };
  const selection = {
    host: HOST,
    proposal_id: "proposal-native",
    approval_id: `approval-${session}`,
    approved_at: "2026-09-01T00:00:00.000Z",
    confirmed_by: "baton-recommendation" as const,
    catalog_fingerprint: "catalog-native",
    recommended_model_id: ROUTE,
    selected_model_id: ROUTE,
    changed_by_user: false,
  };
  const ticket = buildSpawnTicket({
    cwd, env, id: nextSpawnId(cwd, "spn", env), description: "edit isolated root", prompt: "edit isolated root",
    modelId: ROUTE, routeId: ROUTE, taskKind: "concrete", selection, targetHost: HOST,
    rollingUnitLineage: lineage, deliverable: "isolated edit", doneWhen: "isolated edit is complete",
    readContext: ["tracked.txt"], writePaths: [writePath], allowedOperations: ["write"],
    completionCriteria: ["root remains exact"], permittedValidation: ["read"],
  });
  const base = buildReadOnlyReceipt({
    ticketId: ticket.id,
    card: { id: ROUTE, route_id: ROUTE, provider: HOST, strengths: "exact root" },
    issuedAt: ticket.created_at,
    selection,
    host: HOST,
    rollingUnitLineage: lineage,
  });
  const receipt = buildWriteReceipt({
    base,
    baseline: captureBaseline(executionRoot, new Date(ticket.created_at)),
    writeAllowlist: [writePath],
    allowedOperations: ["write"],
  });
  ticket.mode = "write";
  ticket.read_only = false;
  ticket.receipt_id = receipt.receipt_id;
  writeReceipt(cwd, receipt, env);
  writeSpawn(cwd, ticket, env);
  const handle = { kind: "task_name", value: `native-${session}`, source: "native-return" as const, ...exactRoot };
  return { outer, cwd, env, ticket, receipt, setup, exactRoot, handle, runId, unitKey, attemptId, executionRoot };
}

describe("isolated native dispatch", () => {
  it("does not blame an active isolated worker for parent-owned shared ref movement", async () => withHome(async (home) => {
    const f = await fixture(home, "native-parent-ref-movement");
    try {
      await reserveNext(f.cwd, { capacity: 1, limit: 1, host: HOST, env: f.env });
      bindAgent(f.cwd, f.ticket.id, { executionHandle: f.handle, host: HOST, env: f.env });
      git(f.cwd, ["tag", "parent-integration-moved-refs"]);
      fs.writeFileSync(path.join(f.executionRoot, "tracked.txt"), "worker after parent integration\n");

      const terminal = await finishAgent(f.cwd, f.ticket.id, {
        status: "completed", conclusion: "worker remained isolated", host: HOST, env: f.env,
      });
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.error, null);
      assert.ok(!(terminal.safety_verdict as any).violations.some((item: any) => item.code === "E_REFS_MUTATION"));
    } finally {
      fs.rmSync(f.outer, { recursive: true, force: true });
    }
  }));

  it("propagates one exact root, requires identical acknowledgement, and retains terminal-unreleased lineage", async () => withHome(async (home) => {
    const f = await fixture(home, "native-success");
    try {
      const reserved = await reserveNext(f.cwd, { capacity: 1, limit: 1, host: HOST, env: f.env });
      assert.deepEqual(reserved.reserved[0]?.reservation, {
        schema: 1,
        reservation_id: reserved.reserved[0]!.reservation.reservation_id,
        ticket_id: f.ticket.id,
        attempt: 1,
        host: HOST,
        ...f.exactRoot,
      });
      assert.equal(reserved.reserved[0]?.execution_root, f.executionRoot);
      assert.throws(() => bindAgent(f.cwd, f.ticket.id, {
        executionHandle: { kind: "task_name", value: "missing-ack", source: "native-return" },
        host: HOST,
        env: f.env,
      }), (error: unknown) => (error as { code?: string }).code === "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH");
      await assert.rejects(runDispatch([
        "bind", f.ticket.id, "--host", HOST, "--execution-handle", `task_name=${f.handle.value}`,
        "--repository-id", f.exactRoot.repository_id, "--json",
      ], { cwd: f.cwd, env: f.env, stdout: { write: () => {} } }), /all five identity flags/);
      const bindOutput: string[] = [];
      assert.equal(await runDispatch([
        "bind", f.ticket.id, "--host", HOST, "--execution-handle", `task_name=${f.handle.value}`,
        "--repository-id", f.exactRoot.repository_id,
        "--git-common-dir-identity", f.exactRoot.git_common_dir_identity,
        "--execution-root", f.exactRoot.execution_root,
        "--base-tree", f.exactRoot.base_tree,
        "--worktree-record-id", f.exactRoot.worktree_record_id,
        "--json",
      ], { cwd: f.cwd, env: f.env, stdout: { write: (chunk) => bindOutput.push(chunk) } }), 0);
      const bound = JSON.parse(bindOutput.join("")).ticket;
      assert.deepEqual(bound.execution_handle, { ...f.handle, source: "manual" });
      assert.deepEqual(bound.liveness?.execution_handle, { ...f.handle, source: "manual" });
      const simpleHandle = { kind: "task_name", value: f.handle.value, source: "manual" as const };
      const probeOutput: string[] = [];
      assert.equal(await runDispatch([
        "probe", f.ticket.id, "--host", HOST, "--execution-handle", `task_name=${f.handle.value}`,
        "--state", "running", "--activity", "heartbeat", "--json",
      ], { cwd: f.cwd, env: f.env, stdout: { write: (chunk) => probeOutput.push(chunk) } }), 0);
      assert.equal(JSON.parse(probeOutput.join("")).ticket.liveness.execution_handle.execution_root, f.executionRoot);
      assert.throws(() => reportAgentProbe(f.cwd, f.ticket.id, {
        executionHandle: { ...simpleHandle, repository_id: f.exactRoot.repository_id },
        state: "running", host: HOST, env: f.env,
      }), (error: unknown) => (error as { code?: string }).code === "EXECUTION_ROOT_ACKNOWLEDGEMENT_MISMATCH");
      fs.writeFileSync(path.join(f.executionRoot, "tracked.txt"), "worker\n");
      const terminal = await finishAgent(f.cwd, f.ticket.id, { status: "completed", conclusion: "done", host: HOST, env: f.env });
      assert.equal(terminal.slot_released_at, undefined);
      const record = readPersistedWorktreeRecord(f.cwd, f.runId, f.unitKey, f.attemptId, f.env);
      assert.equal(record.lifecycle_state, "terminal_awaiting_audit");
      assert.deepEqual(record.retention_reasons, ["pending_audit", "terminal_unreleased_ticket"]);
      const releaseOutput: string[] = [];
      assert.equal(await runDispatch([
        "release", f.ticket.id, "--host", HOST, "--execution-handle", `task_name=${f.handle.value}`, "--json",
      ], { cwd: f.cwd, env: f.env, stdout: { write: (chunk) => releaseOutput.push(chunk) } }), 0);
      assert.ok(JSON.parse(releaseOutput.join("")).ticket.slot_released_at);
    } finally {
      fs.rmSync(f.outer, { recursive: true, force: true });
    }
  }));

  it("fails closed before spawn when a symlink scope escapes to the caller checkout", async () => withHome(async (home) => {
    const f = await fixture(home, "native-symlink", "caller-link/tracked.txt");
    try {
      const result = await reserveNext(f.cwd, { capacity: 1, limit: 1, host: HOST, env: f.env });
      assert.equal(result.reserved.length, 0);
      assert.equal(result.blocked[0]?.code, "EXECUTION_ROOT_SCOPE_ESCAPE");
      assert.equal(readSpawn(f.cwd, f.ticket.id, f.env).status, "errored");
    } finally {
      fs.rmSync(f.outer, { recursive: true, force: true });
    }
  }));

  it("releases an isolated reservation when native spawn fails before a handle exists", async () => withHome(async (home) => {
    const f = await fixture(home, "native-failure");
    try {
      await reserveNext(f.cwd, { capacity: 1, limit: 1, host: HOST, env: f.env });
      const terminal = await finishAgent(f.cwd, f.ticket.id, {
        status: "errored", errorCode: "NATIVE_SPAWN_FAILED", errorMessage: "native spawn failed", host: HOST, env: f.env,
      });
      assert.ok(terminal.slot_released_at);
      assert.equal(terminal.execution_handle, null);
      const rejected = readPersistedWorktreeRecord(f.cwd, f.runId, f.unitKey, f.attemptId, f.env);
      assert.equal(rejected.lifecycle_state, "rejected");
      assert.deepEqual(rejected.retention_reasons, ["rejected_result_evidence"]);
      const cleaned = await cleanupWorktreeAttempt({
        cwd: f.cwd,
        run_id: f.runId,
        unit_key: f.unitKey,
        attempt_id: f.attemptId,
        env: f.env,
        discard_rejected_evidence: true,
      });
      assert.equal(cleaned.record.lifecycle_state, "cleaned");
    } finally {
      fs.rmSync(f.outer, { recursive: true, force: true });
    }
  }));

  it("persists a terminal ticket before a failed record transition and lets recovery finish the projection", async () => withHome(async (home) => {
    const f = await fixture(home, "native-terminal-recovery");
    const recordFile = worktreeRecordPath(f.cwd, f.runId, f.unitKey, f.attemptId, f.env);
    const displaced = `${recordFile}.blocked`;
    try {
      await reserveNext(f.cwd, { capacity: 1, limit: 1, host: HOST, env: f.env });
      bindAgent(f.cwd, f.ticket.id, { executionHandle: f.handle, host: HOST, env: f.env });
      fs.writeFileSync(path.join(f.executionRoot, "tracked.txt"), "terminal before projection failure\n");
      let moved = false;
      await assert.rejects(finishAgent(f.cwd, f.ticket.id, {
        status: "completed", conclusion: "terminal ticket survives", host: HOST, env: f.env,
        safety: {
          collectFacts: async (root, options) => {
            const facts = await collectGitSafetyFacts(root, options);
            if (!moved) { fs.renameSync(recordFile, displaced); moved = true; }
            return facts;
          },
        },
      }));
      const terminal = readSpawn(f.cwd, f.ticket.id, f.env);
      assert.equal(terminal.status, "completed");
      fs.renameSync(displaced, recordFile);
      const recovered = await recoverWorktreeRun({ cwd: f.cwd, run_id: f.runId, env: f.env, tickets: [terminal] });
      assert.ok(recovered.repaired_record_ids.includes(f.setup.record.record_id));
      assert.equal(readPersistedWorktreeRecord(f.cwd, f.runId, f.unitKey, f.attemptId, f.env).lifecycle_state, "terminal_awaiting_audit");
    } finally {
      if (fs.existsSync(displaced) && !fs.existsSync(recordFile)) fs.renameSync(displaced, recordFile);
      fs.rmSync(f.outer, { recursive: true, force: true });
    }
  }));
});
