import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BATON_DISPATCH_RESERVATION_SCHEMA,
  dispatchReservationEnvelope,
  parseDispatchReservationEnvelope,
  parseDispatchReservationIdentity,
  withDispatchReservationEnvelope,
} from "../src/lib/dispatch-reservation.js";

const identity = {
  schema: BATON_DISPATCH_RESERVATION_SCHEMA,
  reservation_id: "4f29e230-95dc-48a6-b455-290ea93074dd",
  ticket_id: "zly-anything",
  attempt: 2,
  host: "alpha",
} as const;

describe("dispatch reservation envelope", () => {
  it("round-trips one complete first-line identity without interpreting the ticket id", () => {
    const prompt = withDispatchReservationEnvelope("work for os-0001 and spn-0002", identity);
    assert.deepEqual(parseDispatchReservationEnvelope(prompt), identity);
    assert.equal(prompt.split("\n", 1)[0], dispatchReservationEnvelope(identity));
  });

  it("never treats ticket-like business text or a later embedded envelope as identity", () => {
    assert.equal(parseDispatchReservationEnvelope("work for spn-0001, os-0001, or zly-anything"), null);
    assert.equal(parseDispatchReservationEnvelope(`business text\n${dispatchReservationEnvelope(identity)}`), null);
  });

  it("rejects partial, extended, or malformed structured identities", () => {
    assert.equal(parseDispatchReservationIdentity({ baton_dispatch: { ...identity, extra: true } }), null);
    assert.equal(parseDispatchReservationIdentity({ baton_dispatch: { ...identity, reservation_id: "" } }), null);
    assert.equal(parseDispatchReservationIdentity({ baton_dispatch: { ...identity, reservation_id: ` ${identity.reservation_id}` } }), null);
    assert.equal(parseDispatchReservationIdentity({ baton_dispatch: { ...identity, ticket_id: `${identity.ticket_id} ` } }), null);
    assert.equal(parseDispatchReservationIdentity({ baton_dispatch: { ...identity, host: "ALPHA" } }), null);
    assert.equal(parseDispatchReservationIdentity({ baton_dispatch: { ...identity, attempt: "2" } }), null);
    assert.equal(parseDispatchReservationIdentity({ baton_dispatch: { ...identity, attempt: 0 } }), null);
    assert.equal(parseDispatchReservationEnvelope('{"baton_dispatch":'), null);
  });
});
