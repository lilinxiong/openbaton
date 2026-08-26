import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostHome, displayHomePath } from "./paths.js";
import { findBinaryOnPath, isExecutableFile } from "./executables.js";
import { currentBatonHookTargets, type BatonHookTarget } from "./codex-hooks.js";

export const BATON_GROK_HOOK_COMMAND = "baton guard hook --host grok";
export const BATON_GROK_HOOK_EVENTS = ["PreToolUse", "SubagentStart"] as const;
export const BATON_GROK_PRETOOLUSE_MATCHER = "Bash|Edit|Write|run_terminal_command|search_replace|spawn_subagent";

export type GrokHookEvent = (typeof BATON_GROK_HOOK_EVENTS)[number];

export interface GrokHooksOptions {
  env?: NodeJS.ProcessEnv;
  hooksPath?: string;
  command?: string;
  executablePath?: string;
  runtimePath?: string;
  entryPath?: string;
  cwd?: string;
}

export interface GrokHooksStatus {
  path: string;
  display_path: string;
  exists: boolean;
  installed: boolean;
  baton_entries: number;
  events: GrokHookEvent[];
  configured: boolean;
  operational: boolean;
  command: string | null;
  command_usable: boolean;
  operational_error: string | null;
  trust_required: false;
  trust_command: "/hooks";
}

export interface GrokHooksInstallResult extends GrokHooksStatus {
  changed: boolean;
  action: "installed" | "updated" | "kept";
}

export type GrokHookRemovalAction = "removed" | "preserved" | "conflict";
export interface GrokHookRemovalResult {
  document: Record<string, unknown>;
  action: GrokHookRemovalAction;
  canDelete: boolean;
}

function grokHome(env?: NodeJS.ProcessEnv): string {
  const override = String(env?.GROK_HOME || "").trim();
  if (override) return path.resolve(override);
  return path.join(hostHome(env), ".grok");
}

export function grokHooksPath(options: GrokHooksOptions = {}): string {
  if (options.hooksPath) return path.resolve(options.hooksPath);
  return path.join(grokHome(options.env), "hooks", "baton.json");
}

