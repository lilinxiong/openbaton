#!/usr/bin/env bun
/**
 * Run the same mechanical units twice: once through Baton, once directly.
 * Host (codex|grok|...) comes from --host, BATON_HOST, or a unique runtime signal.
 *
 *   bun scripts/compare-mechanical-ops.ts
 *   bun scripts/compare-mechanical-ops.ts --json
 *   bun scripts/compare-mechanical-ops.ts --fixture
 *
 * The Baton lane opens tickets, bind/complete/release them, and runs the same
 * command locally as the worker body. It does not call host spawn tools.
 * Live mode never git-commits; --fixture commits only inside a temp repo.
 */
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { cliProfileForHost, loadConfig } from "../src/lib/config.js";
import { recordNativeIdentity, recordPendingReservation, type NativeIdentitySource } from "../src/lib/host-identity.js";
import { resolveRuntimeHost } from "../src/lib/hosts.js";
import { spawnsDir } from "../src/lib/paths.js";
import type { CliId } from "../src/adapters/contract.js";

export const COMPARE_REQUEST = "coverage of configured mechanical routes";

export interface CompareUnit {
  key: string;
  phrase: string;
  argv: string[];
  classification: "mechanical" | "long-context" | "implementation";
  operation: string;
  capabilities?: string[];
  commit?: boolean;
}

export const COMPARE_UNITS: CompareUnit[] = [
  { key: "test", phrase: "bun run test", argv: ["bun", "run", "test"], classification: "mechanical", operation: "test" },
  { key: "build", phrase: "bun run build", argv: ["bun", "run", "build"], classification: "mechanical", operation: "build" },
  { key: "typecheck", phrase: "bun run check", argv: ["bun", "run", "check"], classification: "mechanical", operation: "typecheck" },
  { key: "search", phrase: "rg configuredRoute src", argv: ["rg", "configuredRoute", "src"], classification: "long-context", operation: "search" },
  { key: "summarize", phrase: "git status", argv: ["git", "status", "--short", "--branch"], classification: "long-context", operation: "summarize" },
  { key: "ordinary", phrase: "Read package.json and report the bin name", argv: ["node", "-e", "const p=require('./package.json'); console.log(JSON.stringify(p.bin || p.name))"], classification: "implementation", operation: "read-package" },
  { key: "commit", phrase: "git commit staged changes", argv: ["git", "commit", "-m", "compare-ops: staged work"], classification: "mechanical", operation: "git-commit", capabilities: ["commit"], commit: true },
];

export interface LaneResult {
  elapsed_ms: number;
  exit: number | null;
  stdout: string;
  stderr: string;
  skipped?: string;
}

export interface BatonLaneResult extends LaneResult {
  kind: "ops-dispatch" | "subagent" | "director-local" | "skipped" | "missing";
  operation: string | null;
  profile: string | null;
  model: string | null;
  ticket_id: string | null;
  phases: {
    queued_to_reserved_ms: number | null;
    reserved_to_bound_ms: number | null;
    bound_to_completed_ms: number | null;
    completed_to_released_ms: number | null;
    queued_to_finished_ms: number | null;
    spawn_cli_ms: number | null;
    bind_cli_ms: number | null;
    execute_ms: number | null;
    complete_cli_ms: number | null;
  };
}

export interface TaskComparison {
  key: string;
  phrase: string;
  direct: LaneResult;
  baton: BatonLaneResult;
  overhead_ms: number | null;
}

export interface CompareReport {
  ok: boolean;
  mode: "live" | "fixture";
  cli: CliId;
  host: CliId;
  runner: string;
  longctx: string;
  cwd: string;
  spawn_cli_ms: number;
  tasks: TaskComparison[];
}

export interface CompareOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  mode?: "live" | "fixture";
  timeoutMs?: number;
  workspace?: string;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function ms(value: number): string {
  return `${value} ms`;
}

