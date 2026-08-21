/**
 * Apply = multi-model, uncapped, card-routed execution of OpenSpec tasks.
 * OpenSpec owns the task list and status. baton owns who runs each unit.
 */
import fs from "node:fs";
import path from "node:path";
import { matchModelCard } from "./cards.js";
import { directorMayRun, sanitizeConclusion } from "./hygiene.js";
import {
  OpenSpecChange,
  OpenSpecConclusion,
  OpenSpecTask,
  loadTasksFromChangeDir,
  resolveChangeDir,
  listChangeNames,
  writeTaskConclusion,
  writeTaskConclusionByNumber,
  OpenSpecError,
} from "./openspec.js";
import { buildSpawnTicket, nextSpawnId, writeSpawn, readSpawn } from "./spawn.js";
import { buildReadOnlyReceipt, writeReceipt } from "./receipt.js";
import { runsDir } from "./paths.js";
import type { SpawnTicket } from "./spawn.js";
import type { ModelCard, ModelSelectionApproval } from "../types.js";

export type ApplyModelCard = ModelCard;

export interface ApplyConfig {
  director: {
    max_concurrent: number;
  };
}

interface ApplyUnitBase {
  id: string;
  description: string;
  prompt: string;
  line_index: number;
  section: string;
}

export type ApplyUnit =
  | (ApplyUnitBase & {
      model_id: null;
      route_id?: null;
      reasoning_effort?: null;
      provider?: null;
      director_local: true;
    })
  | (ApplyUnitBase & {
      model_id: string;
      route_id?: string | null;
      reasoning_effort?: string | null;
      provider?: string | null;
      director_local: false;
    });

export interface BlockedApplyTask {
  id: string;
  description: string;
  error: string;
  code: string | undefined;
}

export interface ApplyQueue {
  max_concurrent: number;
  running: number;
  queued: number;
}

export interface ApplyRun {
  id: string;
  change_dir: string;
  tasks_path: string;
  tickets: string[];
  director_local: ApplyUnit[];
  blocked: BlockedApplyTask[];
  queue: ApplyQueue;
}

export interface OpenSpecTicketBinding {
  change_dir?: string;
  tasks_path?: string;
  line_index?: number;
  number?: string;
  section?: string;
}

export type OpenSpecTicket = SpawnTicket;

export interface ApplyResult {
  changeDir: string;
  tasksPath: string;
  units: ApplyUnit[];
  blocked: BlockedApplyTask[];
  tickets: OpenSpecTicket[];
  local: ApplyUnit[];
  queue: ApplyQueue | null;
  error?: string;
  run?: ApplyRun;
}

export interface ConcludeSpawnResult {
  ticket: OpenSpecTicket;
  openspecWritten: boolean;
}

export type ApplyErrorCode = "HYGIENE" | "LIFECYCLE_REQUIRED";

export class ApplyError extends Error {
  readonly code: ApplyErrorCode;

  constructor(message: string, code: ApplyErrorCode) {
    super(message);
    this.name = "ApplyError";
    this.code = code;
  }
}

interface PlanApplyInput {
  tasks: OpenSpecTask[];
  cards: ApplyModelCard[];
  includeTask?: (task: OpenSpecTask) => boolean;
  selectCard?: (task: OpenSpecTask, cards: ApplyModelCard[]) => ApplyModelCard | undefined;
  selectCards?: (prompt: string, cards: ApplyModelCard[]) => ApplyModelCard[];
}

interface PlanApplyResult {
  units: ApplyUnit[];
  blocked: BlockedApplyTask[];
}

