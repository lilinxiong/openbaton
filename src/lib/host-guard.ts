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

function eventName(input: HookInput, fallback = "PreToolUse"): string {
  return stringValue(input.hook_event_name) || fallback;
}

function toolName(input: HookInput): string | null {
  return stringValue(input.tool_name);
}

function toolInput(input: HookInput): Record<string, unknown> {
  return record(input.tool_input) ? input.tool_input : {};
}

function hookTurnIdentity(input: HookInput): string | null {
  const candidates = [input.turn_id, input.turnId];
  for (const value of candidates) {
    const id = stringValue(value);
    if (id) return id;
  }
  const nested = toolInput(input);
  for (const key of ["turn_id", "turnId"]) {
    const id = stringValue(nested[key]);
    if (id) return id;
  }
  return null;
}

function hookAgentType(input: HookInput): string | null {
  const direct = stringValue(input.agent_type);
  if (direct) return direct;
  return stringValue(toolInput(input).agent_type);
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

function reasonOutput(event: string, reason: string): Record<string, unknown> {
  if (event === "PreToolUse") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }
  return {
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: reason,
    },
  };
}

function allowOutput(event: string, additionalContext?: string): Record<string, unknown> {
  if (event === "PreToolUse") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    };
  }
  return additionalContext ? {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext,
    },
  } : {};
}

function denied(event: string, reason: HostGuardReason, input: HookInput, ticketId: string | null = null, agentId: string | null = null): GuardDecision {
  return {
    allowed: false,
    event,
    ...(toolName(input) ? { tool_name: toolName(input)! } : {}),
    reason,
    ticket_id: ticketId,
    agent_id: agentId,
    output: reasonOutput(event, reason),
  };
}

