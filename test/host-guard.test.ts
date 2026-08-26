import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearHostGuardBindingsForTicketAttempt,
  evaluatePreToolUse,
  evaluateSubagentStart,
  HOST_GUARD_REASONS,
  isBatonActivationCommand,
  classifyBatonActivationCommand,
  isBatonControlPlaneCommand,
  isDirectorStageCommand,
  isGitTopologyMutation,
  isReadOnlyGitCommand,
  isShellWriteCommand,
  type GuardDecision,
  type HostGuardState,
} from "../src/lib/host-guard.js";
import { currentBatonHookTargets } from "../src/lib/codex-hooks.js";
import {
  BATON_DISPATCH_RESERVATION_SCHEMA,
  withDispatchReservationEnvelope,
  type DispatchReservationIdentity,
} from "../src/lib/dispatch-reservation.js";
import { recordPendingReservation } from "../src/lib/host-identity.js";
import { issueGuardClaim } from "../src/lib/guard-claims.js";
import { configPath, runsDir, spawnsDir } from "../src/lib/paths.js";
import { emptyConfig, saveConfig } from "../src/lib/config.js";
import { runActivation } from "../src/lib/activation.js";

function state(tickets: HostGuardState["tickets"] = []): HostGuardState {
  return { active: true, initialized: true, tickets, bindings: [], state_error: null };
}

function event(tool_name: string, tool_input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { hook_event_name: "PreToolUse", tool_name, tool_input, cwd: "/workspace", ...extra };
}

function reservedTicket(
  ticket: HostGuardState["tickets"][number],
  reservationId: string,
): HostGuardState["tickets"][number] {
  return { ...ticket, status: "dispatching", agent_id: null, reservation_id: reservationId, attempt: 1 };
}

function reservationFor(ticket: HostGuardState["tickets"][number]): DispatchReservationIdentity {
  assert.ok(ticket.reservation_id);
  return {
    schema: BATON_DISPATCH_RESERVATION_SCHEMA,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: ticket.dispatch_host || ticket.host || "codex",
  };
}

function reservedText(ticket: HostGuardState["tickets"][number], text: string): string {
  return withDispatchReservationEnvelope(text, reservationFor(ticket));
}

const HOST_GUARD_MODULE_URL = new URL("../src/lib/host-guard.ts", import.meta.url).href;

interface DiskGuardProject {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function makeDiskGuardProject(): DiskGuardProject {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-disk-"));
  const env = {
    ...process.env,
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-home-")),
  };
  const config = configPath(cwd, { env });
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, "{}\n", "utf8");
  return { cwd, env };
}

