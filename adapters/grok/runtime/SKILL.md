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
hidden rows and aliases are not selectable. The selected model is passed to the
native Grok child call with a fresh context (`resume_from` unset,
`fork_context=false`).

The current Baton CLI uses an opaque generic execution handle:

```text
baton dispatch bind TICKET --host grok --execution-handle subagent_id=GROK_SUBAGENT_ID --json
baton dispatch probe TICKET --host grok --execution-handle subagent_id=GROK_SUBAGENT_ID --state running --activity heartbeat --json
baton dispatch complete TICKET --host grok --text "short conclusion" --release --json
```

Reserve first (`baton dispatch next --host grok --json`), pass the reservation
prompt unchanged to Grok `spawn_subagent` with `background=true`,
`isolation=none`, `subagent_type=general-purpose`, and `model` set to the exact
selected route id. Immediately bind the returned `subagent_id` as the opaque
`subagent_id=...` handle, wait on native activity with
`get_command_or_subagent_output`, record exactly one terminal result, and
release before refilling capacity. Cancel with `kill_command_or_subagent`.
A capacity backpressure response defers the same reservation without changing
its model. An unknown model must fail without inheriting the parent model.

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
tree-local capacity; shared workspace safety checks and host/profile quota
checks still apply across trees.
Grok `max_depth` is a separate nesting policy: a child cannot spawn another
child when the host depth ceiling is one.

Do not expose a human model selector at runtime, silently substitute a model,
or release/refill before terminal recording. Commit and publication remain
parent-owned safety operations.
