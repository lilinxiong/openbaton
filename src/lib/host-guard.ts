import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configPath, receiptsDir, runsDir } from "./paths.js";
import { currentBatonHookTargets } from "./codex-hooks.js";
import { findBinaryOnPath, isExecutableFile } from "./executables.js";
import { listSpawns, type SpawnTicket } from "./spawn.js";

/** Stable machine-readable reasons emitted by the Codex hook. */
export const HOST_GUARD_REASONS = {
  invalid_input: "BATON_GUARD_INVALID_INPUT",
  state_unavailable: "BATON_GUARD_STATE_UNAVAILABLE",
  not_initialized: "BATON_GUARD_NOT_INITIALIZED",
  director_shell: "BATON_GUARD_DIRECTOR_SHELL_REQUIRES_BOUND_AGENT",
  director_code_write: "BATON_GUARD_DIRECTOR_CODE_WRITE_REQUIRES_BOUND_AGENT",
  spawn_bind_pending: "BATON_GUARD_SPAWN_BIND_PENDING",
  agent_identity_required: "BATON_GUARD_AGENT_IDENTITY_REQUIRED",
  agent_identity_mismatch: "BATON_GUARD_AGENT_IDENTITY_MISMATCH",
  no_reserved_ticket: "BATON_GUARD_NO_RESERVED_TICKET",
  ambiguous_reserved_ticket: "BATON_GUARD_AMBIGUOUS_RESERVED_TICKET",
  nested_agent: "BATON_GUARD_NESTED_AGENT_DISALLOWED",
  ticket_not_active: "BATON_GUARD_TICKET_NOT_ACTIVE",
  write_receipt_required: "BATON_GUARD_WRITE_RECEIPT_REQUIRED",
  commit_only_command: "BATON_GUARD_COMMIT_ONLY_COMMAND",
} as const;

export type HostGuardReason = (typeof HOST_GUARD_REASONS)[keyof typeof HOST_GUARD_REASONS];

export interface HookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
  agent_id?: unknown;
  agentId?: unknown;
  turn_id?: unknown;
  turnId?: unknown;
  subagent_id?: unknown;
  subagentId?: unknown;
  agent_type?: unknown;
  ticket_id?: unknown;
  ticketId?: unknown;
  [key: string]: unknown;
}

export interface GuardTicket {
  id: string;
  status: string;
  mode: string;
  read_only: boolean;
  agent_id: string | null;
  host: string | null;
  dispatch_host: string | null;
  receipt_id: string | null;
  allowed_operations: string[];
  write_allowlist: string[];
}

export interface GuardBinding {
  ticket_id: string;
  agent_id: string;
  turn_id: string | null;
  session_id: string | null;
  agent_type: string | null;
  state: "pending" | "bound";
  observed_at: string;
}

export interface HostGuardState {
  active: boolean;
  initialized: boolean;
  tickets: GuardTicket[];
  bindings: GuardBinding[];
  state_error?: string | null;
}

export interface HostGuardOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runtimePath?: string;
  entryPath?: string;
  executablePath?: string;
  state?: HostGuardState;
  bindingPath?: string;
  now?: Date | string | number;
  /**
   * Host whose guard is evaluating this hook. Each guard-capable host serves
   * only its own tickets; a ticket from another host is never gated or
   * satisfied here. Defaults to Codex for legacy unqualified hook installs.
   */
  host?: string;
}

/** Guard-capable hosts share one policy; the serving host scopes every ticket lookup. */
export const DEFAULT_GUARD_HOST = "codex";

function guardHost(options: HostGuardOptions): string {
  return String(options.host || "").trim().toLowerCase() || DEFAULT_GUARD_HOST;
}

