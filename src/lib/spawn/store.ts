/**
 * Ticket persistence and id generation. Split from spawn.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../json-utils.js";
import { spawnsDir } from "../paths.js";
import { sessionScope, validateSessionScope, type SessionScope } from "../session-scope.js";
import {
  SpawnTicket,
  assertSessionScope,
  sessionUidFromEnv
} from "../spawn.js";
import {
  isCurrentSpawnRecord,
  normalizeSpawnTicket
} from "./normalize.js";
import type { CodedError } from "../../types.js";

export function listSpawns(cwd: string, env?: NodeJS.ProcessEnv): SpawnTicket[] {
  const dir = spawnsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJsonFile(path.join(dir, f)) as unknown)
    .filter(isCurrentSpawnRecord)
    .map((value) => normalizeSpawnTicket(value))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function readSpawn(cwd: string, id: string, env?: NodeJS.ProcessEnv): SpawnTicket {
  const file = path.join(spawnsDir(cwd, env), `${id}.json`);
  if (!fs.existsSync(file)) {
    const err = new Error(`spawn not found: ${id}`) as CodedError;
    err.code = "SPAWN_NOT_FOUND";
    throw err;
  }
  const raw = readJsonFile(file) as unknown;
  if (!isCurrentSpawnRecord(raw)) {
    const err = new Error(`spawn is not a current-format ticket: ${id}`) as CodedError;
    err.code = "TICKET_FORMAT_UNSUPPORTED";
    throw err;
  }
  return normalizeSpawnTicket(raw);
}

export function writeSpawn(cwd: string, ticket: SpawnTicket, env?: NodeJS.ProcessEnv): SpawnTicket {
  ticket = normalizeSpawnTicket(ticket);
  if (!isCurrentSpawnRecord(ticket)) {
    throw new Error("spawn ticket must be current and include session identity");
  }
  // Persisting a lifecycle change is ticket-targeted: a later environment
  // value must not be able to rewrite another root tree's immutable identity.
  validateSpawnSessionScope(ticket, env);
  const dir = spawnsDir(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ticket.id}.json`);
  writeJsonAtomic(file, ticket);
  return ticket;
}

/** Validate the current caller before a ticket-targeted lifecycle mutation. */
export function validateSpawnSessionScope(ticket: Pick<SpawnTicket, "session_uid">, env?: NodeJS.ProcessEnv): SessionScope {
  return assertSessionScope(ticket.session_uid, env);
}

export function sessionUid(env?: NodeJS.ProcessEnv): string {
  return sessionUidFromEnv(env);
}

export function sessionTicketId(prefix: string, uid: string, ordinal: number): string {
  if (!/^(?:spn|os)$/.test(prefix) || !/^[0-9a-f]{64}$/.test(uid) || !Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error("invalid session ticket identity");
  }
  return `${prefix}-${uid}-${String(ordinal).padStart(4, "0")}`;
}

export function nextSpawnId(cwd: string, prefix = "spn", env?: NodeJS.ProcessEnv): string {
  if (!/^(?:spn|os)$/.test(prefix)) throw new Error("invalid session ticket prefix");
  const uid = sessionUid(env);
  let max = 0;
  const directory = spawnsDir(cwd, env);
  const names = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  for (const name of names) {
    // Reserve ordinals from filenames before parsing payloads. A corrupt or
    // future-format ticket must remain visible to identity allocation so a
    // later write can never overwrite its durable record.
    const m = name.match(/^(spn|os)-([0-9a-f]{64})-(\d+)\.json$/);
    if (!m || m[2] !== uid) continue;
    max = Math.max(max, Number(m[3]));
  }
  return sessionTicketId(prefix, uid, max + 1);
}

/** Reserve a deterministic contiguous id range before a multi-unit wave is persisted. */
export function nextSpawnIds(cwd: string, prefix = "spn", count = 1, env?: NodeJS.ProcessEnv): string[] {
  const first = nextSpawnId(cwd, prefix, env);
  const match = first.match(/^(.*-)(\d+)$/);
  if (!match) return Array.from({ length: count }, (_, index) => `${first}-${index + 1}`);
  const start = Number(match[2]);
  return Array.from({ length: count }, (_, index) => `${match[1]}${String(start + index).padStart(match[2].length, "0")}`);
}