interface ApplyChangeInput {
  cwd: string;
  change?: string | null;
  cfg: ApplyConfig;
  cards: ApplyModelCard[];
  includeTask?: (task: OpenSpecTask) => boolean;
  selectCard?: (task: OpenSpecTask, cards: ApplyModelCard[]) => ApplyModelCard | undefined;
  selectCards?: (prompt: string, cards: ApplyModelCard[]) => ApplyModelCard[];
  selectionApprovals?: Map<string, ModelSelectionApproval>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function openSpecWriteback(value: unknown): OpenSpecTicketBinding | null {
  if (!isRecord(value)) return null;
  const tasksPath = value.tasks_path;
  const lineIndex = value.line_index;
  const number = value.number;
  if (typeof tasksPath !== "string") return null;
  if (typeof number === "string" && number) return { tasks_path: tasksPath, number, line_index: typeof lineIndex === "number" ? lineIndex : undefined };
  if (typeof lineIndex !== "number" || !Number.isInteger(lineIndex)) return null;
  return { tasks_path: tasksPath, line_index: lineIndex };
}

export function resolveApplyChange(cwd: string, change?: string | null): string {
  if (change) {
    const changeDir = resolveChangeDir(cwd, change);
    if (changeDir) return changeDir;
  }
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

export function planApply({ tasks, cards, includeTask, selectCard, selectCards }: PlanApplyInput): PlanApplyResult {
  const units: ApplyUnit[] = [];
  const blocked: BlockedApplyTask[] = [];
  for (const task of tasks) {
    if (task.status !== "pending") continue;
    if (includeTask && !includeTask(task)) continue;
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
      const explicit = selectCard?.(task, cards);
      const matched = explicit
        ? { model_id: explicit.id, card: explicit }
        : matchModelCard(prompt, selectCards ? selectCards(prompt, cards) : cards);
      units.push({
        id: task.number || `line-${task.line_index}`,
        description: task.description,
        prompt,
        model_id: matched.model_id,
        route_id: matched.card.route_id || null,
        reasoning_effort: matched.card.reasoning_effort || null,
        provider: matched.card.provider || null,
        director_local: false,
        line_index: task.line_index,
        section: task.section,
      });
    } catch (err) {
      blocked.push({
        id: task.number || `line-${task.line_index}`,
        description: task.description,
        error: errorMessage(err),
        code: errorCode(err),
      });
    }
  }
  return { units, blocked };
}

export function formatTaskPrompt(task: OpenSpecTask): string {
  const num = task.number ? ` ${task.number}` : "";
  const section = task.section ? ` in section "${task.section}"` : "";
  return `OpenSpec task${num}${section}: ${task.description}`;
}

export function applyChange({ cwd, change, cfg, cards, includeTask, selectCard, selectCards, selectionApprovals = new Map() }: ApplyChangeInput): ApplyResult {
  const changeDir = resolveApplyChange(cwd, change);
  const changeData: OpenSpecChange = loadTasksFromChangeDir(changeDir);
  const { tasksPath, tasks } = changeData;
  const { units, blocked } = planApply({ tasks, cards, includeTask, selectCard, selectCards });
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

  const tickets: OpenSpecTicket[] = [];
  const local: ApplyUnit[] = [];
  for (const unit of units) {
    if (unit.director_local) {
      local.push(unit);
      continue;
    }
    const id = nextSpawnId(cwd, "os");
    const ticket: OpenSpecTicket = buildSpawnTicket({
      id,
      description: unit.description,
      prompt: unit.prompt,
      modelId: unit.model_id,
      routeId: unit.route_id,
      reasoningEffort: unit.reasoning_effort,
      source: "openspec",
      openspec: {
        change_dir: changeDir,
        tasks_path: tasksPath,
        line_index: unit.line_index,
        number: unit.id,
        section: unit.section,
      },
      selection: selectionApprovals.get(unit.id) || null,
    });
    const receipt = buildReadOnlyReceipt({
      ticketId: id,
      card: {
        id: unit.model_id,
        strengths: "",
        route_id: unit.route_id || undefined,
        reasoning_effort: unit.reasoning_effort || undefined,
        provider: unit.provider || undefined,
      },
      issuedAt: ticket.created_at,
      maxAttempts: ticket.max_attempts,
      selection: selectionApprovals.get(unit.id) || null,
    });
    ticket.receipt_id = receipt.receipt_id;
    writeReceipt(cwd, receipt);
    writeSpawn(cwd, ticket);
    tickets.push(ticket);
  }

  const run: ApplyRun = {
    id: `run-${Date.now()}`,
    change_dir: changeDir,
    tasks_path: tasksPath,
    tickets: tickets.map((t) => t.id),
    director_local: local,
    blocked,
    queue: { max_concurrent: cfg.director.max_concurrent, running: 0, queued: tickets.length },
  };
  fs.mkdirSync(runsDir(cwd), { recursive: true });
  fs.writeFileSync(
    path.join(runsDir(cwd), `${run.id}.json`),
    JSON.stringify(run, null, 2) + "\n",
  );

  return { changeDir, tasksPath, units, blocked, tickets, local, queue: run.queue, run };
}

export function concludeSpawn(cwd: string, id: string, text: OpenSpecConclusion): ConcludeSpawnResult {
  const clean = sanitizeConclusion(text);
  if (clean.ok === false) {
    throw new ApplyError(String(clean.error), "HYGIENE");
  }
  const ticket: OpenSpecTicket = readSpawn(cwd, id);
  if (Number(ticket.schema_version || 1) >= 2) {
    throw new ApplyError(
      "schema v2+ tickets require a bound host agent; use the dispatch lifecycle after the host agent completes",
      "LIFECYCLE_REQUIRED",
    );
  }
  ticket.status = "done";
  ticket.conclusion = clean.conclusion;
  ticket.finished_at = new Date().toISOString();
  writeSpawn(cwd, ticket);

  let openspecWritten = false;
  const writeback = openSpecWriteback(ticket.openspec);
  if (writeback) {
    const tasksPath = writeback.tasks_path;
    if (fs.existsSync(tasksPath)) {
      const current = fs.readFileSync(tasksPath, "utf8");
      const updated = writeback.number
        ? writeTaskConclusionByNumber(current, writeback.number, clean.conclusion)
        : writeTaskConclusion(current, writeback.line_index!, clean.conclusion);
      if (updated) {
        fs.writeFileSync(tasksPath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
        openspecWritten = true;
      }
    }
  }
  return { ticket, openspecWritten };
}
