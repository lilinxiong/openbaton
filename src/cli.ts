import { initProject } from "./commands/init.js";
import { updateProject } from "./commands/update.js";
import { listCards, addCard } from "./commands/cards.js";
import { runLogin } from "./commands/login.js";
import { runCapabilities } from "./commands/capabilities.js";
import { runDispatch } from "./commands/dispatch.js";
import { runRoutes } from "./commands/routes.js";
import { loadConfig } from "./lib/config.js";
import { matchModelCard, CardMatchError } from "./lib/cards.js";
import { planStandaloneSpawn, listSpawns, writeSpawn } from "./lib/spawn.js";
import { applyChange, concludeSpawn } from "./lib/apply.js";
import { detectOpenSpecRoot, readOpenSpecStatus } from "./lib/openspec.js";
import { DispatchQueue } from "./lib/queue.js";
import { ensureFreshKimiAccount } from "./lib/kimi-account.js";
import { buildWriteReceipt, writeReceipt } from "./lib/receipt.js";
import { captureBaseline, type SafetyOperation } from "./lib/safety.js";
import type { OcxResolver, OcxRunner } from "./lib/opencodex.js";
import type { CodedError, WritableLike } from "./types.js";

interface RunOptions {
  cwd?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  env?: NodeJS.ProcessEnv;
  runner?: OcxRunner;
  resolve?: OcxResolver;
  fetchImpl?: typeof fetch;
}

type FlagMap = Record<string, string | boolean>;

export const VERSION = "0.1.0";

const HELP = `baton — director for multi-model work
既能独立，又能 1+1>2

Standalone: cards + native spawn + director context hygiene. Complete without OpenSpec.
Together: OpenSpec owns breakdown/status; baton owns who runs each task and keeps
the director context clean. Apply is multi-model, uncapped, card-routed execution
of OpenSpec tasks, with conclusions written back. Not a thin adapter.

Usage:
  baton init [--force] [--tools a,b]  initialize .baton/ and host skill paths
  baton update                        refresh SKILL + director defaults; keep cards
  baton cards                       list model cards
  baton cards add --id ID --strengths "..." [--route MODEL] [--reasoning-effort EFFORT]
  baton match <text>                show which card would run
  baton spawn <text> [--model ID]   card-route a standalone unit
  baton apply [change]              execute an OpenSpec change (consume, do not invent)
  baton conclude <id> --text "..."  write a short conclusion (hygiene)
  baton login                       list accounts + card->provider
  baton login <provider>            sign in with a browser (kimi, xai, cursor)
  baton login --card <id>           resolve card then login
  baton capabilities refresh --provider aa --key-file PATH
  baton capabilities status
  baton capabilities show ROUTE [--profile PROFILE]
  baton dispatch next --host codex --capacity N --json
  baton dispatch bind TICKET --agent-id ID --host codex --json
  baton dispatch complete TICKET --text "short conclusion" --json
  baton dispatch fail|timeout|close TICKET --json
  baton dispatch recover|status --json
  baton status                      director queue + OpenSpec status if present
  baton help | --help | -h
  baton version | --version | -v
`;

