---
name: baton
description: "Baton runtime for approved multi-unit execution. Invoke only with /baton; discussion and read-only analysis stay in the director session."
disable-model-invocation: true
user-invocable: true
---

# Baton runtime

This skill is slash-command only. Apply these rules only after the user
explicitly ran `/baton`. Do not load or follow this skill from ordinary
conversation, implementation requests, or implied intent.

Baton is a scheduling and policy layer. External adapter packages describe a
CLI, its catalog, native child execution surface, runtime skill, and capacity
through the public SDK and `adapter.json` manifest. The runtime discovers those
packages; this skill never names or assumes a built-in adapter.

## Explicit dual-skill OpenSpec apply

Baton is hookless. It is inert until the user explicitly invokes the host
skill (`$baton` in Codex or `/baton` in Grok); no runtime hook, prompt watcher,
or forced interception turns an ordinary request into a ticket. The stable
OpenSpec entry is the explicit dual-skill request
`$baton $openspec-apply-change <change>` (or the same request after `/baton` in
Grok). OpenSpec's task ledger remains canonical: Baton may compile and track
execution, but it never replaces the change's tasks or lets a worker own the
ledger.

The director follows this loop for every explicit apply request:

1. The main agent reads the apply instructions first, then every returned
   `contextFiles` entry, the applicable repository guidance, and the affected
   code before deciding scope or dispatch. A missing, blocked, stale, or
   ambiguous apply context stops the loop.
   It must capture and audit the plan's `source_snapshot`, including repository
   revision, task-ledger path and identity/hash, context-file hashes, and
   selected-task fingerprint. Missing or stale snapshot evidence fails closed.
2. It compiles a versioned, fine-grained plan containing exact task refs
   (`task_refs`/`task_ids`), dependencies, read context, write paths and
   allowed operations, an imperative patch recipe, done criteria, permitted validation,
   parent gates, and explicit task mappings. Each unit is either
   `patch-only` (write scope is mandatory) or `verification-only` (write scope
   and patch fields are forbidden). A broad task can map to several disjoint
   units; coupled tasks can map to one patch unit; a later overlapping unit
   must carry an ordering dependency.
3. Baton validates every unit atomically, persists the immutable plan and
   versioned run state, and derives the maximal safe ready frontier. Before
   routing, it derives each unit's minimum capability (minimum route
   capability) from complexity, estimated context, code scope, required
   reasoning, and execution/tool needs.
4. For every unit, routing walks only the configured `coding_models` in exact
   priority order. For every unverified session-host-route, single-flight the
   first native launch; bind success to fan out. On native launch failure,
   immediately report the exact code and unmodified raw message with
   `dispatch fail`, then release the ticket. Refill the same run only after that
   terminal/release boundary so Baton uses immutable configured successors.
   Never create a separate read-only probe or a new compiled run, and never
   special-case Spark. Silently continue while any configured route remains
   available and capable. Notify the user only on
   `NO_QUALIFIED_CANDIDATE`, listing every configured candidate and every
   exclusion reason (including absent, quota, session, context, reasoning,
   execution-capability, and task-suitability failures).
5. Quota, rate-limit, and uncallability evidence are current-session,
   session-local Baton cache facts only; session evidence never carries to a
   new Baton session, which must recheck its routes. For each reservation,
   Baton passes the exact reservation prompt unchanged to a fresh native worker
   with the exact selected model and options, waits on real native liveness,
   records exactly one terminal result, releases the ticket before refilling
   capacity, and keeps terminal scopes owned until release is confirmed. The
   worker returns to the director only for source
   staleness, changed contracts, scope changes, safety-blocked partial
   mutation, or a structured `PLAN_INSUFFICIENT` result.
6. Workers do not redesign or broaden the plan, spawn children, touch Git or
   OpenSpec, choose models, or write outside their Receipt. The parent alone
   accepts gates and, only after every mapped unit and gate passes, reconciles
   the OpenSpec checkboxes and conclusions. A checkbox is never marked early.
   The parent owns final gates, repository evidence, staging, and publication.

## Rolling v2 protocol

New multi-unit execution uses the source-neutral rolling run. OpenSpec is one
optional task-source adapter; director-authored tasks use the same kernel. The
source adapter provides stable task keys. Never substitute a transient source
ordinal for that identity. Start as soon as one small, safe delta is known and
append later deltas while existing units are queued, active, terminal, or
accepted. A large change must not require whole-change analysis before the
workspace begins moving.

