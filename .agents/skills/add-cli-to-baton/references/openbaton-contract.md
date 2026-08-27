# Public Adapter SDK contract

The public SDK is the integration boundary. Baton discovers an external
adapter package from its manifest and consumes the normalized contract. Core
code must not know an adapter's executable, protocol details, model ids, or
native handle fields.

## Manifest and adapter responsibilities

`adapter.json` schema `1` declares:

- stable lowercase id, display metadata, package/version, and SDK version;
- catalog executable, arguments, protocol, and timeout;
- invocation signal and optional environment description;
- `native.execution_handle_kind`;
- runtime-skill source and destination;
- reported concurrency, depth, and backpressure behavior.

The adapter implements executable/version probing, the CLI-owned catalog,
pagination and visibility semantics, duplicate detection, metadata
normalization, exact model/option validation, native child spawn, fresh context,
activity, wait, cancellation, terminal, release, and workspace semantics.

The adapter catalog is the only source for configured models. Preserve exact
ids, reasoning options, service tiers, modalities, defaults, and missing
optional values. Never add aliases or values from another source.

## Normalized dispatch and identity

`dispatch next` returns an opaque per-attempt reservation, prompt, and
description in the shared first-line JSON envelope. Pass prompt and description
unchanged to the adapter. Ticket ids and reservations are opaque and must not
be parsed or regenerated.

Native spawn returns an adapter-defined execution handle. The adapter hands
Baton an identity record containing `session_id`, `ticket_id`, `native_handle`,
and the adapter id. `BATON_SESSION_ID` is required; Baton derives
`session_uid` and allocates a contiguous `session_ordinal` per session. A
reconnect receives a new native handle while retaining ticket and quota
lineage.

An explicit quota result may create an immutable successor after a clean
pre-mutation baseline. The successor receives a new ticket id/ordinal and
Receipt, retains `successor_from_ticket_id`, session, adapter, host, scope,
authorization, and quota lineage, and reruns all hard checks. No ticket is
rewritten in place and quota is not reset. If the baseline changed, stop for
reconciliation.

The lifecycle is reserve → native spawn → identity handoff → activity-based
wait → exactly one terminal result → release. Capacity backpressure returns the
same reservation without consuming an attempt or changing its selected model.
A polling interval is not a worker failure.

## Profiles and routing

Manifest discovery drives `baton init` and `baton config`; only the explicitly
selected `cli.<id>` profile is created. Enablement, runner, long-context,
coding allowlist, and limits are scoped to that adapter. Missing or disabled
profiles, missing catalogs, unsupported options, invalid authorization, and
unresolved classification stop before native execution without borrowing
another profile.

The director classifies every executable request before dispatch. Discussion and
read-only analysis stay in the director; authorized implementation and declared
mechanical units use native children. The structured class selects the
configured route; operation labels remain audit metadata. Baton stores tickets
and Receipts, not a separate task graph.

For writes, the director records exact per-unit paths and allowed operations
(`write`, `create`, `delete`, `rename`, `chmod`) during a read-only
impact/dependency pass. Validate the complete proposal atomically before ticket
creation, including rename endpoints and path-prefix conflicts. Fill the
maximal safe ready frontier at each scheduling/refill decision; section order
only breaks otherwise equal choices. An unknown scope or undeclared worker
operation stops before mutation.

## Package/update boundary

Install the adapter and runtime skill from the manifest into an isolated home
first. The runtime skill describes the shared routing and scope contract plus
the adapter's actual native protocol. Update only files owned by the package's
installation record and preserve unrelated user files. Do not change the
structured change tool's own execution instructions to force integration.
