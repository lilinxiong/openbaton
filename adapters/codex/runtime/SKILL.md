---
name: baton
description: "Prepare current-host native subagents after an explicit user request."
---

# Baton for Codex

Apply only after an explicit request to use Baton, including `$baton`; never
activate from ordinary conversation, implementation requests, or implication.

Root makes only needed decomposition, shared contracts, integration and commits.
After manual activation, delegate by default; do not do worker tasks first.
Use one worker for a small bounded task. Group work sharing context in one
worker; parallelize independent, disjoint scopes. Do not fill slots just to use capacity.

Use current-host native subagents only. Discovery is read-only; Baton never uses
another CLI for task execution. If host cannot execute parameters, report; do not substitute.

Choose mode from remaining decisions: execution (settled steps/facts),
implementation (bounded design), investigation (uncertain cause/design).

Select models from the selected mode's candidate pool in list order: no
cross-mode fallback, and explicit models belong there. Root chooses effort
independently; pass `--effort <level>` only when chosen, else keep host—not
catalog—default. Do not infer context from migration/monorepo or invent quotas;
pass known unavailable models when relevant.

Brief JSON has goal, decisions, scope, acceptance, context, constraints and mode
(read-only/write). Scope is files/modules/dirs, a prompt contract, never a sandbox.
Inspect dependencies; writes are disjoint or root coordinates overlap. Handoff:
existingChanges, checks, unresolvedIssues. Use precise file/symbol refs and
settled conclusions, not full source/history; logs are file refs, and repeat
checks only after changes, failure or integration. `--brief-budget-chars N` is
advisory: warn only above N, never truncate/reject.

`baton spawn --host <host> --brief <file> --work-mode <mode> --json` prepares
native parameters, never starts agents. For matching briefs sharing selection
flags, use `baton spawn --briefs FILE --host HOST --work-mode MODE --json`;
`FILE` is a nonempty JSON array of brief objects. Start independent workers in
parallel through the native host API, with returned prompt and supported model/effort
in fresh context. Native handles/activity/completion are authority; no tickets,
receipts, queues or another state machine.

On finish review concise status, conclusion, changed locations, check evidence
and blockers; optionally record: `baton record --host <host> --handle <handle>
--model <model> --status completed --text <result>`. `baton status` is recorded,
never live state.

Root preserves user changes, checks integration and makes authorized commits.
Report static review, build, tests and native execution separately; never claim
prompt contracts enforce write isolation.
