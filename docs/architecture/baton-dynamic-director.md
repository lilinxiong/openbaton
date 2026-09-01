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
  -> choose from the configured coding_models order
  -> validate model/options against the catalog
  -> create a Receipt and ticket
  -> reserve and hand off to native execution
```

Only explicitly selected profiles are written. `runner`, `longctx`, and the
ordered `coding_models` list are policy labels; the adapter catalog remains the
authority for model ids and supported options. Execution stops when an adapter,
profile, model, option, authorization, or classification is not usable.

## Compiled OpenSpec apply

OpenSpec apply is a second, explicit skill in the director path:
`$baton $openspec-apply-change <change>` in Codex or `/baton
$openspec-apply-change <change>` in Grok. Baton is hookless and activates only
after the host invocation. The OpenSpec task ledger remains canonical. Before
dispatch, the main agent reads apply instructions, every returned
`contextFiles` file, repository guidance, and affected code, then compiles a
versioned fine-grained plan. Each plan contains exact task refs, dependencies,
read context, write paths and operations, imperative patch recipes, done
criteria, validation, parent gates, and task mappings.

The plan supports a broad task split into disjoint units, coupled tasks merged
into one patch, and a later overlapping integration unit ordered after its
predecessor. Units are `patch-only` or `verification-only`. Baton atomically
validates and persists the plan/run, computes its maximal safe ready frontier,
and derives each unit's minimum capability from complexity, context, code
scope, reasoning, and execution needs. It then walks only configured routes in
exact priority order. Spark is only the first candidate: an under-capable or
current-session-exhausted Spark is skipped silently when a later configured
route qualifies. An unconfigured route is never selected. A notification is
emitted only for a complete `NO_QUALIFIED_CANDIDATE` result, which lists every
configured candidate and every exclusion reason. Quota and uncallability are
current-session cache facts; a new session rechecks them.

The parent passes each reservation prompt unchanged to a fresh exact-model
native worker, binds its opaque handle immediately, waits on real liveness,
records exactly one terminal result, and releases before refilling. Terminal
scope remains owned until release. Workers cannot redesign or broaden scope,
spawn children, touch Git/OpenSpec, or choose models. Only the parent accepts
gates and reconciles OpenSpec checkboxes after all mapped units and gates pass;
checkbox completion is deliberately delayed. Source staleness, changed
contracts, scope changes, safety-blocked partial mutation, and structured
`PLAN_INSUFFICIENT` return to the director.

The compiled run CLI is:

```text
baton apply <change> --host <host> --plan-file <plan.json> [--dispatch] --json
baton apply <change> --host <host> --run <run-id> --status --json
baton apply <change> --host <host> --run <run-id> --accept-gate <gate-id> --text "..." --json
baton apply <change> --host <host> --run <run-id> --reconcile [--task <number>] --json
baton apply <change> --host <host> --run <run-id> --plan-file <successor.json> [--dispatch] --json
```

The initial plan is revision `1`; successors preserve selected-task coverage,
use the current parent revision/fingerprint, and rerun catalog, capability,
scope, and baseline checks. `--status` is read-only, `--accept-gate` records
parent evidence, and only `--reconcile` writes the canonical ledger. Legacy
manual apply with explicit scopes or `--read-only` remains compatible, while
compiled mode rejects manual scope flags. These failure paths fail closed
without inventing a route or accepting partial work.

## Rolling execution planning v2

The generic rolling kernel removes the whole-change planning barrier. It
accepts a bounded `PlanDelta` as soon as that delta contains one complete,
dependency-ready unit, dispatches the maximal safe known frontier, and accepts
later deltas while existing native attempts are queued, running, terminal, or
accepted. Unplanned manifest tasks create no repository-read or semantic-plan
prerequisite for that first unit.

`TaskSourceDescriptor` makes the kernel source-neutral. The built-in director
adapter derives stable task keys from caller-owned ids. The OpenSpec adapter
derives reconciliation identity from the stable Markdown task number and keeps
the Apply ordinal as separate non-authoritative metadata. This prevents Apply
result ordering from changing task ownership.

Each accepted unit and gate version has a local immutable fingerprint. Deltas
compare an append sequence only for storage concurrency; appending unrelated
work does not invalidate an active ticket. Supersession is allowed only for
undispatched or failed lineage. Scheduling, route failure, input staleness,
gate failure, and `PLAN_INSUFFICIENT` remain local to their smallest owner.

The three gate types are `safety-precondition`, `integration-acceptance`, and
`evidence`. They block explicit dependencies only. Terminal result, safety
verdict, parent acceptance, and release are separate facts. A task remains
open after its known units pass; only an exact seal over non-superseded
coverage followed by source-adapter reconciliation completes it.

The source-neutral control surface is:

```text
baton run start --host <host> --source-file <source.json|-> [--plan-delta-file <delta.json|->] [--run-id <run>] [--dispatch] --json
baton run <run> --append-plan <delta.json|-> [--dispatch] --json
baton run <run> --status --json
baton run <run> --accept-gate <gate>@<version> --text "..." [--dispatch] --json
baton run <run> --seal-task <task-key> --seal-file <seal.json|-> --json
baton run <run> --reconcile [--task <task-key>] --json
```

The append-only log and immutable accepted documents live in the current
workspace runtime under `runs/rolling-runs-v2/`; checkpoints are replaceable
derived caches. Reconnect recovery joins those facts to ordinary tickets,
Receipts, reservations, bound native handles, terminal results, and releases
idempotently. Clean uninstall inventories and retains auditable rolling-run
records. Compiled-v1 and manual apply records remain readable through their
original protocols and are never silently migrated.

### Isolated worktree data plane

The rolling log is the control plane; a verified detached worktree is the
default data plane for each writing unit. Read-only units have no worktree.
Before a frontier ticket exists, the adapter must advertise exact-root support
and Baton must resolve one owning repository, freeze an immutable base, create
the canonical run/unit/attempt root, and prove the caller's HEAD, index, refs,
and dirty facts did not move. Only the current capacity frontier is prepared,
so open-world planning does not turn into eager whole-change setup.

Execution ownership is `(repository_id, execution_root, normalized_path)`.
This preserves strict overlap exclusion inside a root while allowing
speculative overlap across roots. Cross-root overlap becomes a deterministic
integration risk rather than concurrent caller mutation.

At terminal release Baton audits the complete root and freezes a
`ChangeBundle v1` with base/result trees, non-text facts, Receipt lineage, and
internal Git transport. Each repository has one serialized parent queue.
Application and conflict resolution occur in isolated object plumbing; the
caller changes only at final acceptance under a fresh baseline gate. Bundle
readiness, integration, parent acceptance, task sealing, and source
reconciliation remain separate facts.

Submodules retain literal repository ownership. A submodule bundle is based,
audited, and integrated in the submodule object database; a later superproject
unit owns the mode-160000 gitlink change. Recovery reconciles exact records,
registered worktrees, internal refs, bundles, integration contexts, and native
liveness. Cleanup removes only an identity-matching eligible attempt after all
retention reasons clear.

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
