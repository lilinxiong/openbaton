import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runsDir } from "./paths.js";
import type { DispatchReservationIdentity } from "./dispatch-reservation.js";

/**
 * Native child APIs do not expose one common identity contract.  Keep the
 * host-specific field knowledge at this boundary; dispatch and the guard only
 * consume the normalized identity returned by these adapters.
 */
export type NativeIdentityHost = "codex" | "claude" | "grok" | "cursor" | string;

export type NativeIdentitySource = "hook" | "tool-return" | "lifecycle";

export interface NativeWorkerIdentityAdapter {
  readonly host: NativeIdentityHost;
  /** Identity exposed on ordinary hook payloads, when the host has one. */
  readonly hookIdentity: (value: unknown) => string | null;
  /** Identity returned by the native spawn/task tool, when available. */
  readonly toolReturnIdentity: (value: unknown) => string | null;
  /** Grok's lifecycle description/session carrier, if present. */
  readonly lifecycleDescription: (value: unknown) => string | null;
  /** Native source that is authoritative for this host, if any. */
  readonly authoritativeSource: NativeIdentitySource | null;
  /** Whether the host's native tool return may bind without a hook observation. */
  readonly callerIdentityAllowed: boolean;
}

export interface NativeIdentityResolution {
  ok: boolean;
  identity: string | null;
  caller_identity: string | null;
  observed_identity: string | null;
  code: "OK" | "AGENT_ID_REQUIRED" | "AGENT_IDENTITY_REQUIRED" | "AGENT_IDENTITY_MISMATCH";
}

export interface PendingNativeReservation {
  reservation_id: string;
  ticket_id: string;
  attempt: number;
  host: string;
  turn_id: string | null;
  session_id: string | null;
  tool_use_id?: string | null;
  transcript_path?: string | null;
  observed_at: string;
}

export interface NativeIdentityObservation extends PendingNativeReservation {
  agent_id: string;
  source: NativeIdentitySource;
}

export interface HostIdentityState {
  schema: 1;
  pending: PendingNativeReservation[];
  observed: NativeIdentityObservation[];
}

export interface HostIdentityStateRead {
  state: HostIdentityState;
  error: string | null;
}

export interface IdentityContext {
  turn_id?: string | null;
  session_id?: string | null;
  tool_use_id?: string | null;
  transcript_path?: string | null;
  now?: Date | string | number;
}

export interface ObservedIdentityQuery {
  ticket_id: string;
  host: string;
  reservation_id?: string | null;
  attempt?: number | null;
}

export const HOST_IDENTITY_SCHEMA = 1 as const;
export const HOST_IDENTITY_FILE = "host-identity.json";
export const HOST_IDENTITY_LOCK_FILE = `${HOST_IDENTITY_FILE}.lock`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function candidate(value: unknown, keys: readonly string[]): string | null {
  if (typeof value === "string") return stringValue(value);
  if (!record(value)) return null;
  for (const key of keys) {
    const found = stringValue(value[key]);
    if (found) return found;
  }
  return null;
}

