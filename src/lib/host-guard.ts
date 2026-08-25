import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configPath, receiptsDir, runsDir, spawnsDir } from "./paths.js";
import { currentBatonHookTargets } from "./codex-hooks.js";
import { findBinaryOnPath, isExecutableFile } from "./executables.js";
import { type SpawnTicket } from "./spawn.js";
import {
  parseDispatchReservationEnvelope,
  parseDispatchReservationIdentity,
  type DispatchReservationIdentity,
} from "./dispatch-reservation.js";
import {
  nativeHookIdentity,
  pendingNativeReservation,
  pendingNativeReservations,
  readHostIdentityState,
  recordNativeIdentity,
  recordPendingReservationExclusive,
  reservationContextMatchesForHost,
  type HostIdentityState,
  type NativeIdentityObservation,
  type PendingNativeReservation,
} from "./host-identity.js";

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
  reservation_identity_required: "BATON_GUARD_RESERVATION_IDENTITY_REQUIRED",
  reservation_identity_mismatch: "BATON_GUARD_RESERVATION_IDENTITY_MISMATCH",
  nested_agent: "BATON_GUARD_NESTED_AGENT_DISALLOWED",
  ticket_not_active: "BATON_GUARD_TICKET_NOT_ACTIVE",
  write_receipt_required: "BATON_GUARD_WRITE_RECEIPT_REQUIRED",
  commit_only_command: "BATON_GUARD_COMMIT_ONLY_COMMAND",
  worker_git_topology: "BATON_GUARD_WORKER_GIT_TOPOLOGY_FORBIDDEN",
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
  reservation_id: string | null;
  attempt: number;
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
  reservation_id: string | null;
  attempt: number | null;
  host: string | null;
  turn_id: string | null;
  session_id: string | null;
  agent_type: string | null;
  state: "pending" | "bound";
  observed_at: string;
}

/** In-flight reservations are kept separately from bindings because the
 * native hook supplies the agent identity only after PreToolUse. */
export type GuardReservation = PendingNativeReservation;

