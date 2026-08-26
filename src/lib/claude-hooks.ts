import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostHome, displayHomePath } from "./paths.js";
import { findBinaryOnPath, isExecutableFile } from "./executables.js";
import { currentBatonHookTargets, type BatonHookTarget } from "./codex-hooks.js";

/** The command is deliberately stable so Baton can merge only its own hooks. */
export const BATON_CLAUDE_HOOK_COMMAND = "baton guard hook --host claude";
export const BATON_CLAUDE_HOOK_EVENTS = ["PreToolUse", "SubagentStart"] as const;

export type ClaudeHookEvent = (typeof BATON_CLAUDE_HOOK_EVENTS)[number];

/**
 * Claude Code routes the native child-agent call through the `Agent` tool name
 * at the hook boundary (the wire tool is `Task`; the hook sees `Agent`), and
 * matches file mutations on Edit/Write/NotebookEdit.
 */
export const BATON_CLAUDE_PRETOOLUSE_MATCHER = "Bash|Edit|Write|NotebookEdit|Agent";

export interface ClaudeHooksOptions {
  env?: NodeJS.ProcessEnv;
  settingsPath?: string;
  /** Exact command used by tests/embedders when it is known to be usable. */
  command?: string;
  executablePath?: string;
  runtimePath?: string;
  entryPath?: string;
  cwd?: string;
}

export interface ClaudeHooksStatus {
  path: string;
  display_path: string;
  exists: boolean;
  installed: boolean;
  baton_entries: number;
  events: ClaudeHookEvent[];
  configured: boolean;
  operational: boolean;
  command: string | null;
  command_usable: boolean;
  operational_error: string | null;
  /** Claude Code applies user settings hooks without a separate trust prompt. */
  trust_required: false;
  trust_command: "/hooks";
  /**
   * SubagentStart cannot cancel a child in Claude Code either, so the
   * PreToolUse gate remains the enforcing surface.
   */
  subagent_start_cannot_cancel: true;
}

export interface ClaudeHooksInstallResult extends ClaudeHooksStatus {
  changed: boolean;
  action: "installed" | "updated" | "kept";
}

function claudeHome(env?: NodeJS.ProcessEnv): string {
  return env?.CLAUDE_CONFIG_DIR || path.join(hostHome(env), ".claude");
}

/** Honor CLAUDE_CONFIG_DIR the same way Claude Code does, while keeping HOME injectable. */
export function claudeSettingsPath(options: ClaudeHooksOptions = {}): string {
  if (options.settingsPath) return path.resolve(options.settingsPath);
  return path.join(claudeHome(options.env), "settings.json");
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
  const error = new Error("CLAUDE_HOOK_COMMAND_UNAVAILABLE: " + detail) as Error & { code: string };
  error.code = "CLAUDE_HOOK_COMMAND_UNAVAILABLE";
  return error;
}

function hostSuffix(): string {
  return " guard hook --host claude";
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

/**
 * Resolve a command Claude Code can invoke without inheriting the director's
 * interactive PATH. Tests and embedders may inject a deterministic command.
 */
export function resolveClaudeHookCommand(options: ClaudeHooksOptions = {}): string {
  const env = options.env || process.env;
  const explicit = String(options.command || env.BATON_CLAUDE_HOOK_COMMAND || "").trim();
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
  throw hookCommandError("set BATON_CLAUDE_HOOK_PATH or provide a usable command");
}

interface HookHandler {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

interface HookMatcherGroup {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

interface SettingsFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function handlersOf(group: HookMatcherGroup): HookHandler[] {
  return Array.isArray(group.hooks) ? group.hooks.filter(isRecord) as HookHandler[] : [];
}

/** Match only a Baton claude-host command; unrelated scripts are retained. */
export function isBatonClaudeHookHandler(value: unknown): value is HookHandler {
  if (!isRecord(value) || value.type !== "command" || typeof value.command !== "string") return false;
  const command = value.command.trim();
  if (!/\bguard\s+hook\b/.test(command)) return false;
  if (!/--host[\s=]claude(?:\s|$)/.test(command)) return false;
  return /(?:^|\/)baton(?:\.js|\.ts)?(?:\s|$)/.test(command.split(/\s+/)[0])
    || /(?:^|\s)[^\s]*\/baton\.(?:js|ts)(?:\s|$)/.test(command);
}

function isBatonGroup(value: unknown): value is HookMatcherGroup {
  return isRecord(value) && handlersOf(value).some(isBatonClaudeHookHandler);
}

function retainUnrelatedHandlers(value: unknown): unknown | null {
  if (!isRecord(value) || !isBatonGroup(value)) return value;
  const unrelated = handlersOf(value).filter((item) => !isBatonClaudeHookHandler(item));
  if (!unrelated.length) return null;
  return { ...structuredClone(value), hooks: unrelated };
}

function handler(command: string): HookHandler {
  return {
    type: "command",
    command,
    timeout: 30,
  };
}

/** Canonical entries added to the user's Claude Code settings hook layer. */
export function batonClaudeHookEntries(command = BATON_CLAUDE_HOOK_COMMAND): Record<ClaudeHookEvent, HookMatcherGroup[]> {
  return {
    PreToolUse: [{ matcher: BATON_CLAUDE_PRETOOLUSE_MATCHER, hooks: [handler(command)] }],
    SubagentStart: [{ matcher: "", hooks: [handler(command)] }],
  };
}

function readSettingsFile(file: string): SettingsFile | null {
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CLAUDE_SETTINGS_INVALID_JSON: ${file}: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error(`CLAUDE_SETTINGS_INVALID_JSON: ${file}: top level must be an object`);
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) {
    throw new Error(`CLAUDE_SETTINGS_INVALID_JSON: ${file}: hooks must be an object`);
  }
  return parsed as SettingsFile;
}

/**
 * Merge Baton entries into the user's settings without replacing unrelated
 * settings or hooks. Repeated init/update calls are idempotent.
 */
export function mergeBatonClaudeHooks(existing: unknown, command = BATON_CLAUDE_HOOK_COMMAND): SettingsFile {
  const output: SettingsFile = isRecord(existing) ? structuredClone(existing) as SettingsFile : {};
  const hooks = isRecord(output.hooks) ? output.hooks : {};
  output.hooks = hooks;
  const entries = batonClaudeHookEntries(command);

  for (const event of BATON_CLAUDE_HOOK_EVENTS) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`CLAUDE_SETTINGS_INVALID_EVENT: hooks.${event} must be an array`);
    }
    const retained = (Array.isArray(current) ? current : [])
      .map(retainUnrelatedHandlers)
      .filter((item): item is unknown => item !== null);
    hooks[event] = [...retained, ...structuredClone(entries[event])];
  }
  return output;
}

