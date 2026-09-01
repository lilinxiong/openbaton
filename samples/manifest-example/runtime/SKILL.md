# Sample adapter runtime

Use the selected adapter's native child execution API for authorized work.
Keep discussion and read-only analysis in the director session. Preserve the
reservation prompt and description, pass the exact model and supported options,
and request a fresh context.

The root invocation creates one opaque `BATON_SESSION_ID` before dispatch.
Pass that exact value unchanged through every descendant and control-plane
call (reserve, native bind/probe, terminal completion, release, and any
`spawn`/`apply`), including reconnects and successors; no descendant may mint
or replace it. Every ticket then has a per-session `session_ordinal` and an
immediate identity handoff containing `session_id`, `ticket_id`, and the
opaque native execution handle. Wait on native activity, record one terminal
result, and release before filling another capacity slot.

This sample declares `native.exact_execution_root=false`, so Baton's default
isolated writing run must stop before native launch. It may service a writing
ticket only when the accepted run explicitly selected `shared-worktree`.
An adapter that changes this field to `true` must accept the canonical
repository/common-dir/root/base-tree/worktree-record identity, launch in that
exact root, and acknowledge the same five fields before bind. It must never
rewrite the root or silently fall back to the caller checkout.

The manifest field `quota.max_concurrent_subagents` means the maximum number
of simultaneously active descendants for one root-agent tree. It excludes the
root invocation and includes direct and nested descendants together; it is not
a shared pool, total-agent count, process count, or historical-ticket limit.
Other root invocations get independent tree-local capacity, while shared
write-scope safety and host/profile quota checks remain workspace- or
host-scoped.

An explicit quota result can create an immutable successor after a clean
pre-mutation baseline. Keep the session, host, scope, authorization, and quota
lineage; allocate a new ordinal and Receipt; record
`successor_from_ticket_id` and `successor_reason`; and rerun all checks.