function allowed(event: string, input: HookInput, ticketId: string | null = null, agentId: string | null = null, additionalContext?: string): GuardDecision {
  return {
    allowed: true,
    event,
    ...(toolName(input) ? { tool_name: toolName(input)! } : {}),
    reason: null,
    ticket_id: ticketId,
    agent_id: agentId,
    output: allowOutput(event, additionalContext),
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

function bindingConflictForTurn(state: HostGuardState, turnId: string | null, ticketId: string, agentId: string): boolean {
  if (!turnId) return false;
  return state.bindings.some((item) => item.turn_id === turnId
    && (item.ticket_id !== ticketId || item.agent_id !== agentId));
}

function isRootIdentity(input: HookInput): boolean {
  const type = hookAgentType(input)?.toLowerCase();
  return type === "root"
    || type === "root_agent"
    || type === "main"
    || type === "director"
    || type === "parent";
}

function runningByBinding(state: HostGuardState, agentId: string | null, host: string, turnId: string | null = null): GuardTicket | null {
  if (!agentId && !turnId) return null;
  const binding = turnId
    ? bindingForTurn(state, turnId)
    : state.bindings.find((item) => item.agent_id === agentId) || null;
  if (!binding) return null;
  if (agentId && binding.agent_id !== agentId) return null;
  return state.tickets.find((ticket) => ticket.status === "running"
    && ticket.id === binding.ticket_id
    && ticket.agent_id === binding.agent_id
    && isGuardTicket(ticket, host)) || null;
}

function reservedTickets(state: HostGuardState, host: string): GuardTicket[] {
  return state.tickets.filter((ticket) => ticket.status === "dispatching"
    && (ticket.dispatch_host || ticket.host || DEFAULT_GUARD_HOST) === host);
}

function findReserved(state: HostGuardState, input: HookInput, host: string): GuardTicket | null {
  const reserved = reservedTickets(state, host);
  const requestedId = ticketIdFromInput(input);
  if (requestedId) return reserved.find((ticket) => ticket.id === requestedId) || null;
  return reserved.length === 1 ? reserved[0] : null;
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
  const binding = bindingForTurn(state, turnId);
  if (isRootIdentity(input)) return { id, turnId, binding, ticket: null };
  if (binding && id && binding.agent_id !== id) return { id, turnId, binding, ticket: null };
  return {
    id,
    turnId,
    binding,
    ticket: runningByBinding(state, id, host, turnId)
      || (turnId && binding ? null : currentRunning(state, id, host)),
  };
}

/** Enforce the director/worker boundary for the official PreToolUse event. */
export function evaluatePreToolUse(input: HookInput, options: HostGuardOptions = {}): GuardDecision {
  const event = eventName(input);
  const cwd = stringValue(input.cwd) || options.cwd || process.cwd();
  const state = loadHostGuardState(cwd, options);
  const host = guardHost(options);
  const name = toolName(input);
  const command = stringValue(toolInput(input).command) || "";
  if (!state.active) return allowed(event, input);
  if (!name) return denied(event, HOST_GUARD_REASONS.invalid_input, input);
  if (name === "Bash" && isBatonControlPlaneCommand(command, {
    env: options.env,
    runtimePath: options.runtimePath,
    entryPath: options.entryPath,
    executablePath: options.executablePath,
  })) return allowed(event, input);
  if (state.state_error) return denied(event, HOST_GUARD_REASONS.state_unavailable, input);
  if (name !== "Bash" && name !== "apply_patch" && name !== "Edit" && name !== "Write" && name !== "Agent") {
    // Codex may route specialized tools around this hook. Keep this explicit:
    // the installed matcher covers only the tools for which the policy exists.
    return allowed(event, input);
  }

  if (name === "Agent") {
    if (!state.initialized) return denied(event, HOST_GUARD_REASONS.not_initialized, input);
    const identity = identityFor(state, input, host);
    if (identity.ticket) return denied(event, HOST_GUARD_REASONS.nested_agent, input, identity.ticket.id, identity.id);
    const reserved = findReserved(state, input, host);
    if (!reserved) {
      return denied(event, reservedTickets(state, host).length > 1
        ? HOST_GUARD_REASONS.ambiguous_reserved_ticket
        : HOST_GUARD_REASONS.no_reserved_ticket, input);
    }
    return allowed(event, input, reserved.id, null);
  }

  if (!state.initialized) return denied(event, HOST_GUARD_REASONS.not_initialized, input);
  const identity = identityFor(state, input, host);
  if (!identity.ticket) {
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
      : hasAnotherBoundAgent
        ? HOST_GUARD_REASONS.agent_identity_mismatch
      : name === "Bash"
        ? HOST_GUARD_REASONS.director_shell
        : HOST_GUARD_REASONS.director_code_write;
    return denied(event, reason, input, null, identity.id);
  }

  if (name === "Bash") {
    if (isShellWriteCommand(command)) {
      if (hasCommitAuthorization(identity.ticket, command)) return allowed(event, input, identity.ticket.id, identity.id);
      if (!hasWriteAuthorization(identity.ticket)) {
        return denied(event, identity.ticket.mode === "commit-only"
          ? HOST_GUARD_REASONS.commit_only_command
          : HOST_GUARD_REASONS.write_receipt_required, input, identity.ticket.id, identity.id);
      }
    }
    return allowed(event, input, identity.ticket.id, identity.id);
  }

  if (!hasWriteAuthorization(identity.ticket)) {
    return denied(event, identity.ticket.mode === "commit-only"
      ? HOST_GUARD_REASONS.commit_only_command
      : HOST_GUARD_REASONS.write_receipt_required, input, identity.ticket.id, identity.id);
  }
  return allowed(event, input, identity.ticket.id, identity.id);
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
): void {
  const agentId = hookAgentIdentity(input);
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
export function evaluateSubagentStart(input: HookInput, options: HostGuardOptions = {}): GuardDecision {
  const event = "SubagentStart";
  const cwd = stringValue(input.cwd) || options.cwd || process.cwd();
  const state = loadHostGuardState(cwd, options);
  const host = guardHost(options);
  if (!state.active) return allowed(event, input);
  if (state.state_error) return denied(event, HOST_GUARD_REASONS.state_unavailable, input);
  if (!state.initialized) return denied(event, HOST_GUARD_REASONS.not_initialized, input);
  const agentId = hookAgentIdentity(input);
  if (!agentId) return denied(event, HOST_GUARD_REASONS.agent_identity_required, input, null, null);
  const turnId = hookTurnIdentity(input);
  if (isRootIdentity(input)) {
    return denied(event, HOST_GUARD_REASONS.agent_identity_mismatch, input, null, agentId);
  }
  const existingBinding = bindingForTurn(state, turnId);
  if (bindingConflictForTurn(state, turnId, existingBinding?.ticket_id || "", agentId)) {
    return denied(event, HOST_GUARD_REASONS.agent_identity_mismatch, input, existingBinding?.ticket_id || null, agentId);
  }
  const bound = runningByBinding(state, agentId, host, turnId)
    || (turnId && existingBinding ? null : currentRunning(state, agentId, host));
  if (bound) {
    if (!existingBinding || existingBinding.agent_id !== agentId) {
      recordPendingBinding(cwd, input, state, bound, options, "bound");
    }
    return allowed(event, input, bound.id, agentId, "BATON_GUARD_SUBAGENT_BOUND");
  }
  const reserved = findReserved(state, input, host);
  if (!reserved) {
    return denied(event, reservedTickets(state, host).length > 1
      ? HOST_GUARD_REASONS.ambiguous_reserved_ticket
      : HOST_GUARD_REASONS.no_reserved_ticket, input, null, agentId);
  }
  recordPendingBinding(cwd, input, state, reserved, options);
  return allowed(event, input, reserved.id, agentId, "BATON_GUARD_SUBAGENT_PENDING_BIND");
}

export const guardPreToolUse = evaluatePreToolUse;
export const guardSubagentStart = evaluateSubagentStart;
export const evaluateHostGuard = evaluatePreToolUse;
