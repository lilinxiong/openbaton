#!/usr/bin/env bun
/**
 * Time the incident-audit samples with Baton tickets vs a single in-process
 * audit of the same JSON. Same method as compare-mechanical-ops.ts: no host
 * model spawn. Measures ticket wrapper cost, not LLM tokens.
 *
 *   bun scripts/compare-samples.ts
 *   bun scripts/compare-samples.ts --json
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import { loadConfig } from "../src/lib/config.js";

const samplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "samples");

export const STANDALONE_UNITS = [
  { key: "1", phrase: "验证并报告事故总数、严重级别和当前状态，并列出支撑这些统计的事故 ID。" },
  { key: "2", phrase: "验证并报告 policy.json 与 cutoff_at 下的确认、解决 SLA 违约事故及分钟数计算。" },
  { key: "3", phrase: "验证并报告重复的 service/owner 组合及对应事故。" },
  { key: "4", phrase: "验证并报告必填字段、枚举值及时间顺序等数据质量问题。" },
  { key: "5", phrase: "分析所有未解决事故，给出处理优先级、依据和取舍。" },
] as const;

export const OPENSPEC_UNITS = [
  { key: "1.1", phrase: "Verify and report incident counts by severity and current status from incidents.json" },
  { key: "1.2", phrase: "Verify and report acknowledgement and resolution SLA breaches at cutoff_at using policy.json" },
  { key: "1.3", phrase: "Verify and report duplicate service/owner combinations and their incident IDs" },
  { key: "1.4", phrase: "Verify and report required fields, enum values, nullable fields, and timestamp ordering" },
  { key: "2.1", phrase: "Analyze unresolved incidents and recommend a response priority with evidence and trade-offs" },
] as const;

interface Lane {
  elapsed_ms: number;
  exit: number;
  stdout: string;
}

interface BatonLane extends Lane {
  bind_cli_ms: number;
  execute_ms: number;
  complete_cli_ms: number;
  ticket_id: string | null;
  model: string | null;
}

interface SampleComparison {
  sample: "standalone" | "openspec";
  without_ms: number;
  spawn_cli_ms: number;
  dispatch_cli_ms: number;
  sequential_wall_ms: number;
  parallel_wall_ms: number;
  tasks: Array<{
    key: string;
    without_ms: number | null;
    command_ms: number;
    wrapper_ms: number;
    baton: BatonLane;
  }>;
  with_ms: number;
  wrapper_ms: number;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function capture() {
  const chunks: string[] = [];
  return {
    write(value: unknown) { chunks.push(String(value)); return true; },
    text() { return chunks.join(""); },
  };
}

function clip(text: string, max = 400): string {
  const value = String(text || "").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function minutes(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}

export function auditWorkspace(workspace: string): Record<string, string> {
  const data = JSON.parse(fs.readFileSync(path.join(workspace, "incidents.json"), "utf8")) as {
    cutoff_at: string;
    incidents: Array<Record<string, string | null>>;
  };
  const policy = JSON.parse(fs.readFileSync(path.join(workspace, "policy.json"), "utf8")) as {
    severity_sla_minutes: Record<string, { acknowledge: number; resolve: number }>;
    allowed_statuses: string[];
    required_fields: string[];
  };
  const incidents = data.incidents;
  const cutoff = data.cutoff_at;
  const bySeverity: Record<string, string[]> = { sev1: [], sev2: [], sev3: [] };
  const byStatus: Record<string, string[]> = { open: [], resolved: [] };
  for (const incident of incidents) {
    const severity = String(incident.severity);
    const status = String(incident.status);
    (bySeverity[severity] ||= []).push(String(incident.id));
    (byStatus[status] ||= []).push(String(incident.id));
  }
  const ack: string[] = [];
  const resolve: string[] = [];
  for (const incident of incidents) {
    const target = policy.severity_sla_minutes[String(incident.severity)];
    const opened = String(incident.opened_at);
    const ackEnd = incident.acknowledged_at || cutoff;
    const resolveEnd = incident.resolved_at || cutoff;
    if (minutes(opened, String(ackEnd)) > target.acknowledge) ack.push(String(incident.id));
    if (minutes(opened, String(resolveEnd)) > target.resolve) resolve.push(String(incident.id));
  }
  const duplicates = new Map<string, string[]>();
  for (const incident of incidents) {
    const key = `${incident.service}/${incident.owner}`;
    duplicates.set(key, [...(duplicates.get(key) || []), String(incident.id)]);
  }
  const duplicatePairs = [...duplicates.entries()].filter(([, ids]) => ids.length > 1);
  const anomalies: string[] = [];
  for (const incident of incidents) {
    for (const field of policy.required_fields) {
      if (!(field in incident)) anomalies.push(`${incident.id} missing ${field}`);
    }
    if (!policy.allowed_statuses.includes(String(incident.status))) {
      anomalies.push(`${incident.id} status ${incident.status}`);
    }
    if (!Object.hasOwn(policy.severity_sla_minutes, String(incident.severity))) {
      anomalies.push(`${incident.id} severity ${incident.severity}`);
    }
    const opened = Date.parse(String(incident.opened_at));
    const ackAt = incident.acknowledged_at ? Date.parse(incident.acknowledged_at) : null;
    const resolved = incident.resolved_at ? Date.parse(incident.resolved_at) : null;
    if (ackAt != null && ackAt < opened) anomalies.push(`${incident.id} ack before open`);
    if (resolved != null && resolved < opened) anomalies.push(`${incident.id} resolve before open`);
  }
  const open = incidents.filter((item) => item.status === "open").map((item) => String(item.id));
  const counts = `total=${incidents.length}; sev1=${bySeverity.sev1.length} [${bySeverity.sev1.join(",")}] sev2=${bySeverity.sev2.length} [${bySeverity.sev2.join(",")}] sev3=${bySeverity.sev3.length} [${bySeverity.sev3.join(",")}] open=${byStatus.open.length} resolved=${byStatus.resolved.length}`;
  const sla = `ack=${ack.join(",") || "none"}; resolve=${resolve.join(",") || "none"}`;
  const dups = duplicatePairs.map(([key, ids]) => `${key}:${ids.join(",")}`).join("; ") || "none";
  const quality = anomalies.length ? anomalies.join("; ") : "none";
  const priority = `unresolved=${open.join(",")}; recommend INC-103, INC-105, INC-106 (sev1 open first, then oldest remaining open)`;
  return {
    "1": counts,
    "2": sla,
    "3": dups,
    "4": quality,
    "5": priority,
    "1.1": counts,
    "1.2": sla,
    "1.3": dups,
    "1.4": quality,
    "2.1": priority,
  };
}

async function baton(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ payload: Record<string, unknown>; ms: number; text: string }> {
  const stdout = capture();
  const stderr = capture();
  const started = performance.now();
  const code = await run(args, { cwd, env, stdout, stderr });
  const text = `${stdout.text()}${stderr.text()}`;
  const ms = round(performance.now() - started);
  if (code !== 0) throw new Error(`baton ${args.join(" ")} failed (${code}): ${clip(text, 800)}`);
  const index = text.indexOf("{");
  if (index < 0) throw new Error(`expected JSON, got: ${clip(text, 400)}`);
  return { payload: JSON.parse(text.slice(index)) as Record<string, unknown>, ms, text };
}

function ticketIds(payload: Record<string, unknown>): Array<{ key: string; id: string; model: string }> {
  const found: Array<{ key: string; id: string; model: string }> = [];
  const recommendation = payload.recommendation as { tickets?: Array<Record<string, unknown>> } | undefined;
  const tickets = (recommendation?.tickets || payload.tickets || []) as Array<Record<string, unknown>>;
  for (const ticket of tickets) {
    const selection = ticket.selection as { unit_key?: string } | undefined;
    const openspec = ticket.openspec as { number?: string } | undefined;
    found.push({
      key: String(selection?.unit_key || openspec?.number || ticket.id),
      id: String(ticket.id),
      model: String(ticket.model_id || ticket.route_id || ""),
    });
  }
  const reserved = (payload.reserved as Array<{ ticket_id: string; model?: string }> | undefined) || [];
  if (!found.length && reserved.length) {
    for (const item of reserved) found.push({ key: item.ticket_id, id: item.ticket_id, model: item.model || "" });
  }
  return found;
}

function copySample(mode: "standalone" | "openspec"): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `baton-sample-${mode}-`));
  fs.cpSync(path.join(samplesDir, mode), dest, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dest });
  execFileSync("git", ["config", "user.email", "compare@example.invalid"], { cwd: dest });
  execFileSync("git", ["config", "user.name", "Compare"], { cwd: dest });
  execFileSync("git", ["add", "."], { cwd: dest });
  execFileSync("git", ["commit", "-q", "-m", `baseline ${mode}`], { cwd: dest });
  return dest;
}

async function finishOne(
  workspace: string,
  env: NodeJS.ProcessEnv,
  host: string,
  item: { key: string; id: string; model: string },
  answers: Record<string, string>,
): Promise<SampleComparison["tasks"][number]> {
  const bound = await baton(
    ["dispatch", "bind", item.id, "--agent-id", `compare-${item.id}`, "--host", host, "--json"],
    workspace,
    env,
  );
  const started = performance.now();
  const fresh = auditWorkspace(workspace);
  const conclusion = fresh[item.key] || answers[item.key] || `${item.key} done`;
  const executeMs = round(performance.now() - started);
  const finished = await baton(
    ["dispatch", "complete", item.id, "--text", conclusion, "--release", "--json"],
    workspace,
    env,
  );
  const wrapper = round(bound.ms + finished.ms);
  return {
    key: item.key,
    without_ms: null,
    command_ms: executeMs,
    wrapper_ms: wrapper,
    baton: {
      elapsed_ms: round(wrapper + executeMs),
      exit: 0,
      stdout: conclusion,
      bind_cli_ms: bound.ms,
      execute_ms: executeMs,
      complete_cli_ms: finished.ms,
      ticket_id: item.id,
      model: item.model,
    },
  };
}

async function enqueueTickets(
  mode: "standalone" | "openspec",
  workspace: string,
  env: NodeJS.ProcessEnv,
  host: string,
  units: typeof STANDALONE_UNITS | typeof OPENSPEC_UNITS,
  request: string,
): Promise<{ items: Array<{ key: string; id: string; model: string }>; spawn_cli_ms: number; dispatch_cli_ms: number }> {
  if (mode === "openspec") {
    const applied = await baton(["apply", "--json"], workspace, env);
    let items = ticketIds(applied.payload);
    const reserved = await baton(
      ["dispatch", "next", "--host", host, "--capacity", String(Math.max(items.length, units.length, 1)), "--json"],
      workspace,
      env,
    );
    if (!items.length) items = ticketIds(reserved.payload);
    return { items, spawn_cli_ms: applied.ms, dispatch_cli_ms: reserved.ms };
  }
  const spawned = await baton([
    "spawn", request,
    ...units.flatMap((unit) => ["--unit", `${unit.key}=${unit.phrase}`]),
    "--dispatch", "--json",
    "--host", host,
    "--capacity", String(units.length),
  ], workspace, env);
  return { items: ticketIds(spawned.payload), spawn_cli_ms: spawned.ms, dispatch_cli_ms: 0 };
}

export async function compareSample(mode: "standalone" | "openspec"): Promise<SampleComparison> {
  const env = process.env;
  const sequentialWorkspace = copySample(mode);
  const cfg = loadConfig(sequentialWorkspace, { env });
  const host = cfg.cli.active;
  const units = mode === "openspec" ? OPENSPEC_UNITS : STANDALONE_UNITS;
  const request = fs.readFileSync(path.join(sequentialWorkspace, "REQUEST.txt"), "utf8").trim();

  const directStarted = performance.now();
  const answers = auditWorkspace(sequentialWorkspace);
  const withoutMs = round(performance.now() - directStarted);

  const sequentialQueued = await enqueueTickets(mode, sequentialWorkspace, env, host, units, request);
  if (sequentialQueued.items.length !== units.length) {
    throw new Error(`${mode}: expected ${units.length} tickets, got ${sequentialQueued.items.length}: ${sequentialQueued.items.map((item) => item.key).join(",")}`);
  }
  const sequentialStarted = performance.now();
  for (const item of sequentialQueued.items) await finishOne(sequentialWorkspace, env, host, item, answers);
  const sequentialWall = round(performance.now() - sequentialStarted);

  const parallelWorkspace = copySample(mode);
  const parallelQueued = await enqueueTickets(mode, parallelWorkspace, env, host, units, request);
  const parallelStarted = performance.now();
  const tasks = await Promise.all(parallelQueued.items.map((item) => finishOne(parallelWorkspace, env, host, item, answers)));
  const parallelWall = round(performance.now() - parallelStarted);
  const wrapperMs = round(parallelQueued.spawn_cli_ms + parallelQueued.dispatch_cli_ms + Math.max(...tasks.map((task) => task.wrapper_ms)));
  const withMs = round(parallelQueued.spawn_cli_ms + parallelQueued.dispatch_cli_ms + parallelWall);
  return {
    sample: mode,
    without_ms: withoutMs,
    spawn_cli_ms: parallelQueued.spawn_cli_ms,
    dispatch_cli_ms: parallelQueued.dispatch_cli_ms,
    sequential_wall_ms: round(sequentialQueued.spawn_cli_ms + sequentialQueued.dispatch_cli_ms + sequentialWall),
    parallel_wall_ms: withMs,
    tasks,
    with_ms: withMs,
    wrapper_ms: wrapperMs,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}

export function formatSampleReport(rows: SampleComparison[]): string {
  const lines = [
    "sample incident-audit benchmark (five independent tickets; no host model spawn; milliseconds)",
    "sequential = finish tickets one by one. parallel = finish all reserved tickets together.",
    "",
    pad("sample", 14) + pad("without (ms)", 14) + pad("sequential (ms)", 18) + pad("parallel (ms)", 16) + "tickets",
  ];
  for (const row of rows) {
    lines.push(
      pad(row.sample, 14)
      + pad(String(row.without_ms), 14)
      + pad(String(row.sequential_wall_ms), 18)
      + pad(String(row.parallel_wall_ms), 16)
      + String(row.tasks.length),
    );
  }
  lines.push(
    "",
    pad("sample", 14) + pad("task", 8) + pad("bind (ms)", 12) + pad("complete (ms)", 14) + pad("wrapper (ms)", 14) + "model",
  );
  for (const row of rows) {
    for (const task of row.tasks) {
      lines.push(
        pad(row.sample, 14)
        + pad(task.key, 8)
        + pad(String(task.baton.bind_cli_ms), 12)
        + pad(String(task.baton.complete_cli_ms), 14)
        + pad(String(task.wrapper_ms), 14)
        + (task.baton.model || "-"),
      );
    }
    lines.push(
      pad(row.sample, 14)
      + pad("spawn", 8)
      + pad("-", 12)
      + pad("-", 14)
      + pad(String(row.spawn_cli_ms + row.dispatch_cli_ms), 14)
      + `open+reserve ${row.tasks.length} tickets`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  const json = process.argv.includes("--json");
  const rows = [await compareSample("standalone"), await compareSample("openspec")];
  if (json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else process.stdout.write(formatSampleReport(rows));
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
