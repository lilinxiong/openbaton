---
name: baton
description: "Use Baton for approved multi-unit execution and structured change application. Baton is a manifest-driven, CLI-neutral scheduler; keep discussion and read-only analysis in the director session."
---

# Baton runtime

Baton is a scheduling and policy layer. External adapter packages describe a
CLI, its catalog, native child execution surface, runtime skill, and capacity
through the public SDK and `adapter.json` manifest. The runtime discovers those
packages; this skill never names or assumes a built-in adapter.

## Director and worker boundary

- Discussion and read-only analysis stay in the director session.
- An authorized implementation request is classified before any ticket is
  created and runs through the selected adapter's native child execution API.
- A `mechanical` unit uses the configured `runner` route; a `long-context` unit
  uses `longctx`. Operation labels are audit metadata, never route selectors.
- Missing authorization, an unresolved classification, a missing adapter, or a
  disabled profile stops before ticket creation. Do not infer a route from
  prose or another adapter.
- A structured change tool may provide decomposition and dependencies. Baton
  schedules its ready units but does not create a second task graph.

## Adapter and catalog contract

The selected adapter is discovered from `~/.baton/adapters/<id>/adapter.json`
or the directories in `BATON_ADAPTER_PATHS`. A manifest has schema `1` and
declares:

- `adapter.id`, display metadata, package/version, and SDK version;
- the catalog executable, arguments, protocol, and timeout;
- the invocation signal used to identify the current runtime;
- `native.execution_handle_kind`;
- runtime-skill source and destination;
- reported `quota.max_concurrent_subagents` (active descendants per root tree,
  excluding the root), `max_depth`, and backpressure semantics. `max_depth` is
  a depth policy, not a capacity count.

The adapter's catalog is the sole source of model ids and optional reasoning,
modality, and service-tier metadata. Preserve exact values and validate the
selected id and options again at dispatch. Baton does not invent catalog rows,
aliases, or execution options. `runner`, `longctx`, and the ordered
`coding_models` list are labels and policy data; they do not assert capabilities.

## Scope and scheduling

Before creating a write ticket, perform a read-only impact/dependency pass and
record an exact path set and allowed operations for every unit. Operations are
`write`, `create`, `delete`, `rename`, and `chmod`. Validate all units in one
atomic decision, including rename endpoints, path-prefix overlaps, and scopes
already owned by active tickets. An unknown path, dependency, or operation
stops before mutation.

At each dispatch or refill, calculate the maximal safe ready frontier: every
order-ready unit whose scope is complete, pairwise disjoint, and within the
selected adapter's tree-local runtime capacity. Fill every available slot.
Section order only breaks otherwise equivalent choices; it is not a reason to
serialize. `[cli.<id>].max_concurrent` is that CLI's reported tree limit
(or `-1` when unknown). `director.max_concurrent` is the fallback policy
when the CLI did not report one, while any `planning_max_concurrent` value
emitted by Apply or the director queue is legacy director planning metadata.
Neither planning field is a runtime snapshot; runtime capacity comes from
the current `(host, session_uid)` resolver.

## Ticket identity and lifecycle

The root director creates one opaque `BATON_SESSION_ID` for the dispatch
session before the first control-plane or ticket-producing call. It is
immutable for that session: pass the exact same value to every descendant and
every control-plane call (`spawn`/`apply`, `dispatch next`, `bind`, `probe`,
`complete`, and `release`), including reconnects and quota successors. A
descendant must not create, derive, or replace a session id. Baton hashes that
value into `session_uid` and assigns a contiguous `session_ordinal` within the
session. A ticket id contains the opaque prefix, session uid, and ordinal; the
id is data, not a routing signal. Keep `session_id`, `ticket_id`,
`session_ordinal`, and the adapter's native handle in every identity handoff.

Use this lifecycle for every reserved ticket:

1. Create the ticket and immutable Receipt with `baton spawn` or scoped
   `baton apply`.
2. Reserve it with `baton dispatch next` or the combined dispatch form.
3. Pass the reservation's exact prompt and description unchanged to the
   adapter's native child API, with the exact selected model and supported
   options. Request a fresh child context.
4. Immediately bind the returned opaque native execution handle together with
   the session and ticket identity.
5. Wait on native activity, record concise progress when useful, and record one
   terminal result.
6. Release the ticket and only then refill capacity.

The adapter may expose any handle kind. Do not infer identity from ticket text
or replace a handle with a newly generated identifier. A capacity response defers
the same reservation without consuming
an attempt or changing its model.

## Quota successors

When the adapter reports explicit quota exhaustion, Baton first persists the
availability fact and checks that a write ticket's pre-mutation baseline is
unchanged. It may then create an immutable successor ticket from the next
configured coding priority. The successor has a new per-session ordinal and
Receipt, records `successor_from_ticket_id` and `successor_reason`, and retains
the originating `session_uid`, host, scope, authorization, and quota lineage.
It reruns model, effort, capacity, and scope checks. The original ticket is
never rewritten to carry a different model, and quota is never reset. If
mutation has started or reconciliation fails, stop and report the required
reconciliation instead of creating a successor.

## Safety boundary

Read-only is the default. Write tickets carry an exact path and operation
allowlist and a parent-owned repository observation. Workers do not perform
Git operations. The sole commit exception is an explicitly authorized,
exclusive commit ticket over the parent-staged tree; it may create one commit
and no other repository operation.

Do not dispatch a ticket without its Receipt, exact model, session identity,
scope, and reservation. Do not inherit the parent model, choose outside the
enabled adapter profile, or refill before release. A polling interval is not a
worker failure; terminal state comes from the native execution handle.

## Useful command shapes

```text
baton init
baton config --cli <adapter-id> --enable
baton models refresh --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton apply <change> --host <adapter-id>
baton dispatch next --host <adapter-id> [--capacity <n>] --json
baton dispatch status --host <adapter-id> --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

Capacity-sensitive JSON is deliberately breaking: dispatch snapshots are
scoped to the current `(host, session_uid)` root-agent tree and expose
`capacity`, `capacity_sources`, `active`, `available`, and that tree's queue.
Workspace status keeps ticket inventory separately under `spawns` and groups
runtime capacity under `capacity_trees`; it never exposes one aggregate
workspace `available` value.

Finish with separate evidence for SDK conformance, package/build checks,
catalog discovery, native execution, ticket lifecycle, quota lineage, and the
exact changed-path audit.