/** Exact inverse used by uninstall: retain settings and unrelated handlers. */
export function removeBatonClaudeHooks(existing: unknown): SettingsFile {
  const output: SettingsFile = isRecord(existing) ? structuredClone(existing) as SettingsFile : {};
  const hooks = isRecord(output.hooks) ? output.hooks : {};
  output.hooks = hooks;
  for (const event of BATON_CLAUDE_HOOK_EVENTS) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`CLAUDE_SETTINGS_INVALID_EVENT: hooks.${event} must be an array`);
    }
    const retained = (Array.isArray(current) ? current : [])
      .map(retainUnrelatedHandlers)
      .filter((item): item is unknown => item !== null);
    if (retained.length) hooks[event] = retained;
    else delete hooks[event];
  }
  return output;
}

function countBatonEntries(value: unknown): { count: number; events: ClaudeHookEvent[] } {
  if (!isRecord(value) || !isRecord(value.hooks)) return { count: 0, events: [] };
  let count = 0;
  const events: ClaudeHookEvent[] = [];
  for (const event of BATON_CLAUDE_HOOK_EVENTS) {
    const groups = value.hooks[event];
    if (!Array.isArray(groups)) continue;
    const eventCount = groups.filter(isBatonGroup).length;
    if (eventCount) events.push(event);
    count += eventCount;
  }
  return { count, events };
}

function batonCommands(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.hooks)) return [];
  const commands: string[] = [];
  for (const event of BATON_CLAUDE_HOOK_EVENTS) {
    const groups = value.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isBatonGroup(group)) continue;
      for (const item of handlersOf(group)) {
        if (isBatonClaudeHookHandler(item) && typeof item.command === "string") {
          commands.push(item.command.trim());
        }
      }
    }
  }
  return commands;
}

function commandOperational(command: string, options: ClaudeHooksOptions): boolean {
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
    if (fs.existsSync(file)) {
      try {
        fs.chmodSync(temp, fs.statSync(file).mode & 0o777);
      } catch {
        // Keep the secure default mode when a platform cannot stat/chmod.
      }
    }
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function statusFor(file: string, options: ClaudeHooksOptions, value: unknown): ClaudeHooksStatus {
  const found = countBatonEntries(value);
  const commands = batonCommands(value);
  const command = commands.at(-1) || null;
  const unusable = commands.find((item) => !commandOperational(item, options));
  const configured = found.count > 0;
  return {
    path: file,
    display_path: displayHomePath(file, { cwd: options.cwd, env: options.env }),
    exists: fs.existsSync(file),
    installed: configured,
    baton_entries: found.count,
    events: found.events,
    configured,
    operational: configured && !unusable,
    command,
    command_usable: configured && !unusable,
    operational_error: unusable ? "hook command is not usable: " + unusable : null,
    trust_required: false,
    trust_command: "/hooks",
    subagent_start_cannot_cancel: true,
  };
}

export function claudeHooksStatus(options: ClaudeHooksOptions = {}): ClaudeHooksStatus {
  const file = claudeSettingsPath(options);
  return statusFor(file, options, readSettingsFile(file));
}

/** Install or refresh the Baton hook while preserving every unrelated setting. */
export function installClaudeHooks(options: ClaudeHooksOptions = {}): ClaudeHooksInstallResult {
  const file = claudeSettingsPath(options);
  const command = resolveClaudeHookCommand(options);
  const before = readSettingsFile(file);
  const merged = mergeBatonClaudeHooks(before || {}, command);
  const beforeText = before == null ? null : `${JSON.stringify(before, null, 2)}\n`;
  const afterText = `${JSON.stringify(merged, null, 2)}\n`;
  const changed = beforeText !== afterText;
  if (changed) writeJsonAtomic(file, merged);
  return {
    ...statusFor(file, options, merged),
    changed,
    action: changed ? (before ? "updated" : "installed") : "kept",
  };
}
