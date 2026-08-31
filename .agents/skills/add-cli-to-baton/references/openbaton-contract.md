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
- reported per-root-tree subagent capacity, depth, and backpressure behavior.

The canonical quota field is `quota.max_concurrent_subagents`. It means the
maximum number of active descendants in one root-agent tree, excluding the
root. Schema-1 compatibility spellings such as `max_concurrent` are normalized
at discovery and must never be interpreted as a workspace-wide pool, process
count, model-list count, or total-agent count.

The adapter implements executable/version probing, the CLI-owned catalog,
pagination and visibility semantics, duplicate detection, metadata
normalization, exact model/option validation, native child spawn, fresh context,
activity, wait, cancellation, terminal, release, and workspace semantics.

The adapter catalog is the only source for configured models. Preserve exact
ids, reasoning options, service tiers, modalities, defaults, and missing
optional values. Never add aliases or values from another source.
Configuration acceptance requires one explicit user-selected route id from the
picker-visible catalog before any ticket or native spawn. Persist that same
exact id in `runner`, `longctx`, and the coding allowlist with one config
operation, with no second coding model, implicit default, or cross-profile
inheritance.

## Normalized dispatch and identity

`dispatch next` returns an opaque per-attempt reservation, prompt, and
description in the shared first-line JSON envelope. Pass prompt and description
unchanged to the adapter. Ticket ids and reservations are opaque and must not
be parsed or regenerated.

The root conversation creates one opaque `BATON_SESSION_ID` before the first
control-plane or ticket-producing call. Every descendant and control-plane
call receives and forwards that exact value unchanged, including `spawn`,
`apply`, reservation, bind, probe, complete, release, reconnect, and successor
creation. No adapter or child may mint, derive, or replace it. Native spawn
returns an adapter-defined execution handle. The adapter hands Baton an
identity record containing `session_id`, `ticket_id`, `session_ordinal`,
`native_handle`, and the adapter id. Baton derives `session_uid` and allocates
a contiguous `session_ordinal` per session. A reconnect receives a new native
handle while retaining the same session identity, ticket, and quota lineage.

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

Capacity-sensitive calls are scoped to `(host, session_uid)`. The root is not a
subagent, while direct and nested descendants share one limit. The effective
value is the minimum of known native/adapter `host_limit`, configured
`configured_policy`, and an optional current-operation `operation_limit`;
`capacity_sources` reports the `kind`, `value`, and `applied` provenance. A
current `--capacity` override is non-persistent and cannot raise a known host
limit. `max_depth` is independent. Legacy remembered `dispatch-<host>.json`
values are inert rollback residue, and active records without a valid
`session_uid` are compatibility blockers rather than implicitly assigned work.

## Profiles and routing

Manifest discovery drives `baton init` and `baton config`; only the explicitly
selected `cli.<id>` profile is created. Runner, long-context, coding allowlist,
and limits are scoped to that adapter. Missing profiles, missing catalogs,
unsupported options, invalid authorization, and unresolved classification stop
before native execution without borrowing another profile.

The director classifies every executable request before dispatch. Discussion and
read-only analysis stay in the director; authorized implementation and declared
mechanical units use native children. The structured class selects the
configured route; operation labels remain audit metadata. Baton stores tickets
and Receipts, not a separate task graph.

For live acceptance, keep the target CLI's main conversation unchanged while
running `$baton <ordinary multi-task implementation request>` followed by
`$baton $openspec-apply-change probe-e2e`. The main agent is limited to scoping,
dispatch, observation, and waiting; live children own executable paths. These
successful paths are independent of the invalid-model and quota conformance
cases, which must remain separately observable. A one-route live profile must
stop as `BLOCKED` on quota exhaustion; successor testing uses a separate
fixture with an explicit second route.

For writes, the director records exact per-unit paths and allowed operations
(`write`, `create`, `delete`, `rename`, `chmod`) during a read-only
impact/dependency pass. Validate the complete proposal atomically before ticket
creation, including rename endpoints and path-prefix conflicts. Fill the
maximal safe ready frontier at each scheduling/refill decision; section order
only breaks otherwise equal choices. An unknown scope or undeclared worker
operation stops before mutation. Tree-local capacity does not narrow the
workspace-wide safety scan, repository audit, activation/dispatch locks, or
cross-tree write-conflict checks. Host/profile route availability and durable
model quota also remain shared across root trees.

## Package/update boundary

Install the adapter and runtime skill from the manifest into an isolated home
first. The runtime skill describes the shared routing and scope contract plus
the adapter's actual native protocol. Update only files owned by the package's
installation record and preserve unrelated user files. Do not change the
structured change tool's own execution instructions to force integration.
