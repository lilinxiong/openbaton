/**
 * Apply = multi-model, uncapped, card-routed execution of OpenSpec tasks.
 * OpenSpec owns the task list and status. baton owns who runs each unit.
 */
import fs from "node:fs";
import path from "node:path";
import { matchModelCard } from "./cards.js";
import { DispatchQueue, START } from "./queue.js";
import { directorMayRun, sanitizeConclusion } from "./hygiene.js";
import {
  loadTasksFromChangeDir,
  resolveChangeDir,
  listChangeNames,
  writeTaskConclusion,
  OpenSpecError,
} from "./openspec.js";
import { buildSpawnTicket, nextSpawnId, writeSpawn, readSpawn } from "./spawn.js";
import { runsDir } from "./paths.js";

export function resolveApplyChange(cwd, change) {
  if (change) return resolveChangeDir(cwd, change);
  const names = listChangeNames(cwd);
  if (names.length === 1) return resolveChangeDir(cwd, names[0]);
  if (names.length === 0) {
    throw new OpenSpecError(
      "no OpenSpec change found. baton will not invent a breakdown. Use `baton spawn` for standalone units, or create a change with OpenSpec.",
      "NO_CHANGE",
    );
  }
  throw new OpenSpecError(
    `multiple OpenSpec changes: ${names.join(", ")}. Pass one: baton apply <change>`,
    "AMBIGUOUS_CHANGE",
  );
}

export function planApply({ tasks, cards }) {
  const units = [];
  const blocked = [];
  for (const task of tasks) {
    if (task.status !== "pending") continue;
    const prompt = formatTaskPrompt(task);
    if (directorMayRun(task.description)) {
      units.push({
        id: task.number || `line-${task.line_index}`,
        description: task.description,
        prompt,
        model_id: null,
        director_local: true,
        line_index: task.line_index,
        section: task.section,
      });
      continue;
    }
    try {
      const matched = matchModelCard(prompt, cards);
      units.push({
        id: task.number || `line-${task.line_index}`,
        description: task.description,
        prompt,
        model_id: matched.model_id,
        director_local: false,
        line_index: task.line_index,
        section: task.section,
      });
    } catch (err) {
      blocked.push({
        id: task.number || `line-${task.line_index}`,
        description: task.description,
        error: err.message,
        code: err.code,
      });
    }
  }
  return { units, blocked };
}

function formatTaskPrompt(task) {
  const num = task.number ? ` ${task.number}` : "";
  const section = task.section ? ` in section "${task.section}"` : "";
  return `OpenSpec task${num}${section}: ${task.description}`;
}

export function applyChange({ cwd, change, cfg }) {
  const changeDir = resolveApplyChange(cwd, change);
  const { tasksPath, tasks } = loadTasksFromChangeDir(changeDir);
  const { units, blocked } = planApply({ tasks, cards: cfg.models });
  if (blocked.length && units.length === 0) {
    return {
      changeDir,
      tasksPath,
      units: [],
      blocked,
      tickets: [],
      local: [],
      queue: null,
      error: "every pending task is blocked on card match. No default model will be used.",
    };
  }

  const queue = DispatchQueue.fromConfig(cfg);
  const tickets = [];
  const local = [];
  for (const unit of units) {
    if (unit.director_local) {
      local.push(unit);
      continue;
    }
    const decision = queue.admit();
    if (decision === START) queue.noteStarted();
    else queue.noteEnqueued();
    const id = nextSpawnId(cwd, "os");
    const ticket = buildSpawnTicket({
      id,
      description: unit.description,
      prompt: unit.prompt,
      modelId: unit.model_id,
      decision,
      source: "openspec",
      openspec: {
        change_dir: changeDir,
        tasks_path: tasksPath,
        line_index: unit.line_index,
        number: unit.id,
        section: unit.section,
      },
    });
    writeSpawn(cwd, ticket);
    tickets.push(ticket);
  }

  const run = {
    id: `run-${Date.now()}`,
    change_dir: changeDir,
    tasks_path: tasksPath,
    tickets: tickets.map((t) => t.id),
    director_local: local,
    blocked,
    queue: queue.snapshot(),
  };
  fs.mkdirSync(runsDir(cwd), { recursive: true });
  fs.writeFileSync(
    path.join(runsDir(cwd), `${run.id}.json`),
    JSON.stringify(run, null, 2) + "\n",
  );

  return { changeDir, tasksPath, units, blocked, tickets, local, queue: queue.snapshot(), run };
}

export function concludeSpawn(cwd, id, text) {
  const clean = sanitizeConclusion(text);
  if (!clean.ok) {
    const err = new Error(clean.error);
    err.code = "HYGIENE";
    throw err;
  }
  const ticket = readSpawn(cwd, id);
  ticket.status = "done";
  ticket.conclusion = clean.conclusion;
  ticket.finished_at = new Date().toISOString();
  writeSpawn(cwd, ticket);

  let openspecWritten = false;
  if (ticket.openspec?.tasks_path && Number.isInteger(ticket.openspec.line_index)) {
    const tasksPath = ticket.openspec.tasks_path;
    if (fs.existsSync(tasksPath)) {
      const current = fs.readFileSync(tasksPath, "utf8");
      const updated = writeTaskConclusion(current, ticket.openspec.line_index, clean.conclusion);
      if (updated) {
        fs.writeFileSync(tasksPath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
        openspecWritten = true;
      }
    }
  }
  return { ticket, openspecWritten };
}