function clip(text: string, max = 240): string {
  const value = String(text || "").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function which(name: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync("which", [name], { encoding: "utf8", env });
  const found = (result.stdout || "").trim();
  return result.status === 0 && found ? found : null;
}

function searchArgv(cwd: string, env: NodeJS.ProcessEnv): string[] {
  if (which("rg", env)) return ["rg", "configuredRoute", "src"];
  return ["grep", "-R", "configuredRoute", path.join(cwd, "src")];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function hasStagedDiff(cwd: string): boolean {
  return spawnSync("git", ["diff", "--cached", "--quiet"], { cwd }).status === 1;
}

function eventAt(ticket: { history?: Array<{ event: string; at: string }> }, event: string): string | null {
  return (ticket.history || []).find((item) => item.event === event)?.at || null;
}

function deltaMs(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return round(end - start);
}

function capture() {
  const chunks: string[] = [];
  return {
    write(value: unknown) { chunks.push(String(value)); return true; },
    text() { return chunks.join(""); },
  };
}

function argvFor(unit: CompareUnit, cwd: string, env: NodeJS.ProcessEnv, mode: "live" | "fixture"): string[] {
  if (unit.key === "search") return searchArgv(cwd, env);
  if (mode === "fixture" && (unit.key === "test" || unit.key === "build" || unit.key === "typecheck")) {
    return ["node", "-e", `console.log(${JSON.stringify(`${unit.key}-ok`)})`];
  }
  return unit.argv;
}

function runArgv(cwd: string, argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): LaneResult {
  const started = performance.now();
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf8", timeout: timeoutMs });
  return {
    elapsed_ms: round(performance.now() - started),
    exit: result.status,
    stdout: clip(result.stdout || ""),
    stderr: clip(result.stderr || result.error?.message || ""),
  };
}

async function baton(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ payload: Record<string, unknown>; ms: number }> {
  const stdout = capture();
  const stderr = capture();
  const started = performance.now();
  const code = await run(args, { cwd, env, stdout, stderr });
  const text = `${stdout.text()}${stderr.text()}`;
  if (code !== 0) throw new Error(`baton ${args.join(" ")} failed (${code}): ${clip(text, 800)}`);
  const ms = round(performance.now() - started);
  const index = text.indexOf("{");
  if (index >= 0) return { payload: JSON.parse(text.slice(index)), ms };
  if (/empty index|git-commit skipped/.test(text)) {
    return {
      payload: {
        skipped: [{ key: "commit", operation: "git-commit", reason: "empty index, nothing to commit" }],
        reserved: [],
      },
      ms,
    };
  }
  if (/director-local/.test(text)) {
    return {
      payload: {
        director_local: [{ key: "commit", operation: "git-commit", reason: clip(text) }],
        reserved: [],
      },
      ms,
    };
  }
  throw new Error(`expected JSON object, got: ${clip(text, 400)}`);
}

function readTicket(cwd: string, env: NodeJS.ProcessEnv, id: string) {
  return JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd, env), `${id}.json`), "utf8"));
}

function fixtureIdentitySource(host: string): NativeIdentitySource {
  const normalized = String(host || "").trim().toLowerCase();
  if (normalized === "grok") return "lifecycle";
  if (normalized === "cursor") return "tool-return";
  if (normalized === "codex" || normalized === "claude") return "hook";
  throw new Error(`fixture compare has no authoritative identity source for host ${host}`);
}

function seedFixtureIdentity(cwd: string, env: NodeJS.ProcessEnv, ticketId: string, host: string): void {
  const ticket = readTicket(cwd, env, ticketId) as Record<string, unknown>;
  const normalizedHost = String(host || ticket.dispatch_host || ticket.host || "").trim().toLowerCase();
  const agentId = `compare-${ticketId}`;
  const context = normalizedHost === "grok" ? { session_id: agentId } : {};
  const pending = recordPendingReservation(cwd, {
    schema: 1,
    reservation_id: String(ticket.reservation_id || ""),
    ticket_id: String(ticket.id || ticketId),
    attempt: Number(ticket.attempt || 0),
    host: normalizedHost,
  }, context, undefined, env);
  recordNativeIdentity(cwd, pending, agentId, fixtureIdentitySource(normalizedHost), context, undefined, env);
}

