import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { run } from "../src/cli.js";
import { spawnsDir } from "../src/lib/paths.js";
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
  assert.equal(await run(["spawn", "git commit staged changes", "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
  assert.equal(readTicket(cwd).mode, "commit-only");
}

async function bindCommitTicket(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await createCommitTicket(cwd, env);
  const reserved = capture();
  assert.equal(await run(["dispatch", "next", "--capacity", "4", "--json"], { cwd, env, stdout: reserved, stderr: reserved }), 0, reserved.text());
  assert.equal(JSON.parse(reserved.text()).reserved.length, 1);
  assert.equal(await run(["dispatch", "bind", "spn-0001", "--agent-id", "agent-commit", "--json"], { cwd, env, stdout: sink(), stderr: sink() }), 0);
}

function parseJson(text: string) {
  return JSON.parse(text.slice(text.indexOf("{")));
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
      assert.equal(await run(["spawn", "git commit staged changes", "--dispatch", "--json"], {
        cwd, env, stdout: out, stderr: out,
      }), 0, out.text());
      const payload = parseJson(out.text());
      assert.equal(payload.ticket.mode, "commit-only");
      assert.equal(payload.reserved.length, 1);
      assert.equal(payload.reserved[0].ticket_id, payload.ticket.id);
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
      assert.equal(await run(["dispatch", "next", "--capacity", "4", "--json"], { cwd, env, stdout: out, stderr: out }), 1, out.text());
      const result = JSON.parse(out.text());
      assert.deepEqual(result.reserved, []);
      assert.equal(result.blocked[0].code, "COMMIT_BASELINE_STALE");
      assert.equal(readTicket(cwd).status, "errored");
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
      assert.equal(await run(["dispatch", "next", "--capacity", "4", "--json"], { cwd, env, stdout: out, stderr: out }), 1, out.text());
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
      assert.equal(await run(["spawn", "bun test"], { cwd, env, stdout: sink(), stderr: sink() }), 0);

      const out = capture();
      assert.equal(await run(["dispatch", "next", "--capacity", "4", "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.deepEqual(result.reserved.map((item) => item.ticket_id), ["spn-0001"]);
      assert.equal(result.reserved[0].mode, "commit-only");
      assert.deepEqual(result.snapshot.queued, ["spn-0002"]);
    });
  });
});
