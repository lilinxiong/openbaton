---
name: baton
description: "Use Baton to prepare bounded work for the current host native subagents."
---

# Baton runtime for Codex

This skill is explicit-invocation only. Apply these rules only after the user
explicitly mentioned `$baton`. Do not load or follow this skill from ordinary
conversation, implementation requests, or implied intent.

The root agent owns decomposition, shared contracts, integration and commits.
It may implement work itself. Delegate only when the independent work justifies
the handoff; never fill slots for their own sake.

Use only the current host's native subagents. Model discovery is read-only;
Baton never launches another CLI to perform a task. If the host cannot execute
the selected model or parameters, report that limitation instead of substituting.

Choose a work mode by the decisions still left to make:
- execution: follow settled steps or narrowly check facts.
- implementation: complete a bounded design.
- investigation: resolve an uncertain cause or design.

Choose a model from the selected mode's configured candidate pool, in list
order; do not fall back across modes. An explicit model must belong to that
pool. The root chooses effort for the current task independently of work mode.
Pass `--effort <level>` when making that choice; no mode implies an effort.
When effort is omitted, Baton omits `reasoning_effort` and leaves the host
default unchanged; it does not substitute a catalog default.
Do not infer large context requirements from words like migration or monorepo.
Do not invent quota facts; pass known unavailable models when relevant.

Write one JSON brief with goal, decisions, scope, acceptance, context,
constraints and mode (read-only or write). Scope can name modules or directories.
Inspect dependencies, keep concurrent write scopes disjoint, and coordinate any
overlap with the root. Scope is a prompt contract, not a filesystem sandbox.
Use handoff fields for existingChanges, checks and unresolvedIssues when
continuing or upgrading a worker. Do not resend the complete conversation.

Run `baton spawn --host <host> --brief <file> --work-mode <mode> --json`.
This returns native execution parameters; it does not start an agent.
Pass the returned prompt and supported model/effort to the host's native child
API with a fresh context. Native handles, activity and completion are the
runtime authority. Do not add tickets, receipts, queues or a second state machine.

When a worker finishes, review its result and optionally append a short record
with `baton record --host <host> --handle <handle> --model <model> --status
completed --text <result>`. `baton status` shows recorded outcomes, not live state.

The root preserves user changes, checks the integrated result, and performs
any authorized commits. Report static review, build, tests and real native
execution separately. Never claim the prompt contract enforces write isolation.