export function createFixtureWorkspace(root?: string): string {
  const cwd = root || fs.mkdtempSync(path.join(os.tmpdir(), "baton-compare-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), `${JSON.stringify({
    name: "compare-fixture",
    bin: { baton: "dist/bin/baton.js" },
    scripts: {
      test: "node -e \"console.log('test-ok')\"",
      build: "node -e \"console.log('build-ok')\"",
      check: "node -e \"console.log('check-ok')\"",
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, "src", "ops.ts"), "export const configuredRoute = true;\n");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "compare@example.invalid");
  git(cwd, "config", "user.name", "Compare");
  git(cwd, "add", "package.json", "src/ops.ts");
  git(cwd, "commit", "-q", "-m", "baseline");
  fs.appendFileSync(path.join(cwd, "src", "ops.ts"), "// staged for commit-only compare\n");
  git(cwd, "add", "src/ops.ts");
  return cwd;
}

function copyWorkspace(src: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "baton-compare-copy-"));
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

function emptyPhases(spawnCliMs: number | null = null): BatonLaneResult["phases"] {
  return {
    queued_to_reserved_ms: null,
    reserved_to_bound_ms: null,
    bound_to_completed_ms: null,
    completed_to_released_ms: null,
    queued_to_finished_ms: null,
    spawn_cli_ms: spawnCliMs,
    bind_cli_ms: null,
    execute_ms: null,
    complete_cli_ms: null,
  };
}

function skippedLane(reason: string, spawnCliMs: number | null = null): BatonLaneResult {
  return {
    elapsed_ms: 0,
    exit: 0,
    stdout: "",
    stderr: "",
    skipped: reason,
    kind: "skipped",
    operation: null,
    profile: null,
    model: null,
    ticket_id: null,
    phases: emptyPhases(spawnCliMs),
  };
}

function indexSpawn(payload: Record<string, unknown>) {
  const dispatched = new Map<string, Record<string, unknown>>();
  for (const item of (payload.dispatched as Array<Record<string, unknown>> | undefined) || []) {
    dispatched.set(String(item.key), item);
  }
  const skipped = new Map<string, Record<string, unknown>>();
  for (const item of (payload.skipped as Array<Record<string, unknown>> | undefined) || []) {
    skipped.set(String(item.key), item);
  }
  const local = new Map<string, Record<string, unknown>>();
  for (const item of (payload.director_local as Array<Record<string, unknown>> | undefined) || []) {
    local.set(String(item.key), item);
  }
  const ordinary = new Map<string, Record<string, unknown>>();
  const recommendation = payload.recommendation as { tickets?: Array<Record<string, unknown>> } | undefined;
  for (const ticket of recommendation?.tickets || []) {
    const selection = ticket.selection as { unit_key?: string } | undefined;
    ordinary.set(String(selection?.unit_key || "ordinary"), ticket);
  }
  if (!ordinary.size && Array.isArray(recommendation?.tickets) === false && payload.ticket) {
    ordinary.set("commit", payload.ticket as Record<string, unknown>);
  }
  const reserved = new Set(((payload.reserved as Array<{ ticket_id: string }> | undefined) || []).map((item) => item.ticket_id));
  return { dispatched, skipped, local, ordinary, reserved };
}

