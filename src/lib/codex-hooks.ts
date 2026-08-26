import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostHome, packageRoot, displayHomePath } from "./paths.js";
import { findBinaryOnPath, isExecutableFile } from "./executables.js";
import { latestHookObservation } from "./hook-observation.js";

/** The command is deliberately stable so Baton can merge only its own hooks. */
export const BATON_CODEX_HOOK_COMMAND = "baton guard hook";
export const BATON_CODEX_HOOK_DESCRIPTION = "Baton-owned host guard (scoped PreToolUse)";
export const BATON_CODEX_HOOK_EVENTS = ["PreToolUse"] as const;
const BATON_CODEX_LEGACY_EVENTS = ["PreToolUse", "SubagentStart"] as const;
export const BATON_CODEX_PRETOOLUSE_MATCHER = "^(Bash|apply_patch|Edit|Write)$";

export type CodexHookEvent = (typeof BATON_CODEX_HOOK_EVENTS)[number];

export interface CodexHooksOptions {
  env?: NodeJS.ProcessEnv;
  hooksPath?: string;
  templatePath?: string;
  /** Exact command used by tests/embedders when it is known to be usable. */
  command?: string;
  /** Executable path used to build a deterministic absolute hook command. */
  executablePath?: string;
  /** Runtime used to execute the current Baton entry (for deterministic tests). */
  runtimePath?: string;
  /** Entry used by the runtime to execute the current Baton implementation. */
  entryPath?: string;
  cwd?: string;
  /** Explicit mutation-guard posture. The config layer supplies this value. */
  guardMode?: "enforce" | "off";
}

export interface CodexHooksStatus {
  path: string;
  display_path: string;
  exists: boolean;
  installed: boolean;
  baton_entries: number;
  events: CodexHookEvent[];
  configured: boolean;
  operational: boolean;
  command: string | null;
  command_usable: boolean;
  operational_error: string | null;
  trust_required: boolean;
  trust_command: "/hooks";
  specialized_tool_paths_may_opt_out: true;
  guard_mode: "enforce" | "off";
  /** Dispatch integration is supplied by the control plane, not inferred from hook install. */
  core_dispatch_ready: boolean | "unknown";
  hook_configured: boolean;
  /** Hook execution telemetry is read from the workspace observation ledger. */
  recent_hook_observation: boolean | "unknown";
  last_observed_at: string | null;
  coverage: "scoped-pretooluse" | "none";
  audit_only: boolean;
}

export interface CodexHooksInstallResult extends CodexHooksStatus {
  changed: boolean;
  action: "installed" | "updated" | "kept";
}

