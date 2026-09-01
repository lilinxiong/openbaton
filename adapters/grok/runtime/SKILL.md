---
name: baton
description: "Baton runtime for approved Grok execution. Invoke only with /baton; discussion and read-only analysis stay in the director session."
disable-model-invocation: true
user-invocable: true
---

# Baton runtime for Grok

This skill is slash-command only. Apply these rules only after the user
explicitly ran `/baton`. Do not load or follow this skill from ordinary
conversation, implementation requests, or implied intent.

Grok is the selected host. Baton owns classification, exact write scopes,
reservations, receipts, and lifecycle; this runtime skill does not add hooks or
invent a second task graph.

## Explicit OpenSpec apply loop

This is a dual-skill path: use `/baton $openspec-apply-change <change>` in the
same Grok director conversation. Baton is hookless and must not activate for an
ordinary OpenSpec request unless `/baton` was explicitly run. OpenSpec tasks
remain canonical. Before dispatch, the Grok main agent reads the apply
instructions, every returned `contextFiles` file, repository guidance, and
affected code. It captures and audits the plan's `source_snapshot`, including
repository revision, task-ledger path and identity/hash, context-file hashes,
and selected-task fingerprint; missing or stale snapshot evidence fails
closed. It compiles a versioned fine-grained plan with exact task refs,
dependencies, read context, write paths and operations, an imperative patch
recipe, done criteria, validation, parent gates, and task mappings. Units are
`patch-only` or `verification-only`; broad tasks may split into disjoint units,
coupled tasks may merge into one patch, and a later overlapping integration
unit must be explicitly ordered after its predecessor.

Baton validates and persists that plan/run, computes the maximal safe ready
frontier, and derives each unit's minimum capability (Grok route capability)
from complexity, context, code scope, reasoning, and native/tool execution
needs. For every unit, routing walks only the configured `coding_models` in
exact priority order. For every unverified session-host-route, single-flight
the first native launch; bind success to fan out. On native launch failure,
immediately report the exact code and unmodified raw message with
`dispatch fail`, then release the ticket. Refill the same run only after that
terminal/release boundary so Baton uses immutable configured successors. Never
create a separate read-only probe or a new compiled run, and never special-case
Spark. Silently continue while any configured route remains available and
capable. Notify only on `NO_QUALIFIED_CANDIDATE`, listing every configured
candidate and every exclusion reason. Quota, rate-limit, and uncallability
evidence are session-local Baton cache facts; session evidence never carries to
a new Grok session, which must recheck its routes.

Grok does not currently guarantee a native child cwd, so it advertises
`exact_execution_root=false`. An `isolated-worktree` reservation must fail
closed as adapter-incompatible before any `spawn_subagent` call; do not fall
back to shared execution. Only an explicitly shared reservation may pass its
prompt unchanged to a fresh exact-model Grok native worker via a
`spawn_subagent` call with `background=true`, `isolation=none`,
`subagent_type=general-purpose`, and `resume_from` unset (`fork_context=false`).
For that shared worker, immediately bind the returned opaque `subagent_id`, wait on real activity with
`get_command_or_subagent_output` for real native liveness, record exactly one terminal result,
release the ticket before refilling capacity, and keep terminal scopes owned until
release. Return to the director only for
source staleness, changed contracts, scope changes, safety-blocked partial
mutation, or structured `PLAN_INSUFFICIENT`. A worker must not redesign or
broaden scope, spawn children, touch Git or OpenSpec, or choose a model. The
parent alone accepts gates and reconciles task checkboxes after all mapped units
and gates pass; never complete a checkbox early.

### Exact worker execution boundary

For an isolated reservation, render and pass the exact canonical
`execution_root`, the patch instructions unchanged, and the complete
`permitted_validation` list. The execution root is the worker's only workspace
boundary, not additional authorization: all paths and operations remain limited
by the Receipt. Validation is not extra read or write authority. The worker must
not read, write, traverse, resolve a path into, or run a command in the caller
checkout or any sibling execution root, including through symlinks, nested
repositories, or other repository indirection.

