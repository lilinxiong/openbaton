import { initProject } from "./commands/init.js";
import { updateProject } from "./commands/update.js";
import { listCards, addCard } from "./commands/cards.js";
import { runLogin } from "./commands/login.js";
import { loadConfig } from "./lib/config.js";
import { matchModelCard, CardMatchError } from "./lib/cards.js";
import { planStandaloneSpawn, listSpawns, writeSpawn } from "./lib/spawn.js";
import { applyChange, concludeSpawn } from "./lib/apply.js";
import { detectOpenSpecRoot, readOpenSpecStatus } from "./lib/openspec.js";
import { DispatchQueue } from "./lib/queue.js";

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
  baton cards add --id ID --strengths "..."
  baton match <text>                show which card would run
  baton spawn <text> [--model ID]   card-route a standalone unit
  baton apply [change]              execute an OpenSpec change (consume, do not invent)
  baton conclude <id> --text "..."  write a short conclusion (hygiene)
  baton login                       list accounts + card->provider
  baton login <provider>            sign in with a browser (kimi, xai, cursor)
  baton login --card <id>           resolve card then login
  baton status                      director queue + OpenSpec status if present
  baton help | --help | -h
  baton version | --version | -v
`;

export async function run(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, env = process.env, runner, resolve } = {}) {
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
        return cmdInit(args, cwd, stdout, env);
      case "update":
        return cmdUpdate(cwd, stdout, env);
      case "cards":
        return cmdCards(args, cwd, stdout, env);
      case "match":
        return cmdMatch(args, cwd, stdout, env);
      case "spawn":
        return cmdSpawn(args, cwd, stdout, env);
      case "apply":
        return cmdApply(args, cwd, stdout, env);
      case "conclude":
        return cmdConclude(args, cwd, stdout);
      case "login":
        return runLogin(args, { cwd, stdout, stderr, env, runner, resolve });
      case "status":
        return cmdStatus(cwd, stdout, env);
      default:
        stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return err.code === "BATON_NOT_INITIALIZED" ? 2 : 1;
  }
}

function cmdInit(args, cwd, stdout, env) {
  const flags = parseFlags(args);
  const force = Boolean(flags.force) || args.includes("--force");
  const tools = flags.tools ? String(flags.tools).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const result = initProject(cwd, { force, tools, env });
  stdout.write(`initialized ${result.dir}\n`);
  for (const f of result.created) stdout.write(`  wrote ${f}\n`);
  for (const f of result.skipped) stdout.write(`  kept  ${f} (use --force to replace)\n`);
  stdout.write("\nNext: add real model cards, then `baton spawn` or `baton apply`.\n");
  stdout.write("OpenSpec is optional. baton is complete without it.\n");
  return 0;
}

function cmdUpdate(cwd, stdout, env) {
  const result = updateProject(cwd, { env });
  stdout.write("updated baton project files\n");
  for (const a of result.actions) stdout.write(`  ${a}\n`);
  return 0;
}

function cmdCards(args, cwd, stdout, env) {
  const sub = args[0];
  if (sub === "add") {
    const flags = parseFlags(args.slice(1));
    const models = addCard(cwd, { id: flags.id, strengths: flags.strengths, env });
    stdout.write(`cards: ${models.length}\n`);
    for (const m of models) stdout.write(`  ${m.id} — ${m.strengths}\n`);
    return 0;
  }
  const models = listCards(cwd, { env });
  if (models.length === 0) {
    stdout.write("no cards. Add some: baton cards add --id NAME --strengths \"...\"\n");
    return 0;
  }
  stdout.write(`cards: ${models.length}\n`);
  for (const m of models) stdout.write(`  ${m.id} — ${m.strengths}\n`);
  return 0;
}

function cmdMatch(args, cwd, stdout, env) {
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

function cmdSpawn(args, cwd, stdout, env) {
  const flags = parseFlags(args);
  const text = positionalText(args);
  if (!text) throw new Error("usage: baton spawn <text> [--model ID]");
  const cfg = loadConfig(cwd, { env });
  const queue = DispatchQueue.fromConfig(cfg);
  // account for already-running tickets
  for (const s of listSpawns(cwd)) {
    if (s.status === "running") queue.noteStarted();
    else if (s.status === "queued") queue.noteEnqueued();
  }
  const planned = planStandaloneSpawn({
    description: text,
    cards: cfg.models,
    explicitModel: flags.model,
    queue,
    cwd,
  });
  if (planned.director_local) {
    stdout.write(`director-local: ${planned.reason}\n`);
    stdout.write(`unit: ${planned.description}\n`);
    return 0;
  }
  writeSpawn(cwd, planned.ticket);
  const t = planned.ticket;
  stdout.write(`spawn ${t.id}\n`);
  stdout.write(`  model:  ${t.model_id}\n`);
  stdout.write(`  queue:  ${t.queue} (${t.status})\n`);
  stdout.write(`  source: ${t.source}\n`);
  stdout.write("parent gets only the conclusion — run: baton conclude " + t.id + " --text \"...\"\n");
  return 0;
}

function cmdApply(args, cwd, stdout, env) {
  const change = args.find((a) => !a.startsWith("-")) || null;
  const cfg = loadConfig(cwd, { env });
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

function cmdConclude(args, cwd, stdout) {
  const flags = parseFlags(args);
  const id = args.find((a) => !a.startsWith("-") && a !== flags.text);
  if (!id || !flags.text) throw new Error("usage: baton conclude <id> --text \"...\"");
  const result = concludeSpawn(cwd, id, flags.text);
  stdout.write(`concluded ${result.ticket.id}\n`);
  stdout.write(`  ${result.ticket.conclusion}\n`);
  if (result.openspecWritten) {
    stdout.write("  wrote conclusion back into OpenSpec tasks.md\n");
  }
  return 0;
}

function cmdStatus(cwd, stdout, env) {
  let cfg = null;
  try {
    cfg = loadConfig(cwd, { env });
  } catch (err) {
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
  const done = spawns.filter((s) => s.status === "done").length;
  stdout.write(`  spawns: ${spawns.length}  running ${running}  queued ${queued}  done ${done}\n`);
  for (const s of spawns) {
    const extra = s.conclusion ? ` → ${s.conclusion}` : "";
    stdout.write(`    ${s.id}  ${s.status}  ${s.model_id || "director"}  ${s.description}${extra}\n`);
  }
  const os = readOpenSpecStatus(cwd);
  stdout.write(`  openspec (${os.source}): ${os.text}\n`);
  return 0;
}

function parseFlags(args) {
  const flags = {};
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

function positionalText(args) {
  const parts = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    parts.push(args[i]);
  }
  return parts.join(" ").trim();
}
