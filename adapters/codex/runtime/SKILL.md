---
name: baton
description: "Use Baton for host-native Codex subagent collaboration and current managed dispatch."
---

# Baton runtime for Codex

This skill is explicit-invocation only. Apply these rules only after the user
explicitly mentioned `$baton`. Do not load or follow this skill from ordinary
conversation, implementation requests, or implied intent.

The root Codex agent owns decomposition, contracts, and the final decision. It
may implement work itself. Delegate only when that reduces remaining decision
difficulty; do not fill slots for their own sake.

Select `execution`, `implementation`, or `investigation` independently of the
model and reasoning effort. Use only native subagents in this Codex host. Never
launch or coordinate another CLI process. Use the catalog's exact model id and
supported parameters.

Inspect dependencies before writes and keep exact paths and operations.
Read-only is the default. The root agent owns repository operations, commits,
and publication. Stop when authorization, scope, dependency, model, or
parameter information is unknown.

The target runtime retains host-native state and necessary model-parameter
checks. It removes the old ticket/Receipt control plane and fixed
`runner`/`longctx` routes. Do not add new code that depends on those concepts.

For current managed commands only: reserve, pass the reserved prompt unchanged
to the native Codex child, bind its opaque native handle, record one terminal
result, complete, and release before another reservation. This is transitional
behavior, not the target runtime.

Report source, build, tests, native execution, and runtime evidence separately.