function codexHome(env?: NodeJS.ProcessEnv): string {
  return env?.CODEX_HOME || path.join(hostHome(env), ".codex");
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

function optionOrEnv(options: CodexHooksOptions, ...keys: string[]): string {
  for (const key of keys) {
    const option = options[key as keyof CodexHooksOptions];
    if (typeof option === "string" && option.trim()) return option.trim();
    const env = options.env || process.env;
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function commandToken(command: string): string | null {
  const text = command.trim();
  if (!text || /[\r\n;|&<>\x60]|\$\(/.test(text)) return null;
  const withoutEnv = text.replace(/^env\s+/, "");
  const match = withoutEnv.match(/^(?:'([^']+)'|"([^"]+)"|(\S+))/);
  return match ? (match[1] || match[2] || match[3] || null) : null;
}

function hookCommandError(detail: string): Error & { code: string } {
  const error = new Error("CODEX_HOOK_COMMAND_UNAVAILABLE: " + detail) as Error & { code: string };
  error.code = "CODEX_HOOK_COMMAND_UNAVAILABLE";
  return error;
}

export interface BatonHookTarget {
  runtime: string | null;
  entry: string;
  executable: string;
}

function processEntryPath(): string | null {
  const candidate = String(process.argv[1] || "").trim();
  if (!path.isAbsolute(candidate) || !/(?:^|[/\\\\])baton(?:\\.js|\\.ts)?$/.test(candidate)) return null;
  return regularFile(candidate);
}

function packageEntryPaths(): string[] {
  const root = packageRoot();
  return [
    path.join(root, "bin", "baton.ts"),
    path.join(root, "dist", "bin", "baton.js"),
  ].map(regularFile).filter((item): item is string => Boolean(item));
}

/** Current executable/entry pairs trusted by the installed hook and host guard. */
export function currentBatonHookTargets(options: CodexHooksOptions = {}): BatonHookTarget[] {
  const runtimeOverride = optionOrEnv(options, "runtimePath", "BATON_CODEX_HOOK_RUNTIME", "BATON_CODEX_RUNTIME");
  const entryOverride = optionOrEnv(options, "entryPath", "BATON_CODEX_HOOK_ENTRY", "BATON_CODEX_ENTRY");
  const executableOverride = optionOrEnv(options, "executablePath", "BATON_CODEX_HOOK_PATH");
  const targets: BatonHookTarget[] = [];
  const seen = new Set<string>();
  const addPair = (runtime: string, entry: string): void => {
    const runtimeFile = executableFile(runtime);
    const entryFile = regularFile(entry);
    if (!runtimeFile || !entryFile) return;
    const key = runtimeFile + "\0" + entryFile;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ runtime: runtimeFile, entry: entryFile, executable: entryFile });
  };
  const addExecutable = (candidate: string): void => {
    const executable = executableFile(candidate);
    if (!executable || seen.has(executable)) return;
    seen.add(executable);
    targets.push({ runtime: null, entry: executable, executable });
  };

  if (runtimeOverride || entryOverride) {
    if (!runtimeOverride || !entryOverride) return [];
    addPair(runtimeOverride, entryOverride);
    return targets;
  }
  if (executableOverride) addExecutable(executableOverride);

  const runtime = executableFile(process.execPath);
  const processEntry = processEntryPath();
  if (runtime && processEntry) addPair(runtime, processEntry);
  for (const entry of packageEntryPaths()) {
    if (runtime) addPair(runtime, entry);
  }
  return targets;
}

function runtimeEntryCommand(target: BatonHookTarget): string {
  return target.runtime
    ? quoteToken(target.runtime) + " " + quoteToken(target.entry) + " guard hook"
    : quoteToken(target.executable) + " guard hook";
}

function validateHookCommand(command: string, env: NodeJS.ProcessEnv): string {
  const text = command.trim();
  const token = commandToken(text);
  if (!token) throw hookCommandError("command is empty or contains shell composition");
  const executable = token.includes("/") ? token : findBinaryOnPath(token, env);
  if (!executable || !isExecutableFile(executable)) {
    throw hookCommandError("executable is not usable: " + token);
  }
  const tokens = text.match(/(?:'[^']*'|"[^"]*"|[^\s]+)/g)
    ?.map((item) => item.replace(/^(['"])(.*)\1$/, "$2")) || [];
  if (tokens.length >= 3 && tokens[1]?.includes("/") && tokens.at(-2) === "guard" && tokens.at(-1) === "hook"
    && !regularFile(tokens[1])) {
    throw hookCommandError("entry path is not usable: " + tokens[1]);
  }
  return text;
}

/**
 * Resolve an executable command that Codex can invoke without inheriting the
 * director's interactive PATH. Tests and embedders may inject a deterministic
 * command; normal installs prefer an absolute baton path.
 */
export function resolveCodexHookCommand(options: CodexHooksOptions = {}): string {
  const env = options.env || process.env;
  const explicitCommand = String(options.command || env.BATON_CODEX_HOOK_COMMAND || "").trim();
  if (explicitCommand) return validateHookCommand(explicitCommand, env);

  const runtimeOverride = optionOrEnv(options, "runtimePath", "BATON_CODEX_HOOK_RUNTIME", "BATON_CODEX_RUNTIME");
  const entryOverride = optionOrEnv(options, "entryPath", "BATON_CODEX_HOOK_ENTRY", "BATON_CODEX_ENTRY");
  if (runtimeOverride || entryOverride) {
    if (!runtimeOverride || !entryOverride) throw hookCommandError("runtime and entry paths must be provided together");
    const runtime = executableFile(runtimeOverride);
    const entry = regularFile(entryOverride);
    if (!runtime) throw hookCommandError("runtime path is not usable: " + runtimeOverride);
    if (!entry) throw hookCommandError("entry path is not usable: " + entryOverride);
    return runtimeEntryCommand({ runtime, entry, executable: entry });
  }

  const explicitPath = optionOrEnv(options, "executablePath", "BATON_CODEX_HOOK_PATH");
  if (explicitPath) {
    const executable = executableFile(explicitPath);
    if (!executable) throw hookCommandError("executable path is not usable: " + explicitPath);
    return runtimeEntryCommand({ runtime: null, entry: executable, executable });
  }

  const current = currentBatonHookTargets({ env });
  if (current.length) return runtimeEntryCommand(current[0]);

  const onPath = findBinaryOnPath("baton", env);
  if (onPath) return quoteToken(onPath) + " guard hook";
  throw hookCommandError("set BATON_CODEX_HOOK_PATH or provide a usable command");
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

interface HooksFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Honor CODEX_HOME in the same way Codex does, while keeping HOME injectable. */
export function codexHooksPath(options: CodexHooksOptions = {}): string {
  if (options.hooksPath) return path.resolve(options.hooksPath);
  return path.join(codexHome(options.env), "hooks.json");
}

function cloned<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handlersOf(group: HookMatcherGroup): HookHandler[] {
  return Array.isArray(group.hooks) ? group.hooks.filter(isRecord) as HookHandler[] : [];
}

/** Match only a Baton command; an unrelated script containing the word baton is retained. */
export function isBatonCodexHookHandler(value: unknown): value is HookHandler {
  if (!isRecord(value) || value.type !== "command" || typeof value.command !== "string") return false;
  const command = value.command.trim();
  return command === BATON_CODEX_HOOK_COMMAND
    || /^(?:env\s+)?(?:baton(?:\.js)?|[^\s]*\/baton(?:\.js)?|[^\s]*\/baton\.ts)\s+guard\s+hook(?:\s|$)/.test(command)
    || /^(?:env\s+)?[^\s]+\s+[^\s]*\/baton\.(?:js|ts)\s+guard\s+hook(?:\s|$)/.test(command)
    || (typeof value.statusMessage === "string"
      && /^Checking Baton (host guard|subagent identity)$/.test(value.statusMessage)
      && /\bguard hook$/.test(command));
}

function isBatonGroup(value: unknown): value is HookMatcherGroup {
  return isRecord(value) && handlersOf(value).some(isBatonCodexHookHandler);
}

function retainUnrelatedHandlers(value: unknown): unknown | null {
  if (!isRecord(value) || !isBatonGroup(value)) return value;
  const unrelated = handlersOf(value).filter((item) => !isBatonCodexHookHandler(item));
  if (!unrelated.length) return null;
  return { ...cloned(value), hooks: unrelated };
}

function handler(command: string): HookHandler {
  return {
    type: "command",
    command,
    timeout: 30,
    statusMessage: "Checking Baton host guard",
  };
}

function matcherGroup(matcher: string, command: string): HookMatcherGroup {
  return { matcher, hooks: [handler(command)] };
}

/** Canonical entries added to a user hook layer. All are synchronous. */
export function batonCodexHookEntries(
  command = BATON_CODEX_HOOK_COMMAND,
  guardMode: "enforce" | "off" = "enforce",
): Record<CodexHookEvent, HookMatcherGroup[]> {
  if (guardMode === "off") return { PreToolUse: [] };
  return { PreToolUse: [matcherGroup(BATON_CODEX_PRETOOLUSE_MATCHER, command)] };
}

function readHooksFile(file: string): HooksFile | null {
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CODEX_HOOKS_INVALID_JSON: ${file}: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error(`CODEX_HOOKS_INVALID_JSON: ${file}: top level must be an object`);
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) {
    throw new Error(`CODEX_HOOKS_INVALID_JSON: ${file}: hooks must be an object`);
  }
  return parsed as HooksFile;
}

/**
 * Merge Baton entries into one hooks layer without replacing unrelated hooks.
 * Existing Baton entries are replaced in-place at the end of their event list,
 * which makes repeated `init`/`update` calls idempotent.
 */
export function mergeBatonCodexHooks(
  existing: unknown,
  command = BATON_CODEX_HOOK_COMMAND,
  guardMode: "enforce" | "off" = "enforce",
): HooksFile {
  const output: HooksFile = isRecord(existing) ? cloned(existing) as HooksFile : {};
  const hooks = isRecord(output.hooks) ? output.hooks : {};
  output.hooks = hooks;
  const entries = batonCodexHookEntries(command, guardMode);

  // Always inspect the legacy lifecycle event even though it is no longer
  // part of the current manifest. This is the migration/removal path for
  // installations that predate the task-name native attachment contract.
  for (const event of BATON_CODEX_LEGACY_EVENTS) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`CODEX_HOOKS_INVALID_EVENT: hooks.${event} must be an array`);
    }
    const retained = (Array.isArray(current) ? current : [])
      .map(retainUnrelatedHandlers)
      .filter((item): item is unknown => item !== null);
    const next = event === "PreToolUse" ? [...retained, ...cloned(entries.PreToolUse)] : retained;
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  return output;
}

/** Exact inverse used by uninstall: remove only recognized Baton handlers. */
export function removeBatonCodexHooks(existing: unknown): HooksFile {
  return mergeBatonCodexHooks(existing, BATON_CODEX_HOOK_COMMAND, "off");
}

function countBatonEntries(value: unknown): { count: number; events: CodexHookEvent[] } {
  if (!isRecord(value) || !isRecord(value.hooks)) return { count: 0, events: [] };
  let count = 0;
  const events: CodexHookEvent[] = [];
  for (const event of BATON_CODEX_HOOK_EVENTS) {
    const groups = value.hooks[event];
    if (!Array.isArray(groups)) continue;
    const eventCount = groups.filter(isBatonGroup).length;
    if (eventCount) events.push(event);
    count += eventCount;
  }
  return { count, events };
}

function commandOperational(command: string, options: CodexHooksOptions): boolean {
  const text = command.trim();
  if (!text || /[\r\n;|&<>\x60]|\$\(/.test(text)) return false;
  const tokens = text.match(/(?:'[^']*'|"[^"]*"|[^\s]+)/g)
    ?.map((token) => token.replace(/^(['"])(.*)\1$/, "$2")) || [];
  if (!tokens.length) return false;
  if (tokens[0] === "env") tokens.shift();
  if (!tokens.length) return false;
  const env = options.env || process.env;
  const first = tokens[0];
  const executable = first.includes("/") ? first : findBinaryOnPath(first, env);
  if (!executableFile(executable || "")) return false;
  if (tokens.length >= 3 && tokens.at(-2) === "guard" && tokens.at(-1) === "hook") {
    if (tokens[1] && tokens[1].includes("/")) return Boolean(regularFile(tokens[1]));
    return true;
  }
  return false;
}

function batonCommands(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.hooks)) return [];
  const commands: string[] = [];
  for (const event of BATON_CODEX_HOOK_EVENTS) {
    const groups = value.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isBatonGroup(group)) continue;
      for (const item of handlersOf(group)) {
        if (isBatonCodexHookHandler(item) && typeof item.command === "string") {
          commands.push(item.command.trim());
        }
      }
    }
  }
  return commands;
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

function statusFor(
  file: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  value: unknown,
  guardMode: "enforce" | "off",
): CodexHooksStatus {
  const found = countBatonEntries(value);
  const commands = batonCommands(value);
  const command = commands.at(-1) || null;
  const unusable = commands.find((item) => !commandOperational(item, { cwd, env }));
  const configured = found.count > 0;
  const operational = guardMode === "off" ? true : configured && !unusable;
  const observation = latestHookObservation(cwd, "codex", env);
  const recentObservation = cwd
    ? Boolean(observation && Date.now() - new Date(observation.last_observed_at).getTime() <= 5 * 60_000)
    : "unknown" as const;
  return {
    path: file,
    display_path: displayHomePath(file, { cwd, env: undefined }),
    exists: fs.existsSync(file),
    installed: configured,
    baton_entries: found.count,
    events: found.events,
    configured,
    operational,
    command,
    command_usable: guardMode === "off" ? false : operational,
    operational_error: guardMode === "enforce" && !configured
      ? "required scoped PreToolUse hook is not configured"
      : unusable ? "hook command is not usable: " + unusable : null,
    trust_required: guardMode === "enforce",
    trust_command: "/hooks",
    specialized_tool_paths_may_opt_out: true,
    guard_mode: guardMode,
    core_dispatch_ready: "unknown",
    hook_configured: configured,
    recent_hook_observation: recentObservation,
    last_observed_at: observation?.last_observed_at || null,
    coverage: guardMode === "off" ? "none" : "scoped-pretooluse",
    audit_only: guardMode === "off",
  };
}

function emptyCodexDocument(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "hooks")) return false;
  return isRecord(value.hooks) && Object.keys(value.hooks).length === 0;
}

function resolveGuardMode(options: CodexHooksOptions): "enforce" | "off" {
  const explicit = options.guardMode || String((options.env || process.env).BATON_GUARD_MODE || "").trim().toLowerCase();
  return explicit === "off" ? "off" : "enforce";
}

export function codexHooksStatus(options: CodexHooksOptions = {}): CodexHooksStatus {
  const file = codexHooksPath(options);
  const value = readHooksFile(file);
  const status = statusFor(file, options.cwd, options.env, value, resolveGuardMode(options));
  status.display_path = displayHomePath(file, { cwd: options.cwd, env: options.env });
  return status;
}

/** Install or refresh the Baton hook while preserving every unrelated entry. */
export function installCodexHooks(options: CodexHooksOptions = {}): CodexHooksInstallResult {
  const file = codexHooksPath(options);
  const guardMode = resolveGuardMode(options);
  // Guard-off is deliberately a zero-hook posture and must not require a
  // usable executable merely to remove stale Baton entries.
  const command = guardMode === "off" ? BATON_CODEX_HOOK_COMMAND : resolveCodexHookCommand(options);
  const before = readHooksFile(file);
  // Explicit off with no existing integration is a true zero-hook/no-file
  // posture. Do not create an empty hooks.json merely to report that state.
  if (guardMode === "off" && before == null) {
    const status = statusFor(file, options.cwd, options.env, null, guardMode);
    status.display_path = displayHomePath(file, { cwd: options.cwd, env: options.env });
    return { ...status, changed: false, action: "kept" };
  }
  const merged = mergeBatonCodexHooks(before || {}, command, guardMode);
  const beforeText = before == null ? null : `${JSON.stringify(before, null, 2)}\n`;
  const afterText = `${JSON.stringify(merged, null, 2)}\n`;
  const changed = beforeText !== afterText;
  if (changed && guardMode === "off" && emptyCodexDocument(merged)) {
    fs.unlinkSync(file);
    const status = statusFor(file, options.cwd, options.env, null, guardMode);
    status.display_path = displayHomePath(file, { cwd: options.cwd, env: options.env });
    return { ...status, changed: true, action: "updated" };
  }
  if (changed) writeJsonAtomic(file, merged);
  const status = statusFor(file, options.cwd, options.env, merged, guardMode);
  status.display_path = displayHomePath(file, { cwd: options.cwd, env: options.env });
  return {
    ...status,
    changed,
    action: changed ? (before ? "updated" : "installed") : "kept",
  };
}

/** Resolve the bundled template for tests and package consumers. */
export function codexHookTemplatePath(): string {
  return path.join(packageRoot(), "templates", "hosts", "codex", "hooks.json");
}

export function loadCodexHookTemplate(file = codexHookTemplatePath()): HooksFile {
  const value = readHooksFile(file);
  if (!value) throw new Error(`CODEX_HOOK_TEMPLATE_MISSING: ${file}`);
  return value;
}