export interface HostGuardState {
  active: boolean;
  initialized: boolean;
  tickets: GuardTicket[];
  bindings: GuardBinding[];
  pending_reservations?: GuardReservation[];
  identity_observations?: NativeIdentityObservation[];
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
   * satisfied here. Defaults to Codex for the current host guard install.
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

function normalizeTicket(ticket: SpawnTicket, env?: NodeJS.ProcessEnv): GuardTicket {
  const receipt = ticket.receipt_id ? readReceiptShape(ticket, ticket.receipt_id, env) : null;
  return {
    id: String(ticket.id || ""),
    reservation_id: stringValue(ticket.reservation_id),
    attempt: Number(ticket.attempt || 0),
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
function readReceiptShape(ticket: SpawnTicket, receiptId: string, env?: NodeJS.ProcessEnv): { allowed_operations: string[]; write_allowlist: string[] } | null {
  try {
    const cwd = (ticket as unknown as { __cwd?: string }).__cwd;
    if (!cwd) return null;
    const file = path.join(receiptsDir(cwd, env), `${receiptId}.json`);
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

function listGuardSpawns(cwd: string, env?: NodeJS.ProcessEnv): SpawnTicket[] {
  const dir = spawnsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as SpawnTicket)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

/** Convert a raw ticket while looking up receipts under the supplied workspace. */
function normalizeTickets(cwd: string, tickets: SpawnTicket[], env?: NodeJS.ProcessEnv): GuardTicket[] {
  return tickets.map((ticket) => {
    const withCwd = { ...ticket, __cwd: cwd } as SpawnTicket & { __cwd: string };
    return normalizeTicket(withCwd, env);
  }).filter((ticket) => ticket.id);
}

function normalizeProvidedTicket(ticket: GuardTicket): GuardTicket {
  return {
    id: String(ticket?.id || ""),
    reservation_id: stringValue(ticket?.reservation_id),
    attempt: Number(ticket?.attempt || 0),
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

const GUARD_BINDING_KEYS = new Set([
  "ticket_id",
  "agent_id",
  "reservation_id",
  "attempt",
  "host",
  "turn_id",
  "session_id",
  "agent_type",
  "state",
  "observed_at",
]);
const GUARD_RESERVATION_KEYS = new Set([
  "reservation_id",
  "ticket_id",
  "host",
  "attempt",
  "turn_id",
  "session_id",
  "tool_use_id",
  "transcript_path",
  "observed_at",
  "agent_id",
  "source",
]);

function hasNoUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeProvidedBinding(value: unknown): GuardBinding | null {
  if (!record(value)) return null;
  if (!hasNoUnknownKeys(value, GUARD_BINDING_KEYS)) return null;
  const ticketId = stringValue(value.ticket_id);
  const agentId = stringValue(value.agent_id);
  if (!ticketId || !agentId) return null;
  const attemptValue = value.attempt;
  const attempt = attemptValue == null || attemptValue === ""
    ? null
    : Number.isInteger(Number(attemptValue)) && Number(attemptValue) > 0 ? Number(attemptValue) : null;
  return {
    ticket_id: ticketId,
    agent_id: agentId,
    reservation_id: stringValue(value.reservation_id),
    attempt,
    host: stringValue(value.host)?.toLowerCase() || null,
    turn_id: stringValue(value.turn_id),
    session_id: stringValue(value.session_id),
    agent_type: stringValue(value.agent_type),
    state: value.state === "bound" ? "bound" : "pending",
    observed_at: String(value.observed_at || ""),
  };
}

function normalizeProvidedReservation(value: unknown, observed = false): GuardReservation | null {
  if (!record(value)) return null;
  const keys = observed
    ? GUARD_RESERVATION_KEYS
    : new Set([...GUARD_RESERVATION_KEYS].filter((key) => key !== "agent_id" && key !== "source"));
  if (!hasNoUnknownKeys(value, keys)) return null;
  const reservationId = stringValue(value.reservation_id);
  const ticketId = stringValue(value.ticket_id);
  const host = stringValue(value.host)?.toLowerCase() || null;
  const attempt = Number(value.attempt);
  if (!reservationId || !ticketId || !host || !Number.isInteger(attempt) || attempt < 1) return null;
  return {
    reservation_id: reservationId,
    ticket_id: ticketId,
    host,
    attempt,
    turn_id: stringValue(value.turn_id),
    session_id: stringValue(value.session_id),
    tool_use_id: stringValue(value.tool_use_id),
    transcript_path: stringValue(value.transcript_path),
    observed_at: stringValue(value.observed_at) || new Date(0).toISOString(),
  };
}

interface BindingReadResult {
  bindings: GuardBinding[];
  error: string | null;
}

const HOST_GUARD_BINDINGS_LOCK_WAIT_MS = 2_000;
const HOST_GUARD_BINDINGS_LOCK_STALE_MS = 1_000;

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
      if (!hasNoUnknownKeys(item, GUARD_BINDING_KEYS)) {
        return { bindings: [], error: "host guard binding entry has unknown keys" };
      }
      const ticketId = stringValue(item.ticket_id);
      const agentId = stringValue(item.agent_id);
      if (!ticketId || !agentId) {
        return { bindings: [], error: "host guard binding entry is missing ticket_id or agent_id" };
      }
      bindings.push({
        ticket_id: ticketId,
        agent_id: agentId,
        reservation_id: stringValue(item.reservation_id),
        attempt: item.attempt == null || item.attempt === ""
          ? null
          : Number.isInteger(Number(item.attempt)) && Number(item.attempt) > 0 ? Number(item.attempt) : null,
        host: stringValue(item.host)?.toLowerCase() || null,
        turn_id: stringValue(item.turn_id),
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

function identityStateFor(cwd: string, options: HostGuardOptions): {
  state: HostIdentityState;
  error: string | null;
} {
  if (options.state) {
    const candidate = options.state as HostGuardState & {
    pending_reservations?: unknown;
    identity_observations?: unknown;
    };
    const pending = Array.isArray(candidate.pending_reservations)
      ? candidate.pending_reservations.map((item) => normalizeProvidedReservation(item))
      : [];
    const observed = Array.isArray(candidate.identity_observations)
      ? candidate.identity_observations.map((item) => {
        if (!record(item)) return null;
        const pendingItem = normalizeProvidedReservation(item, true);
        const agentId = stringValue(item.agent_id);
        const source = stringValue(item.source);
        if (!pendingItem || !agentId || !source || !["hook", "tool-return", "lifecycle"].includes(source)) return null;
        return { ...pendingItem, agent_id: agentId, source: source as NativeIdentityObservation["source"] };
      })
      : [];
    const allowedStateKeys = new Set([
      "active",
      "initialized",
      "tickets",
      "bindings",
      "pending_reservations",
      "identity_observations",
      "state_error",
    ]);
    const malformed = (candidate.pending_reservations !== undefined && (!Array.isArray(candidate.pending_reservations) || pending.some((item) => item === null)))
      || (candidate.identity_observations !== undefined && (!Array.isArray(candidate.identity_observations) || observed.some((item) => item === null)))
      || Object.keys(candidate).some((key) => !allowedStateKeys.has(key));
    return {
      state: {
        schema: 1,
        pending: pending.filter((item): item is GuardReservation => item !== null),
        observed: observed.filter((item): item is NativeIdentityObservation => item !== null),
      },
      error: malformed ? "host identity state is malformed" : null,
    };
  }
  return readHostIdentityState(cwd, options.env);
}

function publishIdentityState(options: HostGuardOptions, state: HostIdentityState): void {
  if (!options.state) return;
  options.state.pending_reservations = state.pending;
  options.state.identity_observations = state.observed;
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
    const identity = identityStateFor(cwd, options);
    const malformedBindings = rawBindings !== undefined
      && (!Array.isArray(rawBindings) || bindings.some((item) => item === null));
    return {
      active: options.state.active !== false,
      initialized: options.state.initialized !== false,
      tickets: tickets.filter((item): item is GuardTicket => item !== null),
      bindings: bindings.filter((item): item is GuardBinding => item !== null),
    pending_reservations: identity.state.pending,
    identity_observations: identity.state.observed,
    state_error: options.state.state_error
        || (malformedTickets ? "host guard tickets are malformed" : null)
        || (malformedBindings ? "host guard bindings are malformed" : null)
        || identity.error,
    };
  }
  const env = options.env || process.env;
  const initialized = fs.existsSync(configPath(cwd, { env }));
  const active = String(env.BATON_GUARD_DISABLED || "") !== "1";
  let tickets: GuardTicket[] = [];
  let stateError: string | null = null;
  try {
    const raw = listGuardSpawns(cwd, env);
    tickets = normalizeTickets(cwd, raw, env);
  } catch (error) {
    stateError = error instanceof Error ? error.message : String(error);
  }
  const bindingResult = readBindings(bindingsPath(cwd, options));
  if (bindingResult.error) stateError = stateError || bindingResult.error;
  const identityResult = identityStateFor(cwd, options);
  if (identityResult.error) stateError = stateError || identityResult.error;
  return {
    active,
    initialized,
    tickets,
    bindings: bindingResult.bindings,
    pending_reservations: identityResult.state.pending,
    identity_observations: identityResult.state.observed,
    state_error: stateError,
  };
}

export const readHostGuardState = loadHostGuardState;
export const readGuardState = loadHostGuardState;

/** Grok sends camelCase keys and snake_case event values. Codex reads only the
 * current snake_case Hooks fields; its identity contract has no aliases. */
export function normalizeHookInput(raw: unknown, host = DEFAULT_GUARD_HOST): HookInput {
  if (!record(raw)) return {};
  const normalizedHost = String(host || DEFAULT_GUARD_HOST).trim().toLowerCase();
  const codex = normalizedHost === "codex";
  const eventRaw = stringValue(raw.hook_event_name) || stringValue(raw.hookEventName) || "";
  const lower = eventRaw.toLowerCase().replaceAll("-", "_");
  const event = lower === "pre_tool_use" ? "PreToolUse"
    : lower === "subagent_start" ? "SubagentStart"
    : eventRaw;
  const nestedInput = record(raw.tool_input) ? raw.tool_input : (!codex && record(raw.toolInput) ? raw.toolInput : {});
  return {
    ...raw,
    hook_event_name: event || undefined,
    cwd: stringValue(raw.cwd) || (!codex ? stringValue(raw.workspaceRoot) : null) || raw.cwd,
    tool_name: stringValue(raw.tool_name) || (!codex ? stringValue(raw.toolName) : null) || raw.tool_name,
    tool_input: nestedInput,
    session_id: stringValue(raw.session_id) || (!codex ? stringValue(raw.sessionId) : null) || raw.session_id,
    transcript_path: stringValue(raw.transcript_path) || raw.transcript_path,
    tool_use_id: stringValue(raw.tool_use_id) || (!codex ? stringValue(raw.toolUseId) : null) || raw.tool_use_id,
    agent_id: stringValue(raw.agent_id) || (!codex ? stringValue(raw.agentId) : null) || raw.agent_id,
    agent_type: stringValue(raw.agent_type)
      || (!codex ? stringValue(raw.agentType) : null)
      || (!codex ? stringValue(raw.subagentType) : null)
      || (!codex ? stringValue(raw.subagent_type) : null)
      || raw.agent_type,
    turn_id: stringValue(raw.turn_id) || (!codex ? stringValue(raw.turnId) : null) || raw.turn_id,
    ...(!codex ? {
      promptId: stringValue(raw.promptId) || stringValue(raw.prompt_id) || raw.promptId,
      subagentType: stringValue(raw.subagentType) || stringValue(raw.subagent_type) || raw.subagentType,
    } : {}),
  };
}

export function canonicalGuardToolName(name: string | null): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  if (lower === "bash" || lower === "run_terminal_command") return "Bash";
  if (lower === "edit" || lower === "write" || lower === "multiedit" || lower === "search_replace") return "Edit";
  if (lower === "apply_patch") return "apply_patch";
  if (lower === "agent" || lower === "spawn_subagent" || lower === "task"
    || lower === "spawn_agent" || /(?:^|[.])spawn_agent$/.test(lower)) return "Agent";
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

function hookAgentType(input: HookInput, host = DEFAULT_GUARD_HOST): string | null {
  const codex = String(host || DEFAULT_GUARD_HOST).trim().toLowerCase() === "codex";
  if (codex) return stringValue(input.agent_type);
  const candidates = [input.agent_type, input.agentType, input.subagentType, input.subagent_type];
  for (const value of candidates) {
    const type = stringValue(value);
    if (type) return type;
  }
  const nested = toolInput(input);
  const nestedKeys = ["agent_type", "agentType", "subagentType", "subagent_type"];
  for (const key of nestedKeys) {
    const type = stringValue(nested[key]);
    if (type) return type;
  }
  return null;
}

function isRootIdentity(input: HookInput, host = DEFAULT_GUARD_HOST): boolean {
  const type = hookAgentType(input, host)?.toLowerCase();
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
  return Boolean(hookAgentType(input, "grok")) && Boolean(sessionId(input)) && !isRootIdentity(input, "grok");
}

function grokLifecyclePayload(input: HookInput): boolean {
  const type = [input.agent_type, input.agentType, input.subagentType, input.subagent_type]
    .map(stringValue)
    .find((value): value is string => Boolean(value));
  return Boolean(type) && Boolean(sessionId(input)) && !["root", "root_agent", "main", "director", "parent"].includes(type!.toLowerCase());
}

function hookTurnIdentity(input: HookInput, host = DEFAULT_GUARD_HOST): string | null {
  const codex = String(host || DEFAULT_GUARD_HOST).trim().toLowerCase() === "codex";
  const candidates = codex ? [input.turn_id] : [input.turn_id, input.turnId];
  if (!codex && grokSubagentPayload(input)) candidates.push(input.promptId, input.prompt_id);
  for (const value of candidates) {
    const id = stringValue(value);
    if (id) return id;
  }
  const nested = toolInput(input);
  const nestedKeys = codex ? [] : grokSubagentPayload(input)
    ? ["turn_id", "turnId", "promptId", "prompt_id"]
    : ["turn_id", "turnId"];
  for (const key of nestedKeys) {
    const id = stringValue(nested[key]);
    if (id) return id;
  }
  return null;
}

/** Lifecycle correlation fields are top-level host evidence, never caller tool payload. */
function lifecycleTurnIdentity(input: HookInput, host = DEFAULT_GUARD_HOST): string | null {
  const codex = String(host || DEFAULT_GUARD_HOST).trim().toLowerCase() === "codex";
  for (const value of codex ? [input.turn_id] : [input.turn_id, input.turnId]) {
    const id = stringValue(value);
    if (id) return id;
  }
  const type = [input.agent_type, input.agentType, input.subagentType, input.subagent_type]
    .map(stringValue)
    .find((value): value is string => Boolean(value));
  if (host === "grok" && type && sessionId(input)
    && !["root", "root_agent", "main", "director", "parent"].includes(type.toLowerCase())) {
    for (const value of [input.promptId, input.prompt_id]) {
      const id = stringValue(value);
      if (id) return id;
    }
  }
  return null;
}

/** Resolve the identity field exposed by the serving host's native lifecycle. */
export function hookAgentIdentity(input: HookInput, host = DEFAULT_GUARD_HOST): string | null {
  return nativeHookIdentity(host, input);
}

/** SubagentStart identity is lifecycle-owned; never read a caller tool payload. */
function lifecycleAgentIdentity(input: HookInput, host: string): string | null {
  return nativeHookIdentity(host, input);
}

interface RequestedReservation {
  identity: DispatchReservationIdentity | null;
  conflict: boolean;
  invalid: boolean;
}

function reservationEnvelopeIntent(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(firstLine) as unknown;
    return record(parsed) && Object.hasOwn(parsed, "baton_dispatch");
  } catch {
    return /"baton_dispatch"\s*:/.test(firstLine);
  }
}

/** Read only an explicit machine envelope. Business prompt text and ticket prefixes are irrelevant. */
function reservationFromInput(input: HookInput): RequestedReservation {
  const nested = toolInput(input);
  const candidates: DispatchReservationIdentity[] = [];
  let invalid = false;
  for (const value of [input.baton_dispatch, nested.baton_dispatch]) {
    if (value !== undefined) {
      const parsed = parseDispatchReservationIdentity({ baton_dispatch: value });
      if (parsed) candidates.push(parsed);
      else invalid = true;
    }
  }
  for (const value of [
    input.prompt,
    input.message,
    input.description,
    input.task,
    input.input,
    nested.prompt,
    nested.message,
    nested.description,
    nested.task,
    nested.input,
  ]) {
    const parsed = parseDispatchReservationEnvelope(value);
    if (parsed) candidates.push(parsed);
    else if (reservationEnvelopeIntent(value)) invalid = true;
  }
  if (!candidates.length) return { identity: null, conflict: false, invalid };
  const encoded = candidates.map((item) => JSON.stringify(item));
  return {
    identity: candidates[0],
    conflict: encoded.some((item) => item !== encoded[0]),
    invalid,
  };
}

function sessionId(input: HookInput): string | null {
  return stringValue(input.session_id);
}

function lifecycleContext(input: HookInput, host = DEFAULT_GUARD_HOST): {
  turn_id: string | null;
  session_id: string | null;
  tool_use_id: string | null;
  transcript_path: string | null;
} {
  return {
    turn_id: lifecycleTurnIdentity(input, host),
    session_id: sessionId(input),
    tool_use_id: stringValue(input.tool_use_id),
    transcript_path: stringValue(input.transcript_path),
  };
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

function denied(
  event: string,
  reason: HostGuardReason,
  input: HookInput,
  ticketId: string | null = null,
  agentId: string | null = null,
  host = DEFAULT_GUARD_HOST,
  message: string | null = null,
): GuardDecision {
  return {
    allowed: false,
    event,
    ...(toolName(input) ? { tool_name: toolName(input)! } : {}),
    reason,
    ticket_id: ticketId,
    agent_id: agentId,
    output: reasonOutput(event, message || reason, host),
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

function bindingForAgent(state: HostGuardState, agentId: string | null, host: string): GuardBinding | null {
  if (!agentId) return null;
  const matches = state.bindings.filter((item) => item.agent_id === agentId
    && ((item.host || null) === host || item.host == null));
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
    : bindingForAgent(state, agentId, host);
  if (!binding) return null;
  if (agentId && binding.agent_id !== agentId) return null;
  const ticket = state.tickets.find((item) => item.status === "running"
    && item.id === binding.ticket_id
    && item.reservation_id === binding.reservation_id
    && item.attempt === binding.attempt
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
 * Grok PreToolUse inside an already-bound child has `subagentType` and a child
 * `sessionId`, not Codex `agent_id`. Only the exact session recorded from an
 * envelope-bearing SubagentStart may identify the ticket; never guess from the
 * number of running workers.
 */
function grokBoundWorker(state: HostGuardState, input: HookInput, host: string): GuardTicket | null {
  if (host !== "grok" || !grokSubagentPayload(input)) return null;
  const bySession = bindingForSession(state, sessionId(input));
  if (bySession) {
    const ticket = state.tickets.find((item) => item.id === bySession.ticket_id && isGuardTicket(item, host));
    if (ticket?.status === "running" && ticket.agent_id) return ticket;
  }
  return null;
}

function findReserved(state: HostGuardState, identity: DispatchReservationIdentity, host: string): GuardTicket | null {
  return reservedTickets(state, host).find((ticket) => ticket.reservation_id === identity.reservation_id
    && ticket.id === identity.ticket_id
    && ticket.attempt === identity.attempt
    && identity.host === host) || null;
}

function pendingForHost(state: HostGuardState, host: string): PendingNativeReservation[] {
  return (state.pending_reservations || []).filter((item) => item.host === host);
}

function pendingReservationFromLifecycleTicket(
  ticket: GuardTicket,
  input: HookInput,
  host: string,
  options: HostGuardOptions,
): PendingNativeReservation | null {
  const reservationId = stringValue(ticket.reservation_id);
  const reservationHost = stringValue(ticket.host || ticket.dispatch_host || host)?.toLowerCase() || null;
  if (!reservationId || !reservationHost || !Number.isInteger(ticket.attempt) || ticket.attempt < 1) return null;
  const context = lifecycleContext(input, host);
  return {
    reservation_id: reservationId,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: reservationHost,
    turn_id: context.turn_id,
    session_id: context.session_id,
    tool_use_id: context.tool_use_id,
    transcript_path: context.transcript_path,
    observed_at: isoNow(options.now),
  };
}

/**
 * Codex and Claude do not carry the Agent envelope into SubagentStart. Keep
 * one short reservation-to-observation handshake per host, then release it
 * as soon as the hook identity is recorded. Existing bound workers remain
 * fully parallel because only `pending`, never `observed`, participates here.
 */
function handshakeBusyFor(
  cwd: string,
  host: string,
  state: HostGuardState,
  options: HostGuardOptions,
  requested: DispatchReservationIdentity,
): boolean {
  // Grok carries the reservation in its lifecycle payload and Cursor binds
  // from its native tool return; only Codex/Claude need this serialized
  // carrier-free handshake.
  if (host !== "codex" && host !== "claude") return false;
  const pending = options.state
    ? pendingForHost(state, host)
    : pendingNativeReservations(cwd, host, options.env);
  // Replayed aliases for the same exact reservation are idempotent. A
  // different reservation must still wait for the current native identity
  // observation so an uncorrelated worker cannot consume the slot.
  return pending.some((item) => !sameReservationIdentity(item, requested));
}

function rememberReservation(
  cwd: string,
  input: HookInput,
  identity: DispatchReservationIdentity,
  state: HostGuardState,
  options: HostGuardOptions,
  host: string,
): boolean {
  const identityState = identityStateFor(cwd, options);
  const context = {
    // Codex PreToolUse carries the parent turn, while SubagentStart carries
    // the child turn. Do not persist the parent turn as a correlation key.
    turn_id: host === "codex" ? null : hookTurnIdentity(input, host),
    session_id: sessionId(input),
    tool_use_id: stringValue(input.tool_use_id),
    transcript_path: stringValue(input.transcript_path),
    now: options.now,
  };
  const serializedHost = host === "codex" || host === "claude" ? host : null;
  const pending = recordPendingReservationExclusive(cwd, identity, context, serializedHost,
    options.state ? identityState.state : undefined, options.env);
  if (!pending) return false;
  const currentIdentityState = options.state ? identityState.state : readHostIdentityState(cwd, options.env).state;
  currentIdentityState.pending = currentIdentityState.pending.filter((item) =>
    item.reservation_id === pending.reservation_id
      ? item.ticket_id === pending.ticket_id && item.attempt === pending.attempt && item.host === pending.host
      : true);
  state.pending_reservations = currentIdentityState.pending;
  state.identity_observations = currentIdentityState.observed;
  publishIdentityState(options, currentIdentityState);
  return true;
}

function sameReservationIdentity(left: PendingNativeReservation, right: DispatchReservationIdentity): boolean {
  return left.host === right.host
    && left.ticket_id === right.ticket_id
    && left.reservation_id === right.reservation_id
    && left.attempt === right.attempt;
}

function pendingForReservation(
  cwd: string,
  state: HostGuardState,
  options: HostGuardOptions,
  identity: DispatchReservationIdentity,
): PendingNativeReservation | null {
  if (options.state) {
    const matches = pendingForHost(state, identity.host).filter((item) => sameReservationIdentity(item, identity));
    return matches.length === 1 ? matches[0] : null;
  }
  return pendingNativeReservation(cwd, {
    ticket_id: identity.ticket_id,
    host: identity.host,
    reservation_id: identity.reservation_id,
    attempt: identity.attempt,
  }, options.env);
}

/** SubagentStart on Grok has one documented opaque carrier: returned description. */
function grokLifecycleReservation(input: HookInput): RequestedReservation {
  const description = input.description;
  const parsed = description === undefined ? null : parseDispatchReservationEnvelope(description);
  const envelopeLike = (value: unknown): boolean => parseDispatchReservationEnvelope(value) !== null
    || parseDispatchReservationIdentity({ baton_dispatch: value }) !== null
    || reservationEnvelopeIntent(value)
    || (record(value) && (Object.hasOwn(value, "baton_dispatch") || Object.hasOwn(value, "reservation_id")));
  let invalid = description !== undefined && (!parsed && (reservationEnvelopeIntent(description) || record(description)));
  // Grok's lifecycle contract carries the unchanged reservation only in
  // `description`. A copied envelope in a prompt/tool field is not another
  // valid carrier; reject it instead of silently treating the event as an
  // ordinary child start.
  const nested = toolInput(input);
  for (const value of [
    input.baton_dispatch,
    input.prompt,
    input.message,
    input.task,
    input.input,
    nested.baton_dispatch,
    nested.prompt,
    nested.message,
    nested.task,
    nested.input,
    nested.description,
  ]) {
    if (value === undefined) continue;
    if (envelopeLike(value)) invalid = true;
  }
  return { identity: parsed, conflict: false, invalid };
}

function correlatePendingReservation(
  cwd: string,
  input: HookInput,
  host: string,
  state: HostGuardState,
  options: HostGuardOptions,
): { reservation: PendingNativeReservation | null; ambiguous: boolean } {
  const identityState = identityStateFor(cwd, options);
  const candidates = (options.state
    ? pendingForHost(state, host)
    : pendingNativeReservations(cwd, host, options.env))
    .filter((item) => reservationContextMatchesForHost(host, item, lifecycleContext(input, host)));
  if (candidates.length === 1) return { reservation: candidates[0], ambiguous: false };
  if (candidates.length > 1) return { reservation: null, ambiguous: true };
  // Keep the in-memory state published even when no candidate matched; this
  // makes a malformed/expired reservation visible to the caller and fail
  // closed instead of silently guessing from the ticket list.
  if (options.state) publishIdentityState(options, identityState.state);
  return { reservation: null, ambiguous: false };
}

function exclusiveGitTickets(state: HostGuardState, host: string): GuardTicket[] {
  return state.tickets.filter((ticket) => (ticket.status === "running" || ticket.status === "dispatching")
    && isGuardTicket(ticket, host)
    && (ticket.mode === "commit-only" || ticket.mode === "write"));
}

/** Reserved/dispatching/running tickets for this host — the PreToolUse work signal. */
function hostWorkerTickets(state: HostGuardState, host: string): GuardTicket[] {
  return state.tickets.filter((ticket) => (ticket.status === "dispatching" || ticket.status === "running")
    && isGuardTicket(ticket, host));
}

function isDirectorMutatingTool(name: string, command: string): boolean {
  return name === "apply_patch" || name === "Edit" || name === "Write"
    || (name === "Bash" && (isShellWriteCommand(command) || isDirectorStageCommand(command)));
}

/** Director-only caller: not a Grok child session and not a bound native agent_id. */
function isDirectorCaller(input: HookInput, host = DEFAULT_GUARD_HOST, state?: HostGuardState): boolean {
  if (host === "grok" && grokSubagentPayload(input)) return false;
  const id = hookAgentIdentity(input, host);
  if (id || isRootIdentity(input, host)) return !id || isRootIdentity(input, host);
  // Release-shaped worker hooks can carry the turn but not Codex's native
  // agent_id. A recorded turn binding still makes this a child, and it must
  // remain denied while its exact ticket is only dispatching.
  if (state && bindingForTurn(state, hookTurnIdentity(input, host))) return false;
  // A typed non-root lifecycle payload is also a child even before its
  // binding is persisted; never treat it as an idle director.
  return !hookAgentType(input, host);
}

const READ_ONLY_GIT_VERBS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree",
  "describe", "cat-file", "blame", "shortlog", "name-rev", "rev-list",
  "version", "help", "grep", "var",
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
    return !rest.some((item) => !item.startsWith("-")
      || item === "--delete" || item === "--move" || item === "--copy"
      || item === "--edit-description"
      || /^-([dDmcC]|[^-]*[dDmcC])/.test(item));
  }
  if (verb === "symbolic-ref") {
    return rest.filter((item) => !item.startsWith("-")).length <= 1
      && !rest.some((item) => item === "--delete");
  }
  if (verb === "reflog") {
    return !["delete", "drop", "expire"].includes(rest[0] || "");
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
  const tokens = standaloneCommandTokens(text);
  const verb = tokens?.[0] === "git" ? gitVerb(tokens) : null;
  // A worker Receipt never grants authority to rewrite branch topology,
  // refs, tags, or the remote. Parse global Git options too (`git -C ...`).
  if (tokens?.[0] === "git" && verb
    && new Set(["branch", "tag", "push", "fetch", "pull", "update-ref", "symbolic-ref"]).has(verb)) return true;
  if (tokens?.[0] === "git" && verb === "reflog"
    && ["delete", "drop", "expire"].includes(gitArgsAfterVerb(tokens)[0] || "")) return true;
  return /(?:^|[\s;&|])(?:sudo\s+)?(?:rm|rmdir|mv|cp|mkdir|install|ln|touch|tee|dd|truncate|chmod|chown|unlink)\b/i.test(text)
    || /\b(?:git\s+(?:add|commit|reset|restore|checkout|switch|branch|merge|rebase|cherry-pick|revert|tag|stash|clean|push|fetch|pull|update-ref|symbolic-ref)|npm\s+install|pnpm\s+install|yarn\s+add|bun\s+add)\b/i.test(text)
    || /(?:^|\s)(?:\d?>|>>|&>)/.test(text)
    || /\b(?:sed|perl)\s+-[[:alnum:]]*i\b/i.test(text)
    || /\b(?:python|python3|node|ruby)\b[^\n]*(?:writeFile|writeFileSync|open\([^\n]*["']w)/i.test(text);
}

/** Git topology/ref operations are never part of an ordinary worker Receipt. */
export function isGitTopologyMutation(command: unknown): boolean {
  const text = String(command || "").trim();
  if (!text) return false;
  const tokens = standaloneCommandTokens(text);
  const verb = tokens?.[0] === "git" ? gitVerb(tokens) : null;
  if (verb && new Set(["branch", "tag", "push", "fetch", "pull", "update-ref", "symbolic-ref"]).has(verb)) return true;
  if (verb === "reflog" && ["delete", "drop", "expire"].includes(gitArgsAfterVerb(tokens!)[0] || "")) return true;
  // Keep composed commands conservative: the shell-write gate already
  // rejects composition for director exemptions, so an explicit topology
  // verb anywhere in the command is enough to deny a bound worker.
  return /\bgit\s+(?:branch|tag|push|fetch|pull|update-ref|symbolic-ref)\b/i.test(text)
    || /\bgit\s+reflog\s+(?:delete|drop|expire)\b/i.test(text);
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
  const id = hookAgentIdentity(input, host);
  const turnId = hookTurnIdentity(input, host);
  const binding = bindingForTurn(state, turnId)
    || bindingForAgent(state, id, host)
    || (host === "grok" && grokSubagentPayload(input) ? bindingForSession(state, sessionId(input)) : null);
  if (isRootIdentity(input, host)) return { id, turnId, binding, ticket: null };
  if (binding && id && binding.agent_id !== id) return { id, turnId, binding, ticket: null };
  return {
    id,
    turnId,
    binding,
    ticket: runningByBinding(state, id, host, turnId, input)
      || (binding ? null : currentRunning(state, id, host))
      || grokBoundWorker(state, input, host),
  };
}

/** Enforce the director/worker boundary for the official PreToolUse event. */
export function evaluatePreToolUse(raw: HookInput, options: HostGuardOptions = {}): GuardDecision {
  const host = guardHost(options);
  const input = normalizeHookInput(raw, host);
  const event = eventName(input);
  const cwd = stringValue(input.cwd) || options.cwd || process.cwd();
  const state = loadHostGuardState(cwd, options);
  const name = toolName(input);
  const command = stringValue(toolInput(input).command) || "";
  const deny = (
    reason: HostGuardReason,
    ticketId: string | null = null,
    agentId: string | null = null,
    message: string | null = null,
  ) => denied(event, reason, input, ticketId, agentId, host, message);
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
  if (name === "Bash" && isDirectorCaller(input, host, state) && isReadOnlyGitCommand(command)) return allow();
  if (name === "Bash" && isDirectorCaller(input, host, state) && isDirectorStageCommand(command)) {
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
    // No reserved work for this host: undeclared native-child spawn is allowed.
    if (!reserved.length) return allow();
    const requested = reservationFromInput(input);
    if (requested.invalid || requested.conflict) return deny(HOST_GUARD_REASONS.reservation_identity_mismatch);
    if (!requested.identity) return deny(HOST_GUARD_REASONS.reservation_identity_required);
    const matched = findReserved(state, requested.identity, host);
    if (!matched) return deny(HOST_GUARD_REASONS.reservation_identity_mismatch);
    // Codex/Claude do not repeat the Agent tool input at SubagentStart. Only
    // serialize this short handshake; once the hook records an identity,
    // observed workers may run in parallel and the next spawn can proceed.
    if (handshakeBusyFor(cwd, host, state, options, requested.identity)) {
      return deny(HOST_GUARD_REASONS.spawn_bind_pending, matched.id, null,
        `${HOST_GUARD_REASONS.spawn_bind_pending}: ${host} identity observation in progress`);
    }
    if (host !== "cursor" && !rememberReservation(cwd, input, requested.identity, state, options, host)) {
      return deny(HOST_GUARD_REASONS.spawn_bind_pending, matched.id, null,
        `${HOST_GUARD_REASONS.spawn_bind_pending}: ${host} identity observation in progress`);
    }
    return allow(matched.id, null);
  }

  if (!state.initialized) {
    if (host === "grok") return allow();
    return deny(HOST_GUARD_REASONS.not_initialized);
  }
  const identity = identityFor(state, input, host);
  if (!identity.ticket) {
    const mutating = isDirectorMutatingTool(name, command);

    // Root must not borrow a child turn binding.
    if (isRootIdentity(input, host) && identity.binding) {
      return deny(HOST_GUARD_REASONS.agent_identity_mismatch, null, identity.id);
    }

    // Unbound native child: pending bind / identity races (not idle director).
    if (!isDirectorCaller(input, host, state)) {
      if (identity.binding && identity.id && identity.binding.agent_id !== identity.id) {
        return deny(HOST_GUARD_REASONS.agent_identity_mismatch, null, identity.id);
      }
      if (identity.binding && identity.binding.ticket_id) {
        // Grok children may inspect before bind; mutations wait for bind.
        if (host === "grok" && !mutating) return allow();
        return deny(HOST_GUARD_REASONS.spawn_bind_pending, identity.binding.ticket_id, identity.id);
      }
      if (reservedTickets(state, host).length > 0) {
        if (host === "grok" && !mutating) return allow();
        return deny(HOST_GUARD_REASONS.spawn_bind_pending, null, identity.id);
      }
      if (grokSubagentPayload(input) && grokRunningTickets(state, host).length > 1) {
        if (!mutating) return allow();
        return deny(HOST_GUARD_REASONS.agent_identity_mismatch, null, identity.id);
      }
      const hasAnotherBoundAgent = Boolean(identity.id) && state.tickets.some((ticket) => ticket.status === "running"
        && ticket.agent_id
        && isGuardTicket(ticket, host)
        && ticket.agent_id !== identity.id);
      if (hasAnotherBoundAgent) {
        return deny(HOST_GUARD_REASONS.agent_identity_mismatch, null, identity.id);
      }
    }

    if (mutating && exclusiveGitTickets(state, host).some((ticket) => ticket.mode === "commit-only")) {
      return deny(HOST_GUARD_REASONS.commit_only_command);
    }

    // Shared Codex/Grok/Claude policy: worker tickets deny director implementation writes.
    const blocking = hostWorkerTickets(state, host);
    if (mutating && blocking.length > 0) {
      const code = name === "Bash" ? HOST_GUARD_REASONS.director_shell : HOST_GUARD_REASONS.director_code_write;
      const blockingIds = blocking.map((ticket) => ticket.id).join(", ");
      return deny(code, null, identity.id, `${code}: ${blockingIds}`);
    }
    return allow();
  }

  if (name === "Bash") {
    if (isGitTopologyMutation(command)) {
      return deny(HOST_GUARD_REASONS.worker_git_topology, identity.ticket.id, identity.id);
    }
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

function bindingsLockPath(file: string): string {
  return `${file}.lock`;
}

function staleBindingsLock(lock: string, now: number): boolean {
  try {
    const stat = fs.statSync(lock);
    return now - stat.mtimeMs >= HOST_GUARD_BINDINGS_LOCK_STALE_MS;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function withBindingsLock<T>(file: string, fn: () => T): T {
  const lock = bindingsLockPath(file);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + HOST_GUARD_BINDINGS_LOCK_WAIT_MS;
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      const candidate = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeFileSync(candidate, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
        handle = candidate;
      } catch (error) {
        try { fs.closeSync(candidate); } catch { /* best effort */ }
        try { fs.unlinkSync(lock); } catch { /* best effort */ }
        throw error;
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const now = Date.now();
      if (staleBindingsLock(lock, now)) {
        try { fs.unlinkSync(lock); } catch (unlinkError: unknown) {
          if (!(unlinkError instanceof Error && "code" in unlinkError && unlinkError.code === "ENOENT")) throw unlinkError;
        }
        continue;
      }
      if (now >= deadline) throw new Error("host guard bindings lock unavailable");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(handle); } catch { /* best effort */ }
    try { fs.unlinkSync(lock); } catch { /* best effort */ }
  }
}

function mutateBindingsFile(file: string, mutate: (bindings: GuardBinding[]) => GuardBinding[]): GuardBinding[] {
  return withBindingsLock(file, () => {
    const loaded = readBindings(file);
    if (loaded.error) throw new Error(loaded.error);
    const bindings = mutate(loaded.bindings);
    writeBindings(file, bindings);
    return bindings;
  });
}

interface BindingCleanupKey {
  ticket_id: string;
  reservation_id: string | null;
  attempt: number | null;
  host: string | null;
  agent_id: string | null;
}

function bindingCleanupKey(
  ticket: Pick<GuardTicket, "id" | "reservation_id" | "attempt" | "host" | "dispatch_host" | "agent_id">,
  fallbackHost: string | null = null,
  agentId: string | null | undefined = ticket.agent_id,
): BindingCleanupKey {
  return {
    ticket_id: ticket.id,
    reservation_id: ticket.reservation_id || null,
    attempt: ticket.attempt > 0 ? ticket.attempt : null,
    host: stringValue(ticket.dispatch_host || ticket.host || fallbackHost)?.toLowerCase() || null,
    agent_id: agentId || null,
  };
}

function bindingMatchesTicketAttempt(
  binding: GuardBinding,
  key: BindingCleanupKey,
): boolean {
  if (binding.ticket_id !== key.ticket_id) return false;
  if (binding.reservation_id !== key.reservation_id) return false;
  if (binding.attempt !== key.attempt) return false;
  if ((binding.host || null) !== key.host) return false;
  if (key.agent_id && binding.agent_id !== key.agent_id) return false;
  return true;
}

export function clearHostGuardBindingsForTicketAttempt(
  cwd: string,
  ticket: Pick<GuardTicket, "id" | "reservation_id" | "attempt" | "host" | "dispatch_host" | "agent_id">,
  options: HostGuardOptions = {},
): void {
  const key = bindingCleanupKey(ticket);
  const bindings = options.state
    ? options.state.bindings.filter((item) => !bindingMatchesTicketAttempt(item, key))
    : mutateBindingsFile(bindingsPath(cwd, options), (current) =>
      current.filter((item) => !bindingMatchesTicketAttempt(item, key)));
  if (options.state) options.state.bindings = bindings;
}

function recordPendingBinding(
  cwd: string,
  input: HookInput,
  state: HostGuardState,
  ticket: GuardTicket,
  options: HostGuardOptions,
  bindingState: GuardBinding["state"] = "pending",
  resolvedAgentId: string | null = null,
  host = DEFAULT_GUARD_HOST,
  resolvedTurnId: string | null | undefined = undefined,
): void {
  const agentId = resolvedAgentId || hookAgentIdentity(input, host) || (host === "grok" ? sessionId(input) : null);
  if (!agentId) return;
  const turnId = resolvedTurnId === undefined ? hookTurnIdentity(input, host) : resolvedTurnId;
  const key = bindingCleanupKey(ticket, host, agentId);
  const nextBinding: GuardBinding = {
    ticket_id: ticket.id,
    agent_id: agentId,
    reservation_id: key.reservation_id,
    attempt: key.attempt,
    host: key.host || host.toLowerCase(),
    turn_id: turnId,
    session_id: sessionId(input),
    agent_type: hookAgentType(input, host),
    state: bindingState,
    observed_at: isoNow(options.now),
  };
  const bindings = options.state
    ? state.bindings.filter((item) => !bindingMatchesTicketAttempt(item, key))
    : mutateBindingsFile(bindingsPath(cwd, options), (current) => {
      const updated = current.filter((item) => !bindingMatchesTicketAttempt(item, key));
      updated.push(nextBinding);
      return updated;
    });
  if (options.state) bindings.push(nextBinding);
  if (options.state) options.state.bindings = bindings;
  state.bindings = bindings;
}

function observeNativeIdentityForReservation(
  cwd: string,
  input: HookInput,
  state: HostGuardState,
  options: HostGuardOptions,
  reservation: PendingNativeReservation,
  agentId: string,
  host: string,
): boolean {
  const identityState = identityStateFor(cwd, options);
  let observed: NativeIdentityObservation;
  try {
    observed = recordNativeIdentity(cwd, reservation, agentId, host === "grok" ? "lifecycle" : "hook", {
      turn_id: lifecycleTurnIdentity(input, host),
      session_id: sessionId(input),
      tool_use_id: stringValue(input.tool_use_id),
      transcript_path: stringValue(input.transcript_path),
      now: options.now,
    }, options.state ? identityState.state : undefined, options.env);
  } catch {
    return false;
  }
  const currentIdentityState = options.state ? identityState.state : readHostIdentityState(cwd, options.env).state;
  state.pending_reservations = currentIdentityState.pending;
  state.identity_observations = currentIdentityState.observed;
  publishIdentityState(options, currentIdentityState);
  return Boolean(observed);
}

/**
 * SubagentStart cannot cancel a child according to the Codex contract. It
 * records the native identity and emits a deterministic context message; the
 * actual PreToolUse gate remains closed until `dispatch bind` observes it.
 */
export function evaluateSubagentStart(raw: HookInput, options: HostGuardOptions = {}): GuardDecision {
  const host = guardHost(options);
  const input = normalizeHookInput(raw, host);
  const event = "SubagentStart";
  const cwd = stringValue(input.cwd) || options.cwd || process.cwd();
  const state = loadHostGuardState(cwd, options);
  const deny = (reason: HostGuardReason, ticketId: string | null = null, agentId: string | null = null) =>
    denied(event, reason, input, ticketId, agentId, host);
  const allow = (ticketId: string | null = null, agentId: string | null = null, extra?: string) =>
    allowed(event, input, ticketId, agentId, extra, host);
  if (!state.active) return allow();
  if (state.state_error) return deny(HOST_GUARD_REASONS.state_unavailable);
  if (!state.initialized) return deny(HOST_GUARD_REASONS.not_initialized);
  if (host === "grok" && !grokLifecyclePayload(input)) {
    return deny(HOST_GUARD_REASONS.agent_identity_required, null, null);
  }
  const agentId = lifecycleAgentIdentity(input, host) || (host === "grok" ? sessionId(input) : null);
  if (!agentId) return deny(HOST_GUARD_REASONS.agent_identity_required, null, null);
  const turnId = lifecycleTurnIdentity(input, host);
  if (isRootIdentity(input, host)) {
    return deny(HOST_GUARD_REASONS.agent_identity_mismatch, null, agentId);
  }
  const existingBinding = bindingForTurn(state, turnId);
  if (bindingConflictForTurn(state, turnId, existingBinding?.ticket_id || "", agentId)) {
    return deny(HOST_GUARD_REASONS.agent_identity_mismatch, existingBinding?.ticket_id || null, agentId);
  }
  const hostReservations = reservedTickets(state, host);
  const requested = host === "grok" ? grokLifecycleReservation(input) : reservationFromInput(input);
  if (requested.invalid || requested.conflict) {
    return deny(HOST_GUARD_REASONS.reservation_identity_mismatch, null, agentId);
  }
  const bound = runningByBinding(state, agentId, host, turnId, input)
    || (!hostReservations.length && (turnId && existingBinding ? null : currentRunning(state, agentId, host)));
  if (bound) {
    if (requested.identity) {
      const boundReservation = pendingReservationFromLifecycleTicket(bound, input, host, options);
      if (!boundReservation || !sameReservationIdentity(boundReservation, requested.identity)) {
        return deny(HOST_GUARD_REASONS.reservation_identity_mismatch, bound.id, agentId);
      }
    }
    if (!existingBinding || existingBinding.agent_id !== agentId) {
      try {
        recordPendingBinding(cwd, input, state, bound, options, "bound", agentId, host, turnId);
      } catch {
        return deny(HOST_GUARD_REASONS.state_unavailable, bound.id, agentId);
      }
    }
    return allow(bound.id, agentId, "BATON_GUARD_SUBAGENT_BOUND");
  }
  if (!hostReservations.length) {
    // A copied reservation envelope is not an ordinary unreserved child start.
    // Treat it as stale instead of allowing it to reseed the identity ledger.
    return requested.identity
      ? deny(HOST_GUARD_REASONS.reservation_identity_mismatch, null, agentId)
      : allow(null, agentId);
  }
  let reservation: DispatchReservationIdentity | null = requested.identity;
  let pending: PendingNativeReservation | null = null;
  if (host === "codex" || host === "claude") {
    const correlated = correlatePendingReservation(cwd, input, host, state, options);
    if (correlated.ambiguous) {
      return deny(HOST_GUARD_REASONS.ambiguous_reserved_ticket, null, agentId);
    }
    pending = correlated.reservation;
    reservation = pending
      ? {
        schema: 1,
        reservation_id: pending.reservation_id,
        ticket_id: pending.ticket_id,
        attempt: pending.attempt,
        host: pending.host,
      }
      : null;
    if (!pending) {
      return deny(HOST_GUARD_REASONS.reservation_identity_required, null, agentId);
    }
    if (requested.identity && !sameReservationIdentity(pending, requested.identity)) {
      return deny(HOST_GUARD_REASONS.reservation_identity_mismatch, null, agentId);
    }
    reservation = {
      schema: 1,
      reservation_id: pending.reservation_id,
      ticket_id: pending.ticket_id,
      attempt: pending.attempt,
      host: pending.host,
    };
  }
  if (!reservation) {
    // Grok must carry the exact returned description; Codex/Claude must have
    // matched the causal pending context above.
    return deny(HOST_GUARD_REASONS.reservation_identity_required, null, agentId);
  }
  const reserved = findReserved(state, reservation, host);
  if (!reserved) return deny(HOST_GUARD_REASONS.reservation_identity_mismatch, null, agentId);
  if (!pending) {
    pending = pendingForReservation(cwd, state, options, reservation);
  }
  if (pending) {
    const context = lifecycleContext(input, host);
    pending = {
      ...pending,
      turn_id: context.turn_id ?? pending.turn_id,
      session_id: context.session_id ?? pending.session_id,
      tool_use_id: context.tool_use_id ?? pending.tool_use_id,
      transcript_path: context.transcript_path ?? pending.transcript_path,
    };
  }
  // Grok's SubagentStart carries the exact reservation in its lifecycle
  // description and its native subagent id/session. Unlike Codex/Claude,
  // that lifecycle carrier is the authoritative observation itself; do not
  // require a separate carrier-free PreToolUse ledger row.
  if (!pending && host === "grok") {
    pending = pendingReservationFromLifecycleTicket(reserved, input, host, options);
  }
  // Every non-Grok host must observe the reservation from its native spawn
  // path before this lifecycle event can seed an identity. A copied/late
  // lifecycle carrier cannot create a fresh entry after exact retirement.
  if (!pending || !observeNativeIdentityForReservation(cwd, input, state, options, pending, agentId, host)) {
    return deny(HOST_GUARD_REASONS.reservation_identity_mismatch, null, agentId);
  }
  try {
    recordPendingBinding(cwd, input, state, reserved, options, "pending", agentId, host, turnId);
  } catch {
    return deny(HOST_GUARD_REASONS.state_unavailable, reserved.id, agentId);
  }
  return allow(reserved.id, agentId, "BATON_GUARD_SUBAGENT_PENDING_BIND");
}

export const guardPreToolUse = evaluatePreToolUse;
export const guardSubagentStart = evaluateSubagentStart;
export const evaluateHostGuard = evaluatePreToolUse;