async function finishTicket(options: {
  unit: CompareUnit;
  ticket: Record<string, unknown>;
  kind: BatonLaneResult["kind"];
  operation: string | null;
  profile: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  host: string;
  mode: "live" | "fixture";
  timeoutMs: number;
  spawnCliMs: number;
  reserved: Set<string>;
}): Promise<BatonLaneResult> {
  const ticketId = String(options.ticket.id);
  const lane: BatonLaneResult = {
    elapsed_ms: 0,
    exit: 0,
    stdout: "",
    stderr: "",
    kind: options.kind,
    operation: options.operation,
    profile: options.profile,
    model: String(options.ticket.model_id || options.ticket.route_id || ""),
    ticket_id: ticketId,
    phases: emptyPhases(options.spawnCliMs),
  };
  if (!options.reserved.has(ticketId)) {
    throw new Error(`${ticketId} was created but not reserved`);
  }
  if (options.mode === "fixture") seedFixtureIdentity(options.cwd, options.env, ticketId, options.host);
  const bound = await baton(
    ["dispatch", "bind", ticketId, "--agent-id", `compare-${ticketId}`, "--host", options.host, "--json"],
    options.cwd,
    options.env,
  );
  lane.phases.bind_cli_ms = bound.ms;
  const executed = runArgv(options.cwd, argvFor(options.unit, options.cwd, options.env, options.mode), options.env, options.timeoutMs);
  Object.assign(lane, executed);
  lane.kind = options.kind;
  lane.operation = options.operation;
  lane.profile = options.profile;
  lane.model = String(options.ticket.model_id || options.ticket.route_id || "");
  lane.ticket_id = ticketId;
  lane.phases.execute_ms = executed.elapsed_ms;
  const conclusion = clip(executed.stdout || `${options.unit.key} exit ${executed.exit}`, 200) || `${options.unit.key} done`;
  const finished = await baton(
    ["dispatch", "complete", ticketId, "--text", conclusion, "--release", "--json"],
    options.cwd,
    options.env,
  );
  lane.phases.complete_cli_ms = finished.ms;
  const stored = readTicket(options.cwd, options.env, ticketId);
  lane.phases.queued_to_reserved_ms = deltaMs(eventAt(stored, "ticket_queued"), eventAt(stored, "dispatch_reserved"));
  lane.phases.reserved_to_bound_ms = deltaMs(eventAt(stored, "dispatch_reserved"), eventAt(stored, "agent_bound"));
  lane.phases.bound_to_completed_ms = deltaMs(eventAt(stored, "agent_bound"), eventAt(stored, "agent_completed"));
  lane.phases.completed_to_released_ms = deltaMs(eventAt(stored, "agent_completed"), eventAt(stored, "agent_slot_released"));
  lane.phases.queued_to_finished_ms = deltaMs(eventAt(stored, "ticket_queued"), eventAt(stored, "agent_completed"));
  lane.elapsed_ms = round((lane.phases.bind_cli_ms || 0) + executed.elapsed_ms + (lane.phases.complete_cli_ms || 0));
  return lane;
}

async function batonLaneForUnit(options: {
  unit: CompareUnit;
  payload: Record<string, unknown>;
  spawnCliMs: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  host: string;
  mode: "live" | "fixture";
  timeoutMs: number;
}): Promise<BatonLaneResult> {
  const index = indexSpawn(options.payload);
  const skip = index.skipped.get(options.unit.key);
  if (skip) return { ...skippedLane(String(skip.reason || "skipped"), options.spawnCliMs), operation: String(skip.operation || options.unit.operation) };
  const director = index.local.get(options.unit.key);
  if (director) {
    const executed = runArgv(
      options.cwd,
      argvFor(options.unit, options.cwd, options.env, options.mode),
      options.env,
      options.timeoutMs,
    );
    return {
      ...executed,
      kind: "director-local",
      operation: String(director.operation || options.unit.operation),
      profile: null,
      model: null,
      ticket_id: null,
      phases: { ...emptyPhases(options.spawnCliMs), execute_ms: executed.elapsed_ms },
    };
  }
  const ops = index.dispatched.get(options.unit.key)
    || (options.unit.commit ? index.dispatched.get("standalone") : undefined);
  if (ops) {
    return finishTicket({
      unit: options.unit,
      ticket: ops.ticket as Record<string, unknown>,
      kind: "ops-dispatch",
      operation: String(ops.operation || options.unit.operation),
      profile: String(ops.profile),
      cwd: options.cwd,
      env: options.env,
      host: options.host,
      mode: options.mode,
      timeoutMs: options.timeoutMs,
      spawnCliMs: options.spawnCliMs,
      reserved: index.reserved,
    });
  }
  const ordinary = index.ordinary.get(options.unit.key) || (options.unit.commit ? index.ordinary.get("commit") : undefined);
  if (ordinary) {
    return finishTicket({
      unit: options.unit,
      ticket: ordinary,
      kind: options.unit.commit ? "ops-dispatch" : "subagent",
      operation: options.unit.commit ? options.unit.operation : null,
      profile: options.unit.commit ? "runner" : null,
      cwd: options.cwd,
      env: options.env,
      host: options.host,
      mode: options.mode,
      timeoutMs: options.timeoutMs,
      spawnCliMs: options.spawnCliMs,
      reserved: index.reserved,
    });
  }
  return {
    elapsed_ms: 0,
    exit: 1,
    stdout: "",
    stderr: "unit missing from baton spawn payload",
    kind: "missing",
    operation: null,
    profile: null,
    model: null,
    ticket_id: null,
    phases: emptyPhases(options.spawnCliMs),
  };
}

