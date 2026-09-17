#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveCodexCommand } from "./catalog.mjs";

export const PROBE_CEILING = 20;

// A model's final answer alone is not a measurement. Require matching native
// spawn/close events, a boundary failure (or the ceiling), and full cleanup.
export class ProbeEvidence {
  root = null;
  open = new Set();
  created = new Set();
  seen = new Set();
  failureAt = null;
  closing = false;
  completed = false;
  receipt = null;
  error = null;

  accept(event) {
    if (event.type === "thread.started") this.root = event.thread_id;
    if (event.type === "turn.failed" || event.type === "error") this.error = "probe turn failed";
    if (event.type === "turn.completed") this.completed = true;
    if (event.type !== "item.completed") return;
    const item = event.item || {};
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    if (item.type === "agent_message") {
      try { this.receipt = JSON.parse(item.text); } catch { /* progress prose */ }
      return;
    }
    if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
      this.error = "probe used a non-probe tool";
      return;
    }
    if (item.type !== "collab_tool_call") return;
    if (!this.root || item.sender_thread_id !== this.root) {
      this.error = "unexpected nested agent activity";
      return;
    }
    const ids = item.receiver_thread_ids || [];
    if (item.tool === "spawn_agent") {
      if (this.closing || this.failureAt !== null || this.created.size >= PROBE_CEILING) {
        this.error = "probe spawned after its boundary";
      } else if (item.status === "failed" && ids.length === 0) {
        this.failureAt = this.open.size;
      } else if (item.status === "completed" && ids.length === 1 && !this.created.has(ids[0])) {
        this.created.add(ids[0]);
        this.open.add(ids[0]);
      } else this.error = "invalid spawn event";
    } else if (item.tool === "close_agent") {
      this.closing = true;
      if (item.status !== "completed" || ids.length !== 1 || !this.open.delete(ids[0])) this.error = "probe cleanup failed";
    } else this.error = "unexpected agent operation";
  }

  result() {
    const count = this.created.size;
    if (this.error || !this.completed || this.open.size || !count || this.receipt?.capacity !== count)
      throw new Error(`SUBAGENT_TEST_INCONCLUSIVE: ${this.error || "missing native evidence or cleanup"}`);
    const ceiling = count === PROBE_CEILING && this.failureAt === null && this.receipt.stop_reason === "ceiling";
    // Exec events expose failed spawn status but omit its error string. Require
    // the root's exact error report as well; a generic failed spawn is not a cap.
    const limit = this.failureAt === count && this.receipt.stop_reason === "limit"
      && typeof this.receipt.error === "string" && /\bagent thread limit reached\b/i.test(this.receipt.error);
    if (!ceiling && !limit) throw new Error("SUBAGENT_TEST_INCONCLUSIVE: no capacity boundary");
    return { adapter_id: "codex", capacity: count, ceiling_reached: ceiling };
  }
}

export async function testCodexSubagents({ cwd = process.cwd(), env = process.env, spawnImpl = spawn } = {}) {
  const command = resolveCodexCommand(env);
  if (!command) throw new Error("CODEX_CLI_NOT_AVAILABLE");
  const prompt = `Explicitly authorized native subagent capacity test ONLY.
Discover native spawn_agent and close_agent tools if deferred. No shell, file,
web, MCP, or other task tools. Do not read or change files. Never change limits.
Spawn agents SEQUENTIALLY with fork_context=false, without model overrides, and
message "Reply OK only. No tools, no files, no child agents."
Keep ALL agents open, even completed ones, until the FIRST spawn failure or
${PROBE_CEILING} successful spawns. Stop immediately on ANY failure. Record its exact error.
Then close EVERY created agent. No retries, no resume, no nested agents.
Final response ONLY JSON: {"capacity":number,"stop_reason":"limit"|"ceiling"|"error","error":string|null}.
Use limit ONLY if the exact error says agent thread limit reached. Use ceiling
ONLY after ${PROBE_CEILING} successes. Other failures are error. Actually call the tools;
never infer success, capacity, or cleanup from configuration or memory.`;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, ["exec", "--ephemeral", "--json", "--skip-git-repo-check",
      "-s", "read-only", "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="low"', prompt],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const evidence = new ProbeEvidence();
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = "", failure = null;
    let force;
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => stop("SUBAGENT_TEST_TIMEOUT"), 150000);
    const cancel = () => stop("SUBAGENT_TEST_CANCELLED");
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const clean = () => {
      clearTimeout(timer); clearTimeout(force); lines.close();
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    };
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2048); });
    lines.on("line", (line) => {
      try { evidence.accept(JSON.parse(line)); } catch { stop("SUBAGENT_TEST_INVALID_EVENT"); }
      if (evidence.error) stop(`SUBAGENT_TEST_INCONCLUSIVE: ${evidence.error}`);
    });
    child.once("error", (error) => { clean(); reject(error); });
    child.once("close", (code) => {
      clean();
      if (failure || code !== 0) return reject(new Error(failure || `SUBAGENT_TEST_FAILED: ${stderr || code}`));
      try { resolve(evidence.result()); } catch (error) { reject(error); }
    });
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  testCodexSubagents().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