export interface GuardDecision {
  allowed: boolean;
  event: string;
  tool_name?: string;
  reason: string | null;
  ticket_id: string | null;
  agent_id: string | null;
  output: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function isoNow(value?: Date | string | number): string {
  const date = value instanceof Date ? value : value == null ? new Date() : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function normalizeTicket(ticket: SpawnTicket): GuardTicket {
  const receipt = ticket.receipt_id ? readReceiptShape(ticket, ticket.receipt_id) : null;
  return {
    id: String(ticket.id || ""),
    status: String(ticket.status || ""),
    mode: String(ticket.mode || (ticket.read_only ? "read-only" : "write")),
    read_only: ticket.read_only !== false,
    agent_id: stringValue(ticket.agent_id),
    host: stringValue(ticket.host),
    dispatch_host: stringValue(ticket.dispatch_host),
    receipt_id: stringValue(ticket.receipt_id),
    allowed_operations: receipt?.allowed_operations || [],
    write_allowlist: receipt?.write_allowlist || [],
  };
}

/** Read only enough Receipt data for the host gate; malformed Receipts fail closed. */
function readReceiptShape(ticket: SpawnTicket, receiptId: string): { allowed_operations: string[]; write_allowlist: string[] } | null {
  try {
    const cwd = (ticket as unknown as { __cwd?: string }).__cwd;
    if (!cwd) return null;
    const file = path.join(receiptsDir(cwd), `${receiptId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const scope = record(parsed.scope) ? parsed.scope : {};
    return {
      allowed_operations: Array.isArray(scope.allowed_operations) ? scope.allowed_operations.map(String) : [],
      write_allowlist: Array.isArray(scope.write_allowlist) ? scope.write_allowlist.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** Convert a raw ticket while looking up receipts under the supplied workspace. */
function normalizeTickets(cwd: string, tickets: SpawnTicket[]): GuardTicket[] {
  return tickets.map((ticket) => {
    const withCwd = { ...ticket, __cwd: cwd } as SpawnTicket & { __cwd: string };
    return normalizeTicket(withCwd);
  }).filter((ticket) => ticket.id);
}

function normalizeProvidedTicket(ticket: GuardTicket): GuardTicket {
  return {
    id: String(ticket?.id || ""),
    status: String(ticket?.status || ""),
    mode: String(ticket?.mode || (ticket?.read_only ? "read-only" : "write")),
    read_only: ticket?.read_only !== false,
    agent_id: stringValue(ticket?.agent_id),
    host: stringValue(ticket?.host),
    dispatch_host: stringValue(ticket?.dispatch_host),
    receipt_id: stringValue(ticket?.receipt_id),
    allowed_operations: Array.isArray(ticket?.allowed_operations) ? ticket.allowed_operations.map(String) : [],
    write_allowlist: Array.isArray(ticket?.write_allowlist) ? ticket.write_allowlist.map(String) : [],
  };
}

function normalizeProvidedBinding(value: unknown): GuardBinding | null {
  if (!record(value)) return null;
  const ticketId = stringValue(value.ticket_id);
  const agentId = stringValue(value.agent_id);
  if (!ticketId || !agentId) return null;
  return {
    ticket_id: ticketId,
    agent_id: agentId,
    turn_id: stringValue(value.turn_id ?? value.turnId),
    session_id: stringValue(value.session_id),
    agent_type: stringValue(value.agent_type),
    state: value.state === "bound" ? "bound" : "pending",
    observed_at: String(value.observed_at || ""),
  };
}

interface BindingReadResult {
  bindings: GuardBinding[];
  error: string | null;
}

function readBindings(file: string): BindingReadResult {
  if (!fs.existsSync(file)) return { bindings: [], error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return { bindings: [], error: "host guard bindings must be an array" };
    }
    const bindings: GuardBinding[] = [];
    for (const item of parsed) {
      if (!record(item)) return { bindings: [], error: "host guard binding entry must be an object" };
      const ticketId = stringValue(item.ticket_id);
      const agentId = stringValue(item.agent_id);
      if (!ticketId || !agentId) {
        return { bindings: [], error: "host guard binding entry is missing ticket_id or agent_id" };
      }
      bindings.push({
        ticket_id: ticketId,
        agent_id: agentId,
        turn_id: stringValue(item.turn_id ?? item.turnId),
        session_id: stringValue(item.session_id),
        agent_type: stringValue(item.agent_type),
        state: item.state === "bound" ? "bound" : "pending",
        observed_at: String(item.observed_at || ""),
      });
    }
    return { bindings, error: null };
  } catch (error) {
    return {
      bindings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function bindingsPath(cwd: string, options: HostGuardOptions): string {
  return options.bindingPath || path.join(runsDir(cwd, options.env), "host-guard-bindings.json");
}

/**
 * Load the user-global workspace state used by the host hook. The hook is
 * fail-closed when state is missing or malformed; `baton ...` control-plane
 * commands remain usable so the user can initialize or repair the state.
 */
export function loadHostGuardState(cwd: string, options: HostGuardOptions = {}): HostGuardState {
  if (options.state) {
    const rawTickets: unknown = (options.state as unknown as Record<string, unknown>).tickets;
    const rawBindings: unknown = (options.state as unknown as Record<string, unknown>).bindings;
    const tickets = Array.isArray(rawTickets)
      ? rawTickets.map((item) => record(item) && stringValue(item.id) ? normalizeProvidedTicket(item as unknown as GuardTicket) : null)
      : [];
    const malformedTickets = rawTickets !== undefined
      && (!Array.isArray(rawTickets) || tickets.some((item) => item === null));
    const bindings = Array.isArray(rawBindings)
      ? rawBindings.map(normalizeProvidedBinding)
      : [];
    const malformedBindings = rawBindings !== undefined
      && (!Array.isArray(rawBindings) || bindings.some((item) => item === null));
    return {
      active: options.state.active !== false,
      initialized: options.state.initialized !== false,
      tickets: tickets.filter((item): item is GuardTicket => item !== null),
      bindings: bindings.filter((item): item is GuardBinding => item !== null),
      state_error: options.state.state_error
        || (malformedTickets ? "host guard tickets are malformed" : null)
        || (malformedBindings ? "host guard bindings are malformed" : null),
    };
  }
  const env = options.env || process.env;
  const initialized = fs.existsSync(configPath(cwd, { env }));
  const active = String(env.BATON_GUARD_DISABLED || "") !== "1";
  let tickets: GuardTicket[] = [];
  let stateError: string | null = null;
  try {
    const raw = listSpawns(cwd);
    tickets = normalizeTickets(cwd, raw);
  } catch (error) {
    stateError = error instanceof Error ? error.message : String(error);
  }
  const bindingResult = readBindings(bindingsPath(cwd, options));
  if (bindingResult.error) stateError = stateError || bindingResult.error;
  return {
    active,
    initialized,
    tickets,
    bindings: bindingResult.bindings,
    state_error: stateError,
  };
}

export const readHostGuardState = loadHostGuardState;
export const readGuardState = loadHostGuardState;

/** Grok sends camelCase keys and snake_case event values. Codex/Claude use Pascal/snake fields. */
export function normalizeHookInput(raw: unknown): HookInput {
  if (!record(raw)) return {};
  const eventRaw = stringValue(raw.hook_event_name) || stringValue(raw.hookEventName) || "";
  const lower = eventRaw.toLowerCase().replaceAll("-", "_");
  const event = lower === "pre_tool_use" ? "PreToolUse"
    : lower === "subagent_start" ? "SubagentStart"
    : eventRaw;
  const nestedInput = record(raw.tool_input) ? raw.tool_input : record(raw.toolInput) ? raw.toolInput : {};
  return {
    ...raw,
    hook_event_name: event || undefined,
    cwd: stringValue(raw.cwd) || stringValue(raw.workspaceRoot) || raw.cwd,
    tool_name: stringValue(raw.tool_name) || stringValue(raw.toolName) || raw.tool_name,
    tool_input: nestedInput,
    session_id: stringValue(raw.session_id) || stringValue(raw.sessionId) || raw.session_id,
    tool_use_id: stringValue(raw.tool_use_id) || stringValue(raw.toolUseId) || raw.tool_use_id,
    agent_id: stringValue(raw.agent_id) || stringValue(raw.agentId) || raw.agent_id,
    agent_type: stringValue(raw.agent_type)
      || stringValue(raw.agentType)
      || stringValue(raw.subagentType)
      || stringValue(raw.subagent_type)
      || raw.agent_type,
    turn_id: stringValue(raw.turn_id) || stringValue(raw.turnId) || raw.turn_id,
    promptId: stringValue(raw.promptId) || stringValue(raw.prompt_id) || raw.promptId,
    subagentType: stringValue(raw.subagentType) || stringValue(raw.subagent_type) || raw.subagentType,
  };
}

export function canonicalGuardToolName(name: string | null): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  if (lower === "bash" || lower === "run_terminal_command") return "Bash";
  if (lower === "edit" || lower === "write" || lower === "multiedit" || lower === "search_replace") return "Edit";
  if (lower === "apply_patch") return "apply_patch";
  if (lower === "agent" || lower === "spawn_subagent" || lower === "task") return "Agent";
  return name.trim();
}

function eventName(input: HookInput, fallback = "PreToolUse"): string {
  return stringValue(input.hook_event_name) || fallback;
}

function toolName(input: HookInput): string | null {
  return canonicalGuardToolName(stringValue(input.tool_name));
}

function toolInput(input: HookInput): Record<string, unknown> {
  return record(input.tool_input) ? input.tool_input : {};
}

function hookAgentType(input: HookInput): string | null {
  const candidates = [input.agent_type, input.agentType, input.subagentType, input.subagent_type];
  for (const value of candidates) {
    const type = stringValue(value);
    if (type) return type;
  }
  const nested = toolInput(input);
  for (const key of ["agent_type", "agentType", "subagentType", "subagent_type"]) {
    const type = stringValue(nested[key]);
    if (type) return type;
  }
  return null;
}

function isRootIdentity(input: HookInput): boolean {
  const type = hookAgentType(input)?.toLowerCase();
  return type === "root"
    || type === "root_agent"
    || type === "main"
    || type === "director"
    || type === "parent";
}

/**
 * Grok child sessions set `subagentType` and omit Codex `agent_id`. The main
 * session omits `subagentType`, which is what keeps the director gated.
 */
function grokSubagentPayload(input: HookInput): boolean {
  return Boolean(hookAgentType(input)) && !isRootIdentity(input);
}

function hookTurnIdentity(input: HookInput): string | null {
  const candidates = [input.turn_id, input.turnId];
  if (grokSubagentPayload(input)) candidates.push(input.promptId, input.prompt_id);
  for (const value of candidates) {
    const id = stringValue(value);
    if (id) return id;
  }
  const nested = toolInput(input);
  const nestedKeys = grokSubagentPayload(input)
    ? ["turn_id", "turnId", "promptId", "prompt_id"]
    : ["turn_id", "turnId"];
  for (const key of nestedKeys) {
    const id = stringValue(nested[key]);
    if (id) return id;
  }
  return null;
}

/** The Codex schema currently exposes agent_id on SubagentStart; accept aliases for host-version skew. */
export function hookAgentIdentity(input: HookInput): string | null {
  const candidates = [input.agent_id, input.agentId, input.subagent_id, input.subagentId];
  for (const value of candidates) {
    const id = stringValue(value);
    if (id) return id;
  }
  const nested = toolInput(input);
  for (const key of ["agent_id", "agentId", "subagent_id", "subagentId", "native_agent_id"]) {
    const id = stringValue(nested[key]);
    if (id) return id;
  }
  return null;
}

function ticketIdFromInput(input: HookInput): string | null {
  const direct = stringValue(input.ticket_id) || stringValue(input.ticketId);
  if (direct) return direct;
  const nested = toolInput(input);
  const nestedId = stringValue(nested.ticket_id) || stringValue(nested.ticketId);
  if (nestedId) return nestedId;
  const text = [nested.prompt, nested.description, nested.task, nested.input].map(stringValue).filter(Boolean).join(" ");
  return text.match(/\bspn-[0-9]{4,}\b/)?.[0] || null;
}

function sessionId(input: HookInput): string | null {
  return stringValue(input.session_id);
}

function reasonOutput(event: string, reason: string, host: string): Record<string, unknown> {
  const body = event === "PreToolUse" ? {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  } : {
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: reason,
    },
  };
  if (host !== "grok") return body;
  return { decision: "deny", reason, ...body };
}

function allowOutput(event: string, host: string, additionalContext?: string): Record<string, unknown> {
  const body = event === "PreToolUse" ? {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  } : additionalContext ? {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext,
    },
  } : {};
  if (host !== "grok") return body;
  return { decision: "allow", ...body };
}

function denied(event: string, reason: HostGuardReason, input: HookInput, ticketId: string | null = null, agentId: string | null = null, host = DEFAULT_GUARD_HOST): GuardDecision {
  return {
    allowed: false,
    event,
    ...(toolName(input) ? { tool_name: toolName(input)! } : {}),
    reason,
    ticket_id: ticketId,
    agent_id: agentId,
    output: reasonOutput(event, reason, host),
  };
}

function allowed(event: string, input: HookInput, ticketId: string | null = null, agentId: string | null = null, additionalContext?: string, host = DEFAULT_GUARD_HOST): GuardDecision {
  return {
    allowed: true,
    event,
    ...(toolName(input) ? { tool_name: toolName(input)! } : {}),
    reason: null,
    ticket_id: ticketId,
    agent_id: agentId,
    output: allowOutput(event, host, additionalContext),
  };
}

/** A ticket belongs to the guard only when it names the serving host. */
function isGuardTicket(ticket: GuardTicket, host: string): boolean {
  return (ticket.host || ticket.dispatch_host || DEFAULT_GUARD_HOST) === host;
}

function currentRunning(state: HostGuardState, agentId: string | null, host: string): GuardTicket | null {
  if (!agentId) return null;
  return state.tickets.find((ticket) => ticket.status === "running"
    && ticket.agent_id === agentId
    && isGuardTicket(ticket, host)) || null;
}

function bindingForTurn(state: HostGuardState, turnId: string | null): GuardBinding | null {
  if (!turnId) return null;
  const matches = state.bindings.filter((item) => item.turn_id === turnId);
  return matches.length === 1 ? matches[0] : null;
}

function bindingForSession(state: HostGuardState, session: string | null): GuardBinding | null {
  if (!session) return null;
  const matches = state.bindings.filter((item) => item.session_id === session);
  return matches.length === 1 ? matches[0] : null;
}

function bindingConflictForTurn(state: HostGuardState, turnId: string | null, ticketId: string, agentId: string): boolean {
  if (!turnId) return false;
  return state.bindings.some((item) => item.turn_id === turnId
    && (item.ticket_id !== ticketId || item.agent_id !== agentId));
}

function runningByBinding(
  state: HostGuardState,
  agentId: string | null,
  host: string,
  turnId: string | null = null,
  input: HookInput | null = null,
): GuardTicket | null {
  if (!agentId && !turnId) return null;
  const binding = turnId
    ? bindingForTurn(state, turnId)
    : state.bindings.find((item) => item.agent_id === agentId) || null;
  if (!binding) return null;
  if (agentId && binding.agent_id !== agentId) return null;
  const ticket = state.tickets.find((item) => item.status === "running"
    && item.id === binding.ticket_id
    && isGuardTicket(item, host)) || null;
  if (!ticket?.agent_id) return null;
  if (ticket.agent_id === binding.agent_id) return ticket;
  // Grok bind uses the spawn return id; SubagentStart may have recorded sessionId.
  if (host === "grok" && input && grokSubagentPayload(input)) return ticket;
  return null;
}

function reservedTickets(state: HostGuardState, host: string): GuardTicket[] {
  return state.tickets.filter((ticket) => ticket.status === "dispatching"
    && (ticket.dispatch_host || ticket.host || DEFAULT_GUARD_HOST) === host);
}

function grokRunningTickets(state: HostGuardState, host: string): GuardTicket[] {
  return state.tickets.filter((ticket) => ticket.status === "running"
    && ticket.agent_id
    && isGuardTicket(ticket, host));
}

/**
 * Grok PreToolUse inside a child has `subagentType` and a child `sessionId`,
 * not Codex `agent_id`. Match the bound ticket by recorded session, or by the
 * unique running Grok ticket when only one worker is live.
 */
function grokBoundWorker(state: HostGuardState, input: HookInput, host: string): GuardTicket | null {
  if (host !== "grok" || !grokSubagentPayload(input)) return null;
  const bySession = bindingForSession(state, sessionId(input));
  if (bySession) {
    const ticket = state.tickets.find((item) => item.id === bySession.ticket_id && isGuardTicket(item, host));
    if (ticket?.status === "running" && ticket.agent_id) return ticket;
  }
  const running = grokRunningTickets(state, host);
  return running.length === 1 ? running[0] : null;
}

function findReserved(state: HostGuardState, input: HookInput, host: string): GuardTicket | null {
  const reserved = reservedTickets(state, host);
  const requestedId = ticketIdFromInput(input);
  if (requestedId) return reserved.find((ticket) => ticket.id === requestedId) || null;
  return reserved.length === 1 ? reserved[0] : null;
}

function exclusiveGitTickets(state: HostGuardState, host: string): GuardTicket[] {
  return state.tickets.filter((ticket) => (ticket.status === "running" || ticket.status === "dispatching")
    && isGuardTicket(ticket, host)
    && (ticket.mode === "commit-only" || ticket.mode === "write"));
}

/** Director-only caller: not a Grok child session and not a bound native agent_id. */
function isDirectorCaller(input: HookInput): boolean {
  if (grokSubagentPayload(input)) return false;
  const id = hookAgentIdentity(input);
  return !id || isRootIdentity(input);
}

const READ_ONLY_GIT_VERBS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree",
  "describe", "cat-file", "blame", "shortlog", "name-rev", "rev-list",
  "symbolic-ref", "version", "help", "grep", "reflog", "var",
  "check-ignore", "check-attr",
]);

const DIRECTOR_STAGE_LONG_FLAGS = new Set([
  "--all",
  "--update",
  "--verbose",
  "--dry-run",
  "--force",
  "--intent-to-add",
]);

function gitVerb(tokens: string[]): string | null {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "-C" || token === "-c") {
      index += 2;
      continue;
    }
    if (token === "--no-pager" || token === "-P" || token === "--literal-pathspecs" || token === "--no-optional-locks") {
      index += 1;
      continue;
    }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("-c")) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return null;
    return token;
  }
  return null;
}

function gitArgsAfterVerb(tokens: string[]): string[] {
  const verb = gitVerb(tokens);
  if (!verb) return [];
  const index = tokens.lastIndexOf(verb);
  return index >= 0 ? tokens.slice(index + 1) : [];
}

/** Standalone read-only git used to inspect a worktree without a bound worker. */
export function isReadOnlyGitCommand(command: unknown): boolean {
  const tokens = standaloneCommandTokens(String(command || "").trim());
  if (!tokens || tokens[0] !== "git") return false;
  const verb = gitVerb(tokens);
  if (!verb) return false;
  if (READ_ONLY_GIT_VERBS.has(verb)) return true;
  const rest = gitArgsAfterVerb(tokens);
  if (verb === "remote") {
    return rest.every((item) => !["add", "remove", "rm", "rename", "set-url", "prune"].includes(item));
  }
  if (verb === "branch") {
    return !rest.some((item) => /^-([dDmcC]|[^-]*[dDmcC])/.test(item)
      || item === "--delete" || item === "--move" || item === "--copy");
  }
  return false;
}

/**
 * Standalone `git add` used to freeze a commit-only tree. Composition, patch
 * mode, and every other git verb stay denied on the director.
 */
export function isDirectorStageCommand(command: unknown): boolean {
  const tokens = standaloneCommandTokens(String(command || "").trim());
  if (!tokens || tokens[0] !== "git" || gitVerb(tokens) !== "add") return false;
  for (const token of gitArgsAfterVerb(tokens)) {
    if (token === "--" || token === ".") continue;
    if (token.startsWith("--")) {
      if (!DIRECTOR_STAGE_LONG_FLAGS.has(token)) return false;
      continue;
    }
    if (token.startsWith("-") && !/^-([AuvnfN]+)$/.test(token)) return false;
  }
  return true;
}

/**
 * A shell write is intentionally conservative. Receipt/Git audits remain the
 * authoritative path-level check after a worker finishes, while this gate
 * prevents an unbound director from starting any obvious mutation.
 */
export function isShellWriteCommand(command: unknown): boolean {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(?:^|[\s;&|])(?:sudo\s+)?(?:rm|rmdir|mv|cp|mkdir|install|ln|touch|tee|dd|truncate|chmod|chown|unlink)\b/i.test(text)
    || /\b(?:git\s+(?:add|commit|reset|restore|checkout|switch|branch|merge|rebase|cherry-pick|revert|tag|stash|clean|push)|npm\s+install|pnpm\s+install|yarn\s+add|bun\s+add)\b/i.test(text)
    || /(?:^|\s)(?:\d?>|>>|&>)/.test(text)
    || /\b(?:sed|perl)\s+-[[:alnum:]]*i\b/i.test(text)
    || /\b(?:python|python3|node|ruby)\b[^\n]*(?:writeFile|writeFileSync|open\([^\n]*["']w)/i.test(text);
}

/**
 * Recognize only a standalone Baton executable invocation. Shell composition
 * is rejected so `baton ...; rm ...` cannot use the control-plane exemption.
 */
export interface BatonControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  runtimePath?: string;
  entryPath?: string;
  executablePath?: string;
}

function standaloneCommandTokens(command: string): string[] | null {
  if (!command || /[\r\n;|&<>]/.test(command) || command.includes(String.fromCharCode(96)) || command.includes("$(")) return null;
  const matches = command.match(/(?:\"[^\"]*\"|'[^']*'|\S+)/g);
  if (!matches) return null;
  const tokens = matches.map((token) => token.replace(/^(['\"])(.*)\1$/, "$2"));
  if (tokens[0] === "env") {
    tokens.shift();
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  }
  return tokens.length ? tokens : null;
}

function sameExecutable(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function trustedAbsoluteBatonCommand(tokens: string[], options: BatonControlPlaneOptions): boolean {
  const first = tokens[0];
  if (!first || !first.includes("/") || !isExecutableFile(first)) return false;
  const targets = currentBatonHookTargets(options);
  if (tokens.length >= 2 && tokens[1].includes("/")) {
    return targets.some((target) => Boolean(target.runtime)
      && sameExecutable(first, target.runtime)
      && sameExecutable(tokens[1], target.entry));
  }
  return targets.some((target) => sameExecutable(first, target.executable));
}

export function isBatonControlPlaneCommand(command: unknown, options: BatonControlPlaneOptions = {}): boolean {
  const tokens = standaloneCommandTokens(String(command || "").trim());
  if (!tokens) return false;
  const executable = tokens[0];
  const base = path.basename(executable);
  if (!executable.includes("/")) {
    if (base !== "baton" && base !== "baton.js") return false;
    const resolved = findBinaryOnPath(executable, options.env || process.env);
    return Boolean(resolved && isExecutableFile(resolved));
  }
  return trustedAbsoluteBatonCommand(tokens, options);
}

function hasWriteAuthorization(ticket: GuardTicket): boolean {
  return ticket.status === "running"
    && ticket.mode === "write"
    && !ticket.read_only
    && ticket.write_allowlist.length > 0
    && ticket.allowed_operations.some((item) => ["write", "create", "delete", "rename", "chmod"].includes(item));
}

function hasCommitAuthorization(ticket: GuardTicket, command: string): boolean {
  const normalized = command.trim();
  return ticket.status === "running"
    && ticket.mode === "commit-only"
    && !ticket.read_only
    && ticket.allowed_operations.includes("commit")
    && /^git\s+commit(?:\s|$)/i.test(normalized)
    && !/[\r\n;&|<>`]|\$\(/.test(normalized)
    && !/\b(?:--amend|--all|-a|--only|--include|push|reset|restore|checkout|switch|branch|merge|rebase|cherry-pick|revert|tag|stash|clean)\b/i.test(command);
}

function identityFor(state: HostGuardState, input: HookInput, host: string): {
  id: string | null;
  turnId: string | null;
  binding: GuardBinding | null;
  ticket: GuardTicket | null;
} {
  const id = hookAgentIdentity(input);
  const turnId = hookTurnIdentity(input);
  const binding = bindingForTurn(state, turnId)
    || (host === "grok" && grokSubagentPayload(input) ? bindingForSession(state, sessionId(input)) : null);
  if (isRootIdentity(input)) return { id, turnId, binding, ticket: null };
  if (binding && id && binding.agent_id !== id) return { id, turnId, binding, ticket: null };
  return {
    id,
    turnId,
    binding,
    ticket: runningByBinding(state, id, host, turnId, input)
      || (turnId && binding ? null : currentRunning(state, id, host))
      || grokBoundWorker(state, input, host),
  };
}

/** Enforce the director/worker boundary for the official PreToolUse event. */
export function evaluatePreToolUse(raw: HookInput, options: HostGuardOptions = {}): GuardDecision {
  const input = normalizeHookInput(raw);
  const event = eventName(input);
  const cwd = stringValue(input.cwd) || options.cwd || process.cwd();
  const state = loadHostGuardState(cwd, options);
  const host = guardHost(options);
  const name = toolName(input);
  const command = stringValue(toolInput(input).command) || "";
  const deny = (reason: HostGuardReason, ticketId: string | null = null, agentId: string | null = null) =>
    denied(event, reason, input, ticketId, agentId, host);
  const allow = (ticketId: string | null = null, agentId: string | null = null, extra?: string) =>
    allowed(event, input, ticketId, agentId, extra, host);
  if (!state.active) return allow();
  if (!name) return deny(HOST_GUARD_REASONS.invalid_input);
  if (name === "Bash" && isBatonControlPlaneCommand(command, {
    env: options.env,
    runtimePath: options.runtimePath,
    entryPath: options.entryPath,
    executablePath: options.executablePath,
  })) return allow();
  if (state.state_error) return deny(HOST_GUARD_REASONS.state_unavailable);
  if (name === "Bash" && isDirectorCaller(input) && isReadOnlyGitCommand(command)) return allow();
  if (name === "Bash" && isDirectorCaller(input) && isDirectorStageCommand(command)) {
    if (exclusiveGitTickets(state, host).some((ticket) => ticket.mode === "commit-only")) {
      return deny(HOST_GUARD_REASONS.commit_only_command);
    }
    return allow();
  }
  if (name !== "Bash" && name !== "apply_patch" && name !== "Edit" && name !== "Write" && name !== "Agent") {
    // Codex may route specialized tools around this hook. Keep this explicit:
    // the installed matcher covers only the tools for which the policy exists.
    return allow();
  }

  if (name === "Agent") {
    if (!state.initialized) {
      if (host === "grok") return allow();
      return deny(HOST_GUARD_REASONS.not_initialized);
    }
    const spawnIdentity = identityFor(state, input, host);
    if (spawnIdentity.ticket) return deny(HOST_GUARD_REASONS.nested_agent, spawnIdentity.ticket.id, spawnIdentity.id);
    const reserved = reservedTickets(state, host);
    if (!reserved.length) {
      if (host === "grok") return allow();
      return deny(HOST_GUARD_REASONS.no_reserved_ticket);
    }
    const matched = findReserved(state, input, host);
    if (!matched) {
      return deny(reserved.length > 1
        ? HOST_GUARD_REASONS.ambiguous_reserved_ticket
        : HOST_GUARD_REASONS.no_reserved_ticket);
    }
    return allow(matched.id, null);
  }

  if (!state.initialized) {
    if (host === "grok") return allow();
    return deny(HOST_GUARD_REASONS.not_initialized);
  }
  const identity = identityFor(state, input, host);
  if (!identity.ticket) {
    if (host === "grok") {
      const mutating = name === "apply_patch" || name === "Edit" || name === "Write"
        || (name === "Bash" && (isShellWriteCommand(command) || isDirectorStageCommand(command)));
      if (identity.binding && identity.binding.state === "pending" && mutating) {
        return deny(HOST_GUARD_REASONS.spawn_bind_pending, identity.binding.ticket_id, identity.id);
      }
      if (mutating && exclusiveGitTickets(state, host).some((ticket) => ticket.mode === "commit-only")) {
        return deny(HOST_GUARD_REASONS.commit_only_command);
      }
      return allow();
    }
    const hasAnotherBoundAgent = Boolean(identity.id) && state.tickets.some((ticket) => ticket.status === "running"
      && ticket.agent_id
      && isGuardTicket(ticket, host)
      && ticket.agent_id !== identity.id);
    const reason = isRootIdentity(input) && identity.binding
      ? HOST_GUARD_REASONS.agent_identity_mismatch
      : isRootIdentity(input)
        ? (name === "Bash" ? HOST_GUARD_REASONS.director_shell : HOST_GUARD_REASONS.director_code_write)
      : identity.binding && identity.id && identity.binding.agent_id !== identity.id
      ? HOST_GUARD_REASONS.agent_identity_mismatch
      : identity.binding && identity.binding.ticket_id
        ? HOST_GUARD_REASONS.spawn_bind_pending
      : reservedTickets(state, host).length > 0
      ? HOST_GUARD_REASONS.spawn_bind_pending
      : grokSubagentPayload(input) && grokRunningTickets(state, host).length > 1
      ? HOST_GUARD_REASONS.agent_identity_mismatch
      : hasAnotherBoundAgent
        ? HOST_GUARD_REASONS.agent_identity_mismatch
      : name === "Bash"
        ? HOST_GUARD_REASONS.director_shell
        : HOST_GUARD_REASONS.director_code_write;
    return deny(reason, null, identity.id);
  }

  if (name === "Bash") {
    if (isShellWriteCommand(command)) {
      if (hasCommitAuthorization(identity.ticket, command)) return allow(identity.ticket.id, identity.id);
      if (!hasWriteAuthorization(identity.ticket)) {
        return deny(identity.ticket.mode === "commit-only"
          ? HOST_GUARD_REASONS.commit_only_command
          : HOST_GUARD_REASONS.write_receipt_required, identity.ticket.id, identity.id);
      }
    }
    return allow(identity.ticket.id, identity.id);
  }

  if (!hasWriteAuthorization(identity.ticket)) {
    return deny(identity.ticket.mode === "commit-only"
      ? HOST_GUARD_REASONS.commit_only_command
      : HOST_GUARD_REASONS.write_receipt_required, identity.ticket.id, identity.id);
  }
  return allow(identity.ticket.id, identity.id);
}

function writeBindings(file: string, bindings: GuardBinding[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(bindings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function recordPendingBinding(
  cwd: string,
  input: HookInput,
  state: HostGuardState,
  ticket: GuardTicket,
  options: HostGuardOptions,
  bindingState: GuardBinding["state"] = "pending",
  resolvedAgentId: string | null = null,
): void {
  const agentId = resolvedAgentId || hookAgentIdentity(input) || sessionId(input);
  if (!agentId) return;
  const turnId = hookTurnIdentity(input);
  const current = options.state
    ? state.bindings
    : readBindings(bindingsPath(cwd, options)).bindings;
  const bindings = current.filter((item) => item.agent_id !== agentId
    && item.ticket_id !== ticket.id
    && item.turn_id !== turnId);
  bindings.push({
    ticket_id: ticket.id,
    agent_id: agentId,
    turn_id: turnId,
    session_id: sessionId(input),
    agent_type: hookAgentType(input),
    state: bindingState,
    observed_at: isoNow(options.now),
  });
  if (!options.state) writeBindings(bindingsPath(cwd, options), bindings);
  if (options.state) options.state.bindings = bindings;
  state.bindings = bindings;
}

/**
 * SubagentStart cannot cancel a child according to the Codex contract. It
 * records the native identity and emits a deterministic context message; the
 * actual PreToolUse gate remains closed until `dispatch bind` observes it.
 */
export function evaluateSubagentStart(raw: HookInput, options: HostGuardOptions = {}): GuardDecision {
  const input = normalizeHookInput(raw);
  const event = "SubagentStart";
  const cwd = stringValue(input.cwd) || options.cwd || process.cwd();
  const state = loadHostGuardState(cwd, options);
  const host = guardHost(options);
  const deny = (reason: HostGuardReason, ticketId: string | null = null, agentId: string | null = null) =>
    denied(event, reason, input, ticketId, agentId, host);
  const allow = (ticketId: string | null = null, agentId: string | null = null, extra?: string) =>
    allowed(event, input, ticketId, agentId, extra, host);
  if (!state.active) return allow();
  if (state.state_error) return deny(HOST_GUARD_REASONS.state_unavailable);
  if (!state.initialized) return deny(HOST_GUARD_REASONS.not_initialized);
  const agentId = hookAgentIdentity(input) || (host === "grok" ? sessionId(input) : null);
  if (!agentId) return deny(HOST_GUARD_REASONS.agent_identity_required, null, null);
  const turnId = hookTurnIdentity(input);
  if (isRootIdentity(input)) {
    return deny(HOST_GUARD_REASONS.agent_identity_mismatch, null, agentId);
  }
  const existingBinding = bindingForTurn(state, turnId);
  if (bindingConflictForTurn(state, turnId, existingBinding?.ticket_id || "", agentId)) {
    return deny(HOST_GUARD_REASONS.agent_identity_mismatch, existingBinding?.ticket_id || null, agentId);
  }
  const bound = runningByBinding(state, agentId, host, turnId, input)
    || (turnId && existingBinding ? null : currentRunning(state, agentId, host));
  if (bound) {
    if (!existingBinding || existingBinding.agent_id !== agentId) {
      recordPendingBinding(cwd, input, state, bound, options, "bound", agentId);
    }
    return allow(bound.id, agentId, "BATON_GUARD_SUBAGENT_BOUND");
  }
  const reserved = findReserved(state, input, host);
  if (!reserved) {
    return deny(reservedTickets(state, host).length > 1
      ? HOST_GUARD_REASONS.ambiguous_reserved_ticket
      : HOST_GUARD_REASONS.no_reserved_ticket, null, agentId);
  }
  recordPendingBinding(cwd, input, state, reserved, options, "pending", agentId);
  return allow(reserved.id, agentId, "BATON_GUARD_SUBAGENT_PENDING_BIND");
}

export const guardPreToolUse = evaluatePreToolUse;
export const guardSubagentStart = evaluateSubagentStart;
export const evaluateHostGuard = evaluatePreToolUse;
