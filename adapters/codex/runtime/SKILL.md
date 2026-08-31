---
name: baton
description: "Baton runtime for approved Codex execution. Invoke explicitly with $baton; discussion and read-only analysis stay in the director session."
---

# Baton runtime for Codex

This skill is explicit-invocation only. Apply these rules only after the user
explicitly mentioned `$baton`. Do not load or follow this skill from ordinary
conversation, implementation requests, or implied intent.

Codex is the selected host. Baton owns classification, exact write scopes,
reservations, receipts, and lifecycle; this runtime skill does not add hooks or
invent a second task graph.

## Explicit OpenSpec apply loop

This is a dual-skill path: use `$baton $openspec-apply-change <change>` in the
same Codex director conversation. Baton remains hookless and must not activate
for an ordinary OpenSpec request unless `$baton` was explicitly invoked.
OpenSpec tasks are canonical. Before dispatch, the Codex main agent reads the
apply instructions, every returned `contextFiles` file, repository guidance,
and affected code. It then compiles a versioned fine-grained plan whose units
carry exact task refs, dependencies, read context, write paths and operations,
an imperative patch recipe, done criteria, validation, parent gates, and task
mappings. Units are `patch-only` or `verification-only`; a broad task may be
split into disjoint units, coupled tasks may be merged into one patch, and a
later overlapping integration unit must be ordered after its predecessor.

Baton validates and persists that plan/run, computes the maximal safe ready
frontier, and derives each unit's minimum capability (Codex route capability) from complexity,
context, code scope, reasoning, and native/tool execution needs. It walks only
the configured `coding_models` in exact priority order. Spark is only the
first candidate: silently advance when it is under-capable or exhausted in the
current session and a later configured route qualifies. Never use an
unconfigured route. Notify only when no configured route is both current-session
available and capable, and include every candidate's exclusion reason in the
`NO_QUALIFIED_CANDIDATE` result. Quota and uncallability are session-local
Baton cache facts; a new Codex session rechecks them.

For every reservation, pass its prompt unchanged to a fresh exact-model Codex
native worker (the native child, `fork_context=false`), immediately bind the returned opaque
`task_name`, wait on real native liveness/activity, record exactly one terminal result,
and release before refilling. Keep terminal scopes owned until release. Return
to the director only for source staleness, changed contracts, scope changes,
safety-blocked partial mutation, or structured `PLAN_INSUFFICIENT`. A worker
must not redesign or broaden scope, spawn children, touch Git or OpenSpec, or
choose a model. The parent alone accepts gates and reconciles task checkboxes
after all mapped units and gates pass; never complete a checkbox early.

The compiled CLI operations are explicit and preserve manual compatibility:

```text
baton apply <change> --host codex --plan-file <plan.json> [--dispatch] --json
baton apply <change> --host codex --run <run-id> --status --json
baton apply <change> --host codex --run <run-id> --accept-gate <gate-id> --text "..." --json
baton apply <change> --host codex --run <run-id> --reconcile [--task <number>] --json
baton apply <change> --host codex --run <run-id> --plan-file <successor.json> [--dispatch] --json
```

Use the run's current revision and fingerprint when appending a successor;
stale source or changed contracts fail closed. `--status` is observational,
`--accept-gate` records parent evidence, and only `--reconcile` writes the
canonical OpenSpec ledger. Manual `baton apply` scope flags remain available
for legacy callers; compiled apply rejects those flags instead of guessing.

## Routing and scope

- Discussion and read-only analysis stay in the director session.
- Authorized implementation, mechanical, long-context, and OpenSpec units use
  Codex native child execution after the director records their exact paths and
  allowed operations (`write`, `create`, `delete`, `rename`, `chmod`).
- Recompute the maximal safe ready frontier whenever a dependency completes or
  a slot is released. Fill every pairwise-disjoint ready scope within capacity;
  section order is only a tie-breaker and never a serialization reason.
- Stop before mutation when an impact, dependency, path, or operation is
  unknown. Never borrow another host or inherit the parent model.

## Codex catalog and native execution

The adapter's app-server `model/list` response is the only model authority.
Use the exact picker-visible id, reasoning effort, service tier, and modality;
hidden rows and aliases are not selectable. The selected model is passed to the
native Codex child call with a fresh context (`fork_context=false`).

The current Baton CLI uses an opaque generic execution handle:

```text
baton dispatch bind TICKET --host codex --execution-handle task_name=CODEX_TASK_NAME --json
baton dispatch probe TICKET --host codex --execution-handle task_name=CODEX_TASK_NAME --state running --activity heartbeat --json
baton dispatch complete TICKET --host codex --text "short conclusion" --release --json
```

Reserve first (`baton dispatch next --host codex --json`), pass the reservation
prompt unchanged to the native Codex child API, immediately bind its returned
`task_name` as the opaque `task_name=...` handle, wait on native liveness/activity, record
exactly one terminal result, and release before refilling capacity. A capacity
backpressure response defers the same reservation without changing its model.

The root Codex conversation creates one opaque `BATON_SESSION_ID` before its
first control-plane call. Every descendant and every control-plane operation
(`spawn`/`apply`, reserve, bind, probe, complete, and release) receives and
forwards that exact value unchanged; no child or reconnect may mint or replace
it. Every ticket-producing command therefore remains session-scoped, and the
handoff keeps `session_id`, `ticket_id`, `session_ordinal`, and the native
handle together. Explicit quota exhaustion may create an immutable successor
only after a clean pre-mutation baseline and fresh hard checks; retain the
same session identity, host, scope, authorization, and quota lineage while
recording `successor_from_ticket_id`.

The manifest's `quota.max_concurrent_subagents` is stored on
`[cli.codex].max_concurrent` as the maximum number of simultaneously active
descendants in this root agent tree. A live catalog value replaces it. If
neither current source is available, Baton preserves an existing positive
reported value; otherwise the profile stores `-1` and Baton uses
`[director].max_concurrent`. It excludes the root conversation, includes
direct and nested descendants together, and is strictly tree-local rather
than a process, model, or historical-ticket count.
A separate root conversation has its own tree-local capacity; shared workspace
safety checks and host/profile quota checks still apply across trees.

Do not expose a human model selector at runtime, silently substitute a model,
or release/refill before terminal recording. Commit and publication remain
parent-owned safety operations.
