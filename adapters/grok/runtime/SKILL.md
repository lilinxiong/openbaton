---
name: baton
description: "Use Baton to prepare bounded work for the current host native subagents. Invoke only with /baton; discussion and read-only analysis stay in the director session."
disable-model-invocation: true
user-invocable: true
---

# Baton runtime for Grok

This skill is slash-command only. Apply these rules only after the user
explicitly ran `/baton`. Do not load or follow this skill from ordinary
conversation, implementation requests, or implied intent.

The root agent owns decomposition, shared contracts, integration and commits.
It may implement work itself. Delegate only when the independent work justifies
the handoff; never fill slots for their own sake.

Use only the current host's native subagents. Model discovery is read-only;
Baton never launches another CLI to perform a task. If the host cannot execute
the selected model or parameters, report that limitation instead of substituting.

Choose a work mode by the decisions still left to make:
- execution: follow settled steps or narrowly check facts; prefer low effort.
- implementation: complete a bounded design; prefer medium effort.
- investigation: resolve an uncertain cause or design; prefer high effort.

Choose model and effort independently from the current catalog and configured
mode preferences. Supply an explicit model when task complexity warrants it.
Do not infer large context requirements from words like migration or monorepo.
Do not invent quota facts; pass known unavailable models when relevant.

Write one JSON brief with goal, decisions, scope, acceptance, context,
constraints and mode (read-only or write). Scope can name modules or directories.
Inspect dependencies, keep concurrent write scopes disjoint, and coordinate any
overlap with the root. Scope is a prompt contract, not a filesystem sandbox.
Use handoff fields for existingChanges, checks and unresolvedIssues when
continuing or upgrading a worker. Do not resend the complete conversation.

Run `baton spawn --host grok --brief <file> --work-mode <mode> --json`.
This returns native execution parameters; it does not start an agent.
Pass the returned prompt and supported model/effort to the host's native child
API with a fresh context. Native handles, activity and completion are the
runtime authority. Do not add tickets, receipts, queues or a second state machine.

When a worker finishes, review its result and optionally append a short record
with `baton record --host grok --handle <handle> --model <model> --status
completed --text <result>`. `baton status` shows recorded outcomes, not live state.

The root preserves user changes, checks the integrated result, and performs
any authorized commits. Report static review, build, tests and real native
execution separately. Never claim the prompt contract enforces write isolation.