function writeDiskGuardTicket(cwd: string, ticket: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  const dir = spawnsDir(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${String(ticket.id)}.json`), `${JSON.stringify(ticket, null, 2)}\n`, "utf8");
}

function writeDiskBindings(cwd: string, bindings: Array<Record<string, unknown>>, env: NodeJS.ProcessEnv): void {
  const file = path.join(runsDir(cwd, env), "host-guard-bindings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");
}

function readDiskBindings(cwd: string, env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
  const file = path.join(runsDir(cwd, env), "host-guard-bindings.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
}

function spawnDiskSubagentStart(event: Record<string, unknown>, now: string, env: NodeJS.ProcessEnv): {
  child: ReturnType<typeof spawn>;
  completion: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  const script = path.join(os.tmpdir(), `baton-guard-subagent-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(script, [
    `import { evaluateSubagentStart } from ${JSON.stringify(HOST_GUARD_MODULE_URL)};`,
    "const event = JSON.parse(process.env.BATON_GUARD_TEST_EVENT || \"{}\");",
    "const now = process.env.BATON_GUARD_TEST_NOW || undefined;",
    "const result = evaluateSubagentStart(event, { host: \"codex\", now, env: process.env });",
    "process.stdout.write(JSON.stringify(result));",
    "",
  ].join("\n"), "utf8");
  const child = spawn(process.execPath, [script], {
    env: {
      ...env,
      BATON_GUARD_TEST_EVENT: JSON.stringify(event),
      BATON_GUARD_TEST_NOW: now,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const completion = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, completion };
}

const readTicket = {
  id: "spn-0001",
  reservation_id: null,
  attempt: 1,
  status: "running",
  mode: "read-only",
  read_only: true,
  agent_id: "native-1",
  host: "codex",
  dispatch_host: "codex",
  receipt_id: "rcpt-spn-0001-a1",
  allowed_operations: ["read"],
  write_allowlist: [],
};

const writeTicket = {
  id: "spn-0002",
  reservation_id: null,
  attempt: 1,
  status: "running",
  mode: "write",
  read_only: false,
  agent_id: "native-2",
  host: "codex",
  dispatch_host: "codex",
  receipt_id: "rcpt-spn-0002-a1",
  allowed_operations: ["write", "create"],
  write_allowlist: ["src/index.ts"],
};

describe("Baton Codex host guard", () => {
  it("allows idle director mutating tools and denies them while a worker ticket is live", () => {
    const idle = state();
    assert.equal(evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }), { state: idle }).allowed, true);
    assert.equal(evaluatePreToolUse(event("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }), { state: idle }).allowed, true);
    assert.equal(evaluatePreToolUse(event("Write", { file_path: "src/a.ts", content: "x" }), { state: idle }).allowed, true);
    assert.equal(evaluatePreToolUse(event("Bash", { command: "rm -rf build" }), { state: idle }).allowed, true);

    const live = state([readTicket]);
    const deniedShell = evaluatePreToolUse(event("Bash", { command: "rm -rf build" }, { agent_type: "root" }), { state: live });
    assert.equal(deniedShell.allowed, false);
    assert.equal(deniedShell.reason, HOST_GUARD_REASONS.director_shell);
    assert.match(String((deniedShell.output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /spn-0001/);
    assert.deepEqual(deniedShell.output, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${HOST_GUARD_REASONS.director_shell}: spn-0001`,
      },
    });

    const deniedPatch = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }, { agent_type: "root" }), { state: live });
    assert.equal(deniedPatch.allowed, false);
    assert.equal(deniedPatch.reason, HOST_GUARD_REASONS.director_code_write);
    assert.equal((deniedPatch.output.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
    assert.match(String((deniedPatch.output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /spn-0001/);
  });

  it("allows only standalone Baton control-plane commands on the director", () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-control-bare-"));
    const bare = path.join(bareDir, "baton");
    fs.writeFileSync(bare, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bare, 0o755);
    assert.equal(isBatonControlPlaneCommand("baton dispatch next --host codex --json", { env: { PATH: bareDir } }), false);
    assert.equal(isBatonControlPlaneCommand("baton dispatch next --host codex --json", { env: { PATH: bareDir }, executablePath: bare }), true);
    for (const disallowed of ["config", "update", "uninstall", "activation", "init"]) {
      assert.equal(isBatonControlPlaneCommand(`baton ${disallowed}`, { env: { PATH: bareDir }, executablePath: bare }), false, disallowed);
    }
    const current = currentBatonHookTargets()[0];
    assert.ok(current);
    assert.equal(isBatonControlPlaneCommand(current.executable + " guard status"), true);
    assert.equal(isBatonControlPlaneCommand("/tmp/baton guard status"), false);
    assert.equal(isBatonControlPlaneCommand("baton dispatch next; rm -rf src"), false);
    assert.equal(isBatonControlPlaneCommand("baton guard status\nrm -rf src"), false);
    assert.equal(isBatonControlPlaneCommand("echo baton dispatch next"), false);
    assert.equal(isBatonActivationCommand("baton enable all --host codex", { env: { PATH: bareDir }, executablePath: bare }), true);
    assert.equal(isBatonActivationCommand("baton disable curproject --host codex --json", { env: { PATH: bareDir }, executablePath: bare }), true);
    assert.equal(classifyBatonActivationCommand("env baton disable all --host codex", { env: { PATH: bareDir }, executablePath: bare }), "invalid-intent");
    for (const wrapped of [
      "env A=1 B=2 baton disable all --host codex",
      "env A=1 B=2 baton disable all --host codex; rm -rf src",
    ]) {
      assert.equal(classifyBatonActivationCommand(wrapped, { env: { PATH: bareDir }, executablePath: bare }), "invalid-intent", wrapped);
    }
    assert.equal(classifyBatonActivationCommand("baton enable all --host codex", { env: { PATH: bareDir } }), "invalid-intent");
    assert.equal(classifyBatonActivationCommand("/tmp/baton.js disable all --host codex"), "invalid-intent");
    assert.equal(classifyBatonActivationCommand("baton enable all --host codex; rm -rf src", { env: { PATH: bareDir }, executablePath: bare }), "invalid-intent");
    for (const unsupported of [
      "baton enable all --host codex; rm -rf src",
      "baton enable all --host codex --yes",
      "baton enable all --host unsupported",
      "baton enable --host codex all",
    ]) {
      assert.equal(isBatonActivationCommand(unsupported, { env: { PATH: bareDir }, executablePath: bare }), false, unsupported);
    }
    const liveDirector = evaluatePreToolUse(event("Bash", { command: "baton disable all --host codex" }, { agent_type: "root" }), { state: state([readTicket]), env: { PATH: bareDir }, executablePath: bare });
    assert.equal(liveDirector.allowed, true);
    const worker = evaluatePreToolUse(event("Bash", { command: "baton disable all --host codex" }, { agent_type: "worker", agent_id: "native-1" }), { state: state([readTicket]), env: { PATH: bareDir }, executablePath: bare });
    assert.equal(worker.allowed, false);
    assert.equal(worker.reason, HOST_GUARD_REASONS.worker_control_plane);
    for (const command of ["baton disable all --host codex; rm -rf src", "baton disable all --host codex --yes", "baton disable all --host grok"]) {
      const denied = evaluatePreToolUse(event("Bash", { command }, { agent_type: "root" }), { state: state([readTicket]), env: { PATH: bareDir }, executablePath: bare });
      assert.equal(denied.allowed, false, command);
      assert.equal(denied.reason, HOST_GUARD_REASONS.invalid_input, command);
    }
    const untyped = evaluatePreToolUse(event("Bash", { command: "baton disable all --host codex" }), { state: state([readTicket]), env: { PATH: bareDir }, executablePath: bare });
    assert.equal(untyped.allowed, false);
    assert.equal(untyped.reason, HOST_GUARD_REASONS.worker_control_plane);
    const runtime = path.join(bareDir, "runtime");
    const entry = path.join(bareDir, "entry.js");
    fs.writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(runtime, 0o755);
    fs.writeFileSync(entry, "export {}\n");
    const runtimeExact = evaluatePreToolUse(event("Bash", { command: `${runtime} ${entry} enable all --host codex` }, { agent_type: "root" }), { state: state([readTicket]), runtimePath: runtime, entryPath: entry });
    assert.equal(runtimeExact.allowed, true);
    const runtimeComposed = evaluatePreToolUse(event("Bash", { command: `${runtime} ${entry} enable all --host codex; rm -rf src` }, { agent_type: "root" }), { state: state([readTicket]), runtimePath: runtime, entryPath: entry });
    assert.equal(runtimeComposed.allowed, false);
    assert.equal(classifyBatonActivationCommand(`${runtime} ${entry} enable all --host codex; rm -rf src`, { runtimePath: runtime, entryPath: entry }), "invalid-intent");
    const disk = makeDiskGuardProject();
    saveConfig(disk.cwd, { ...emptyConfig(), cli: { ...emptyConfig().cli, codex: { ...emptyConfig().cli.codex, enabled: true, guard_mode: "enforce" } } }, { env: disk.env });
    runActivation(["disable", "curproject", "--host", "codex"], { cwd: disk.cwd, env: disk.env, stdout: { write: () => undefined } });
    const diskCommand = `${current.executable} disable all --host codex`;
    const diskWorker = evaluatePreToolUse(event("Bash", { command: diskCommand }, { agent_type: "worker", agent_id: "native-1", cwd: disk.cwd }), { env: disk.env });
    assert.equal(diskWorker.allowed, false);
    const diskRoot = evaluatePreToolUse(event("Bash", { command: diskCommand }, { agent_type: "root", cwd: disk.cwd }), { env: disk.env });
    assert.equal(diskRoot.disposition, "bypass");
    assert.deepEqual(diskRoot.output, {});
    const diskOrdinary = evaluatePreToolUse(event("Bash", { command: "printf ok" }, { cwd: disk.cwd }), { env: disk.env });
    assert.equal(diskOrdinary.disposition, "bypass");
    assert.deepEqual(diskOrdinary.output, {});
    const allowed = evaluatePreToolUse(event("Bash", { command: current.executable + " guard status" }), { state: state() });
    assert.equal(allowed.allowed, true);
  });

  it("lets the director inspect and stage; idle commit allowed, denied while a worker ticket is live", () => {
    assert.equal(isReadOnlyGitCommand("git status"), true);
    assert.equal(isReadOnlyGitCommand("git branch release"), false);
    assert.equal(isReadOnlyGitCommand("git symbolic-ref HEAD refs/heads/release"), false);
    assert.equal(isReadOnlyGitCommand("git diff --cached"), true);
    assert.equal(isReadOnlyGitCommand("git log -1 --oneline"), true);
    assert.equal(isReadOnlyGitCommand("git commit -m x"), false);
    assert.equal(isDirectorStageCommand("git add -A"), true);
    assert.equal(isDirectorStageCommand("git add src/lib/host-guard.ts test/host-guard.test.ts"), true);
    assert.equal(isDirectorStageCommand("git add -p"), false);
    assert.equal(isDirectorStageCommand("git add; rm -rf src"), false);

    const inspect = evaluatePreToolUse(event("Bash", { command: "git status" }), { state: state() });
    assert.equal(inspect.allowed, true);
    const stage = evaluatePreToolUse(event("Bash", { command: "git add -A" }), { state: state() });
    assert.equal(stage.allowed, true);
    const idleCommit = evaluatePreToolUse(event("Bash", { command: "git commit -m x" }), { state: state() });
    assert.equal(idleCommit.allowed, true);

    const live = state([readTicket]);
    const commit = evaluatePreToolUse(event("Bash", { command: "git commit -m x" }, { agent_type: "root" }), { state: live });
    assert.equal(commit.allowed, false);
    assert.equal(commit.reason, HOST_GUARD_REASONS.director_shell);
    assert.match(String((commit.output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /spn-0001/);
    const composed = evaluatePreToolUse(event("Bash", { command: "git add -A; rm -rf src" }, { agent_type: "root" }), { state: live });
    assert.equal(composed.allowed, false);
    for (const command of ["git branch release", "git tag release", "git update-ref refs/heads/release HEAD", "git push origin HEAD"]) {
      assert.equal(isShellWriteCommand(command), true, command);
      assert.equal(isGitTopologyMutation(command), true, command);
    }
  });

  it("trusts configured bare Baton and current runtime/entry pairs only", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-control-plane-"));
    const runtime = path.join(cwd, "runtime");
    const entry = path.join(cwd, "bin", "baton.ts");
    const bareDir = path.join(cwd, "bin-on-path");
    const bare = path.join(bareDir, "baton");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(bareDir, { recursive: true });
    fs.writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(runtime, 0o755);
    fs.writeFileSync(entry, "export {}\n");
    fs.writeFileSync(bare, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bare, 0o755);
    const env = { PATH: bareDir };
    assert.equal(isBatonControlPlaneCommand("baton guard status", { env }), false);
    assert.equal(isBatonControlPlaneCommand("baton guard status", { env, executablePath: bare }), true);
    assert.equal(isBatonControlPlaneCommand(runtime + " " + entry + " guard status", {
      env,
      runtimePath: runtime,
      entryPath: entry,
    }), true);
    assert.equal(isBatonControlPlaneCommand("/tmp/baton guard status", { env }), false);
  });

  it("does not use Codex Agent/SubagentStart as an attachment surface", () => {
    const ticket = reservedTicket(readTicket, "codex-reservation-one");
    const reserved = state([ticket]);
    const spawn = evaluatePreToolUse(event("Agent", { prompt: reservedText(ticket, "work on the unit") }, {
      turn_id: "parent-turn",
      session_id: "parent-session",
      transcript_path: "/workspace/spn-0001.jsonl",
    }), { state: reserved });
    assert.equal(spawn.allowed, true);
    assert.equal(spawn.ticket_id, null);

    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "native-1",
      agent_type: "worker",
      session_id: "parent-session",
      transcript_path: "/workspace/spn-0001.jsonl",
      turn_id: "child-turn",
    }, { state: reserved });
    assert.equal(start.allowed, false);
    assert.equal(start.reason, HOST_GUARD_REASONS.invalid_input);

    const beforeBind = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: reserved });
    assert.equal(beforeBind.allowed, false);
    assert.equal(beforeBind.reason, HOST_GUARD_REASONS.spawn_bind_pending);
    assert.equal(beforeBind.ticket_id, null);

    reserved.tickets[0] = { ...reserved.tickets[0], status: "running", agent_id: "native-1" };
    const afterBind = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: reserved });
    assert.equal(afterBind.allowed, true);
  });

  it("does not correlate Codex attachment from SubagentStart", () => {
    const ticket = reservedTicket(readTicket, "codex-in-flight-reservation");
    const reserved = state([ticket]);
    const spawn = evaluatePreToolUse(event("Agent", { prompt: reservedText(ticket, "work on the unit") }, {
      turn_id: "parent-turn",
      session_id: "root-session",
      transcript_path: "/workspace/spn-0001.jsonl",
    }), { state: reserved });
    assert.equal(spawn.allowed, true);
    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "hook-agent-123",
      agent_type: "worker",
      session_id: "root-session",
      turn_id: "child-turn",
      transcript_path: "/workspace/spn-0001.jsonl",
    }, { state: reserved, host: "codex" });
    assert.equal(start.allowed, false);
    assert.equal(start.reason, HOST_GUARD_REASONS.invalid_input);
    assert.equal(reserved.identity_observations?.length || 0, 0);
  });

  it("does not use Codex session or transcript fields as lifecycle identity", () => {
    const ticket = reservedTicket(readTicket, "codex-session-transcript");
    const reserved = state([ticket]);
    assert.equal(evaluatePreToolUse(event("Agent", { prompt: reservedText(ticket, "work on the unit") }, {
      turn_id: "parent-turn",
      session_id: "parent-session",
      transcript_path: "/workspace/parent.jsonl",
    }), { state: reserved, host: "codex" }).allowed, true);

    const missingTranscript = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "session-agent",
      agent_type: "worker",
      session_id: "parent-session",
      turn_id: "child-turn",
    }, { state: reserved, host: "codex" });
    assert.equal(missingTranscript.allowed, false);
    assert.equal(missingTranscript.reason, HOST_GUARD_REASONS.invalid_input);

    const mismatchState = state([reservedTicket(readTicket, "codex-session-mismatch")]);
    const mismatchTicket = mismatchState.tickets[0];
    assert.equal(evaluatePreToolUse(event("Agent", { prompt: reservedText(mismatchTicket, "work on the unit") }, {
      turn_id: "parent-turn",
      session_id: "parent-session",
      transcript_path: "/workspace/parent.jsonl",
    }), { state: mismatchState, host: "codex" }).allowed, true);
    const mismatchedSession = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "session-agent",
      agent_type: "worker",
      session_id: "other-session",
      turn_id: "child-turn",
      transcript_path: "/workspace/parent.jsonl",
    }, { state: mismatchState, host: "codex" });
    assert.equal(mismatchedSession.allowed, false);

    const transcriptState = state([reservedTicket(readTicket, "codex-transcript-mismatch")]);
    const transcriptTicket = transcriptState.tickets[0];
    assert.equal(evaluatePreToolUse(event("Agent", { prompt: reservedText(transcriptTicket, "work on the unit") }, {
      turn_id: "parent-turn",
      session_id: "parent-session",
      transcript_path: "/workspace/parent.jsonl",
    }), { state: transcriptState, host: "codex" }).allowed, true);
    const mismatchedTranscript = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "transcript-agent",
      agent_type: "worker",
      session_id: "parent-session",
      turn_id: "child-turn",
      transcript_path: "/workspace/other.jsonl",
    }, { state: transcriptState, host: "codex" });
    assert.equal(mismatchedTranscript.allowed, false);
  });

  it("rejects direct Codex SubagentStart payloads regardless of identity carrier", () => {
    const startFor = (extra: Record<string, unknown>): GuardDecision => {
      const ticket = reservedTicket(readTicket, "codex-current-format");
      const reserved = state([ticket]);
      assert.equal(evaluatePreToolUse(event("Agent", { prompt: reservedText(ticket, "work on the unit") }, {
        turn_id: "parent-turn",
        session_id: "root-session",
        transcript_path: "/workspace/spn-0001.jsonl",
      }), { state: reserved }).allowed, true);
      return evaluateSubagentStart({
        hook_event_name: "SubagentStart",
        cwd: "/workspace",
        agent_type: "worker",
        session_id: "root-session",
        turn_id: "child-turn",
        transcript_path: "/workspace/spn-0001.jsonl",
        ...extra,
      }, { state: reserved, host: "codex" });
    };

    const taskNameOnly = startFor({ task_name: "codex-task-name" });
    assert.equal(taskNameOnly.allowed, false);
    assert.equal(taskNameOnly.reason, HOST_GUARD_REASONS.invalid_input);

    const aliased = startFor({ agentId: "legacy-agent" });
    assert.equal(aliased.allowed, false);
    assert.equal(aliased.reason, HOST_GUARD_REASONS.invalid_input);

    const nested = startFor({ tool_input: { agent_id: "nested-agent" } });
    assert.equal(nested.allowed, false);
    assert.equal(nested.reason, HOST_GUARD_REASONS.invalid_input);

    const current = startFor({ agent_id: "current-agent" });
    assert.equal(current.allowed, false);
    assert.equal(current.reason, HOST_GUARD_REASONS.invalid_input);
  });

  it("does not persist a Codex child identity from SubagentStart", () => {
    const ticket = reservedTicket(readTicket, "codex-reservation-two");
    const reserved = state([ticket]);
    const spawn = evaluatePreToolUse(event("Agent", { prompt: reservedText(ticket, "work on the unit") }, {
      turn_id: "parent-turn-1",
      session_id: "root-turn",
      transcript_path: "/workspace/spn-0001.jsonl",
    }), { state: reserved });
    assert.equal(spawn.allowed, true);
    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      turn_id: "child-turn-1",
      agent_id: "native-1",
      agent_type: "worker",
      session_id: "root-turn",
      transcript_path: "/workspace/spn-0001.jsonl",
    }, { state: reserved });
    assert.equal(start.allowed, false);
    assert.equal(start.reason, HOST_GUARD_REASONS.invalid_input);
    assert.deepEqual(reserved.bindings, []);

    const beforeBind = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      turn_id: "child-turn-1",
      agent_type: "worker",
    }), { state: reserved });
    assert.equal(beforeBind.allowed, false);
    assert.equal(beforeBind.reason, HOST_GUARD_REASONS.spawn_bind_pending);

    reserved.tickets[0] = { ...reserved.tickets[0], status: "running", agent_id: "native-1" };
    const afterBind = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      turn_id: "child-turn-1",
      agent_type: "worker",
    }), { state: reserved });
    assert.equal(afterBind.allowed, true);
  });

  it("keeps a pending binding denied instead of borrowing another running ticket", () => {
    const pendingTicket = reservedTicket(readTicket, "codex-pending-exact-ticket");
    const otherRunning = {
      ...readTicket,
      id: "spn-other-running",
      reservation_id: "codex-other-running",
      agent_id: "native-1",
      status: "running",
    };
    const reserved = state([pendingTicket, otherRunning]);
    assert.equal(evaluatePreToolUse(event("Agent", { prompt: reservedText(pendingTicket, "work on the unit") }, {
      turn_id: "pending-turn",
      session_id: "root-session",
      transcript_path: "/workspace/spn-pending.jsonl",
    }), { state: reserved }).allowed, true);
    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "native-1",
      agent_type: "worker",
      session_id: "root-session",
      turn_id: "child-pending-turn",
      transcript_path: "/workspace/spn-pending.jsonl",
    }, { state: reserved, host: "codex" });
    assert.equal(start.allowed, false);
    assert.equal(start.reason, HOST_GUARD_REASONS.invalid_input);

    const denied = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: reserved });
    assert.equal(denied.allowed, true);
    assert.equal(denied.ticket_id, "spn-other-running");
  });

  it("uses agent_id for current-source payloads and never lets the root turn borrow a child", () => {
    const bound = state([readTicket]);
    const currentSource = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      agent_id: "native-1",
      agent_type: "worker",
    }), { state: bound });
    assert.equal(currentSource.allowed, true);

    bound.bindings.push({
      ticket_id: "spn-0001",
      agent_id: "native-1",
      turn_id: "child-turn-1",
      session_id: "root-turn",
      agent_type: "worker",
      state: "bound",
      observed_at: "2026-08-24T00:00:00.000Z",
    });
    const root = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      turn_id: "root-turn",
      agent_type: "root",
    }), { state: bound });
    assert.equal(root.allowed, true);

    const rootWrite = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }, {
      turn_id: "root-turn",
      agent_type: "root",
    }), { state: bound });
    assert.equal(rootWrite.allowed, false);
    assert.equal(rootWrite.reason, HOST_GUARD_REASONS.director_code_write);
    assert.match(String((rootWrite.output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /spn-0001/);

    const rootBorrow = evaluatePreToolUse(event("Bash", { command: "npm test" }, {
      turn_id: "child-turn-1",
      agent_type: "root",
    }), { state: bound });
    assert.equal(rootBorrow.allowed, false);
    assert.equal(rootBorrow.reason, HOST_GUARD_REASONS.agent_identity_mismatch);
  });

  it("requires an exact reservation envelope and treats ticket ids as opaque data", () => {
    const first = reservedTicket({ ...readTicket, id: "os-0001" }, "opaque-reservation-one");
    const second = reservedTicket({ ...writeTicket, id: "zly-unit" }, "opaque-reservation-two");
    const missing = evaluatePreToolUse(event("Agent", { prompt: "implement zly-unit and mention os-0001" }), {
      state: state([first, second]),
    });
    assert.equal(missing.allowed, true);
    assert.equal(missing.ticket_id, null);

    const explicit = evaluatePreToolUse(event("Agent", { prompt: reservedText(second, "implement the change") }), {
      state: state([first, second]),
    });
    assert.equal(explicit.allowed, true);
    assert.equal(explicit.ticket_id, null);

    const staleIdentity = { ...reservationFor(second), reservation_id: "stale-reservation" };
    const stale = evaluatePreToolUse(event("Agent", {
      prompt: withDispatchReservationEnvelope("implement the change", staleIdentity),
    }), { state: state([first, second]) });
    assert.equal(stale.allowed, true);

    const conflicting = evaluatePreToolUse(event("Agent", {
      prompt: reservedText(first, "implement the change"),
      description: reservedText(second, "implement the change"),
    }), { state: state([first, second]) });
    assert.equal(conflicting.allowed, true);

    const malformed = evaluatePreToolUse(event("Agent", {
      prompt: '{"baton_dispatch":{"schema":1',
      description: reservedText(second, "implement the change"),
    }), { state: state([first, second]) });
    assert.equal(malformed.allowed, true);
  });

  it("accepts Codex spawn_agent aliases and message-carried envelopes", () => {
    const ticket = reservedTicket({ ...readTicket, status: "dispatching", agent_id: null }, "codex-message-envelope");
    const reserved = state([ticket]);
    const plain = evaluatePreToolUse(event("spawn_agent", { message: reservedText(ticket, "implement the change") }), { state: reserved });
    assert.equal(plain.allowed, true);
    assert.equal(plain.ticket_id, null);

    const namespaced = evaluatePreToolUse(event("functions.collaboration.spawn_agent", {
      message: reservedText(ticket, "implement the change"),
    }), { state: reserved });
    assert.equal(namespaced.allowed, true);
    assert.equal(namespaced.ticket_id, null);
  });

  it("fails closed when a carrier-free Codex or Claude start has no handshake observation", () => {
    for (const host of ["codex", "claude"] as const) {
      const ticket = reservedTicket({
        ...readTicket,
        id: `zly-${host}`,
        host,
        dispatch_host: host,
      }, `${host}-carrier-free`);
      const reserved = state([ticket]);
      const start = evaluateSubagentStart({
        hook_event_name: "SubagentStart",
        cwd: "/workspace",
        agent_id: `${host}-agent`,
        agent_type: "worker",
      }, { state: reserved, host });
      assert.equal(start.allowed, false);
      assert.equal(start.ticket_id, null);
      assert.equal(start.reason, host === "codex"
        ? HOST_GUARD_REASONS.invalid_input
        : HOST_GUARD_REASONS.reservation_identity_required);
      assert.deepEqual(reserved.bindings, []);
    }
  });

  it("fails closed on malformed guard state", () => {
    const malformed = evaluatePreToolUse(event("Bash", { command: "npm test" }), {
      state: {
        active: true,
        initialized: true,
        tickets: [],
        bindings: [{} as never],
        state_error: null,
      },
    });
    assert.equal(malformed.allowed, false);
    assert.equal(malformed.reason, HOST_GUARD_REASONS.state_unavailable);
  });

  it("requires a turn claim before Codex worker writes", () => {
    const bound = state([readTicket, writeTicket]);
    const workerRead = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: bound });
    assert.equal(workerRead.allowed, true);

    const readPatch = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }, { agent_id: "native-1", agent_type: "worker" }), { state: bound });
    assert.equal(readPatch.allowed, false);
    assert.equal(readPatch.reason, HOST_GUARD_REASONS.claim_required);

    const writePatch = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }, { agent_id: "native-2", agent_type: "worker" }), { state: bound });
    assert.equal(writePatch.allowed, false);
    assert.equal(writePatch.reason, HOST_GUARD_REASONS.claim_required);
    const noIdentity = evaluatePreToolUse(event("Bash", { command: "npm test" }), { state: bound });
    assert.equal(noIdentity.allowed, true);
    const noIdentityWrite = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }, { agent_type: "root" }), { state: bound });
    assert.equal(noIdentityWrite.allowed, false);
    assert.equal(noIdentityWrite.reason, HOST_GUARD_REASONS.director_code_write);
    assert.match(String((noIdentityWrite.output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /spn-0001|spn-0002/);
    const wrongIdentity = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-unknown" }), { state: bound });
    assert.equal(wrongIdentity.allowed, false);
    assert.equal(wrongIdentity.reason, HOST_GUARD_REASONS.agent_identity_mismatch);
  });

  it("requires a claim for task-name-attached turns without agent identity fields", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-guard-task-name-turn-"));
    const ticket = { ...writeTicket, id: "spn-task-name", agent_id: null };
    const guarded = state([ticket]);
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch" },
      cwd,
      turn_id: "turn-task-name",
    };
    const before = evaluatePreToolUse(input, { cwd, state: guarded, host: "codex", guard_mode: "enforce" });
    assert.equal(before.allowed, false);
    assert.equal(before.reason, HOST_GUARD_REASONS.claim_required);
    const issued = issueGuardClaim({ cwd, ticket_id: ticket.id, attempt: 1, host: "codex" });
    const after = evaluatePreToolUse({ ...input, baton_claim: issued.token }, {
      cwd,
      state: guarded,
      host: "codex",
      guard_mode: "enforce",
    });
    assert.equal(after.allowed, true);
    assert.equal(after.ticket_id, ticket.id);
  });

  it("allows native Codex child creation but does not bind it through hooks", () => {
    const bound = state([readTicket]);
    const nested = evaluatePreToolUse(event("Agent", { prompt: "spawn another" }, { agent_id: "native-1" }), { state: bound });
    assert.equal(nested.allowed, true);
    assert.equal(nested.ticket_id, null);
    const missingIdentity = evaluateSubagentStart({ hook_event_name: "SubagentStart", cwd: "/workspace" }, { state: bound });
    assert.equal(missingIdentity.allowed, false);
    assert.equal(missingIdentity.reason, HOST_GUARD_REASONS.invalid_input);
  });
});

describe("host guard host scoping", () => {
  const claudeTicket = { ...readTicket, id: "spn-0100", agent_id: "a1c6c56", host: "claude", dispatch_host: "claude" };
  const claudeReserved = reservedTicket({ ...claudeTicket, id: "spn-0101" }, "claude-reservation");

  it("serves only the requesting host's running ticket", () => {
    const both = state([readTicket, claudeTicket]);
    // The Claude guard accepts its own bound worker.
    const own = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "a1c6c56" }), { state: both, host: "claude" });
    assert.equal(own.allowed, true);
    assert.equal(own.ticket_id, "spn-0100");
    // The same guard must not satisfy itself with a Codex ticket.
    const foreign = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: both, host: "claude" });
    assert.equal(foreign.allowed, false);
    // And the Codex guard must not accept a Claude worker.
    const reverse = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "a1c6c56" }), { state: both, host: "codex" });
    assert.equal(reverse.allowed, false);
  });

  it("gates child agents against reservations from the same host only", () => {
    const claudeOnly = state([claudeReserved]);
    const allowed = evaluatePreToolUse(event("Agent", { prompt: reservedText(claudeReserved, "run the ticket") }), { state: claudeOnly, host: "claude" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.ticket_id, "spn-0101");
    // Codex with no Codex reserved ticket allows unmatched Agent (undeclared native-child spawn).
    const unmatched = evaluatePreToolUse(event("Agent", { prompt: "run the ticket" }), { state: claudeOnly, host: "codex" });
    assert.equal(unmatched.allowed, true);
  });

  it("records a SubagentStart identity only for its own host reservation", () => {
    const claudeOnly = state([claudeReserved]);
    const spawn = evaluatePreToolUse(event("Agent", { prompt: reservedText(claudeReserved, "run the ticket") }, {
      turn_id: "claude-turn",
      session_id: "claude-session",
    }), { state: claudeOnly, host: "claude" });
    assert.equal(spawn.allowed, true);
    const start = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "a2a931ffa6c987fbd",
      agent_type: "baton-probe",
      turn_id: "claude-turn",
      session_id: "claude-session",
      description: reservedText(claudeReserved, "run the ticket"),
    }, { state: claudeOnly, host: "claude" });
    assert.equal(start.allowed, true);
    assert.equal(start.ticket_id, "spn-0101");
    assert.equal(start.agent_id, "a2a931ffa6c987fbd");
    // SubagentStart cannot cancel, so it only reports the pending bind.
    assert.equal(start.output.hookSpecificOutput?.additionalContext, "BATON_GUARD_SUBAGENT_PENDING_BIND");

    const wrongHost = evaluateSubagentStart({
      hook_event_name: "SubagentStart",
      cwd: "/workspace",
      agent_id: "a2a931ffa6c987fbd",
      agent_type: "baton-probe",
    }, { state: state([claudeReserved]), host: "codex" });
    assert.equal(wrongHost.allowed, false);
    assert.equal(wrongHost.reason, HOST_GUARD_REASONS.invalid_input);
    assert.equal(wrongHost.ticket_id, null);
  });

  it("scopes the current Codex hook install to Codex", () => {
    const both = state([readTicket, claudeTicket]);
    const codex = evaluatePreToolUse(event("Bash", { command: "npm test" }, { agent_id: "native-1" }), { state: both, host: "codex" });
    assert.equal(codex.allowed, true);
    assert.equal(codex.ticket_id, "spn-0001");
  });
});

describe("Codex/Claude ticket-presence director edits", () => {
  function batonOnPath(): { bareDir: string; env: { PATH: string }; executablePath: string } {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ticket-presence-"));
    const bare = path.join(bareDir, "baton");
    fs.writeFileSync(bare, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bare, 0o755);
    return { bareDir, env: { PATH: bareDir }, executablePath: bare };
  }

  for (const host of ["codex", "claude"] as const) {
    it(`${host}: no reserved ticket allows director file-edit`, () => {
      const patch = evaluatePreToolUse(event("apply_patch", { command: "*** Begin Patch" }), { state: state(), host });
      assert.equal(patch.allowed, true);
      const edit = evaluatePreToolUse(event("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }), { state: state(), host });
      assert.equal(edit.allowed, true);
      const write = evaluatePreToolUse(event("Write", { file_path: "src/a.ts", content: "x" }), { state: state(), host });
      assert.equal(write.allowed, true);
    });

    it(`${host}: reserved/dispatching/running ticket denies director file-edit with ticket id in reason`, () => {
      const ticketId = host === "codex" ? "spn-0001" : "spn-0100";
      const base = host === "codex"
        ? readTicket
        : { ...readTicket, id: ticketId, host: "claude", dispatch_host: "claude", agent_id: "a1c6c56" };

      for (const status of ["dispatching", "running"] as const) {
        const live = state([{
          ...base,
          status,
          agent_id: status === "dispatching" ? null : base.agent_id,
        }]);
        const denied = evaluatePreToolUse(event(host === "codex" ? "apply_patch" : "Edit", host === "codex"
          ? { command: "*** Begin Patch" }
          : { file_path: "src/a.ts", old_string: "a", new_string: "b" }, host === "codex" ? { agent_type: "root" } : {}), { state: live, host });
        assert.equal(denied.allowed, false);
        assert.equal(denied.reason, HOST_GUARD_REASONS.director_code_write);
        assert.match(String((denied.output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), new RegExp(ticketId));
      }
    });

    it(`${host}: standalone baton apply --dispatch stays allowed while a worker ticket is reserved`, () => {
      const { env, executablePath } = batonOnPath();
      const ticketId = host === "codex" ? "spn-0001" : "spn-0100";
      const reserved = state([{
        ...(host === "codex" ? readTicket : { ...readTicket, id: ticketId, host: "claude", dispatch_host: "claude" }),
        status: "dispatching",
        agent_id: null,
      }]);
      const bare = evaluatePreToolUse(event("Bash", { command: "baton apply --dispatch" }), { state: reserved, host, env, executablePath });
      assert.equal(bare.allowed, true);
      const scoped = evaluatePreToolUse(event("Bash", {
        command: `baton apply foo --host ${host} --dispatch --json`,
      }), { state: reserved, host, env, executablePath });
      assert.equal(scoped.allowed, true);
    });
  }
});

describe("Grok host guard", () => {
  const grokOpts = { state: state(), host: "grok" as const };

  it("does not intercept ordinary Grok edits when no Baton ticket is reserved", () => {
    const edit = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "search_replace",
      toolInput: { old_string: "a", new_string: "b" },
      cwd: "/workspace",
    }, grokOpts);
    assert.equal(edit.allowed, true);
    assert.equal(edit.output.decision, "allow");

    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-bin-"));
    fs.writeFileSync(path.join(bin, "baton"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(bin, "baton"), 0o755);
    const allowed = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "baton apply foo --host grok --dispatch --json" },
      cwd: "/workspace",
    }, { state: state(), host: "grok", env: { PATH: bin } });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.output.decision, "allow");
  });

  it("lets the Grok director inspect and stage without a bound worker", () => {
    const inspect = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git status" },
      cwd: "/workspace",
    }, grokOpts);
    assert.equal(inspect.allowed, true);
    assert.equal(inspect.output.decision, "allow");

    const stage = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git add -A" },
      cwd: "/workspace",
    }, grokOpts);
    assert.equal(stage.allowed, true);

    const commit = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git commit -m x" },
      cwd: "/workspace",
    }, grokOpts);
    assert.equal(commit.allowed, true);
    const tests = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "bun test" },
      cwd: "/workspace",
    }, grokOpts);
    assert.equal(tests.allowed, true);
  });

  it("does not let the Grok director stage while a commit-only ticket is live", () => {
    const live = state([{
      ...readTicket,
      id: "spn-0200",
      status: "running",
      mode: "commit-only",
      read_only: false,
      agent_id: "01a032d3-b6e3-7960-96b7-fd152f897105",
      host: "grok",
      dispatch_host: "grok",
      allowed_operations: ["commit"],
    }]);
    const denied = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git add -A" },
      cwd: "/workspace",
    }, { state: live, host: "grok" });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, HOST_GUARD_REASONS.commit_only_command);
  });

  it("allows ordinary Grok spawn_subagent when no Baton ticket is reserved", () => {
    const allowed = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "spawn_subagent",
      toolInput: { prompt: "implement the task", model: "grok-4.5" },
      cwd: "/workspace",
    }, grokOpts);
    assert.equal(allowed.allowed, true);
  });

  it("requires the exact Grok reservation even when only one ticket is dispatching", () => {
    const ticket = reservedTicket({
      ...readTicket,
      id: "spn-0200",
      host: "grok",
      dispatch_host: "grok",
    }, "grok-reservation-one");
    const reserved = state([ticket]);
    const missing = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "spawn_subagent",
      toolInput: { prompt: "implement the reserved unit", model: "grok-4.5" },
      cwd: "/workspace",
    }, { state: reserved, host: "grok" });
    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, HOST_GUARD_REASONS.reservation_identity_required);

    const allowed = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "spawn_subagent",
      toolInput: {
        prompt: reservedText(ticket, "implement the reserved unit"),
        description: reservedText(ticket, "reserved unit"),
        model: "grok-4.5",
      },
      cwd: "/workspace",
    }, { state: reserved, host: "grok" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.ticket_id, "spn-0200");
  });

  it("allows parallel Grok reservations by exact identity and never by ticket-like prose", () => {
    const first = reservedTicket({
      ...readTicket,
      id: "os-0200",
      host: "grok",
      dispatch_host: "grok",
    }, "grok-reservation-two");
    const second = reservedTicket({
      ...readTicket,
      id: "zly-anything",
      host: "grok",
      dispatch_host: "grok",
    }, "grok-reservation-three");
    const two = state([first, second]);
    const nonMatching = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "spawn_subagent",
      toolInput: { prompt: "work for os-0200 and zly-anything", model: "grok-4.5" },
      cwd: "/workspace",
    }, { state: two, host: "grok" });
    assert.equal(nonMatching.allowed, false);
    assert.equal(nonMatching.reason, HOST_GUARD_REASONS.reservation_identity_required);

    for (const ticket of [first, second]) {
      const matched = evaluatePreToolUse({
        hookEventName: "pre_tool_use",
        toolName: "spawn_subagent",
        toolInput: {
          prompt: reservedText(ticket, "implement the task"),
          description: reservedText(ticket, "reserved unit"),
          model: "grok-4.5",
        },
        cwd: "/workspace",
      }, { state: two, host: "grok" });
      assert.equal(matched.allowed, true);
      assert.equal(matched.ticket_id, ticket.id);
    }
  });

  const grokWorker = {
    ...readTicket,
    id: "spn-0200",
    agent_id: "01a032d3-b6e3-7960-96b7-fd152f897105",
    host: "grok",
    dispatch_host: "grok",
  };

  function grokBoundState(ticket: HostGuardState["tickets"][number] = grokWorker): HostGuardState {
    const bound = state([ticket]);
    bound.bindings = [{
      ticket_id: ticket.id,
      agent_id: ticket.agent_id!,
      turn_id: null,
      session_id: "child-session",
      agent_type: "general-purpose",
      state: "bound",
      observed_at: "2026-08-25T00:00:00.000Z",
    }];
    return bound;
  }

  it("allows a bound Grok worker shell when PreToolUse has subagentType but no agent_id", () => {
    const bound = grokBoundState();
    const allowed = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git status" },
      cwd: "/workspace",
      sessionId: "child-session",
      subagentType: "general-purpose",
    }, { state: bound, host: "grok" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.ticket_id, "spn-0200");
    assert.equal(allowed.output.decision, "allow");
  });

  it("lets the Grok director keep working while a Baton worker is bound", () => {
    const bound = state([grokWorker]);
    const inspect = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git status" },
      cwd: "/workspace",
      sessionId: "parent-session",
    }, { state: bound, host: "grok" });
    assert.equal(inspect.allowed, true);
    const tests = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "bun test" },
      cwd: "/workspace",
      sessionId: "parent-session",
    }, { state: bound, host: "grok" });
    assert.equal(tests.allowed, true);
    const edit = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "search_replace",
      toolInput: { old_string: "a", new_string: "b" },
      cwd: "/workspace",
      sessionId: "parent-session",
    }, { state: bound, host: "grok" });
    assert.equal(edit.allowed, false);
    assert.equal(edit.reason, HOST_GUARD_REASONS.director_code_write);
    assert.match(String(edit.output.reason || (edit.output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /spn-0200/);

    for (const status of ["dispatching", "running"] as const) {
      const live = state([{
        ...grokWorker,
        status,
        agent_id: status === "dispatching" ? null : grokWorker.agent_id,
      }]);
      const denied = evaluatePreToolUse({
        hookEventName: "pre_tool_use",
        toolName: "search_replace",
        toolInput: { old_string: "a", new_string: "b" },
        cwd: "/workspace",
        sessionId: "parent-session",
      }, { state: live, host: "grok" });
      assert.equal(denied.allowed, false);
      assert.equal(denied.reason, HOST_GUARD_REASONS.director_code_write);
      assert.match(String(denied.output.reason || (denied.output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason), /spn-0200/);
    }
  });

  it("keeps bound Grok workers inside the Receipt for search_replace", () => {
    const readBound = grokBoundState();
    const readDenied = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "search_replace",
      toolInput: { old_string: "a", new_string: "b" },
      cwd: "/workspace",
      sessionId: "child-session",
      subagentType: "general-purpose",
    }, { state: readBound, host: "grok" });
    assert.equal(readDenied.allowed, false);
    assert.equal(readDenied.reason, HOST_GUARD_REASONS.write_receipt_required);
    assert.equal(readDenied.ticket_id, "spn-0200");

    const writeBound = grokBoundState({
      ...grokWorker,
      mode: "write",
      read_only: false,
      allowed_operations: ["write", "create"],
      write_allowlist: ["src/index.ts"],
    });
    const writeAllowed = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "search_replace",
      toolInput: { file_path: "src/index.ts", old_string: "a", new_string: "b" },
      cwd: "/workspace",
      sessionId: "child-session",
      subagentType: "general-purpose",
    }, { state: writeBound, host: "grok" });
    assert.equal(writeAllowed.allowed, true);
    assert.equal(writeAllowed.ticket_id, "spn-0200");
  });

  it("denies Git topology changes even for an ordinary write worker", () => {
    const writeBound = state([{
      ...readTicket,
      host: "grok",
      dispatch_host: "grok",
      mode: "write",
      read_only: false,
      allowed_operations: ["write", "create"],
      write_allowlist: ["src/index.ts"],
    }]);
    for (const command of ["git branch release", "git tag release", "git update-ref refs/heads/release HEAD", "git push origin HEAD"]) {
      const denied = evaluatePreToolUse({
        hookEventName: "pre_tool_use",
        toolName: "run_terminal_command",
        toolInput: { command },
        cwd: "/workspace",
        agentId: "native-1",
        subagentType: "worker",
      }, { state: writeBound, host: "grok" });
      assert.equal(denied.allowed, false, command);
      assert.equal(denied.reason, HOST_GUARD_REASONS.director_shell, command);
    }
  });

  it("denies Grok worker writes before bind once SubagentStart recorded the session", () => {
    const ticket = reservedTicket(grokWorker, "grok-reservation-four");
    const reserved = state([ticket]);
    evaluateSubagentStart({
      hookEventName: "subagent_start",
      cwd: "/workspace",
      sessionId: "child-session",
      subagentId: grokWorker.agent_id,
      subagentType: "general-purpose",
      description: reservedText(ticket, "reserved unit"),
    }, { state: reserved, host: "grok" });
    const inspect = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git status" },
      cwd: "/workspace",
      sessionId: "child-session",
      subagentType: "general-purpose",
    }, { state: reserved, host: "grok" });
    assert.equal(inspect.allowed, true);
    const denied = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "search_replace",
      toolInput: { old_string: "a", new_string: "b" },
      cwd: "/workspace",
      sessionId: "child-session",
      subagentType: "general-purpose",
    }, { state: reserved, host: "grok" });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, HOST_GUARD_REASONS.spawn_bind_pending);
  });

  it("authorizes a session-bound Grok commit-only git commit without agent_id", () => {
    const commit = grokBoundState({
      ...grokWorker,
      mode: "commit-only",
      read_only: false,
      allowed_operations: ["commit"],
      write_allowlist: ["src/lib/host-guard.ts"],
    });
    const allowed = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git commit -m host-guard-identity" },
      cwd: "/workspace",
      sessionId: "child-session",
      subagentType: "general-purpose",
    }, { state: commit, host: "grok" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.ticket_id, "spn-0200");
  });

  it("never assigns an unmapped Grok child to the sole running ticket", () => {
    const unmapped = state([grokWorker]);
    const inspect = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git status" },
      cwd: "/workspace",
      sessionId: "unmapped-child",
      subagentType: "general-purpose",
    }, { state: unmapped, host: "grok" });
    assert.equal(inspect.allowed, true);
    assert.equal(inspect.ticket_id, null);

    const edit = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "search_replace",
      toolInput: { file_path: "src/index.ts", old_string: "a", new_string: "b" },
      cwd: "/workspace",
      sessionId: "unmapped-child",
      subagentType: "general-purpose",
    }, { state: unmapped, host: "grok" });
    assert.equal(edit.allowed, false);
    assert.equal(edit.ticket_id, null);
    assert.equal(edit.reason, HOST_GUARD_REASONS.director_code_write);
  });

  it("maps a Grok worker session from the exact SubagentStart reservation", () => {
    const ticket = reservedTicket(grokWorker, "grok-reservation-five");
    const reserved = state([ticket]);
    const start = evaluateSubagentStart({
      hookEventName: "subagent_start",
      cwd: "/workspace",
      sessionId: "child-session",
      subagentId: grokWorker.agent_id,
      subagentType: "general-purpose",
      description: reservedText(ticket, "reserved unit"),
    }, { state: reserved, host: "grok" });
    assert.equal(start.allowed, true);
    assert.equal(start.output.hookSpecificOutput?.additionalContext, "BATON_GUARD_SUBAGENT_PENDING_BIND");
    assert.equal(reserved.bindings[0]?.session_id, "child-session");
    assert.equal(reserved.bindings[0]?.agent_id, grokWorker.agent_id);

    reserved.tickets[0] = { ...reserved.tickets[0], status: "running", agent_id: grokWorker.agent_id };
    const afterBind = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git status" },
      cwd: "/workspace",
      sessionId: "child-session",
      subagentType: "general-purpose",
    }, { state: reserved, host: "grok" });
    assert.equal(afterBind.allowed, true);
    assert.equal(afterBind.ticket_id, "spn-0200");
  });

  it("does not bind an unmatched Grok child to one of two running tickets", () => {
    const other = {
      ...grokWorker,
      id: "spn-0201",
      agent_id: "01a032d3-dead-beef-0000-000000000001",
    };
    const both = state([grokWorker, other]);
    const unmatched = evaluatePreToolUse({
      hookEventName: "pre_tool_use",
      toolName: "run_terminal_command",
      toolInput: { command: "git status" },
      cwd: "/workspace",
      sessionId: "unknown-child",
      subagentType: "general-purpose",
    }, { state: both, host: "grok" });
    assert.equal(unmatched.allowed, true);
    assert.equal(unmatched.ticket_id, null);
  });

  it("serializes SubagentStart binding writes with terminal cleanup and preserves unrelated rows", async () => {
    const { cwd, env } = makeDiskGuardProject();
    writeDiskGuardTicket(cwd, {
      id: "spn-new",
      reservation_id: "reservation-new",
      attempt: 1,
      status: "dispatching",
      mode: "read-only",
      read_only: true,
      agent_id: null,
      host: "codex",
      dispatch_host: "codex",
      receipt_id: null,
    }, env);
    recordPendingReservation(cwd, {
      schema: BATON_DISPATCH_RESERVATION_SCHEMA,
      reservation_id: "reservation-new",
      ticket_id: "spn-new",
      attempt: 1,
      host: "codex",
    }, {
      turn_id: "parent-turn",
      session_id: "root-session",
      transcript_path: "/workspace/spn-new.jsonl",
      now: "2026-08-25T00:00:00.000Z",
    }, undefined, env);
    const removed = {
      ticket_id: "spn-clear",
      agent_id: "agent-clear",
      reservation_id: "reservation-clear",
      attempt: 1,
      host: "codex",
      turn_id: "turn-clear",
      session_id: "session-clear",
      agent_type: "worker",
      state: "bound",
      observed_at: "2026-08-25T00:00:01.000Z",
    };
    const kept = {
      ticket_id: "spn-keep",
      agent_id: "agent-keep",
      reservation_id: "reservation-keep",
      attempt: 1,
      host: "codex",
      turn_id: "turn-keep",
      session_id: "session-keep",
      agent_type: "worker",
      state: "bound",
      observed_at: "2026-08-25T00:00:02.000Z",
    };
    writeDiskBindings(cwd, [removed, kept], env);
    const lockFile = path.join(runsDir(cwd, env), "host-guard-bindings.json.lock");
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, created_at: "2026-08-25T00:00:03.000Z" })}\n`, "utf8");

    const spawned = spawnDiskSubagentStart({
      hook_event_name: "SubagentStart",
      cwd,
      turn_id: "child-turn",
      session_id: "root-session",
      transcript_path: "/workspace/spn-new.jsonl",
      agent_id: "agent-new",
      agent_type: "worker",
    }, "2026-08-25T00:00:04.000Z", env);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawned.child.exitCode, null);
    fs.unlinkSync(lockFile);
    clearHostGuardBindingsForTicketAttempt(cwd, {
      id: "spn-clear",
      reservation_id: "reservation-clear",
      attempt: 1,
      host: "codex",
      dispatch_host: "codex",
      agent_id: "agent-clear",
    }, { env });

    const result = await spawned.completion;
    assert.equal(result.code, 0, result.stderr);
    const decision = JSON.parse(result.stdout) as GuardDecision;
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, HOST_GUARD_REASONS.invalid_input);
    assert.deepEqual(readDiskBindings(cwd, env), [kept]);
  });
});
