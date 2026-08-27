import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { run } from "../src/cli.js";
import { activationLockPath, dispatchLockPath, globalActivationLockPath, spawnsDir } from "../src/lib/paths.js";
import { finishAgent, reserveNext } from "../src/lib/dispatch.js";
import { GitSafetyError } from "../src/lib/git-safety-process.js";
import { collectGitSafetyFacts } from "../src/lib/git-safety-facts.js";
import { recordNativeIdentity, recordPendingReservation } from "../src/lib/host-identity.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { configureCodex } from "./configure.js";
import { fakeEnv, withHome } from "./home.js";

function sink() { return { write() { return true; } }; }
function capture() {
  const chunks: string[] = [];
  return {
    write(value: unknown) { chunks.push(String(value)); return true; },
    text() { return chunks.join(""); },
  };
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function fixture(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-commit-dispatch-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "validation@example.invalid");
  git(cwd, "config", "user.name", "Validation");
  fs.writeFileSync(path.join(cwd, "allowed.txt"), "BASE_ALLOWED\n");
  fs.writeFileSync(path.join(cwd, "denied.txt"), "BASE_DENIED\n");
  git(cwd, "add", "allowed.txt", "denied.txt");
  git(cwd, "commit", "-q", "-m", "baseline");
  fs.appendFileSync(path.join(cwd, "allowed.txt"), "STAGED\n");
  git(cwd, "add", "allowed.txt");
  return cwd;
}
function readTicket(cwd: string, id = "spn-0001") {
  return JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${id}.json`), "utf8"));
}

const COMMIT_CLASSIFICATION = JSON.stringify({
  kind: "mechanical",
  operation: "git-commit",
  capabilities: ["commit"],
});

async function createCommitTicket(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  assert.equal(await run(["init"], { cwd, env, stdout: sink(), stderr: sink() }), 0);
  publishRouteSnapshot(cwd, { models: [
    { id: "k3[1m]", provider: "kimi", contextWindow: 1_048_576 },
    { id: "mimo-v2.5-pro", provider: "mimo", contextWindow: 262_144 },
  ] });
  configureCodex(cwd, env, ["kimi/k3[1m]", "mimo/mimo-v2.5-pro"], {
    runner: "mimo/mimo-v2.5-pro",
    longctx: "kimi/k3[1m]",
  });
  const out = capture();
  assert.equal(await run(["spawn", "git commit staged changes", "--host", "codex", "--classification", COMMIT_CLASSIFICATION, "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
  assert.equal(readTicket(cwd).mode, "commit-only");
  const ticket = readTicket(cwd);
  const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(spawnsDir(cwd)), "receipts", `${ticket.receipt_id}.json`), "utf8"));
  assert.equal(receipt.commit_baseline.staged_index_control_algorithm, "git-index-control-framed-sha256-v2");
  assert.equal(typeof receipt.commit_baseline.staged_index_control_entry_count, "number");
}

async function bindCommitTicket(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await createCommitTicket(cwd, env);
  const reserved = capture();
  assert.equal(await run(["dispatch", "next", "--host", "codex", "--capacity", "4", "--json"], { cwd, env, stdout: reserved, stderr: reserved }), 0, reserved.text());
  assert.equal(JSON.parse(reserved.text()).reserved.length, 1);
  const ticket = readTicket(cwd);
  const pending = recordPendingReservation(cwd, {
    schema: 1,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: "codex",
  }, {}, undefined, env);
  recordNativeIdentity(cwd, pending, "codex-hook-uuid", "hook", {}, undefined, env);
  assert.equal(await run(["dispatch", "bind", "spn-0001", "--host", "codex", "--task-name", "codex-task-name", "--json"], { cwd, env, stdout: sink(), stderr: sink() }), 0);
}

function parseJson(text: string) {
  return JSON.parse(text.slice(text.indexOf("{")));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(predicate(), true, "condition did not become true before timeout");
}

function lockOwner(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as { token: string; lease_until: string; refreshed_at: string };
}

describe("commit-only dispatch integration", () => {
  it("spawn --dispatch reserves a commit-only ticket in one call", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: sink(), stderr: sink() }), 0);
      publishRouteSnapshot(cwd, { models: [
        { id: "k3[1m]", provider: "kimi", contextWindow: 1_048_576 },
        { id: "mimo-v2.5-pro", provider: "mimo", contextWindow: 262_144 },
      ] });
      configureCodex(cwd, env, ["kimi/k3[1m]", "mimo/mimo-v2.5-pro"], {
        runner: "mimo/mimo-v2.5-pro",
        longctx: "kimi/k3[1m]",
      });
      const out = capture();
      assert.equal(await run(["spawn", "git commit staged changes", "--host", "codex", "--classification", COMMIT_CLASSIFICATION, "--dispatch", "--json"], {
        cwd, env, stdout: out, stderr: out,
      }), 0, out.text());
      const payload = parseJson(out.text());
      assert.equal(payload.dispatched[0].ticket.mode, "commit-only");
      assert.equal(payload.reserved.length, 1);
      assert.equal(payload.reserved[0].ticket_id, payload.dispatched[0].ticket.id);
      assert.equal(payload.reserved[0].mode, "commit-only");
      assert.match(payload.reserved[0].prompt, /commit-only authorization/);
      assert.equal(readTicket(cwd).status, "dispatching");
    });
  });

  it("accepts one worker-created commit with the frozen staged tree", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      const originalHead = git(cwd, "rev-parse", "HEAD").trim();
      await bindCommitTicket(cwd, env);

      git(cwd, "commit", "-q", "-m", "feat: worker commit");
      assert.equal(await run(["dispatch", "complete", "spn-0001", "--text", "commit created", "--json"], { cwd, env, stdout: sink(), stderr: sink() }), 0);
      const ticket = readTicket(cwd);
      assert.equal(ticket.status, "completed");
      assert.equal(ticket.error, null);
      assert.equal(ticket.safety_verdict.accepted, true);
      assert.equal(ticket.safety_verdict.committed, true);
      assert.equal(ticket.safety_verdict.commit.parent, originalHead);
      assert.equal(ticket.safety_verdict.commit.subject, "feat: worker commit");
    });
  });

  it("rejects a completed worker that did not create a commit", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await bindCommitTicket(cwd, env);

      assert.equal(await run(["dispatch", "complete", "spn-0001", "--text", "claimed completion", "--json"], { cwd, env, stdout: sink(), stderr: sink() }), 0);
      const ticket = readTicket(cwd);
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error.code, "COMMIT_SCOPE_VIOLATION");
      assert.ok(ticket.safety_verdict.violations.some((item) => item.code === "E_COMMIT_MISSING"));
    });
  });

  it("cannot weaken commit completion policy through an injected safety option", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await bindCommitTicket(cwd, env);

      const unsafeRuntimeOptions = { requireCommit: false } as unknown as import("../src/lib/safety.js").AsyncSafetyOptions;
      const ticket = await finishAgent(cwd, "spn-0001", {
        status: "completed", conclusion: "claimed completion", env, safety: unsafeRuntimeOptions,
      });
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error?.code, "COMMIT_SCOPE_VIOLATION");
      assert.ok(ticket.safety_verdict && (ticket.safety_verdict.violations as Array<{ code: string }>).some((item) => item.code === "E_COMMIT_MISSING"));
    });
  });

  it("rejects a worker that widens the staged tree before committing", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await bindCommitTicket(cwd, env);

      fs.appendFileSync(path.join(cwd, "denied.txt"), "OUT_OF_SCOPE\n");
      git(cwd, "add", "denied.txt");
      git(cwd, "commit", "-q", "-m", "worker widened commit");
      assert.equal(await run(["dispatch", "complete", "spn-0001", "--text", "must be rejected", "--json"], { cwd, env, stdout: sink(), stderr: sink() }), 0);
      const ticket = readTicket(cwd);
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error.code, "COMMIT_SCOPE_VIOLATION");
      assert.ok(ticket.safety_verdict.violations.some((item) => item.code === "E_COMMIT_TREE_MISMATCH"));
    });
  });

  it("keeps the original host error when a failed worker leaves the staged baseline untouched", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await bindCommitTicket(cwd, env);

      const out = capture();
      assert.equal(await run([
        "dispatch", "fail", "spn-0001", "--code", "WORKER_CRASHED", "--message", "commit worker failed", "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const ticket = readTicket(cwd);
      assert.equal(ticket.status, "errored");
      assert.deepEqual(ticket.error, { code: "WORKER_CRASHED", message: "commit worker failed" });
      assert.equal(ticket.safety_verdict.accepted, true);
      assert.equal(ticket.safety_verdict.committed, false);
      assert.equal(git(cwd, "diff", "--cached", "--name-only").trim(), "allowed.txt");
    });
  });

  it("blocks reservation when the frozen staged baseline becomes stale", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await createCommitTicket(cwd, env);
      fs.appendFileSync(path.join(cwd, "denied.txt"), "LATE\n");
      git(cwd, "add", "denied.txt");

      const out = capture();
      assert.equal(await run(["dispatch", "next", "--host", "codex", "--capacity", "4", "--json"], { cwd, env, stdout: out, stderr: out }), 1, out.text());
      const result = JSON.parse(out.text());
      assert.deepEqual(result.reserved, []);
      assert.equal(result.blocked[0].code, "COMMIT_BASELINE_STALE");
      assert.equal(readTicket(cwd).status, "errored");
    });
  });

  it("propagates async Git safety collection failures during reservation", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await createCommitTicket(cwd, env);
      fs.writeFileSync(path.join(cwd, ".git", "index"), Buffer.from("corrupt-index\n"));

      await assert.rejects(
        () => reserveNext(cwd, { capacity: 4, host: "codex", env }),
        (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_SAFETY_COMMAND_FAILED",
      );
      assert.equal(readTicket(cwd).status, "queued");
      assert.equal(fs.existsSync(dispatchLockPath(cwd)), false);
      assert.equal(fs.existsSync(globalActivationLockPath("codex", env)), false);
      assert.equal(fs.existsSync(activationLockPath(cwd, env, "codex")), false);
    });
  });

  it("propagates async Git safety collection failures during terminal completion", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await bindCommitTicket(cwd, env);
      fs.writeFileSync(path.join(cwd, ".git", "index"), Buffer.from("corrupt-index\n"));

      await assert.rejects(
        () => finishAgent(cwd, "spn-0001", { status: "completed", conclusion: "commit attempted", env }),
        (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_SAFETY_COMMAND_FAILED",
      );
      assert.equal(readTicket(cwd).status, "running");
      assert.equal(fs.existsSync(dispatchLockPath(cwd)), false);
    });
  });

  it("keeps a live paused reservation owned beyond lease/stale thresholds and serializes a competitor", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await createCommitTicket(cwd, env);
      const gate = deferred<void>();
      const reservation = reserveNext(cwd, {
        capacity: 4, host: "codex", env,
        activationLock: { leaseMs: 20, staleMs: 20, refreshIntervalMs: 3 },
        dispatchLock: { leaseMs: 20, staleMs: 20, refreshIntervalMs: 3 },
        safety: { collectFacts: async (root, options) => { await gate.promise; return collectGitSafetyFacts(root, options); } },
      });
      await until(() => fs.existsSync(globalActivationLockPath("codex", env)) && fs.existsSync(activationLockPath(cwd, env, "codex")) && fs.existsSync(dispatchLockPath(cwd)));
      const before = lockOwner(dispatchLockPath(cwd));
      await new Promise((resolve) => setTimeout(resolve, 65));
      const after = lockOwner(dispatchLockPath(cwd));
      assert.notEqual(after.lease_until, before.lease_until, "live scan lease was not refreshed");
      await assert.rejects(() => reserveNext(cwd, { capacity: 1, host: "codex", env, activationLock: { staleMs: 1 }, dispatchLock: { staleMs: 1 } }), (error: unknown) => (error as { code?: string }).code === "ACTIVATION_LOCK_BUSY");
      gate.resolve();
      const result = await reservation;
      assert.deepEqual(result.reserved.map((item) => item.ticket_id), ["spn-0001"]);
      assert.equal(fs.existsSync(globalActivationLockPath("codex", env)), false);
      assert.equal(fs.existsSync(activationLockPath(cwd, env, "codex")), false);
      assert.equal(fs.existsSync(dispatchLockPath(cwd)), false);
    });
  });

  it("serializes paused terminal completion against reservation without deadlock and recovers locks", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await bindCommitTicket(cwd, env);
      const gate = deferred<void>();
      const completion = finishAgent(cwd, "spn-0001", {
        status: "errored", errorCode: "INTERRUPTED", env,
        dispatchLock: { leaseMs: 20, staleMs: 20, refreshIntervalMs: 3 },
        safety: { collectFacts: async (root, options) => { await gate.promise; return collectGitSafetyFacts(root, options); } },
      });
      await until(() => fs.existsSync(dispatchLockPath(cwd)));
      const started = Date.now();
      await assert.rejects(() => reserveNext(cwd, { capacity: 1, host: "codex", env, dispatchLock: { staleMs: 1 } }), (error: unknown) => (error as { code?: string }).code === "DISPATCH_LOCKED");
      assert.ok(Date.now() - started < 500, "competing reservation was not bounded");
      assert.equal(fs.existsSync(globalActivationLockPath("codex", env)), false);
      assert.equal(fs.existsSync(activationLockPath(cwd, env, "codex")), false);
      gate.resolve();
      const done = await completion;
      assert.equal(done.status, "errored");
      assert.equal(fs.existsSync(dispatchLockPath(cwd)), false);
      await assert.rejects(() => finishAgent(cwd, "spn-0001", { status: "closed", env }), /already terminal/);
    });
  });

  it("cleans only caller-owned locks after ordinary rejection and preserves a foreign dispatch owner", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await createCommitTicket(cwd, env);
      const gate = deferred<void>();
      const failure = reserveNext(cwd, { capacity: 1, host: "codex", env, dispatchLock: { leaseMs: 20, refreshIntervalMs: 3 }, safety: { collectFacts: async () => { await gate.promise; throw new Error("injected rejection"); } } });
      await until(() => fs.existsSync(dispatchLockPath(cwd)));
      fs.unlinkSync(dispatchLockPath(cwd));
      const foreign = { version: 1, token: "foreign-token", pid: process.pid, operation: "foreign", acquired_at: new Date().toISOString(), lease_until: new Date(Date.now() + 60000).toISOString(), refreshed_at: new Date().toISOString() };
      fs.writeFileSync(dispatchLockPath(cwd), `${JSON.stringify(foreign)}\n`);
      gate.resolve();
      await assert.rejects(failure, /injected rejection/);
      assert.equal(lockOwner(dispatchLockPath(cwd)).token, "foreign-token");
      assert.equal(fs.existsSync(globalActivationLockPath("codex", env)), false);
      assert.equal(fs.existsSync(activationLockPath(cwd, env, "codex")), false);
      fs.unlinkSync(dispatchLockPath(cwd));
    });
  });

  it("cleans caller-owned activation and dispatch locks on AbortError cancellation", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await createCommitTicket(cwd, env);
      const gate = deferred<void>();
      const failure = reserveNext(cwd, { capacity: 1, host: "codex", env, safety: { collectFacts: async () => { await gate.promise; const error = new Error("cancelled"); error.name = "AbortError"; throw error; } } });
      await until(() => fs.existsSync(dispatchLockPath(cwd)));
      gate.resolve();
      await assert.rejects(failure, (error: unknown) => (error as Error).name === "AbortError");
      assert.equal(fs.existsSync(globalActivationLockPath("codex", env)), false);
      assert.equal(fs.existsSync(activationLockPath(cwd, env, "codex")), false);
      assert.equal(fs.existsSync(dispatchLockPath(cwd)), false);
    });
  });

  it("rejects a ticket whose read-only flag no longer matches commit-only mode", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await createCommitTicket(cwd, env);
      const ticketPath = path.join(spawnsDir(cwd), "spn-0001.json");
      const ticket = readTicket(cwd);
      ticket.read_only = true;
      fs.writeFileSync(ticketPath, `${JSON.stringify(ticket, null, 2)}\n`);

      const out = capture();
      assert.equal(await run(["dispatch", "next", "--host", "codex", "--capacity", "4", "--json"], { cwd, env, stdout: out, stderr: out }), 1, out.text());
      const result = JSON.parse(out.text());
      assert.deepEqual(result.reserved, []);
      assert.equal(result.blocked[0].code, "RECEIPT_MISMATCH");
      assert.equal(readTicket(cwd).status, "errored");
    });
  });

  it("reserves a commit-only ticket exclusively before later mechanical work", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await createCommitTicket(cwd, env);
      assert.equal(await run(["spawn", "bun test", "--host", "codex", "--classification", "mechanical", "--operation", "test"], { cwd, env, stdout: sink(), stderr: sink() }), 0);

      const out = capture();
      assert.equal(await run(["dispatch", "next", "--host", "codex", "--capacity", "4", "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.deepEqual(result.reserved.map((item) => item.ticket_id), ["spn-0001"]);
      assert.equal(result.reserved[0].mode, "commit-only");
      assert.deepEqual(result.snapshot.queued, ["spn-0002"]);
    });
  });
});