function quoteToken(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

function regularFile(candidate: string): string | null {
  const text = candidate.trim();
  if (!text) return null;
  const resolved = path.resolve(text);
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function executableFile(candidate: string): string | null {
  const file = regularFile(candidate);
  return file && isExecutableFile(file) ? file : null;
}

function hookCommandError(detail: string): Error & { code: string } {
  const error = new Error("GROK_HOOK_COMMAND_UNAVAILABLE: " + detail) as Error & { code: string };
  error.code = "GROK_HOOK_COMMAND_UNAVAILABLE";
  return error;
}

function hostSuffix(): string {
  return " guard hook --host grok";
}

function runtimeEntryCommand(target: BatonHookTarget): string {
  return target.runtime
    ? quoteToken(target.runtime) + " " + quoteToken(target.entry) + hostSuffix()
    : quoteToken(target.executable) + hostSuffix();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandTokens(command: string): string[] | null {
  const text = command.trim();
  if (!text || /[\r\n;|&<>]/.test(text) || text.includes(String.fromCharCode(96)) || text.includes("$(")) return null;
  const matches = text.match(/(?:'[^']*'|"[^"]*"|\S+)/g);
  if (!matches) return null;
  const tokens = matches.map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
  if (tokens[0] === "env") tokens.shift();
  return tokens.length ? tokens : null;
}

function validateHookCommand(command: string, env: NodeJS.ProcessEnv): string {
  const text = command.trim();
  const tokens = commandTokens(text);
  if (!tokens) throw hookCommandError("command is empty or contains shell composition");
  const first = tokens[0];
  const executable = first.includes("/") ? first : findBinaryOnPath(first, env);
  if (!executable || !isExecutableFile(executable)) {
    throw hookCommandError("executable is not usable: " + first);
  }
  if (tokens.length >= 2 && tokens[1].includes("/") && !regularFile(tokens[1])) {
    throw hookCommandError("entry path is not usable: " + tokens[1]);
  }
  return text;
}

export function resolveGrokHookCommand(options: GrokHooksOptions = {}): string {
  const env = options.env || process.env;
  const explicit = String(options.command || env.BATON_GROK_HOOK_COMMAND || "").trim();
  if (explicit) return validateHookCommand(explicit, env);
  const targets = currentBatonHookTargets({
    env,
    runtimePath: options.runtimePath,
    entryPath: options.entryPath,
    executablePath: options.executablePath,
  });
  if (targets.length) return runtimeEntryCommand(targets[0]);
  const onPath = findBinaryOnPath("baton", env);
  if (onPath) return quoteToken(onPath) + hostSuffix();
  throw hookCommandError("set BATON_GROK_HOOK_PATH or provide a usable command");
}

function handler(command: string) {
  return { type: "command", command, timeout: 30 };
}

export function batonGrokHookDocument(command = BATON_GROK_HOOK_COMMAND): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [{ matcher: BATON_GROK_PRETOOLUSE_MATCHER, hooks: [handler(command)] }],
      SubagentStart: [{ matcher: "", hooks: [handler(command)] }],
    },
  };
}

function readHookFile(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(parsed)) throw new Error("top level must be an object");
    if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) throw new Error("hooks must be an object");
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GROK_HOOKS_INVALID_JSON: ${file}: ${message}`);
  }
}

/** Match only Baton-owned Grok commands; mixed groups are retained safely. */
export function isBatonGrokHookHandler(value: unknown): value is { type: "command"; command: string; [key: string]: unknown } {
  if (!isRecord(value) || value.type !== "command" || typeof value.command !== "string") return false;
  const command = value.command.trim();
  if (!/\bguard\s+hook\b/.test(command) || !/--host[=\s]+grok(?:\s|$)/.test(command)) return false;
  return /(?:^|\s|\/)(?:baton|baton\.js|baton\.ts)(?:\s|$)/.test(command)
    || /(?:^|\s)[^\s]+\/baton\.(?:js|ts)(?:\s|$)/.test(command);
}

function grokHandlersOf(group: unknown): Array<Record<string, unknown>> {
  return isRecord(group) && Array.isArray(group.hooks)
    ? group.hooks.filter(isRecord)
    : [];
}

function grokGroup(value: unknown): boolean {
  return isRecord(value) && grokHandlersOf(value).some(isBatonGrokHookHandler);
}

function retainGrokUnrelated(value: unknown): unknown | null {
  if (!grokGroup(value)) return value;
  const unrelated = grokHandlersOf(value).filter((item) => !isBatonGrokHookHandler(item));
  if (!unrelated.length) return null;
  return { ...structuredClone(value) as Record<string, unknown>, hooks: unrelated };
}

function grokHooksOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.hooks !== undefined && !isRecord(value.hooks)) throw new Error("GROK_HOOKS_INVALID_EVENT: hooks must be an object");
  return (value.hooks || {}) as Record<string, unknown>;
}

/** Merge canonical Baton entries while preserving unrelated Grok JSON. */
export function mergeBatonGrokHooks(existing: unknown, command = BATON_GROK_HOOK_COMMAND): Record<string, unknown> {
  const output = isRecord(existing) ? structuredClone(existing) as Record<string, unknown> : {};
  const hooks = grokHooksOf(output);
  output.hooks = hooks;
  const entries = batonGrokHookDocument(command).hooks as Record<string, unknown>;
  for (const event of BATON_GROK_HOOK_EVENTS) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) throw new Error(`GROK_HOOKS_INVALID_EVENT: hooks.${event} must be an array`);
    const retained = (Array.isArray(current) ? current : [])
      .map(retainGrokUnrelated)
      .filter((item): item is unknown => item !== null);
    hooks[event] = [...retained, ...(entries[event] as unknown[])];
  }
  return output;
}

function canonicalGrokDocument(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "hooks") || !isRecord(value.hooks)) return false;
  for (const event of BATON_GROK_HOOK_EVENTS) {
    const groups = value.hooks[event];
    const expected = event === "PreToolUse" ? BATON_GROK_PRETOOLUSE_MATCHER : "";
    if (!Array.isArray(groups) || groups.length !== 1) return false;
    const group = groups[0];
    if (!isRecord(group) || group.matcher !== expected || grokHandlersOf(group).length !== 1 || !isBatonGrokHookHandler(grokHandlersOf(group)[0])) return false;
  }
  return Object.keys(value.hooks).every((key) => (BATON_GROK_HOOK_EVENTS as readonly string[]).includes(key));
}

/** Remove owned entries and report whether the whole file is safe to delete. */
export function removeBatonGrokHooks(existing: unknown): GrokHookRemovalResult {
  if (!isRecord(existing)) return { document: {}, action: "conflict", canDelete: false };
  if (canonicalGrokDocument(existing)) return { document: {}, action: "removed", canDelete: true };
  try {
    const document = structuredClone(existing) as Record<string, unknown>;
    const hooks = grokHooksOf(document);
    for (const event of BATON_GROK_HOOK_EVENTS) {
      if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
        return { document: structuredClone(existing) as Record<string, unknown>, action: "conflict", canDelete: false };
      }
    }
    let owned = false;
    for (const event of BATON_GROK_HOOK_EVENTS) {
      const current = hooks[event];
      if (!Array.isArray(current)) continue;
      const retained = current.map((item) => {
        const next = retainGrokUnrelated(item);
        if (next !== item) owned = true;
        return next;
      }).filter((item): item is unknown => item !== null);
      if (retained.length) hooks[event] = retained;
      else delete hooks[event];
    }
    return { document, action: owned ? "preserved" : "conflict", canDelete: false };
  } catch {
    return { document: structuredClone(existing) as Record<string, unknown>, action: "conflict", canDelete: false };
  }
}

function commandFromDocument(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.hooks) || !Array.isArray(value.hooks.PreToolUse)) return null;
  for (const group of value.hooks.PreToolUse) {
    if (!grokGroup(group)) continue;
    for (const item of grokHandlersOf(group)) {
      if (isBatonGrokHookHandler(item)) return item.command.trim();
    }
  }
  return null;
}

function commandOperational(command: string, options: GrokHooksOptions): boolean {
  const tokens = commandTokens(command);
  if (!tokens) return false;
  const env = options.env || process.env;
  const first = tokens[0];
  const executable = first.includes("/") ? first : findBinaryOnPath(first, env);
  if (!executableFile(executable || "")) return false;
  if (tokens.length >= 2 && tokens[1].includes("/")) return Boolean(regularFile(tokens[1]));
  return true;
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function statusFor(file: string, options: GrokHooksOptions, value: unknown): GrokHooksStatus {
  const command = commandFromDocument(value);
  const events: GrokHookEvent[] = [];
  if (isRecord(value) && isRecord(value.hooks)) {
    for (const event of BATON_GROK_HOOK_EVENTS) {
      if (Array.isArray(value.hooks[event]) && value.hooks[event].some(grokGroup)) events.push(event);
    }
  }
  const configured = Boolean(command);
  const usable = configured && commandOperational(command!, options);
  return {
    path: file,
    display_path: displayHomePath(file, { cwd: options.cwd, env: options.env }),
    exists: fs.existsSync(file),
    installed: configured,
    baton_entries: events.length,
    events,
    configured,
    operational: usable,
    command,
    command_usable: usable,
    operational_error: configured && !usable ? "hook command is not usable: " + command : null,
    trust_required: false,
    trust_command: "/hooks",
  };
}

export function grokHooksStatus(options: GrokHooksOptions = {}): GrokHooksStatus {
  const file = grokHooksPath(options);
  return statusFor(file, options, readHookFile(file));
}

export function installGrokHooks(options: GrokHooksOptions = {}): GrokHooksInstallResult {
  const file = grokHooksPath(options);
  const command = resolveGrokHookCommand(options);
  const before = readHookFile(file);
  const next = mergeBatonGrokHooks(before || {}, command);
  const beforeText = before == null ? null : `${JSON.stringify(before, null, 2)}\n`;
  const afterText = `${JSON.stringify(next, null, 2)}\n`;
  const changed = beforeText !== afterText;
  if (changed) writeJsonAtomic(file, next);
  return {
    ...statusFor(file, options, next),
    changed,
    action: changed ? (before ? "updated" : "installed") : "kept",
  };
}
