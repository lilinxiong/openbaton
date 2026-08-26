import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runsDir } from "./paths.js";

export const HOOK_OBSERVATION_FILE = "hook-observations.json";

export interface HookObservation {
  host: string;
  event: string;
  last_observed_at: string;
}

function fileFor(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(runsDir(cwd, env), HOOK_OBSERVATION_FILE);
}

function normalized(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function valid(value: unknown): value is HookObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Boolean(normalized(item.host) && normalized(item.event) && typeof item.last_observed_at === "string"
    && !Number.isNaN(new Date(item.last_observed_at).getTime()));
}

export function readHookObservations(cwd: string, env?: NodeJS.ProcessEnv): HookObservation[] {
  const file = fileFor(cwd, env);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(valid).map((item) => ({
      host: normalized(item.host),
      event: normalized(item.event),
      last_observed_at: item.last_observed_at,
    })) : [];
  } catch {
    return [];
  }
}

/** Record one real hook invocation with an atomic replace. */
export function recordHookObservation(
  cwd: string,
  host: string,
  event: string,
  now: Date | string | number = new Date(),
  env?: NodeJS.ProcessEnv,
): HookObservation {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error("invalid hook observation timestamp");
  const observation: HookObservation = {
    host: normalized(host),
    event: normalized(event),
    last_observed_at: date.toISOString(),
  };
  if (!observation.host || !observation.event) throw new Error("hook observation host and event are required");
  const file = fileFor(cwd, env);
  const existing = readHookObservations(cwd, env).filter((item) => item.host !== observation.host || item.event !== observation.event);
  existing.push(observation);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return observation;
}

export function latestHookObservation(
  cwd: string | undefined,
  host: string,
  env?: NodeJS.ProcessEnv,
): HookObservation | null {
  if (!cwd) return null;
  const rows = readHookObservations(cwd, env).filter((item) => item.host === normalized(host));
  return rows.sort((left, right) => right.last_observed_at.localeCompare(left.last_observed_at))[0] || null;
}

export function hookObservationPath(cwd: string, env?: NodeJS.ProcessEnv): string {
  return fileFor(cwd, env);
}
