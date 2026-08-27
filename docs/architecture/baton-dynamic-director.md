# Baton architecture

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
quota         max_concurrent, max_depth, backpressure
```

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
frontier: every order-ready unit with a complete scope, pairwise-disjoint paths,
and room under the adapter's physical capacity. Fill all available slots.
Section order is only a stable tie-breaker among otherwise equal choices.

## Identity and lifecycle

`BATON_SESSION_ID` is mandatory for ticket creation. Baton hashes it into
`session_uid` and allocates a contiguous `session_ordinal` per session. Ticket
ids contain an opaque prefix, session uid, and ordinal. They are identifiers,
not routing input.

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
handle. A capacity response returns the same reservation to the queue without
consuming an attempt or changing its selected model.

## Quota successor policy

An explicit quota-exhaustion result is recorded as availability evidence. For a
write ticket, Baton verifies that the pre-mutation baseline is unchanged and
then may create an immutable successor from the next configured coding route.
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
commit and no other repository operation.

Receipts, ticket state, catalog snapshots, and installation records are
user-global under `~/.baton`; the caller owns worktree files. This architecture
keeps adapter-specific behavior at the package boundary while the director
remains deterministic and auditable.
