import crypto from "node:crypto";
import { sha256Hex } from "./json-utils.js";

/**
 * Opaque identity of a root agent tree. The raw BATON_SESSION_ID is never
 * persisted; tickets retain only this stable digest.
 */
export type SessionUid = string;

/**
 * The capacity and lifecycle scope for one root agent tree.
 *
 * This is deliberately immutable: descendants inherit the scope captured by
 * their root and cannot replace it with a later environment value.
 */
export interface SessionScope {
  readonly session_uid: SessionUid;
}

export type SessionScopeErrorCode =
  | "SESSION_SCOPE_REQUIRED"
  | "SESSION_SCOPE_INVALID"
  | "SESSION_SCOPE_MISMATCH";

export interface SessionScopeErrorDetails {
  readonly expected_session_uid?: string;
  readonly actual_session_uid?: string;
  readonly session_uid?: string;
  readonly env_key?: "BATON_SESSION_ID";
}

/** Structured, fail-closed error for missing or invalid tree identity. */
export class SessionScopeError extends Error {
  readonly code: SessionScopeErrorCode;
  readonly details: SessionScopeErrorDetails;
  readonly expected_session_uid?: string;
  readonly actual_session_uid?: string;
  readonly session_uid?: string;

  constructor(code: SessionScopeErrorCode, message: string, details: SessionScopeErrorDetails = {}) {
    super(message);
    this.name = "SessionScopeError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.expected_session_uid = details.expected_session_uid;
    this.actual_session_uid = details.actual_session_uid;
    this.session_uid = details.session_uid;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

function rawSessionId(env: NodeJS.ProcessEnv = process.env): string {
  const value = typeof env.BATON_SESSION_ID === "string" ? env.BATON_SESSION_ID.trim() : "";
  if (!value) {
    throw new SessionScopeError(
      "SESSION_SCOPE_REQUIRED",
      "BATON_SESSION_ID is required to establish the root agent tree scope",
      { env_key: "BATON_SESSION_ID" },
    );
  }
  return value;
}

function isSessionUid(value: unknown): value is SessionUid {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Derive the persisted, opaque tree identity from the current environment. */
export function sessionUidFromEnv(env?: NodeJS.ProcessEnv): SessionUid {
  return sha256Hex(rawSessionId(env));
}

/** Construct an immutable scope from a valid persisted session UID. */
export function sessionScopeFromUid(value: unknown): SessionScope {
  if (!isSessionUid(value)) {
    throw new SessionScopeError(
      "SESSION_SCOPE_INVALID",
      "session_uid must be a lowercase SHA-256 session identity",
      { session_uid: typeof value === "string" ? value : undefined },
    );
  }
  return Object.freeze({ session_uid: value });
}

/** Construct the immutable root-agent-tree scope for the current invocation. */
export function sessionScope(env?: NodeJS.ProcessEnv): SessionScope {
  return sessionScopeFromUid(sessionUidFromEnv(env));
}

/**
 * Validate that the current caller belongs to a ticket's captured tree.
 * Validation happens before callers mutate lifecycle or Receipt state.
 */
export function validateSessionScope(expectedSessionUid: unknown, envOrScope?: NodeJS.ProcessEnv | SessionScope): SessionScope {
  if (!isSessionUid(expectedSessionUid)) {
    throw new SessionScopeError(
      "SESSION_SCOPE_INVALID",
      "target ticket does not contain a valid session_uid",
      { session_uid: typeof expectedSessionUid === "string" ? expectedSessionUid : undefined },
    );
  }

  const expected = sessionScopeFromUid(expectedSessionUid);
  const actual = envOrScope && typeof envOrScope === "object" && "session_uid" in envOrScope
    ? sessionScopeFromUid((envOrScope as SessionScope).session_uid)
    : sessionScope(envOrScope as NodeJS.ProcessEnv | undefined);
  if (actual.session_uid !== expected.session_uid) {
    throw new SessionScopeError(
      "SESSION_SCOPE_MISMATCH",
      `session scope does not match ticket (expected ${expected.session_uid}, got ${actual.session_uid})`,
      { expected_session_uid: expected.session_uid, actual_session_uid: actual.session_uid },
    );
  }
  return expected;
}

/** Alias emphasizing that a scope is checked before a ticket-targeted action. */
export const assertSessionScope = validateSessionScope;
