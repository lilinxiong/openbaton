import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runsDir } from "./paths.js";

/**
 * A Codex mutation claim is deliberately separate from native worker
 * attachment. The host may return task_name and attach a ticket before this
 * capability is presented by the worker's first guarded turn.
 */
export const GUARD_CLAIM_SCHEMA = 1 as const;
export const GUARD_CLAIMS_FILE = "guard-claims.json";
export const GUARD_CLAIMS_LOCK_FILE = `${GUARD_CLAIMS_FILE}.lock`;
export const DEFAULT_GUARD_CLAIM_TTL_MS = 60_000;
export const GUARD_CLAIMS_LOCK_STALE_MS = 2_000;

export type GuardClaimStatus = "issued" | "claimed";

export interface GuardClaimRecord {
  schema: typeof GUARD_CLAIM_SCHEMA;
  ticket_id: string;
  reservation_id: string | null;
  attempt: number;
  host: string;
  token_digest: string;
  issued_at: string;
  expires_at: string;
  status: GuardClaimStatus;
  turn_id: string | null;
  claimed_at: string | null;
  continuation_of_turn_id: string | null;
}

export interface GuardClaimState {
  schema: typeof GUARD_CLAIM_SCHEMA;
  claims: GuardClaimRecord[];
}

export interface GuardClaimPathOptions {
  env?: NodeJS.ProcessEnv;
  claimsPath?: string;
}

export interface IssueGuardClaimOptions extends GuardClaimPathOptions {
  cwd: string;
  ticket_id: string;
  reservation_id?: string | null;
  attempt: number;
  host: string;
  now?: Date | string | number;
  ttl_ms?: number;
  continuation_of_turn_id?: string | null;
}

export interface IssuedGuardClaim {
  token: string;
  ticket_id: string;
  reservation_id: string | null;
  attempt: number;
  host: string;
  issued_at: string;
  expires_at: string;
}

export interface IssueGuardContinuationOptions extends GuardClaimPathOptions {
  cwd: string;
  ticket_id: string;
  reservation_id?: string | null;
  attempt: number;
  host: string;
  predecessor_turn_id: string;
  now?: Date | string | number;
  ttl_ms?: number;
}

export interface ClaimGuardTurnOptions extends GuardClaimPathOptions {
  token?: string | null;
  ticket_id?: string | null;
  reservation_id?: string | null;
  attempt?: number | null;
  host: string;
  turn_id: string;
  now?: Date | string | number;
}

