import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { withHome, fakeEnv } from "./home.js";

function sink() { return { write() { return true; } }; }
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

describe("write dispatch safety integration", () => {
  it("completes an allowlisted write after the parent gate passes", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await run(["init", "--tools", "codex"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["spawn", "implement allowed file", "--model", "k3", "--write-path", "allowed.txt", "--write-ops", "write"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["dispatch", "next", "--capacity", "1", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["dispatch", "bind", "spn-0001", "--agent-id", "agent-write", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      await run(["dispatch", "complete", "spn-0001", "--text", "write accepted", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      const ticket = JSON.parse(fs.readFileSync(path.join(cwd, ".baton", "spawns", "spn-0001.json"), "utf8"));
      assert.equal(ticket.status, "completed");
      assert.equal(ticket.safety_verdict.accepted, true);
      assert.equal(ticket.conclusion, "write accepted");
    });
  });

  it("reproduces V-06 and rejects an out-of-scope write before accepting conclusion", async () => {
    await withHome(async (home) => {
      const cwd = fixture();
      const env = fakeEnv(home);
      await run(["init", "--tools", "codex"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["spawn", "implement allowed file", "--model", "k3", "--write-path", "allowed.txt", "--write-ops", "write"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["dispatch", "next", "--capacity", "1", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      await run(["dispatch", "bind", "spn-0001", "--agent-id", "agent-write", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      fs.appendFileSync(path.join(cwd, "allowed.txt"), "WORKER_ALLOWED\n");
      fs.appendFileSync(path.join(cwd, "denied.txt"), "WORKER_OUT_OF_SCOPE\n");
      await run(["dispatch", "complete", "spn-0001", "--text", "must be rejected", "--json"], { cwd, env, stdout: sink(), stderr: sink() });
      const ticket = JSON.parse(fs.readFileSync(path.join(cwd, ".baton", "spawns", "spn-0001.json"), "utf8"));
      assert.equal(ticket.status, "errored");
      assert.equal(ticket.error.code, "WRITE_SCOPE_VIOLATION");
      assert.equal(ticket.conclusion, null);
      assert.ok(ticket.safety_verdict.violations.some((item) => item.path === "denied.txt"));
    });
  });
});
