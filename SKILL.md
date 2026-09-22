---
name: baton
description: "Prepare current-host native subagents after an explicit user request."
disable-model-invocation: true
user-invocable: true
---

# Baton

Apply only after an explicit request to use Baton, including `/baton`; never
activate from ordinary conversation, implementation requests, or implication.

Root makes only needed decomposition, shared contracts, integration and commits.
After manual activation, delegate by default; do not do worker tasks first.
Use one worker for a small bounded task. Group work sharing context in one
worker; parallelize independent, disjoint scopes. Do not fill slots just to use capacity.

Use current-host native subagents only. Discovery is read-only; Baton never uses
another CLI for task execution. Treat the selected model ID as an opaque value:
pass it unchanged to the native launch tool. Never reject or substitute it based
on provider, name prefix, model family (including non-GPT models), or prior knowledge.
Attempt native launch before reporting model unavailability. If the launch tool
is missing, report a host capability blocker, not an unavailable model.
Failure feedback must cite the actual tool, requested model ID and original error.
Capacity limits, network errors and unsupported effort do not by themselves prove
the model unavailable. For capacity limits, wait or close finished workers before
retrying. A handle proves creation only; inspect subsequent execution failures too.

Choose mode from remaining decisions: execution (settled steps/facts),
implementation (bounded design), investigation (uncertain cause/design).

Select models from the selected mode's candidate pool in list order: no
cross-mode fallback, and explicit models belong there. Root chooses effort
independently; pass `--effort <level>` only when chosen, else keep host—not
catalog—default. Do not infer context from migration/monorepo or invent quotas;
pass unavailable models only for explicit user constraints or observed failures
that establish model unavailability in the current host/context, never guesses.

Brief JSON has goal, decisions, scope, acceptance, context, constraints and mode
(read-only/write). Scope is files/modules/dirs, a prompt contract, never a sandbox.
Inspect dependencies; writes are disjoint or root coordinates overlap. Handoff:
existingChanges, checks, unresolvedIssues. Use precise file/symbol refs and
settled conclusions, not full source/history; logs are file refs, and repeat
checks only after changes, failure or integration. `--brief-budget-chars N` is
advisory: warn only above N, never truncate/reject. For ordinary feedback on the
same task, reuse its existing native worker and send only the delta; start fresh
when scope, model, or context changes. Reuse settled evidence with source/version refs.

`baton spawn --host <host> --brief <file> --work-mode <mode> --json` prepares
native parameters, never starts agents. Its `execution_contract` guides the caller;
do not forward that metadata as native tool arguments or as the worker prompt.
When host and selection are configured,
call `baton spawn` directly; use `baton models` or `baton match` only for setup or selection
diagnosis. For a batch, use `baton spawn --briefs FILE --host HOST --work-mode MODE
--json`; `FILE` is a JSON array of 1–128 plain briefs or `{brief,selection}`
envelopes. One catalog discovery selects each task independently. Start independent
workers in parallel through the native host API with returned parameters in fresh
context. Native handles/activity/completion are authority; no tickets, receipts,
queues, scheduler, automatic routing, or another state machine.

On finish review concise status, conclusion, changed locations, check evidence
and blockers; optionally record: `baton record --host <host> --handle <handle>
--model <model> --status completed --text <result>`. `baton status` is recorded,
never live state.

Root preserves user changes, checks integration and makes authorized commits.
Report static review, build, tests and native execution separately; never claim
prompt contracts enforce write isolation.

Respect `max_concurrent_subagents` returned by `baton spawn` as the user-selected
concurrent budget (default 3, maximum 20). It is not a live host-capacity guarantee.
Keep no more than this many native workers open; close finished workers before
starting queued work. Host capacity errors still take precedence.