export type GuardClaimResult =
  | { ok: true; record: GuardClaimRecord }
  | { ok: false; code: "MISSING" | "INVALID" | "EXPIRED" | "REPLAY" | "CONFLICT"; record?: GuardClaimRecord };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function normalizedHost(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function instant(value?: Date | string | number): Date {
  const date = value instanceof Date ? value : value == null ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid guard claim timestamp");
  return date;
}

function claimsFile(cwd: string, options: GuardClaimPathOptions = {}): string {
  return options.claimsPath || path.join(runsDir(cwd, options.env), GUARD_CLAIMS_FILE);
}

function lockFile(file: string): string {
  return `${file}.lock`;
}

function normalizeClaim(value: unknown): GuardClaimRecord | null {
  if (!record(value)
    || value.schema !== GUARD_CLAIM_SCHEMA
    || !["issued", "claimed"].includes(String(value.status))) return null;
  const ticketId = stringValue(value.ticket_id);
  const host = normalizedHost(value.host);
  const attempt = Number(value.attempt);
  const digest = stringValue(value.token_digest);
  const issuedAt = stringValue(value.issued_at);
  const expiresAt = stringValue(value.expires_at);
  if (!ticketId || !host || !Number.isInteger(attempt) || attempt < 1 || !digest || !issuedAt || !expiresAt) return null;
  return {
    schema: GUARD_CLAIM_SCHEMA,
    ticket_id: ticketId,
    reservation_id: stringValue(value.reservation_id),
    attempt,
    host,
    token_digest: digest,
    issued_at: issuedAt,
    expires_at: expiresAt,
    status: value.status === "claimed" ? "claimed" : "issued",
    turn_id: stringValue(value.turn_id),
    claimed_at: stringValue(value.claimed_at),
    continuation_of_turn_id: stringValue(value.continuation_of_turn_id),
  };
}

function normalizeState(value: unknown): GuardClaimState | null {
  if (!record(value) || value.schema !== GUARD_CLAIM_SCHEMA || !Array.isArray(value.claims)) return null;
  const claims = value.claims.map(normalizeClaim);
  if (claims.some((item) => item === null)) return null;
  return { schema: GUARD_CLAIM_SCHEMA, claims: claims.filter((item): item is GuardClaimRecord => item !== null) };
}

export function guardClaimsPath(cwd: string, options: GuardClaimPathOptions = {}): string {
  return claimsFile(cwd, options);
}

export function readGuardClaimState(cwd: string, options: GuardClaimPathOptions = {}): { state: GuardClaimState; error: string | null } {
  const file = claimsFile(cwd, options);
  if (!fs.existsSync(file)) return { state: { schema: GUARD_CLAIM_SCHEMA, claims: [] }, error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const state = normalizeState(parsed);
    return state ? { state, error: null } : { state: { schema: GUARD_CLAIM_SCHEMA, claims: [] }, error: "guard claim state is malformed" };
  } catch (error) {
    return {
      state: { schema: GUARD_CLAIM_SCHEMA, claims: [] },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeState(file: string, state: GuardClaimState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function withClaimsLock<T>(file: string, fn: () => T): T {
  const lock = lockFile(file);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 2_000;
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs >= GUARD_CLAIMS_LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch (staleError: unknown) {
        if (staleError instanceof Error && "code" in staleError && staleError.code === "ENOENT") continue;
        throw staleError;
      }
      if (Date.now() >= deadline) throw new Error("guard claim state lock unavailable");
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

function digest(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Issue a random one-time capability. Only its digest is persisted. */
export function issueGuardClaim(options: IssueGuardClaimOptions): IssuedGuardClaim {
  const issued = instant(options.now);
  const ttl = Number.isFinite(Number(options.ttl_ms)) && Number(options.ttl_ms) > 0
    ? Math.floor(Number(options.ttl_ms))
    : DEFAULT_GUARD_CLAIM_TTL_MS;
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(issued.getTime() + ttl);
  const recordValue: GuardClaimRecord = {
    schema: GUARD_CLAIM_SCHEMA,
    ticket_id: String(options.ticket_id || "").trim(),
    reservation_id: stringValue(options.reservation_id),
    attempt: Number(options.attempt),
    host: normalizedHost(options.host),
    token_digest: digest(token),
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    status: "issued",
    turn_id: null,
    claimed_at: null,
    continuation_of_turn_id: stringValue(options.continuation_of_turn_id),
  };
  if (!recordValue.ticket_id || !recordValue.host || !Number.isInteger(recordValue.attempt) || recordValue.attempt < 1) {
    throw new Error("guard claim ticket, host, and attempt are required");
  }
  const file = claimsFile(options.cwd, options);
  withClaimsLock(file, () => {
    const loaded = readGuardClaimState(options.cwd, options);
    if (loaded.error) throw new Error(loaded.error);
    const state = loaded.state;
    state.claims = state.claims.filter((item) => item.expires_at > issued.toISOString() || item.status === "claimed");
    if (recordValue.continuation_of_turn_id) {
      const peers = state.claims
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.status === "claimed"
          && item.ticket_id === recordValue.ticket_id
          && item.attempt === recordValue.attempt
          && item.reservation_id === recordValue.reservation_id)
        .sort((left, right) => String(right.item.claimed_at || "").localeCompare(String(left.item.claimed_at || ""))
          || right.index - left.index);
      if (peers[0]?.item.turn_id !== recordValue.continuation_of_turn_id) {
        throw new Error("guard continuation predecessor is not the latest active turn");
      }
      if (state.claims.some((item) => item.status === "issued"
        && item.ticket_id === recordValue.ticket_id
        && item.attempt === recordValue.attempt
        && item.reservation_id === recordValue.reservation_id
        && item.continuation_of_turn_id === recordValue.continuation_of_turn_id)) {
        throw new Error("guard continuation already pending");
      }
    }
    state.claims.push(recordValue);
    writeState(file, state);
  });
  return {
    token,
    ticket_id: recordValue.ticket_id,
    reservation_id: recordValue.reservation_id,
    attempt: recordValue.attempt,
    host: recordValue.host,
    issued_at: recordValue.issued_at,
    expires_at: recordValue.expires_at,
  };
}

/**
 * Atomically issue the one pending capability that can continue the latest
 * active turn. The raw token is returned once; only its digest is persisted.
 */
export function issueGuardContinuationClaim(options: IssueGuardContinuationOptions): IssuedGuardClaim {
  const predecessor = stringValue(options.predecessor_turn_id);
  if (!predecessor) throw new Error("guard continuation predecessor is required");
  return issueGuardClaim({
    ...options,
    continuation_of_turn_id: predecessor,
  });
}

/** Atomically consume a capability and bind its current native turn. */
export function claimGuardTurn(cwd: string, options: ClaimGuardTurnOptions): GuardClaimResult {
  const token = stringValue(options.token);
  if (!token) return { ok: false, code: "MISSING" };
  const turnId = stringValue(options.turn_id);
  if (!turnId) return { ok: false, code: "CONFLICT" };
  const now = instant(options.now);
  const file = claimsFile(cwd, options);
  return withClaimsLock(file, () => {
    const loaded = readGuardClaimState(cwd, options);
    if (loaded.error) throw new Error(loaded.error);
    const state = loaded.state;
    const found = state.claims.find((item) => item.token_digest === digest(token));
    if (!found) return { ok: false, code: "INVALID" };
    if (found.host !== normalizedHost(options.host)
      || (options.ticket_id && found.ticket_id !== options.ticket_id)
      || (options.reservation_id && found.reservation_id !== options.reservation_id)
      || (options.attempt != null && found.attempt !== Number(options.attempt))) {
      return { ok: false, code: "CONFLICT", record: found };
    }
    // expires_at applies only while the capability is unconsumed. Once this
    // token has bound a turn, replay is classified from the binding even if
    // the launch token's short TTL has elapsed.
    if (found.status === "claimed") {
      return { ok: false, code: found.turn_id === turnId ? "REPLAY" : "CONFLICT", record: found };
    }
    if (new Date(found.expires_at).getTime() <= now.getTime()) return { ok: false, code: "EXPIRED", record: found };
    const otherClaims = state.claims.filter((item) => item !== found
      && item.status === "claimed"
      && item.ticket_id === found.ticket_id
      && item.attempt === found.attempt
      && item.reservation_id === found.reservation_id);
    const latestClaim = otherClaims
      .slice()
      .sort((left, right) => String(right.claimed_at || "").localeCompare(String(left.claimed_at || ""))
        || state.claims.indexOf(right) - state.claims.indexOf(left))[0];
    // A second turn cannot race the first binding. It must be issued as an
    // explicit continuation of the current (latest) turn, which replaces the
    // old active binding after the new token is consumed.
    if (latestClaim && found.continuation_of_turn_id !== latestClaim.turn_id) {
      return { ok: false, code: "CONFLICT", record: found };
    }
    found.status = "claimed";
    found.turn_id = turnId;
    found.claimed_at = now.toISOString();
    writeState(file, state);
    return { ok: true, record: found };
  });
}

/** Find an already-claimed, still-valid turn binding without consuming it. */
export function activeGuardClaimForTurn(
  cwd: string,
  options: Omit<ClaimGuardTurnOptions, "token" | "turn_id"> & { turn_id: string },
): GuardClaimRecord | null {
  const loaded = readGuardClaimState(cwd, options);
  if (loaded.error) throw new Error(loaded.error);
  const now = instant(options.now).getTime();
  const matches = loaded.state.claims.filter((item) => item.status === "claimed"
    && item.host === normalizedHost(options.host)
    && item.turn_id === options.turn_id
    // The token expires before it is consumed. Once claimed, its turn binding
    // remains valid until the ticket attempt is released; long-running
    // workers must not lose authorization merely because the launch token's
    // short TTL elapsed.
    && (item.status === "claimed" || new Date(item.expires_at).getTime() > now)
    && (!options.ticket_id || item.ticket_id === options.ticket_id)
    && (!options.reservation_id || item.reservation_id === options.reservation_id)
    && (options.attempt == null || item.attempt === Number(options.attempt)));
  if (matches.length > 1) throw new Error("multiple guard claims are bound to one turn");
  const match = matches[0];
  if (!match) return null;
  // A continuation supersedes its predecessor. Keep historical records for
  // audit, but only the newest link in a continuation chain authorizes work.
  const matchIndex = loaded.state.claims.indexOf(match);
  const superseded = loaded.state.claims.some((item, index) => index > matchIndex && item.status === "claimed"
    && item.ticket_id === match.ticket_id
    && item.attempt === match.attempt
    && item.reservation_id === match.reservation_id
    && item.continuation_of_turn_id === match.turn_id);
  return superseded ? null : match;
}

export function clearGuardClaims(cwd: string, query: { ticket_id: string; host?: string; attempt?: number | null } & GuardClaimPathOptions): void {
  const file = claimsFile(cwd, query);
  withClaimsLock(file, () => {
    const loaded = readGuardClaimState(cwd, query);
    if (loaded.error) throw new Error(loaded.error);
    loaded.state.claims = loaded.state.claims.filter((item) => item.ticket_id !== query.ticket_id
      || (query.host && item.host !== normalizedHost(query.host))
      || (query.attempt != null && item.attempt !== Number(query.attempt)));
    writeState(file, loaded.state);
  });
}