export async function runMechanicalCompare(options: CompareOptions): Promise<CompareReport> {
  const env = options.env || process.env;
  const mode = options.mode || "live";
  const timeoutMs = options.timeoutMs ?? (mode === "live" ? 10 * 60_000 : 15_000);
  const source = mode === "fixture" ? (options.workspace || createFixtureWorkspace()) : options.cwd;
  const cfg = loadConfig(source, { env });
  const cli = resolveRuntimeHost({ cwd: source, env });
  const profile = cliProfileForHost(cfg, cli);
  if (!profile.enabled) throw new Error(`CLI ${cli} is disabled; run baton config --enable`);

  const directRoot = mode === "fixture" ? copyWorkspace(source) : source;
  const batonRoot = mode === "fixture" ? copyWorkspace(source) : source;
  const allowCommit = mode === "fixture";
  const workUnits = COMPARE_UNITS.filter((unit) => !unit.commit);
  const spawnArgs = [
    "spawn", COMPARE_REQUEST,
    ...workUnits.flatMap((unit) => ["--unit", `${unit.key}=${unit.phrase}`]),
    ...workUnits.flatMap((unit) => ["--unit-classification", `${unit.key}=${unit.classification}`]),
    ...workUnits.flatMap((unit) => ["--unit-operation", `${unit.key}=${unit.operation}`]),
    "--dispatch", "--json",
    "--host", cli,
    "--capacity", String(Math.max(workUnits.length, 1)),
  ];
  const spawned = await baton(spawnArgs, batonRoot, env);
  const lanes = new Map<string, BatonLaneResult>();
  for (const unit of workUnits) {
    lanes.set(unit.key, await batonLaneForUnit({
      unit,
      payload: spawned.payload,
      spawnCliMs: spawned.ms,
      cwd: batonRoot,
      env,
      host: cli,
      mode,
      timeoutMs,
    }));
  }

  if (allowCommit) {
    const commitUnit = COMPARE_UNITS.find((unit) => unit.commit)!;
    const commitSpawn = await baton([
      "spawn", commitUnit.phrase,
      "--classification", JSON.stringify({ kind: commitUnit.classification, operation: commitUnit.operation, capabilities: commitUnit.capabilities || [] }),
      "--dispatch", "--json",
      "--host", cli, "--capacity", "1",
    ], batonRoot, env);
    lanes.set(commitUnit.key, await batonLaneForUnit({
      unit: commitUnit,
      payload: commitSpawn.payload,
      spawnCliMs: commitSpawn.ms,
      cwd: batonRoot,
      env,
      host: cli,
      mode,
      timeoutMs,
    }));
  }

  const tasks: TaskComparison[] = [];
  for (const unit of COMPARE_UNITS) {
    let direct: LaneResult;
    if (unit.commit && !allowCommit) {
      direct = { elapsed_ms: 0, exit: 0, stdout: "", stderr: "", skipped: "live mode does not git commit" };
    } else if (unit.commit && !hasStagedDiff(directRoot)) {
      direct = { elapsed_ms: 0, exit: 0, stdout: "", stderr: "", skipped: "empty index, nothing to commit" };
    } else {
      direct = runArgv(directRoot, argvFor(unit, directRoot, env, mode), env, timeoutMs);
    }
    const batonLane = unit.commit && !allowCommit
      ? skippedLane("live mode does not git commit", spawned.ms)
      : lanes.get(unit.key) || skippedLane("unit missing from baton spawn payload", spawned.ms);
    tasks.push({
      key: unit.key,
      phrase: unit.phrase,
      direct,
      baton: batonLane,
      overhead_ms: direct.skipped || batonLane.skipped ? null : round(batonLane.elapsed_ms - direct.elapsed_ms),
    });
  }

  return {
    ok: tasks.every((task) => (task.direct.skipped || task.direct.exit === 0) && (task.baton.skipped || task.baton.exit === 0)),
    mode,
    cli,
    host: cli,
    runner: profile.runner,
    longctx: profile.longctx,
    cwd: source,
    spawn_cli_ms: spawned.ms,
    tasks,
  };
}

