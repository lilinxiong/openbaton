import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnsDir } from "./paths.js";
import { matchModelCard, requireCardId } from "./cards.js";
import { directorMayRun } from "./hygiene.js";
import type { CodedError, ModelCard, UnknownRecord } from "../types.js";

export type TicketStatus = "queued" | "dispatching" | "running" | "completed" | "errored" | "timed_out" | "closed" | "done";

export interface TicketError {
  code: string;
  message: string;
}

export interface TicketHistoryEntry extends UnknownRecord {
  event: string;
  at: string;
}

export interface SpawnTicket extends UnknownRecord {
  schema_version: number;
  id: string;
  description: string;
  prompt: string;
  model_id: string;
  route_id: string | null;
  reasoning_effort: string | null;
  fork_context: false;
  mode: "read-only";
  read_only: true;
  source: string;
  openspec: UnknownRecord | null;
  queue: string;
  status: TicketStatus;
  attempt: number;
  max_attempts: number;
  agent_id: string | null;
  host: string | null;
  error: TicketError | null;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  history: TicketHistoryEntry[];
  dispatch_host?: string;
  dispatch_requested_at?: string;
  started_at?: string;
  finished_at?: string;
}

export function listSpawns(cwd: string): SpawnTicket[] {
  const dir = spawnsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SpawnTicket)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function readSpawn(cwd: string, id: string): SpawnTicket {
  const file = path.join(spawnsDir(cwd), `${id}.json`);
  if (!fs.existsSync(file)) {
    const err = new Error(`spawn not found: ${id}`) as CodedError;
    err.code = "SPAWN_NOT_FOUND";
    throw err;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as SpawnTicket;
}

export function writeSpawn(cwd: string, ticket: SpawnTicket): SpawnTicket {
  const dir = spawnsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ticket.id}.json`);
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(ticket, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return ticket;
}

export function nextSpawnId(cwd: string, prefix = "spn"): string {
  const existing = listSpawns(cwd);
  let max = 0;
  for (const s of existing) {
    const m = String(s.id).match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

interface BuildSpawnTicketOptions {
  id: string;
  description: string;
  prompt: string;
  modelId: string;
  routeId?: string | null;
  reasoningEffort?: string | null;
  source?: string;
  openspec?: UnknownRecord | null;
  now?: Date | string | number;
}

export function buildSpawnTicket({
  id,
  description,
  prompt,
  modelId,
  routeId = null,
  reasoningEffort = null,
  source = "standalone",
  openspec = null,
  now = new Date(),
}: BuildSpawnTicketOptions): SpawnTicket {
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    schema_version: 2,
    id,
    description,
    prompt,
    model_id: modelId,
    route_id: routeId,
    reasoning_effort: reasoningEffort,
    fork_context: false,
    mode: "read-only",
    read_only: true,
    source,
    openspec,
    queue: "enqueue",
    status: "queued",
    attempt: 0,
    max_attempts: 1,
    agent_id: null,
    host: null,
    error: null,
    conclusion: null,
    created_at: createdAt,
    updated_at: createdAt,
    history: [{ event: "ticket_queued", at: createdAt }],
  };
}

/**
 * Card-route one standalone unit. Queue instead of refusing.
 */
interface PlanStandaloneOptions {
  description: string;
  cards: ModelCard[];
  explicitModel?: string | null;
  queue?: unknown;
  cwd: string;
}

export type StandalonePlan =
  | { director_local: true; reason: string; description: string }
  | { director_local: false; ticket: SpawnTicket; queue: { running: number; queued: number } };

export function planStandaloneSpawn({ description, cards, explicitModel, queue, cwd }: PlanStandaloneOptions): StandalonePlan {
  if (directorMayRun(description)) {
    return {
      director_local: true,
      reason: "tiny unit; director can do it without polluting context",
      description,
    };
  }
  void queue;
  const card = explicitModel
    ? requireCardId(explicitModel, cards)
    : matchModelCard(description, cards).card;
  const id = nextSpawnId(cwd);
  const ticket = buildSpawnTicket({
    id,
    description,
    prompt: description,
    modelId: card.id,
    routeId: card.route_id || null,
    reasoningEffort: card.reasoning_effort || null,
    source: "standalone",
  });
  return { director_local: false, ticket, queue: { running: 0, queued: 1 } };
}
