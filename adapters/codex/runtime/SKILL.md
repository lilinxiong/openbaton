---
name: baton
description: "Use Baton for approved Codex execution; discussion and read-only analysis stay in the director session."
---

# Baton runtime for Codex

Codex is the selected host. Baton owns classification, exact write scopes,
reservations, receipts, and lifecycle; this runtime skill does not add hooks or
invent a second task graph.

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
`task_name` as the opaque `task_name=...` handle, wait on native activity, record
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

The manifest's `quota.max_concurrent_subagents` is the maximum number of
simultaneously active descendants in this root agent tree. It excludes the
root conversation, includes direct and nested descendants together, and is
strictly tree-local rather than a process, model, or historical-ticket count.
A separate root conversation has its own tree-local capacity; shared workspace
safety checks and host/profile quota checks still apply across trees.

Do not expose a human model selector at runtime, silently substitute a model,
or release/refill before terminal recording. Commit and publication remain
parent-owned safety operations.
