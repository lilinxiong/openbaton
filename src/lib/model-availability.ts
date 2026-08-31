import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { modelAvailabilityPath } from "./paths.js";
import { sessionUidFromEnv } from "./session-scope.js";

export const MODEL_AVAILABILITY_SCHEMA_VERSION = 2;
const HISTORICAL_MODEL_AVAILABILITY_SCHEMA_VERSION = 1;
export const DEFAULT_ACCOUNT_SCOPE = "host-profile";
export const DEFAULT_PROBE_BACKOFF_MS = 15 * 60 * 1000;
export const MAX_PROBE_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const PROBE_LEASE_MS = 2 * 60 * 1000;
export const MODEL_AVAILABILITY_LOCK_WAIT_MS = 2_000;

export type ModelAvailabilityStatus = "available" | "exhausted" | "probe_due";

export interface ModelAvailabilityRecord {
  session_uid: string;
  host: string;
  account_scope: string;
  route_id: string;
  status: ModelAvailabilityStatus;
  reason: string | null;
  observed_at: string;
  reset_at: string | null;
  next_probe_at: string | null;
  probe_attempts: number;
  probe_lease_owner: string | null;
  probe_lease_until: string | null;
  /** Classification of persisted unavailability evidence, when known. */
  evidence_kind?: AvailabilityEvidenceKind;
}

export type AvailabilityEvidenceKind = "quota" | "rate_limit" | "session_uncallable" | null;

type HistoricalModelAvailabilityRecord = Omit<ModelAvailabilityRecord, "session_uid">;

export interface ModelAvailabilityStore {
  schema_version: typeof MODEL_AVAILABILITY_SCHEMA_VERSION;
  records: ModelAvailabilityRecord[];
  /** Schema-1 records are retained as evidence, but are never dispatch gates. */
  historical_records: HistoricalModelAvailabilityRecord[];
}

export interface AvailabilityScope {
  host: string;
  routeId: string;
  accountScope?: string | null;
}

export interface AvailabilityState extends ModelAvailabilityRecord {
  probe_available: boolean;
  /** False only for the synthetic default used before this session observes a route. */
  evidence_present: boolean;
}

export interface QuotaOutcomeInput {
  errorCode?: string | null;
  message?: string | null;
  /** Authoritative route/provider disclosure, when available. */
  remainingPercent?: number | null;
}

const EXPLICIT_QUOTA_CODES = new Set([
  "MODEL_QUOTA_EXHAUSTED",
  "QUOTA_EXHAUSTED",
  "QUOTA_DEPLETED",
  "INSUFFICIENT_QUOTA",
  "USAGE_LIMIT_REACHED",
  "USAGE_LIMIT_EXHAUSTED",
]);

/**
 * Provider-native usage-limit wording is quota evidence even when it does not
 * mention a model. A bare HTTP 429 remains rate-limit evidence, not quota.
 */
