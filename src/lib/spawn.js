import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnsDir } from "./paths.js";
import { matchModelCard, requireCardId } from "./cards.js";
import { directorMayRun } from "./hygiene.js";

export function listSpawns(cwd) {
  const dir = spawnsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function readSpawn(cwd, id) {
  const file = path.join(spawnsDir(cwd), `${id}.json`);
  if (!fs.existsSync(file)) {
    const err = new Error(`spawn not found: ${id}`);
    err.code = "SPAWN_NOT_FOUND";
    throw err;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeSpawn(cwd, ticket) {
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

export function nextSpawnId(cwd, prefix = "spn") {
  const existing = listSpawns(cwd);
  let max = 0;
  for (const s of existing) {
    const m = String(s.id).match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
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
}) {
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
export function planStandaloneSpawn({ description, cards, explicitModel, queue, cwd }) {
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
