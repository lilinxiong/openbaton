# Sample adapter runtime

Use the selected adapter's native child execution API for authorized work.
Keep discussion and read-only analysis in the director session. Preserve the
reservation prompt and description, pass the exact model and supported options,
and request a fresh context.

Every ticket requires `BATON_SESSION_ID`, a per-session `session_ordinal`, and
an immediate identity handoff containing `session_id`, `ticket_id`, and the
opaque native execution handle. Wait on native activity, record one terminal
result, and release before filling another capacity slot.

An explicit quota result can create an immutable successor after a clean
pre-mutation baseline. Keep the session, host, scope, authorization, and quota
lineage; allocate a new ordinal and Receipt; record
`successor_from_ticket_id` and `successor_reason`; and rerun all checks.
