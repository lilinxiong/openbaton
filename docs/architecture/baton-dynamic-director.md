# Baton architecture

**English** | [中文](baton-dynamic-director.zh.md)

## Boundary

Baton is a CLI-neutral scheduler and policy layer. External adapter packages
are the integration boundary: each package owns executable discovery, its live
catalog, native child execution, and adapter-specific lifecycle behavior. Baton
discovers packages from manifests and operates on the normalized public SDK;
core code does not contain a catalog or adapter-specific protocol branch.

## Manifest discovery

The runtime scans `BATON_ADAPTER_PATHS` when set, otherwise
`~/.baton/adapters/`. Each directory contains an `adapter.json` with schema
`1`. The manifest declares:

```text
adapter       stable id, display metadata, package/version, SDK version
catalog       executable path, arguments, protocol, timeout
invocation    runtime signal and optional environment description
native        opaque execution_handle_kind
runtime_skill package source and installed destination
quota         max_concurrent_subagents, max_depth, backpressure
```

`quota.max_concurrent_subagents` is a per-root-agent-tree subagent limit. It
counts active descendants and excludes the root agent; it is never a
workspace-wide, host-wide, process, model-list, or total-agent count. Schema-1
legacy spellings are normalized at the adapter boundary and do not change this
meaning.

Runtime-skill paths are relative to the package and traversal-free; the catalog
command may be a package path or an absolute executable. Discovery validates
exact fields, SDK major version, protocol, package directory, and duplicate ids.

The catalog command returns JSON containing the matching `adapter_id`, an
optional version, and a `models` array. The adapter preserves each model's id,
display metadata, visibility, reasoning options, modalities, speed/service
tiers, defaults, and other declared fields. Missing optional values remain
unknown; Baton never constructs catalog rows or execution options.

## Configuration flow

```text
baton init
  -> discover manifests
  -> select one adapter
  -> query that adapter's catalog
  -> persist one cli.<id> profile and catalog snapshot

baton spawn/apply
  -> resolve the selected adapter
  -> classify and scope units in the director
  -> choose from the enabled coding_models order
  -> validate model/options against the catalog
  -> create a Receipt and ticket
  -> reserve and hand off to native execution
```

Only explicitly selected profiles are written. `runner`, `longctx`, and the
ordered `coding_models` list are policy labels; the adapter catalog remains the
authority for model ids and supported options. Execution stops when an adapter,
profile, model, option, authorization, or classification is not usable.

## Director and scheduling

The director owns discussion, read-only analysis, classification, dependency
ordering, authorization, and repository scope. Native child execution is the
worker boundary. A `mechanical` class selects `runner`; a `long-context` class
selects `longctx`; operation labels are retained only as audit metadata.

Before any write ticket, the director performs a read-only impact/dependency
pass and records exact paths with allowed operations from `write`, `create`,
`delete`, `rename`, and `chmod`. All units are validated atomically against one
another and active scopes. Rename endpoints and path-prefix overlaps conflict.
An unknown path, dependency, or operation prevents ticket creation.

At each scheduling or refill decision, calculate the maximal safe ready
frontier for the current `(host, session_uid)` root-agent tree: every
order-ready unit with a complete scope, pairwise-disjoint paths, and room under
its effective subagent capacity. Direct children, grandchildren, and deeper
descendants share the same pool; the root is excluded. Fill all available
slots in that tree, while another root tree's queued or active tickets are not
counted or mutated. Section order is only a stable tie-breaker among otherwise
equal choices.

The effective capacity is resolved once as the minimum of known
`host_limit`, `configured_policy`, and optional current-operation
`operation_limit` sources. Reservation and dispatch status expose the same
value with `capacity_sources` provenance (`kind`, `value`, `applied`). A
`--capacity` override is current-tree-only and non-persistent; the legacy
`dispatch-<host>.json` state is inert rollback residue. `max_depth` remains a
separate descendant-depth policy.

## Identity and lifecycle

`BATON_SESSION_ID` is mandatory for ticket creation and capacity-sensitive
dispatch operations. Baton hashes it into the immutable root-agent-tree key
`session_uid` and allocates a contiguous `session_ordinal` per session. Root
and descendant tickets retain the same key; a child, reconnect, or quota
successor cannot mint a new session to escape the tree limit. Ticket ids
contain an opaque prefix, session uid, and ordinal. They are identifiers, not
routing input.

The shared lifecycle is:

```text
ticket + Receipt
  -> reservation
  -> adapter native spawn
  -> identity handoff { session_id, ticket_id, native_handle, adapter_id }
  -> activity-based wait
  -> one terminal result
  -> release
```

`native_handle` is opaque and its kind comes from the manifest. Baton does not
require a universal field name, infer identity from ticket text, or synthesize a
handle. A native `AGENT_LIMIT_REACHED` response returns the same reservation to
its originating tree queue without consuming an attempt or changing its model,
session identity, or another tree's state. A slot is held from `dispatching`
through bound running and terminal-awaiting-release until native release is
confirmed.

## Quota successor policy

An explicit host/profile model quota-exhaustion result is recorded as
availability evidence across every root tree using that route. For a write
ticket, Baton verifies that the pre-mutation baseline is unchanged and then may
create an immutable successor from the next configured coding route.
The successor gets a new session ordinal and Receipt, keeps the original
session, adapter, host, scope, authorization, and quota lineage, and records
`successor_from_ticket_id` plus `successor_reason`.

The original ticket remains immutable. The successor reruns catalog, option,
capacity, and scope checks; quota is not reset. If mutation has begun or the
baseline cannot be reconciled, no successor is created and reconciliation is
required.

## Repository safety

Read-only is the default. Write tickets carry a path/operation allowlist and a
parent-owned repository observation. Workers do not perform Git operations. An
explicit exclusive commit ticket over the parent-staged tree may create one
commit and no other repository operation. Tree-local capacity does not narrow
workspace-wide path ownership, Git safety audits, activation/dispatch locks, or
cross-tree write-conflict checks; host/profile route availability and quota
remain broader than a root tree.

General `baton status` may inventory every workspace ticket, but reports
capacity only as independent `capacity_trees` grouped by `(host, session_uid)`.
It never exposes one aggregate workspace `available` value. A current-tree
`baton dispatch status --host` reports `host`, `session_uid`, `capacity`,
`capacity_sources`, `active`, `available`, and that tree's queue/lifecycle
lists. Records that hold a slot without a valid tree identity are compatibility
blockers and are not silently attributed or rewritten.

Receipts, ticket state, catalog snapshots, and installation records are
user-global under `~/.baton`; the caller owns worktree files. This architecture
keeps adapter-specific behavior at the package boundary while the director
remains deterministic and auditable.
