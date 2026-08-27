import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hostHome } from "./paths.js";
import type { HostId } from "./hosts.js";

type HookHandler = Record<string, unknown>;
export type LegacyHookRemovalAction = "removed" | "preserved" | "conflict";
export interface LegacyHookRemovalResult {
  document: Record<string, unknown>;
  action: LegacyHookRemovalAction;
  canDelete: boolean;
}

const EVENTS = ["PreToolUse", "SubagentStart"] as const;

export function legacyHookPath(host: HostId, env: NodeJS.ProcessEnv = process.env): string {
  if (host === "codex") return path.join(String(env.CODEX_HOME || path.join(hostHome(env), ".codex")), "hooks.json");
  if (host === "claude") return path.join(String(env.CLAUDE_CONFIG_DIR || path.join(hostHome(env), ".claude")), "settings.json");
  if (host === "grok") return path.join(String(env.GROK_HOME || path.join(hostHome(env), ".grok")), "hooks", "baton.json");
  return path.join(hostHome(env), `.${host}`, "hooks.json");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function handlers(group: unknown): HookHandler[] {
  if (!record(group) || !Array.isArray(group.hooks)) return [];
  return group.hooks.filter(record);
}

function isOwned(host: HostId, value: unknown): value is HookHandler {
  if (!record(value) || value.type !== "command" || typeof value.command !== "string") return false;
  const command = value.command.trim();
  if (!/\bguard\s+hook\b/.test(command)) return false;
  if (host === "codex") return /(?:^|[\s/])baton(?:\.js|\.ts)?(?:\s|$)/.test(command) && !/--host\s+(?:claude|grok)\b/.test(command);
  return new RegExp(`--host\\s*=?\\s*${host}(?:\\s|$)`).test(command)
    && /(?:^|[\s/])baton(?:\.js|\.ts)?(?:\s|$)/.test(command);
}

function retainGroup(host: HostId, value: unknown): unknown | null {
  if (!record(value) || !handlers(value).some((item) => isOwned(host, item))) return value;
  const retained = handlers(value).filter((item) => !isOwned(host, item));
  return retained.length ? { ...structuredClone(value), hooks: retained } : null;
}

function removeFromDocument(host: HostId, existing: unknown): LegacyHookRemovalResult {
  if (!record(existing)) return { document: {}, action: "conflict", canDelete: false };
  const document = structuredClone(existing) as Record<string, unknown>;
  const hooks = document.hooks;
  if (!record(hooks)) return { document, action: "preserved", canDelete: false };
  let owned = false;
  for (const event of EVENTS) {
    const current = hooks[event];
    if (current === undefined) continue;
    if (!Array.isArray(current)) return { document: structuredClone(existing), action: "conflict", canDelete: false };
    const retained = current.map((item) => {
      const next = retainGroup(host, item);
      if (next !== item) owned = true;
      return next;
    }).filter((item): item is unknown => item !== null);
    if (retained.length) hooks[event] = retained;
    else delete hooks[event];
  }
  if (!owned) return { document: structuredClone(existing), action: "preserved", canDelete: false };
  // Do not leave an empty hooks container behind after the last Baton handler
  // is removed. Other top-level host settings remain untouched.
  if (record(document.hooks) && Object.keys(document.hooks).length === 0) delete document.hooks;
  const empty = Object.keys(document).length === 0;
  return { document, action: "removed", canDelete: empty };
}

export function removeLegacyHooks(host: HostId, existing: unknown): LegacyHookRemovalResult {
  return removeFromDocument(host, existing);
}

export function readLegacyHookDocument(host: HostId, env: NodeJS.ProcessEnv = process.env): { file: string; document: Record<string, unknown> | null; text: string | null } {
  const file = legacyHookPath(host, env);
  if (!fs.existsSync(file)) return { file, document: null, text: null };
  const text = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(text) as unknown;
  return { file, document: record(parsed) ? parsed : null, text };
}

/** Remove only old Baton handlers during an update; unrelated host hooks stay untouched. */
export function cleanupLegacyHook(host: HostId, env: NodeJS.ProcessEnv = process.env): string {
  const loaded = readLegacyHookDocument(host, env);
  if (!loaded.document || loaded.text === null) return "absent";
  const result = removeLegacyHooks(host, loaded.document);
  if (result.action === "conflict") return "conflict";
  const after = JSON.stringify(result.document, null, 2) + "\n";
  if (after === loaded.text) return "unchanged";
  if (result.canDelete) {
    fs.unlinkSync(loaded.file);
    return "removed";
  }
  fs.mkdirSync(path.dirname(loaded.file), { recursive: true, mode: 0o700 });
  const temporary = `${loaded.file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, after, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, loaded.file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return "updated";
}