export function isConfirmedQuotaExhaustion(input: QuotaOutcomeInput): boolean {
  const code = String(input.errorCode || "").trim().toUpperCase();
  if (EXPLICIT_QUOTA_CODES.has(code)) return true;
  if (typeof input.remainingPercent === "number" && Number.isFinite(input.remainingPercent) && input.remainingPercent <= 0) return true;
  const message = String(input.message || "");
  return /\b(?:model|account|plan)\s+quota\s+(?:exhausted|depleted|remaining\s*[:=]?\s*0)\b/i.test(message)
    || /\byou(?:\s+have|['’]ve)\s+hit\s+your\s+usage\s+limit\b/i.test(message)
    || /\busage\s+limit\s+(?:(?:has|is)\s+been\s+)?(?:reached|exhausted)\b/i.test(message);
}

/** Explicit provider throttling evidence, kept distinct from quota. */
export function isExplicitRateLimit(input: QuotaOutcomeInput): boolean {
  const code = String(input.errorCode || "").trim().toUpperCase().replaceAll("-", "_");
  if (code === "429" || code === "HTTP_429" || /(?:RATE_LIMIT|RATE_LIMITED|TOO_MANY_REQUESTS|THROTTL(?:ED|ING))/.test(code)) return true;
  return /\b(?:rate[ -]?limit(?:ed|ing)?|too\s+many\s+requests|throttl(?:ed|ing))\b/i.test(String(input.message || ""));
}

/** Publicly named counterpart to isConfirmedQuotaExhaustion for callers that
 * need to preserve rate-limit evidence without relabeling it as quota. */
export const isConfirmedRateLimit = isExplicitRateLimit;

export function earliestQuotaResetAt(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .map((value) => String(value || "").trim())
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => item.value && Number.isFinite(item.time))
    .sort((left, right) => left.time - right.time);
  return timestamps[0]?.value || null;
}

function emptyStore(): ModelAvailabilityStore {
  return { schema_version: MODEL_AVAILABILITY_SCHEMA_VERSION, records: [], historical_records: [] };
}

function invalidAvailability(file: string, detail: string): Error {
  const error = new Error(`MODEL_AVAILABILITY_INVALID: ${file}: ${detail}`) as Error & { code: string };
  error.code = "MODEL_AVAILABILITY_INVALID";
  return error;
}

function normalizedHost(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function normalizedRoute(value: string): string {
  return String(value || "").trim();
}

function validSessionUid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Never persist account labels or credentials; only a one-way scope digest. */
export function accountScopeDigest(value: string | null | undefined = DEFAULT_ACCOUNT_SCOPE): string {
  const scope = String(value || DEFAULT_ACCOUNT_SCOPE).trim() || DEFAULT_ACCOUNT_SCOPE;
  return crypto.createHash("sha256").update(scope).digest("hex");
}

function key(value: Pick<ModelAvailabilityRecord, "session_uid" | "host" | "account_scope" | "route_id">): string {
  return `${value.session_uid}\0${value.host}\0${value.account_scope}\0${value.route_id}`;
}

function validStatus(value: unknown): value is ModelAvailabilityStatus {
  return value === "available" || value === "exhausted" || value === "probe_due";
}

function normalizeAvailabilityFields(item: Record<string, unknown>, requireHashedScope: boolean): HistoricalModelAvailabilityRecord | null {
  const host = normalizedHost(String(item.host || ""));
  const routeId = normalizedRoute(String(item.route_id || ""));
  const scope = String(item.account_scope || "").trim();
  if (!host || !routeId || !scope || (requireHashedScope && !/^[0-9a-f]{64}$/.test(scope)) || !validStatus(item.status)) return null;
  const attempts = Number(item.probe_attempts);
  const optionalTimestamp = (value: unknown): value is string | null => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
  const optionalOwner = (value: unknown): value is string | null => value === null || typeof value === "string";
  if (typeof item.reason !== "string" && item.reason !== null) return null;
  if (typeof item.observed_at !== "string" || !item.observed_at.trim() || !Number.isFinite(Date.parse(item.observed_at))) return null;
  if (!optionalTimestamp(item.reset_at) || !optionalTimestamp(item.next_probe_at)) return null;
  if (!optionalOwner(item.probe_lease_owner) || !optionalTimestamp(item.probe_lease_until)) return null;
  if (!Number.isFinite(attempts) || attempts < 0 || !Number.isInteger(attempts)) return null;
  const rawKind = item.evidence_kind;
  const evidenceKind = rawKind === undefined || rawKind === null
    ? (statusEvidenceKind(item.status, item.reason) as AvailabilityEvidenceKind)
    : rawKind === "quota" || rawKind === "rate_limit" || rawKind === "session_uncallable"
      ? rawKind
      : null;
  if (rawKind !== undefined && rawKind !== null && evidenceKind === null) return null;
  return {
    host,
    account_scope: scope,
    route_id: routeId,
    status: item.status,
    reason: String(item.reason || "").trim() || null,
    observed_at: item.observed_at.trim(),
    reset_at: String(item.reset_at || "").trim() || null,
    next_probe_at: String(item.next_probe_at || "").trim() || null,
    probe_attempts: attempts,
    probe_lease_owner: String(item.probe_lease_owner || "").trim() || null,
    probe_lease_until: String(item.probe_lease_until || "").trim() || null,
    evidence_kind: evidenceKind,
  };
}

function statusEvidenceKind(status: unknown, reason: unknown): AvailabilityEvidenceKind {
  if (status !== "exhausted" && status !== "probe_due") return null;
  const value = String(reason || "");
  if (isExplicitRateLimit({ errorCode: value, message: value })) return "rate_limit";
  if (/UNCALLABLE|NOT_CALLABLE|UNAVAILABLE|UNREACHABLE/i.test(value)) return "session_uncallable";
  return "quota";
}

function normalizeRecord(value: unknown): ModelAvailabilityRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!validSessionUid(item.session_uid)) return null;
  const common = normalizeAvailabilityFields(item, true);
  return common ? { session_uid: item.session_uid, ...common } : null;
}

