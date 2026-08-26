import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyTask } from "./cards.js";
import { routeHealthPath } from "./paths.js";
import type { ModelCard } from "../types.js";

export const DEFAULT_ROUTE_HEALTH_COOLDOWN_MS = 15 * 60 * 1000;

export interface RouteHealthRecord {
  route_id: string;
  profile: string;
  host: string;
  task_shape: string;
  status: "healthy" | "degraded";
  terminal_status: "completed" | "errored" | "timed_out" | "closed";
  failure_kind: string | null;
  error_code: string | null;
  message: string | null;
  updated_at: string;
  cooldown_until: string | null;
}

export interface RouteHealthStore {
  schema_version: 1;
  records: RouteHealthRecord[];
}

interface RecordRouteHealthOptions {
  routeId: string;
  profile?: string | null;
  host?: string | null;
  taskText?: string;
  terminalStatus: RouteHealthRecord["terminal_status"];
  errorCode?: string | null;
  message?: string | null;
  now?: Date;
  cooldownMs?: number;
  env?: NodeJS.ProcessEnv;
}

function emptyStore(): RouteHealthStore {
  return { schema_version: 1, records: [] };
}

export function taskShape(text: unknown): string {
  const dimensions = classifyTask(text);
  const active = Object.entries(dimensions)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([key]) => key);
  return active.length ? active.join("+") : "general";
}

export function readRouteHealth(cwd: string, env?: NodeJS.ProcessEnv): RouteHealthStore {
  const file = routeHealthPath(cwd, env);
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RouteHealthStore>;
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.records)) return emptyStore();
    return { schema_version: 1, records: parsed.records as RouteHealthRecord[] };
  } catch {
    return emptyStore();
  }
}

function writeRouteHealth(cwd: string, store: RouteHealthStore, env?: NodeJS.ProcessEnv): void {
  const file = routeHealthPath(cwd, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function healthKey(record: Pick<RouteHealthRecord, "route_id" | "profile" | "host" | "task_shape">): string {
  return [record.host, record.route_id, record.profile, record.task_shape].join("\0");
}

const NON_ROUTE_FAILURES = new Set(["WRITE_SCOPE_VIOLATION", "HYGIENE", "RECEIPT_MISMATCH", "RECEIPT_INVALID"]);

export function recordRouteHealth(cwd: string, options: RecordRouteHealthOptions): RouteHealthRecord | null {
  const routeId = String(options.routeId || "").trim();
  if (!routeId) return null;
  const errorCode = String(options.errorCode || "").trim() || null;
  if (options.terminalStatus !== "completed" && errorCode && NON_ROUTE_FAILURES.has(errorCode)) return null;
  const now = options.now || new Date();
  const healthy = options.terminalStatus === "completed";
  const message = String(options.message || "").trim() || null;
  const failureKind = healthy
    ? null
    : errorCode === "AGENT_TIMEOUT" && /no (?:agent|host) terminal/i.test(message || "")
      ? "HOST_NO_TERMINAL"
      : errorCode;
  const record: RouteHealthRecord = {
    route_id: routeId,
    profile: String(options.profile || "").trim(),
    host: String(options.host || "codex").trim() || "codex",
    task_shape: taskShape(options.taskText),
    status: healthy ? "healthy" : "degraded",
    terminal_status: options.terminalStatus,
    failure_kind: failureKind,
    error_code: errorCode,
    message,
    updated_at: now.toISOString(),
    cooldown_until: healthy ? null : new Date(now.getTime() + (options.cooldownMs ?? DEFAULT_ROUTE_HEALTH_COOLDOWN_MS)).toISOString(),
  };
  const store = readRouteHealth(cwd, options.env);
  const key = healthKey(record);
  store.records = [record, ...store.records.filter((item) => healthKey(item) !== key)]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 500);
  writeRouteHealth(cwd, store, options.env);
  return record;
}

export function isCardAutoEligible(
  cwd: string,
  card: ModelCard,
  taskText: string,
  { host = "codex", now = new Date(), env }: { host?: string; now?: Date; env?: NodeJS.ProcessEnv } = {},
): boolean {
  if (!card.route_id) return false;
  const shape = taskShape(taskText);
  const record = readRouteHealth(cwd, env).records.find((item) =>
    item.route_id === card.route_id
      && item.profile === String(card.reasoning_effort || "")
      && item.host === host
      && item.task_shape === shape,
  );
  if (!record || record.status === "healthy") return true;
  return !record.cooldown_until || Date.parse(record.cooldown_until) <= now.getTime();
}

export function cardsForAutomaticSelection(cwd: string, cards: ModelCard[], taskText: string, host = "codex", env?: NodeJS.ProcessEnv): ModelCard[] {
  return cards.filter((card) => isCardAutoEligible(cwd, card, taskText, { host, env }));
}
