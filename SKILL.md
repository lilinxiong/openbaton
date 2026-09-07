---
name: baton
description: "Use Baton for host-native subagent collaboration and current managed dispatch. Invoke only with /baton; discussion and read-only analysis stay in the director session."
disable-model-invocation: true
user-invocable: true
---

# Baton runtime

This skill is slash-command only. Apply these rules only after the user
explicitly ran `/baton`. Do not load or follow this skill from ordinary
conversation, implementation requests, or implied intent.

The root agent owns decomposition, contracts, and the final decision. It may
implement a unit itself. Delegate only when that reduces remaining decision
difficulty; do not delegate merely to fill capacity.

Choose `execution`, `implementation`, or `investigation` as the work mode.
Choose model and reasoning effort independently. Use the selected adapter's
live catalog and exact supported parameters. Keep native subagents in the
current host; never start or coordinate another CLI process.

Before writes, inspect dependencies and record exact paths and operations.
Read-only is the default. Repository operations and publication remain root
owned. Stop when authorization, scope, dependency, model, or parameter
information is unknown.

The target runtime retains host-native state and necessary model-parameter
checks. It removes the old ticket/Receipt control plane and fixed
`runner`/`longctx` routes. Do not add new dependencies on those concepts.

The current CLI still exposes managed commands. For those commands only:
reserve, pass the reserved prompt unchanged to the native child API, bind the
opaque native handle, record one terminal result, complete, and release before
another reservation. This is transitional behavior, not the target design.

Report source review, build, tests, native execution, and runtime evidence
separately.