export function formatCompareReport(report: CompareReport): string {
  const lines = [
    `mechanical ops benchmark  cli=${report.cli}  host=${report.host}  mode=${report.mode}  ok=${report.ok}`,
    `runner=${report.runner || "-"}  longctx=${report.longctx || "-"}  spawn=${ms(report.spawn_cli_ms)} (once for all units)`,
    "",
    "with baton vs without (same local command; no host model spawn; milliseconds)",
    "Baton wrapper = bind + complete. command run-to-run = execute minus without, not Baton.",
    pad("task", 12) + pad("via", 22) + pad("without (ms)", 14) + pad("command (ms)", 14) + pad("wrapper (ms)", 14) + pad("run-to-run (ms)", 16) + "result",
  ];
  for (const task of report.tasks) {
    const via = task.baton.kind === "ops-dispatch" && task.baton.profile
      ? `${task.baton.profile}${task.baton.operation ? `/${task.baton.operation}` : ""}`
      : task.baton.kind;
    const result = [
      task.direct.skipped ? `without:${task.direct.skipped}` : `without:${task.direct.exit === 0 ? "pass" : `fail ${task.direct.exit}`}`,
      task.baton.skipped ? `with:${task.baton.skipped}` : `with:${task.baton.exit === 0 ? "pass" : `fail ${task.baton.exit}`}`,
    ].join("  ");
    const bind = task.baton.phases.bind_cli_ms;
    const execute = task.baton.phases.execute_ms;
    const complete = task.baton.phases.complete_cli_ms;
    const wrapper = !task.baton.skipped && bind != null && complete != null ? round(bind + complete) : null;
    const delta = !task.direct.skipped && !task.baton.skipped && execute != null
      ? round(execute - task.direct.elapsed_ms)
      : null;
    lines.push(
      pad(task.key, 12)
      + pad(via, 22)
      + pad(task.direct.skipped ? "-" : String(task.direct.elapsed_ms), 14)
      + pad(task.baton.skipped || execute == null ? "-" : String(execute), 14)
      + pad(wrapper == null ? "-" : String(wrapper), 14)
      + pad(delta == null ? "-" : String(delta), 16)
      + result,
    );
  }
  lines.push(
    "",
    "baton phases (milliseconds). execute is the command body.",
    pad("task", 12) + pad("bind (ms)", 12) + pad("execute (ms)", 14) + pad("complete (ms)", 14),
  );
  for (const task of report.tasks) {
    if (task.direct.skipped || task.baton.skipped) {
      lines.push(pad(task.key, 12) + pad("-", 12) + pad("-", 14) + pad("-", 14));
      continue;
    }
    const bind = task.baton.phases.bind_cli_ms;
    const execute = task.baton.phases.execute_ms;
    const complete = task.baton.phases.complete_cli_ms;
    lines.push(
      pad(task.key, 12)
      + pad(bind == null ? "-" : String(bind), 12)
      + pad(execute == null ? "-" : String(execute), 14)
      + pad(complete == null ? "-" : String(complete), 14),
    );
  }
  return `${lines.join("\n")}\n`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const fixture = args.includes("--fixture");
  const report = await runMechanicalCompare({
    cwd: process.cwd(),
    env: process.env,
    mode: fixture ? "fixture" : "live",
  });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatCompareReport(report));
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}
