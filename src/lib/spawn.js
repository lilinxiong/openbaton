import fs from "node:fs";
import path from "node:path";
import { spawnsDir } from "./paths.js";
import { matchModelCard, requireCardId } from "./cards.js";
import { DispatchQueue, START } from "./queue.js";
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
  fs.writeFileSync(file, JSON.stringify(ticket, null, 2) + "\n", "utf8");
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
  decision,
  source = "standalone",
  openspec = null,
}) {
  return {
    id,
    description,
    prompt,
    model_id: modelId,
    source,
    openspec,
    queue: decision,
    status: decision === START ? "running" : "queued",
    conclusion: null,
    created_at: new Date().toISOString(),
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
  const modelId = explicitModel
    ? requireCardId(explicitModel, cards).id
    : matchModelCard(description, cards).model_id;
  const q = queue || new DispatchQueue(4);
  const decision = q.admit();
  if (decision === START) q.noteStarted();
  else q.noteEnqueued();
  const id = nextSpawnId(cwd);
  const ticket = buildSpawnTicket({
    id,
    description,
    prompt: description,
    modelId,
    decision,
    source: "standalone",
  });
  return { director_local: false, ticket, queue: q.snapshot() };
}