function normalizedHost(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isoNow(value?: Date | string | number): string {
  const date = value instanceof Date ? value : value == null ? new Date() : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function emptyState(): HostIdentityState {
  return { schema: HOST_IDENTITY_SCHEMA, pending: [], observed: [] };
}

const CURRENT_PENDING_KEYS = new Set([
  "reservation_id",
  "ticket_id",
  "attempt",
  "host",
  "turn_id",
  "session_id",
  "tool_use_id",
  "transcript_path",
  "observed_at",
]);
const CURRENT_OBSERVED_KEYS = new Set([...CURRENT_PENDING_KEYS, "agent_id", "source"]);

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}

function normalizePending(value: unknown, observed = false): PendingNativeReservation | null {
  const keys = observed ? CURRENT_OBSERVED_KEYS : CURRENT_PENDING_KEYS;
  if (!record(value) || !hasOnlyKeys(value, keys)) return null;
  const reservationId = stringValue(value.reservation_id);
  const ticketId = stringValue(value.ticket_id);
  const host = normalizedHost(value.host);
  const attempt = numberValue(value.attempt);
  if (!reservationId || !ticketId || !host || !attempt) return null;
  return {
    reservation_id: reservationId,
    ticket_id: ticketId,
    attempt,
    host,
    turn_id: stringValue(value.turn_id),
    session_id: stringValue(value.session_id),
    tool_use_id: stringValue(value.tool_use_id),
    transcript_path: stringValue(value.transcript_path),
    observed_at: stringValue(value.observed_at) || new Date(0).toISOString(),
  };
}

function normalizeObserved(value: unknown): NativeIdentityObservation | null {
  const pending = normalizePending(value, true);
  if (!pending || !record(value)) return null;
  if (!hasOnlyKeys(value, CURRENT_OBSERVED_KEYS)) return null;
  const agentId = stringValue(value.agent_id);
  const source = stringValue(value.source);
  if (!agentId || !source || !["hook", "tool-return", "lifecycle"].includes(source)) return null;
  return { ...pending, agent_id: agentId, source: source as NativeIdentitySource };
}

function normalizeState(value: unknown): HostIdentityState | null {
  if (!record(value) || value.schema !== HOST_IDENTITY_SCHEMA
    || !Array.isArray(value.pending) || !Array.isArray(value.observed)
    || Object.keys(value).sort().join("\n") !== ["observed", "pending", "schema"].join("\n")) return null;
  const pending = value.pending.map((item) => normalizePending(item));
  const observed = value.observed.map((item) => normalizeObserved(item));
  if (pending.some((item) => item === null)
    || observed.some((item) => item === null)) return null;
  return {
    schema: HOST_IDENTITY_SCHEMA,
    pending: pending.filter((item): item is PendingNativeReservation => item !== null),
    observed: observed.filter((item): item is NativeIdentityObservation => item !== null),
  };
}

/** User-global per-workspace state for the short reservation-to-hook window. */
export function hostIdentityStatePath(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(runsDir(cwd, env), HOST_IDENTITY_FILE);
}

export function hostIdentityLockPath(cwd: string, env?: NodeJS.ProcessEnv): string {
  return path.join(runsDir(cwd, env), HOST_IDENTITY_LOCK_FILE);
}

export function readHostIdentityState(cwd: string, env?: NodeJS.ProcessEnv): HostIdentityStateRead {
  const file = hostIdentityStatePath(cwd, env);
  if (!fs.existsSync(file)) return { state: emptyState(), error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const state = normalizeState(parsed);
    return state ? { state, error: null } : { state: emptyState(), error: "host identity state is malformed" };
  } catch (error) {
    return {
      state: emptyState(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeState(cwd: string, state: HostIdentityState, env?: NodeJS.ProcessEnv): void {
  const file = hostIdentityStatePath(cwd, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/**
 * Serialize the complete identity-ledger read/modify/write transaction.
 * Atomic rename alone prevents torn JSON but does not prevent two hook
 * processes from both reading the same old state and losing one observation.
 * A short lock closes that read-modify-write race while preserving parallel
 * worker execution after each reservation has been observed.
 */
function withIdentityStateLock<T>(cwd: string, env: NodeJS.ProcessEnv | undefined, fn: () => T): T {
  const lock = hostIdentityLockPath(cwd, env);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 2_000;
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
      if (Date.now() >= deadline) throw new Error("host identity state lock unavailable");
      // Hooks are synchronous entrypoints; wait only for the short handshake
      // critical section and fail closed rather than spinning indefinitely.
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

function mutableState(cwd: string, env: NodeJS.ProcessEnv | undefined): HostIdentityState {
  const loaded = readHostIdentityState(cwd, env);
  if (loaded.error) throw new Error(loaded.error);
  return loaded.state;
}

function reservationKey(value: Pick<PendingNativeReservation, "reservation_id" | "ticket_id" | "attempt" | "host">): string {
  return [value.host, value.ticket_id, value.reservation_id, value.attempt].join("\n");
}

function sameReservation(
  left: Pick<PendingNativeReservation, "reservation_id" | "ticket_id" | "attempt" | "host">,
  right: Pick<PendingNativeReservation, "reservation_id" | "ticket_id" | "attempt" | "host">,
): boolean {
  return reservationKey(left) === reservationKey(right);
}

function sameReservationContext(left: PendingNativeReservation, right: PendingNativeReservation): boolean {
  return stringValue(left.turn_id) === stringValue(right.turn_id)
    && stringValue(left.session_id) === stringValue(right.session_id)
    && stringValue(left.tool_use_id) === stringValue(right.tool_use_id)
    && stringValue(left.transcript_path) === stringValue(right.transcript_path);
}

function normalizeReservation(identity: DispatchReservationIdentity, context: IdentityContext = {}): PendingNativeReservation {
  const host = normalizedHost(identity.host);
  return {
    reservation_id: identity.reservation_id,
    ticket_id: identity.ticket_id,
    attempt: identity.attempt,
    host,
    // Codex PreToolUse has the parent turn, but that field is not repeated by
    // SubagentStart. Keep it out of the pending Codex reservation entirely.
    turn_id: host === "codex" ? null : stringValue(context.turn_id),
    session_id: stringValue(context.session_id),
    tool_use_id: stringValue(context.tool_use_id),
    transcript_path: stringValue(context.transcript_path),
    observed_at: isoNow(context.now),
  };
}

function appendPendingReservation(
  state: HostIdentityState,
  next: PendingNativeReservation,
  exclusiveHost: string | null = null,
): PendingNativeReservation | null {
  const host = normalizedHost(exclusiveHost);
  const existing = state.pending.find((item) => sameReservation(item, next));
  if (existing) return sameReservationContext(existing, next) ? existing : null;
  if (host && state.pending.some((item) => item.host === host)) return null;
  // Once a native lifecycle observation exists, a repeated PreToolUse envelope
  // must not re-open the reservation window or replace its causal context.
  if (state.observed.some((item) => sameReservation(item, next))) return null;
  state.pending = state.pending.filter((item) => !sameReservation(item, next));
  state.pending.push(next);
  return next;
}

/** Remember the exact reservation authorized by PreToolUse. */
export function recordPendingReservation(
  cwd: string,
  identity: DispatchReservationIdentity,
  context: IdentityContext = {},
  stateOverride?: HostIdentityState,
  env?: NodeJS.ProcessEnv,
): PendingNativeReservation {
  const result = recordPendingReservationExclusive(cwd, identity, context, null, stateOverride, env);
  if (!result) throw new Error("native reservation is unavailable");
  return result;
}

/**
 * Atomically reserve a host's short carrier-free handshake. A null result
 * means another reservation for the serialized host is already awaiting its
 * hook observation; callers must deny the second native spawn.
 */
export function recordPendingReservationExclusive(
  cwd: string,
  identity: DispatchReservationIdentity,
  context: IdentityContext = {},
  exclusiveHost: string | null = null,
  stateOverride?: HostIdentityState,
  env?: NodeJS.ProcessEnv,
): PendingNativeReservation | null {
  const next = normalizeReservation(identity, context);
  const apply = (state: HostIdentityState): PendingNativeReservation | null => {
    return appendPendingReservation(state, next, exclusiveHost);
  };
  if (stateOverride) return apply(stateOverride);
  return withIdentityStateLock(cwd, env, () => {
    const state = mutableState(cwd, env);
    const result = apply(state);
    if (result) {
      // Observations are historical evidence until an explicit lifecycle
      // transition clears them. Never evict an earlier worker when a later
      // reservation is recorded.
      writeState(cwd, state, env);
    }
    return result;
  });
}

/** Correlate a host lifecycle identity with one exact in-flight reservation. */
export function recordNativeIdentity(
  cwd: string,
  reservation: PendingNativeReservation,
  agentId: string,
  source: NativeIdentitySource,
  context: IdentityContext = {},
  stateOverride?: HostIdentityState,
  env?: NodeJS.ProcessEnv,
): NativeIdentityObservation {
  const identity = stringValue(agentId);
  if (!identity) throw new Error("native worker identity is required");
  const observed: NativeIdentityObservation = {
    ...reservation,
    turn_id: stringValue(context.turn_id) || reservation.turn_id,
    session_id: stringValue(context.session_id) || reservation.session_id,
    tool_use_id: stringValue(context.tool_use_id) || reservation.tool_use_id,
    transcript_path: stringValue(context.transcript_path) || reservation.transcript_path,
    observed_at: isoNow(context.now),
    agent_id: identity,
    source,
  };
  const apply = (state: HostIdentityState): NativeIdentityObservation => {
    const hasPending = state.pending.some((item) => sameReservation(item, observed));
    const priorObservations = state.observed.filter((item) => sameReservation(item, observed));
    // Grok's exact lifecycle description is itself the authoritative native
    // observation. Codex/Claude remain strict: their hook identity must be
    // correlated to a PreToolUse reservation before a bind is possible.
    const directGrokLifecycle = observed.host === "grok" && observed.source === "lifecycle";
    if (!hasPending && priorObservations.length === 0 && !directGrokLifecycle) {
      throw new Error("native reservation is not pending");
    }
    const existing = state.observed.find((item) => sameReservation(item, observed) && item.agent_id === observed.agent_id);
    // Repeated delivery of the same hook is idempotent. A different identity
    // for the same reservation remains as contradictory evidence so lookup
    // returns null and the subsequent bind fails closed.
    if (!existing) state.observed.push(observed);
    state.pending = state.pending.filter((item) => !sameReservation(item, observed));
    return observed;
  };
  if (stateOverride) return apply(stateOverride);
  return withIdentityStateLock(cwd, env, () => {
    const state = mutableState(cwd, env);
    const result = apply(state);
    writeState(cwd, state, env);
    return result;
  });
}

/** Find the one hook identity authorized for a dispatch attempt. */
export function observedNativeIdentity(
  cwd: string,
  query: ObservedIdentityQuery,
  env?: NodeJS.ProcessEnv,
  stateOverride?: HostIdentityState,
): NativeIdentityObservation | null {
  const host = normalizedHost(query.host);
  const state = stateOverride || readHostIdentityState(cwd, env).state;
  const matches = state.observed.filter((item) => {
    if (item.host !== host || item.ticket_id !== query.ticket_id) return false;
    if (query.reservation_id && item.reservation_id !== query.reservation_id) return false;
    if (query.attempt != null && item.attempt !== query.attempt) return false;
    return true;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function pendingNativeReservations(
  cwd: string,
  host: string,
  env?: NodeJS.ProcessEnv,
  stateOverride?: HostIdentityState,
): PendingNativeReservation[] {
  const normalized = normalizedHost(host);
  const state = stateOverride || readHostIdentityState(cwd, env).state;
  return state.pending.filter((item) => item.host === normalized);
}

/** Return one exact pending reservation, never a host-wide or ticket-prefix guess. */
export function pendingNativeReservation(
  cwd: string,
  query: ObservedIdentityQuery,
  env?: NodeJS.ProcessEnv,
  stateOverride?: HostIdentityState,
): PendingNativeReservation | null {
  const host = normalizedHost(query.host);
  const state = stateOverride || readHostIdentityState(cwd, env).state;
  const matches = state.pending.filter((item) => matchesQuery(item, query, host));
  return matches.length === 1 ? matches[0] : null;
}

/** Lifecycle context must share at least one exact causal field with PreToolUse. */
export function reservationContextMatches(reservation: PendingNativeReservation, context: IdentityContext): boolean {
  const fields: Array<[string | null, string | null]> = [
    [stringValue(reservation.session_id), stringValue(context.session_id)],
    [stringValue(reservation.turn_id), stringValue(context.turn_id)],
    [stringValue(reservation.tool_use_id), stringValue(context.tool_use_id)],
    [stringValue(reservation.transcript_path), stringValue(context.transcript_path)],
  ];
  const shared = fields.filter(([expected, actual]) => expected !== null && actual !== null);
  return shared.length > 0 && shared.every(([expected, actual]) => expected === actual);
}

/**
 * Correlation is a host contract, not a universal identity heuristic. Codex's
 * current Hooks format repeats the parent session_id and an optional
 * transcript_path on SubagentStart, then adds the child turn_id and agent
 * identity. The parent turn is not repeated by the child and no thread_id is
 * part of this contract, so only the session must match and two present
 * transcript paths must agree. Other hosts retain their own native carriers.
 */
export function reservationContextMatchesForHost(
  host: NativeIdentityHost,
  reservation: PendingNativeReservation,
  context: IdentityContext,
): boolean {
  const normalized = normalizedHost(host);
  if (normalized === "codex") {
    const expectedSession = stringValue(reservation.session_id);
    const actualSession = stringValue(context.session_id);
    if (!expectedSession || !actualSession || actualSession !== expectedSession) return false;
    const expectedTranscript = stringValue(reservation.transcript_path);
    const actualTranscript = stringValue(context.transcript_path);
    return expectedTranscript === null
      || actualTranscript === null
      || actualTranscript === expectedTranscript;
  }
  if (normalized === "claude") return reservationContextMatches(reservation, context);
  // Grok carries the exact reservation in its lifecycle description and
  // Cursor uses the native Task return; neither is correlated through this
  // carrier-free hook context.
  return false;
}

export function clearNativeIdentity(
  cwd: string,
  query: ObservedIdentityQuery,
  env?: NodeJS.ProcessEnv,
  stateOverride?: HostIdentityState,
): void {
  const host = normalizedHost(query.host);
  const apply = (state: HostIdentityState): void => {
    state.pending = state.pending.filter((item) => !matchesQuery(item, query, host));
    state.observed = state.observed.filter((item) => !matchesQuery(item, query, host));
  };
  if (stateOverride) {
    apply(stateOverride);
    return;
  }
  withIdentityStateLock(cwd, env, () => {
    const state = mutableState(cwd, env);
    apply(state);
    writeState(cwd, state, env);
  });
}

function matchesQuery(item: PendingNativeReservation, query: ObservedIdentityQuery, host: string): boolean {
  return item.host === host
    && item.ticket_id === query.ticket_id
    && (!query.reservation_id || item.reservation_id === query.reservation_id)
    && (query.attempt == null || item.attempt === query.attempt);
}

function adapterRecord(value: unknown): Record<string, unknown> | null {
  return record(value) ? value : null;
}

function first(value: unknown, keys: readonly string[]): string | null {
  return record(value) ? candidate(value, keys) : null;
}

const CODEX_HOOK_ID_KEYS = ["agent_id"] as const;
const CLAUDE_HOOK_ID_KEYS = ["agent_id", "agentId"] as const;

const codexIdentityAdapter: NativeWorkerIdentityAdapter = {
  host: "codex",
  hookIdentity: (value) => first(value, CODEX_HOOK_ID_KEYS),
  // Codex's task_name is bind metadata only. The authoritative identity is
  // the top-level agent_id emitted by SubagentStart.
  toolReturnIdentity: () => null,
  lifecycleDescription: (value) => first(value, ["description"]),
  authoritativeSource: "hook",
  callerIdentityAllowed: false,
};

const claudeIdentityAdapter: NativeWorkerIdentityAdapter = {
  host: "claude",
  hookIdentity: (value) => first(value, CLAUDE_HOOK_ID_KEYS),
  toolReturnIdentity: (value) => first(value, ["agent_id", "agentId"]),
  lifecycleDescription: (value) => first(value, ["description"]),
  authoritativeSource: "hook",
  callerIdentityAllowed: false,
};

const grokIdentityAdapter: NativeWorkerIdentityAdapter = {
  host: "grok",
  // Grok's session is a lifecycle carrier, not the ticket's agent_id. Keep
  // it available through the guard's explicit session handling while
  // returning only the native subagent identity here.
  hookIdentity: (value) => first(value, ["subagentId", "subagent_id"]),
  toolReturnIdentity: (value) => first(value, ["subagentId", "subagent_id", "session_id", "sessionId"]),
  lifecycleDescription: (value) => first(value, ["description"]),
  authoritativeSource: "lifecycle",
  callerIdentityAllowed: false,
};

const cursorIdentityAdapter: NativeWorkerIdentityAdapter = {
  host: "cursor",
  // Cursor has no equivalent guard hook; do not invent one from a session.
  hookIdentity: () => null,
  toolReturnIdentity: (value) => first(value, ["task_name", "taskName", "task_id", "taskId"]),
  lifecycleDescription: () => null,
  authoritativeSource: "tool-return",
  callerIdentityAllowed: true,
};

const unknownIdentityAdapter: NativeWorkerIdentityAdapter = {
  host: "unknown",
  hookIdentity: () => null,
  toolReturnIdentity: () => null,
  lifecycleDescription: () => null,
  authoritativeSource: null,
  callerIdentityAllowed: false,
};

export const HOST_IDENTITY_ADAPTERS: Readonly<Record<string, NativeWorkerIdentityAdapter>> = {
  codex: codexIdentityAdapter,
  claude: claudeIdentityAdapter,
  grok: grokIdentityAdapter,
  cursor: cursorIdentityAdapter,
};

export function hostIdentityAdapter(host: NativeIdentityHost): NativeWorkerIdentityAdapter {
  return HOST_IDENTITY_ADAPTERS[normalizedHost(host)] || unknownIdentityAdapter;
}

export function nativeHookIdentity(host: NativeIdentityHost, value: unknown): string | null {
  return hostIdentityAdapter(host).hookIdentity(adapterRecord(value) || value);
}

export function nativeToolReturnIdentity(host: NativeIdentityHost, value: unknown): string | null {
  return hostIdentityAdapter(host).toolReturnIdentity(adapterRecord(value) || value);
}

export function nativeLifecycleDescription(host: NativeIdentityHost, value: unknown): string | null {
  return hostIdentityAdapter(host).lifecycleDescription(adapterRecord(value) || value);
}

/** Only the host's declared authoritative carrier can authorize a native bind. */
export function isAuthoritativeNativeObservation(host: NativeIdentityHost, source: NativeIdentitySource): boolean {
  const normalized = normalizedHost(host);
  if (normalized === "codex" || normalized === "claude") return source === "hook";
  if (normalized === "grok") return source === "lifecycle";
  if (normalized === "cursor") return source === "tool-return";
  return false;
}

/** Resolve a caller token against the host's authoritative observation. */
export function resolveNativeWorkerIdentity(
  host: NativeIdentityHost,
  { callerIdentity, observedIdentity, observedSource, requireObserved = true }: {
    callerIdentity?: unknown;
    observedIdentity?: unknown;
    observedSource?: NativeIdentitySource;
    requireObserved?: boolean;
  } = {},
): NativeIdentityResolution {
  const adapter = hostIdentityAdapter(host);
  const caller = stringValue(callerIdentity);
  const candidateObserved = stringValue(observedIdentity);
  const observedSourceAllowed = adapter.authoritativeSource !== null
    && observedSource !== undefined
    && observedSource === adapter.authoritativeSource
    && isAuthoritativeNativeObservation(host, observedSource);
  if (candidateObserved && !observedSourceAllowed) {
    return {
      ok: false,
      identity: null,
      caller_identity: caller,
      observed_identity: candidateObserved,
      code: "AGENT_IDENTITY_MISMATCH",
    };
  }
  const observed = candidateObserved
    && observedSourceAllowed
    ? candidateObserved
    : null;
  if (observed) {
    if (caller && caller !== observed) {
      return {
        ok: false,
        identity: null,
        caller_identity: caller,
        observed_identity: observed,
        code: "AGENT_IDENTITY_MISMATCH",
      };
    }
    return { ok: true, identity: observed, caller_identity: caller, observed_identity: observed, code: "OK" };
  }
  if (!caller) {
    return {
      ok: false,
      identity: null,
      caller_identity: null,
      observed_identity: null,
      code: "AGENT_ID_REQUIRED",
    };
  }
  if (!adapter.callerIdentityAllowed && requireObserved && !observed) {
    return {
      ok: false,
      identity: null,
      caller_identity: caller,
      observed_identity: null,
      code: "AGENT_IDENTITY_REQUIRED",
    };
  }
  return { ok: true, identity: caller, caller_identity: caller, observed_identity: null, code: "OK" };
}

export const resolveHostWorkerIdentity = resolveNativeWorkerIdentity;
export const resolveWorkerIdentity = resolveNativeWorkerIdentity;