function normalizeHistoricalRecord(value: unknown): HistoricalModelAvailabilityRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeAvailabilityFields(value as Record<string, unknown>, false);
}

export function readModelAvailability(cwd: string, env?: NodeJS.ProcessEnv): ModelAvailabilityStore {
  // Establish the current tree identity for every read. It is used by each
  // dispatch-facing operation when selecting a record, but never persisted raw.
  const sessionUid = sessionUidFromEnv(env);
  void sessionUid;
  const file = modelAvailabilityPath(cwd, env);
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidAvailability(file, "root must be an object");
    }
    const source = parsed as Record<string, unknown>;
    if (source.schema_version === HISTORICAL_MODEL_AVAILABILITY_SCHEMA_VERSION) {
      if (!Array.isArray(source.records)) throw invalidAvailability(file, "records must be an array");
      const historicalRecords = source.records.map((item) => {
        const record = normalizeHistoricalRecord(item);
        if (!record) throw invalidAvailability(file, "records contains a malformed legacy entry");
        return record;
      });
      return { ...emptyStore(), historical_records: historicalRecords };
    }
    if (source.schema_version !== MODEL_AVAILABILITY_SCHEMA_VERSION) {
      throw invalidAvailability(file, `unsupported schema_version ${String(source.schema_version)}`);
    }
    if (!Array.isArray(source.records)) throw invalidAvailability(file, "records must be an array");
    const records = source.records.map((item) => {
      const record = normalizeRecord(item);
      if (!record) throw invalidAvailability(file, "records contains a malformed entry");
      return record;
    });
    return {
      schema_version: MODEL_AVAILABILITY_SCHEMA_VERSION,
      records,
      historical_records: Array.isArray(source.historical_records)
        ? source.historical_records.map((item) => {
          const record = normalizeHistoricalRecord(item);
          if (!record) throw invalidAvailability(file, "historical_records contains a malformed entry");
          return record;
        })
        : [],
    };
  } catch (cause) {
    if (cause instanceof Error && (cause as Error & { code?: string }).code === "MODEL_AVAILABILITY_INVALID") throw cause;
    throw invalidAvailability(file, cause instanceof Error ? cause.message : String(cause));
  }
}

function writeModelAvailability(cwd: string, store: ModelAvailabilityStore, env?: NodeJS.ProcessEnv): void {
  const file = modelAvailabilityPath(cwd, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

interface AvailabilityLock {
  fd: number;
  file: string;
  token: string;
}

function lockOwnerIsAlive(file: string): boolean | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    const pid = Number(value.pid);
    if (!Number.isInteger(pid) || pid < 1) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      // EPERM still proves that a process owns the PID. Unknown probe errors
      // are treated conservatively and never authorize lock deletion.
      return true;
    }
  } catch {
    return null;
  }
}