The worker must not run Git or stage, commit, create or change branches, update
refs, merge, or rebase. It must not edit OpenSpec artifacts, task sources, task
ledgers, plans, Receipts, dispatch artifacts, or lifecycle records; create or
manage worktrees; spawn descendants; replan, redesign, change dependencies, or
expand or narrow scope; create or apply bundles; integrate results; or resolve
conflicts. If the exact patch or validation instructions require any forbidden
action, it returns structured `PLAN_INSUFFICIENT` instead of substituting work.

An explicitly selected `shared-worktree` reservation remains a legacy/manual
compatibility path. It has no generated exact-root claim and keeps its existing
shared-workspace semantics, but every other Receipt, operation, Git, planning,
descendant, bundle, and integration restriction above still applies. Never
silently convert between shared and isolated execution.

## Rolling v2 control loop

For new multi-unit work, use the source-neutral rolling protocol. OpenSpec is
an adapter, not a prerequisite. The accepted source descriptor owns stable
task keys; OpenSpec adapters map Markdown numbers such as `1.1` to those keys
and never use a transient Apply ordinal as reconciliation identity. A director
source carries its stable task definitions in the descriptor selection.

Start after the director has one small safe delta; do not wait for a complete
large-change analysis. Append later deltas while existing tickets are queued,
running, terminal, or accepted. An append may add independent work immediately
but cannot replace an active or accepted unit version. Every delta is prepared
against the current `append_sequence`; on a storage race, read status, preserve
the unchanged semantic delta, rebase only the compare token, and retry.

```text
baton run start --host grok --source-file <source.json> [--plan-delta-file <delta.json>] [--run-id <run>] [--dispatch] --json
baton run <run> --append-plan <delta.json> [--dispatch] --json
baton run <run> --status --json
baton run <run> --accept-gate <gate>@<version> --text "..." [--dispatch] --json
baton run <run> --seal-task <task-key> --seal-file <seal.json> --json
baton run <run> --reconcile [--task <task-key>] --json
```

New writing runs default to isolation, so Grok's declared
`exact_execution_root=false` produces a pre-ticket local blocker. Do not retry
that unit through `spawn_subagent` and do not infer shared mode. A user or
director that intentionally needs Grok must create the run with explicit
`--worktree-mode shared-worktree`; verification-only units remain rootless.
Bundle, parent integration, submodule ordering, and cleanup remain parent-only
operations and never belong to a Grok worker.

Status is task-first and distinguishes unplanned, planned, active, blocked,
terminal-unreleased, accepted, sealed, and reconciled work. Preserve the
original `BATON_SESSION_ID` across reconnects. Status/reconciliation repairs
missing ticket-derived facts idempotently; it must never create a duplicate
ticket or native attempt. Terminal success alone is not acceptance: Baton
records the terminal result, safety verdict, parent acceptance, and matching
release as separate idempotent facts. Release keeps attempt ownership exact
and triggers deterministic refill of the same run. Only accept an explicit
typed gate after all of its dependencies are accepted. Only seal exact
non-superseded coverage. Only reconcile sealed tasks; this is the sole
source-writeback path.

If a worker returns structured `PLAN_INSUFFICIENT`, keep the failure on the
smallest unit version, append a director-authored successor delta, and continue
unrelated safe frontier work. Never discard or silently migrate an active
compiled-v1 run. Inspect v1 read-only or finish it with its original protocol.

The older compiled CLI operations remain explicit compatibility surfaces:

```text
baton apply <change> --host grok --plan-file <plan.json> [--dispatch] --json
baton apply <change> --host grok --run <run-id> --status --json
baton apply <change> --host grok --run <run-id> --accept-gate <gate-id> --text "..." --json
baton apply <change> --host grok --run <run-id> --reconcile [--task <number>] --json
baton apply <change> --host grok --run <run-id> --plan-file <successor.json> [--dispatch] --json
```

