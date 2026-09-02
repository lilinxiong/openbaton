import {
  EXACT_EXECUTION_ROOT_IDENTITY_FIELDS,
  extractExactExecutionRootIdentity,
  type ExactExecutionRootIdentity,
} from "../../adapters/contract.js";

const ENVELOPE_KEY = "baton_dispatch";

export const BATON_DISPATCH_RESERVATION_SCHEMA = 1;

export interface DispatchReservationIdentity extends Partial<ExactExecutionRootIdentity> {
  schema: typeof BATON_DISPATCH_RESERVATION_SCHEMA;
  reservation_id: string;
  ticket_id: string;
  attempt: number;
  host: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

/** Validate the complete machine identity. Ticket ids are opaque data, never parsed by prefix. */
export function parseDispatchReservationIdentity(value: unknown): DispatchReservationIdentity | null {
  if (!record(value) || !exactKeys(value, [ENVELOPE_KEY])) return null;
  const identity = value[ENVELOPE_KEY];
  if (!record(identity)) return null;
  const baseFields = ["schema", "reservation_id", "ticket_id", "attempt", "host"];
  const suppliedExactRootFields = EXACT_EXECUTION_ROOT_IDENTITY_FIELDS.filter((field) => Object.hasOwn(identity, field));
  if (suppliedExactRootFields.length !== 0 && suppliedExactRootFields.length !== EXACT_EXECUTION_ROOT_IDENTITY_FIELDS.length) return null;
  if (!exactKeys(identity, suppliedExactRootFields.length ? [...baseFields, ...EXACT_EXECUTION_ROOT_IDENTITY_FIELDS] : baseFields)) return null;
  const reservationId = identity.reservation_id;
  const ticketId = identity.ticket_id;
  const host = identity.host;
  const attempt = identity.attempt;
  if (identity.schema !== BATON_DISPATCH_RESERVATION_SCHEMA
    || typeof reservationId !== "string"
    || !reservationId
    || reservationId !== reservationId.trim()
    || typeof ticketId !== "string"
    || !ticketId
    || ticketId !== ticketId.trim()
    || typeof host !== "string"
    || !host
    || host !== host.trim().toLowerCase()
    || typeof attempt !== "number"
    || !Number.isInteger(attempt)
    || attempt < 1) return null;
  let exactRoot: ExactExecutionRootIdentity | undefined;
  try {
    exactRoot = extractExactExecutionRootIdentity(identity);
  } catch {
    return null;
  }
  return {
    schema: BATON_DISPATCH_RESERVATION_SCHEMA,
    reservation_id: reservationId,
    ticket_id: ticketId,
    attempt,
    host,
    ...(exactRoot || {}),
  };
}

/** Parse only a complete first-line JSON envelope; never scan business text for ticket-like strings. */
export function parseDispatchReservationEnvelope(value: unknown): DispatchReservationIdentity | null {
  if (typeof value !== "string") return null;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine.startsWith("{") || !firstLine.endsWith("}")) return null;
  try {
    return parseDispatchReservationIdentity(JSON.parse(firstLine));
  } catch {
    return null;
  }
}

export function dispatchReservationEnvelope(identity: DispatchReservationIdentity): string {
  const normalized = parseDispatchReservationIdentity({ [ENVELOPE_KEY]: identity });
  if (!normalized) throw new Error("dispatch reservation identity is invalid");
  return JSON.stringify({ [ENVELOPE_KEY]: normalized });
}

export function withDispatchReservationEnvelope(text: string, identity: DispatchReservationIdentity): string {
  return `${dispatchReservationEnvelope(identity)}\n${text}`;
}