export async function run(argv: string[], { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, env = process.env, runner, resolve, fetchImpl }: RunOptions = {}): Promise<number> {
  const args = argv.slice();
  const cmd = args.shift() || "help";

  try {
    switch (cmd) {
      case "help":
      case "--help":
      case "-h":
        stdout.write(HELP);
        return 0;
      case "version":
      case "--version":
      case "-v":
        stdout.write(`baton ${VERSION}\n`);
        return 0;
      case "init":
        return await cmdInit(args, cwd, stdout, env);
      case "update":
        return cmdUpdate(cwd, stdout, env);
      case "cards":
        return cmdCards(args, cwd, stdout, env);
      case "match":
        return cmdMatch(args, cwd, stdout, env);
      case "spawn":
        return await cmdSpawn(args, cwd, stdout, env);
      case "apply":
        return await cmdApply(args, cwd, stdout, env);
      case "conclude":
        return cmdConclude(args, cwd, stdout);
      case "login":
        return await runLogin(args, { cwd, stdout, stderr, env, runner, resolve });
      case "capabilities":
        return await runCapabilities(args, { cwd, stdout, env, fetchImpl: fetchImpl || globalThis.fetch });
      case "dispatch":
        return runDispatch(args, { cwd, stdout, env });
      case "routes":
        return runRoutes(args, { cwd, stdout, env, runner, resolve });
      case "status":
        return cmdStatus(cwd, stdout, env);
      default:
        stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (cause: unknown) {
    const err = cause instanceof Error ? cause as CodedError : new Error(String(cause)) as CodedError;
    stderr.write(`${err.message}\n`);
    return err.code === "BATON_NOT_INITIALIZED" ? 2 : 1;
  }
}

async function cmdInit(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): Promise<number> {
  const flags = parseFlags(args);
  const force = Boolean(flags.force) || args.includes("--force");
  const tools = flags.tools ? String(flags.tools).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const result = await initProject(cwd, { force, tools, env });
  stdout.write(`initialized ${result.dir}\n`);
  for (const f of result.created) stdout.write(`  wrote ${f}\n`);
  for (const f of result.skipped) stdout.write(`  kept  ${f} (use --force to replace)\n`);
  stdout.write("\nNext: add real model cards, then `baton spawn` or `baton apply`.\n");
  stdout.write("OpenSpec is optional. baton is complete without it.\n");
  return 0;
}

function cmdUpdate(cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  const result = updateProject(cwd, { env });
  stdout.write("updated baton project files\n");
  for (const a of result.actions) stdout.write(`  ${a}\n`);
  return 0;
}

function cmdCards(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  const sub = args[0];
  if (sub === "add") {
    const flags = parseFlags(args.slice(1));
    const models = addCard(cwd, {
      id: stringFlag(flags, "id"),
      strengths: stringFlag(flags, "strengths"),
      routeId: stringFlag(flags, "route"),
      reasoningEffort: stringFlag(flags, "reasoning-effort"),
      env,
    });
    stdout.write(`cards: ${models.length}\n`);
    for (const m of models) stdout.write(`  ${m.id}${m.route_id ? ` → ${m.route_id}` : ""} — ${m.strengths}\n`);
    return 0;
  }
  const models = listCards(cwd, { env });
  if (models.length === 0) {
    stdout.write("no cards. Add some: baton cards add --id NAME --strengths \"...\"\n");
    return 0;
  }
  stdout.write(`cards: ${models.length}\n`);
  for (const m of models) stdout.write(`  ${m.id}${m.route_id ? ` → ${m.route_id}` : ""} — ${m.strengths}\n`);
  return 0;
}

function cmdMatch(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  const text = positionalText(args);
  if (!text) {
    throw new Error("usage: baton match <text>");
  }
  const cfg = loadConfig(cwd, { env });
  try {
    const hit = matchModelCard(text, cfg.models);
    stdout.write(`${hit.model_id}  (score ${hit.score})\n`);
    return 0;
  } catch (err) {
    if (err instanceof CardMatchError) {
      stdout.write(`blocked: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function cmdSpawn(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): Promise<number> {
  const flags = parseFlags(args);
  const text = positionalText(args);
  if (!text) throw new Error("usage: baton spawn <text> [--model ID]");
  const cfg = loadConfig(cwd, { env });
  await ensureFreshKimiAccount({ env, cwd });
  const queue = DispatchQueue.fromConfig(cfg);
  // account for already-running tickets
  for (const s of listSpawns(cwd)) {
    if (s.status === "running") queue.noteStarted();
    else if (s.status === "queued") queue.noteEnqueued();
  }
  const planned = planStandaloneSpawn({
    description: text,
    cards: cfg.models,
    explicitModel: stringFlag(flags, "model"),
    queue,
    cwd,
  });
  if (planned.director_local === true) {
    stdout.write(`director-local: ${planned.reason}\n`);
    stdout.write(`unit: ${planned.description}\n`);
    return 0;
  }
  const writePaths = (stringFlag(flags, "write-path") || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (writePaths.length) {
    const allowed = new Set<SafetyOperation>(["write", "create", "delete", "rename", "chmod"]);
    const operations = (stringFlag(flags, "write-ops") || "write,create").split(",").map((item) => item.trim()) as SafetyOperation[];
    if (!operations.length || operations.some((item) => !allowed.has(item))) throw new Error("--write-ops must contain write,create,delete,rename,chmod");
    planned.receipt = buildWriteReceipt({ base: planned.receipt, baseline: captureBaseline(cwd), writeAllowlist: writePaths, allowedOperations: operations });
    planned.ticket.mode = "write";
    planned.ticket.read_only = false;
  }
  writeReceipt(cwd, planned.receipt);
  writeSpawn(cwd, planned.ticket);
  const t = planned.ticket;
  stdout.write(`spawn ${t.id}\n`);
  stdout.write(`  model:  ${t.model_id}\n`);
  stdout.write(`  route:  ${t.route_id || "blocked until an executable route is configured"}\n`);
  stdout.write(`  queue:  ${t.status}\n`);
  stdout.write(`  mode:   ${t.mode}\n`);
  stdout.write(`  source: ${t.source}\n`);
  stdout.write("host director must reserve it with `baton dispatch next --json`; queued is not running.\n");
  return 0;
}

async function cmdApply(args: string[], cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): Promise<number> {
  const change = args.find((a) => !a.startsWith("-")) || null;
  const cfg = loadConfig(cwd, { env });
  await ensureFreshKimiAccount({ env, cwd });
  if (!detectOpenSpecRoot(cwd) && !change) {
    stdout.write("OpenSpec is not in this project. baton still works standalone:\n");
    stdout.write("  baton spawn \"explore the auth module\"\n");
    stdout.write("Create a change with OpenSpec when you want 1+1>2 apply.\n");
    return 2;
  }
  const result = applyChange({ cwd, change, cfg });
  stdout.write(`apply ${result.changeDir}\n`);
  if (result.error) {
    stdout.write(`blocked: ${result.error}\n`);
    for (const b of result.blocked) stdout.write(`  - ${b.id}: ${b.error}\n`);
    return 1;
  }
  stdout.write(`  tickets: ${result.tickets.length}  director-local: ${result.local.length}  blocked: ${result.blocked.length}\n`);
  if (result.queue) {
    stdout.write(`  queue: running ${result.queue.running} / max ${result.queue.max_concurrent}, queued ${result.queue.queued} (never refused)\n`);
  }
  for (const t of result.tickets) {
    stdout.write(`  ${t.id}  ${t.model_id}  ${t.status}  ${t.description}\n`);
  }
  for (const b of result.blocked) {
    stdout.write(`  blocked ${b.id}: ${b.error}\n`);
  }
  stdout.write("OpenSpec remains the status source of truth. Conclude with:\n");
  stdout.write("  baton conclude <id> --text \"short outcome\"\n");
  return result.blocked.length ? 1 : 0;
}

function cmdConclude(args: string[], cwd: string, stdout: WritableLike): number {
  const flags = parseFlags(args);
  const conclusion = stringFlag(flags, "text");
  const id = args.find((a) => !a.startsWith("-") && a !== conclusion);
  if (!id || !conclusion) throw new Error("usage: baton conclude <id> --text \"...\"");
  const result = concludeSpawn(cwd, id, conclusion);
  stdout.write(`concluded ${result.ticket.id}\n`);
  stdout.write(`  ${result.ticket.conclusion}\n`);
  if (result.openspecWritten) {
    stdout.write("  wrote conclusion back into OpenSpec tasks.md\n");
  }
  return 0;
}

function cmdStatus(cwd: string, stdout: WritableLike, env: NodeJS.ProcessEnv): number {
  let cfg = null;
  try {
    cfg = loadConfig(cwd, { env });
  } catch (cause: unknown) {
    const err = cause instanceof Error ? cause as CodedError : new Error(String(cause)) as CodedError;
    if (err.code === "BATON_NOT_INITIALIZED") {
      stdout.write("baton is not initialized. Run: baton init\n");
      return 2;
    }
    throw err;
  }
  stdout.write("baton status\n");
  stdout.write(`  cards: ${cfg.models.map((m) => m.id).join(", ") || "(none)"}\n`);
  stdout.write(`  max_concurrent: ${cfg.director.max_concurrent} (queue beyond this; never refuse)\n`);
  const spawns = listSpawns(cwd);
  const running = spawns.filter((s) => s.status === "running").length;
  const queued = spawns.filter((s) => s.status === "queued").length;
  const dispatching = spawns.filter((s) => s.status === "dispatching").length;
  const terminal = spawns.filter((s) => ["completed", "errored", "timed_out", "closed", "done"].includes(s.status)).length;
  stdout.write(`  spawns: ${spawns.length}  dispatching ${dispatching}  running ${running}  queued ${queued}  terminal ${terminal}\n`);
  for (const s of spawns) {
    const extra = s.conclusion ? ` → ${s.conclusion}` : "";
    const worker = s.agent_id ? ` agent=${s.agent_id}` : "";
    stdout.write(`    ${s.id}  ${s.status}  ${s.model_id || "director"}${worker}  ${s.description}${extra}\n`);
  }
  const os = readOpenSpecStatus(cwd);
  stdout.write(`  openspec (${os.source}): ${os.text}\n`);
  return 0;
}

function parseFlags(args: string[]): FlagMap {
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function stringFlag(flags: FlagMap, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function positionalText(args: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    parts.push(args[i]);
  }
  return parts.join(" ").trim();
}