Use a compiled run's current revision and fingerprint when appending a successor;
stale source or changed contracts fail closed. `--status` is observational,
`--accept-gate` records parent evidence, and only `--reconcile` writes the
canonical OpenSpec ledger. Manual `baton apply` scope flags remain available
for legacy callers; compiled apply rejects those flags instead of guessing.

## Routing and scope

- Discussion and read-only analysis stay in the director session.
- Authorized implementation, mechanical, long-context, and OpenSpec units use
  Grok native child execution after the director records their exact paths and
  allowed operations (`write`, `create`, `delete`, `rename`, `chmod`).
- Recompute the maximal safe ready frontier whenever a dependency completes or
  a slot is released. Fill every pairwise-disjoint ready scope within capacity;
  section order is only a tie-breaker and never a serialization reason.
- Stop before mutation when an impact, dependency, path, or operation is
  unknown. Never borrow another host or inherit the parent model.

## Grok catalog and native execution

The adapter's ACP `initialize` `modelState.availableModels` response is the
only model authority. Use the exact picker-visible id and reasoning effort;
hidden rows and aliases are not selectable. The selected model is passed only
to a shared native Grok child with a fresh context (`resume_from` unset,
`fork_context=false`). Isolated execution remains unsupported until the native
subagent API guarantees the requested cwd.

The current Baton CLI uses an opaque generic execution handle:

```text
baton dispatch bind TICKET --host grok --execution-handle subagent_id=GROK_SUBAGENT_ID --json
baton dispatch probe TICKET --host grok --execution-handle subagent_id=GROK_SUBAGENT_ID --state running --activity heartbeat --json
baton dispatch complete TICKET --host grok --text "short conclusion" --release --json
```

Reserve only explicit shared work (`baton dispatch next --host grok --json`),
pass the reservation prompt unchanged to Grok `spawn_subagent` with `background=true`,
`isolation=none`, `subagent_type=general-purpose`, and `model` set to the exact
selected route id. Immediately bind the returned `subagent_id` as the opaque
`subagent_id=...` handle, wait on native activity with
`get_command_or_subagent_output`, record exactly one terminal result, and
release before refilling capacity. Cancel with `kill_command_or_subagent`.
A capacity backpressure response defers the same reservation without changing
its model. An unknown model must fail without inheriting the parent model. An
isolated reservation is incompatible and must never reach this call.

The root Grok conversation creates one opaque `BATON_SESSION_ID` before its
first control-plane call. Every descendant and every control-plane operation
(`spawn`/`apply`, reserve, bind, probe, complete, and release) receives and
forwards that exact value unchanged; no child or reconnect may mint or replace
it. Every ticket-producing command therefore remains session-scoped, and the
handoff keeps `session_id`, `ticket_id`, `session_ordinal`, and the native
handle together. Explicit quota exhaustion may create an immutable successor
only after a clean pre-mutation baseline and fresh hard checks; retain the
same session identity, host, scope, authorization, and quota lineage while
recording `successor_from_ticket_id`.

This host's measured concurrent subagent ceiling is 16 and is stored on
`[cli.grok].max_concurrent`. If Grok's catalog later reports
`max_concurrent_subagents`, that live CLI value replaces it. If neither is
currently available, Baton preserves an existing positive reported value;
otherwise the profile stores `-1` and Baton uses `[director].max_concurrent`
(default 4). The root conversation is excluded; direct and nested descendants
share the same tree-local pool. A separate root conversation has its own
tree-local capacity. Shared workspace safety checks still apply across trees,
but native route availability, quota, rate-limit, and uncallability evidence
remains session-local and a new session must recheck it. The only provider-wide
quota input is `provider_quotas` explicitly returned by the active adapter
catalog; Baton never promotes another session's native failure into that signal.
Grok `max_depth` is a separate nesting policy: a child cannot spawn another
child when the host depth ceiling is one.

Do not expose a human model selector at runtime, silently substitute a model,
or release/refill before terminal recording. Commit and publication remain
parent-owned safety operations.