```text
baton run start --host <host> --source-file <source.json> [--plan-delta-file <delta.json>] [--run-id <run>] [--dispatch] --json
baton run <run> --append-plan <delta.json> [--dispatch] --json
baton run <run> --status --json
baton run <run> --accept-gate <gate>@<version> --text "..." [--dispatch] --json
baton run <run> --seal-task <task-key> --seal-file <seal.json> --json
baton run <run> --reconcile [--task <task-key>] --json
baton run <run> --freeze-unit <unit> --attempt attempt-<n> --text "..." [--validation "..."] --json
baton integration begin|apply|resolve|accept ... --json
baton run <run> --cleanup-unit <unit> --attempt attempt-<n> --json
```

Writing units in a new run default to `isolated-worktree`; verification units
remain rootless. Let Baton prepare only the selected capacity frontier. Never
create a shared ticket when adapter exact-root capability, repository
decomposition, immutable-base setup, or caller-invariance checks fail. Shared
mode is permitted only when the run explicitly selected the legacy/manual
compatibility path.

After a terminal isolated ticket is released, the parent freezes its audited
bundle, serializes `begin`/`apply`, supplies and audits a separate `resolve`
tree when conflicts exist, and calls `accept` before treating the result as a
downstream base. Workers never create bundles or integrate. For submodules,
run this lifecycle at the literal submodule root and use a later explicit
superproject gitlink unit. Cleanup only an eligible exact attempt; preserve all
reported retention reasons and identity mismatches.

Each delta is compared with the current append sequence. A storage race rebases
only that compare token; it never changes an immutable unit or gate version.
Ticket lifecycle and the rolling log are joined through idempotent recovery:
status may repair missing reservation, native-attempt, terminal, safety,
parent-acceptance, release, or retry facts, but never duplicates a ticket or
attempt. Terminal success alone is not acceptance. The exact safety verdict,
parent acceptance, and matching attempt release remain separate facts. Release,
gate acceptance, and delta append deterministically refill the same run.

Status is task-first and reports unplanned, planned, active, blocked,
terminal-unreleased, accepted, sealed, and reconciled states plus the next
legal action. `PLAN_INSUFFICIENT` stays on the smallest owner and asks the
director for a successor delta without stopping unrelated frontier work. Only
accept an explicit typed gate whose dependencies are accepted; only seal exact
non-superseded coverage; only reconcile sealed tasks. Reconciliation is the
sole task-source writeback. Preserve the original session identity across
reconnects. Never silently migrate an active compiled-v1 run.

The compiled protocol remains an explicit compatibility surface for existing
runs and manual apply:

```text
baton apply <change> --host <host> --plan-file <plan.json> [--dispatch] --json
baton apply <change> --host <host> --run <run-id> --status --json
baton apply <change> --host <host> --run <run-id> --accept-gate <gate-id> --text "..." --json
baton apply <change> --host <host> --run <run-id> --reconcile [--task <number>] --json
baton apply <change> --host <host> --run <run-id> --plan-file <successor.json> [--dispatch] --json
```

`--plan-file` creates revision `1`; a successor plan must name the current
`run`, preserve selected-task coverage, and be submitted against the current
parent revision and fingerprint. `--status` reports unit, gate, task,
terminal-unreleased, and linked-ticket state. `--accept-gate` records
parent-owned evidence. `--reconcile` is the only path that writes task
conclusions/checkboxes, and it is delayed until all mappings and gates are
accepted. Legacy/manual `baton apply` with explicit per-unit scopes and
`--read-only` remains source-compatible; it is not silently converted into a
compiled plan, while compiled mode rejects manual scope flags.

## Director and worker boundary

- Discussion and read-only analysis stay in the director session.
- An authorized implementation request is classified before any ticket is
  created and runs through the selected adapter's native child execution API.
- A `mechanical` unit uses the configured `runner` route; a `long-context` unit
  uses `longctx`. Operation labels are audit metadata, never route selectors.
- Missing authorization, an unresolved classification, or a missing adapter
  stops before ticket creation. Do not infer a route from prose or another
  adapter.
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
configured adapter profile, or refill before release. A polling interval is not a
worker failure; terminal state comes from the native execution handle.

## Useful command shapes

```text
baton init
baton config --cli <adapter-id>
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