function acquireAvailabilityLock(cwd: string, env: NodeJS.ProcessEnv | undefined, _now: Date): AvailabilityLock | null {
  const file = modelAvailabilityPath(cwd, env);
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + MODEL_AVAILABILITY_LOCK_WAIT_MS;
  while (true) {
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        // Lock ownership is a filesystem/runtime concern, so staleness uses
        // wall-clock time rather than a caller-supplied logical event time.
        if (Date.now() - fs.statSync(lock).mtimeMs >= PROBE_LEASE_MS && lockOwnerIsAlive(lock) !== true) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw staleError;
      }
      if (Date.now() >= deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
    const token = crypto.randomUUID();
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() })}\n`, "utf8");
      fs.fsyncSync(fd);
      return { fd, file: lock, token };
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lock); } catch { /* already removed */ }
      throw error;
    }
  }
}

function releaseAvailabilityLock(lock: AvailabilityLock): void {
  fs.closeSync(lock.fd);
  try {
    const value = JSON.parse(fs.readFileSync(lock.file, "utf8")) as { token?: unknown };
    if (value.token === lock.token) fs.unlinkSync(lock.file);
  } catch { /* already reclaimed or replaced */ }
}

function withAvailabilityLock<T>(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  now: Date,
  unavailable: T,
  mutate: () => T,
): T {
  const lock = acquireAvailabilityLock(cwd, env, now);
  if (!lock) return unavailable;
  try {
    return mutate();
  } finally {
    releaseAvailabilityLock(lock);
  }
}

function scopeOf(scope: AvailabilityScope, sessionUid: string): Pick<ModelAvailabilityRecord, "session_uid" | "host" | "account_scope" | "route_id"> {
  const host = normalizedHost(scope.host);
  const routeId = normalizedRoute(scope.routeId);
  if (!host) throw new Error("MODEL_AVAILABILITY_HOST_REQUIRED");
  if (!routeId) throw new Error("MODEL_AVAILABILITY_ROUTE_REQUIRED");
  return { session_uid: sessionUid, host, account_scope: accountScopeDigest(scope.accountScope), route_id: routeId };
}

function iso(value: Date | string | number | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("MODEL_AVAILABILITY_INVALID_TIME");
  return date.toISOString();
}

function millis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordFor(store: ModelAvailabilityStore, scope: Pick<ModelAvailabilityRecord, "session_uid" | "host" | "account_scope" | "route_id">): ModelAvailabilityRecord | null {
  return store.records.find((item) => key(item) === key(scope)) || null;
}

function replaceRecord(store: ModelAvailabilityStore, record: ModelAvailabilityRecord): void {
  const recordKey = key(record);
  store.records = [record, ...store.records.filter((item) => key(item) !== recordKey)]
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at))
    .slice(0, 1000);
}

function backoff(attempts: number): number {
  return Math.min(MAX_PROBE_BACKOFF_MS, DEFAULT_PROBE_BACKOFF_MS * 2 ** Math.min(Math.max(0, attempts - 1), 8));
}

/** Return the durable state without mutating it. */
export function availabilityForRoute(
  cwd: string,
  scope: AvailabilityScope,
  now: Date | string | number = new Date(),
  env?: NodeJS.ProcessEnv,
): AvailabilityState {
  const sessionUid = sessionUidFromEnv(env);
  const identity = scopeOf(scope, sessionUid);
  const persisted = recordFor(readModelAvailability(cwd, env), identity);
  const record = persisted || {
    ...identity,
    status: "available" as const,
    reason: null,
    observed_at: iso(now),
    reset_at: null,
    next_probe_at: null,
    probe_attempts: 0,
    probe_lease_owner: null,
    probe_lease_until: null,
    evidence_kind: null as AvailabilityEvidenceKind,
  };
  const evidencePresent = persisted !== null;
  const current = new Date(now instanceof Date ? now : new Date(now)).getTime();
  const leaseUntil = millis(record.probe_lease_until);
  const due = record.status === "exhausted"
    && ((millis(record.reset_at) !== null && millis(record.reset_at)! <= current)
      || (millis(record.reset_at) === null && millis(record.next_probe_at) !== null && millis(record.next_probe_at)! <= current));
  return {
    ...record,
    status: due ? "probe_due" : record.status,
    probe_available: (due || record.status === "probe_due") && (!leaseUntil || leaseUntil <= current),
    evidence_present: evidencePresent,
  };
}

export function markRouteExhausted(
  cwd: string,
  scope: AvailabilityScope,
  { reason = "QUOTA_EXHAUSTED", resetAt = null, now = new Date(), env, evidenceKind }: { reason?: string; resetAt?: string | null; now?: Date | string | number; env?: NodeJS.ProcessEnv; evidenceKind?: Exclude<AvailabilityEvidenceKind, null> } = {},
): ModelAvailabilityRecord {
  const observed = iso(now);
  const result = withAvailabilityLock(cwd, env, new Date(observed), null, () => {
    const identity = scopeOf(scope, sessionUidFromEnv(env));
    const store = readModelAvailability(cwd, env);
    const previous = recordFor(store, identity);
    const attempts = (previous?.probe_attempts || 0) + 1;
    const reset = resetAt && millis(resetAt) !== null ? new Date(millis(resetAt)!).toISOString() : null;
    const next = reset || new Date(new Date(observed).getTime() + backoff(attempts)).toISOString();
    const record: ModelAvailabilityRecord = {
      ...identity,
      status: "exhausted",
      reason: String(reason || "QUOTA_EXHAUSTED").trim() || "QUOTA_EXHAUSTED",
      observed_at: observed,
      reset_at: reset,
      next_probe_at: next,
      probe_attempts: attempts,
      probe_lease_owner: null,
      probe_lease_until: null,
      evidence_kind: evidenceKind || statusEvidenceKind("exhausted", reason),
    };
    replaceRecord(store, record);
    writeModelAvailability(cwd, store, env);
    return record;
  });
  if (!result) throw new Error("MODEL_AVAILABILITY_LOCK_BUSY");
  return result;
}

export function markRouteAvailable(
  cwd: string,
  scope: AvailabilityScope,
  { now = new Date(), env }: { now?: Date | string | number; env?: NodeJS.ProcessEnv } = {},
): ModelAvailabilityRecord {
  const observed = iso(now);
  const result = withAvailabilityLock(cwd, env, new Date(observed), null, () => {
    const identity = scopeOf(scope, sessionUidFromEnv(env));
    const record: ModelAvailabilityRecord = {
      ...identity,
      status: "available",
      reason: null,
      observed_at: observed,
      reset_at: null,
      next_probe_at: null,
      probe_attempts: 0,
      probe_lease_owner: null,
      probe_lease_until: null,
      evidence_kind: null,
    };
    const store = readModelAvailability(cwd, env);
    replaceRecord(store, record);
    writeModelAvailability(cwd, store, env);
    return record;
  });
  if (!result) throw new Error("MODEL_AVAILABILITY_LOCK_BUSY");
  return result;
}

/** Atomically claim the one probe owner observed by this process. */
export function claimRouteProbe(
  cwd: string,
  scope: AvailabilityScope,
  { owner = `${process.pid}:${crypto.randomUUID()}`, now = new Date(), env }: { owner?: string; now?: Date | string | number; env?: NodeJS.ProcessEnv } = {},
): { claimed: boolean; record: ModelAvailabilityRecord } {
  sessionUidFromEnv(env);
  const current = new Date(now instanceof Date ? now : new Date(now));
  const state = availabilityForRoute(cwd, scope, current, env);
  return withAvailabilityLock(cwd, env, current, { claimed: false, record: state }, () => {
    // Re-read after acquiring the lock. A selector may have changed the route
    // between the optimistic read above and this compare-and-set.
    const freshState = availabilityForRoute(cwd, scope, current, env);
    const identity = scopeOf(scope, sessionUidFromEnv(env));
    const store = readModelAvailability(cwd, env);
    const existing = recordFor(store, identity) || freshState;
    const leaseUntil = millis(existing.probe_lease_until);
    const due = freshState.status === "probe_due" || freshState.probe_available;
    if (!due || (leaseUntil !== null && leaseUntil > current.getTime())) return { claimed: false, record: freshState };
    const record: ModelAvailabilityRecord = {
      ...existing,
      status: "probe_due",
      observed_at: current.toISOString(),
      probe_lease_owner: owner,
      probe_lease_until: new Date(current.getTime() + PROBE_LEASE_MS).toISOString(),
    };
    replaceRecord(store, record);
    writeModelAvailability(cwd, store, env);
    return { claimed: true, record };
  });
}

export function resetRouteAvailability(
  cwd: string,
  scope: AvailabilityScope,
  { now = new Date(), env }: { now?: Date | string | number; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const result = withAvailabilityLock(cwd, env, new Date(iso(now)), null, () => {
    const identity = scopeOf(scope, sessionUidFromEnv(env));
    const store = readModelAvailability(cwd, env);
    const before = store.records.length;
    store.records = store.records.filter((item) => key(item) !== key(identity));
    if (store.records.length !== before) writeModelAvailability(cwd, store, env);
    return store.records.length !== before;
  });
  if (result === null) throw new Error("MODEL_AVAILABILITY_LOCK_BUSY");
  return result;
}
