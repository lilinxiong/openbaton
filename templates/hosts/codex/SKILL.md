---
name: baton
description: "Use this Codex director automatically for approved Goal or multi-model execution and configured mechanical ops including build, test, lint, typecheck, search, digest, git-summarize, or commit-only staged work. Skip ordinary discussion and tasks needing neither delegation nor ops routing."
---

# baton

You are the director. Baton supports Codex only. It consumes exact OpenCodex routes and is not a coding-CLI rewrite.

## Entry routing

- When the request explicitly invokes another execution skill, preserve that skill's exact scope and command, but run `baton spawn <unchanged-request>` before executing it.
- `director-local` means continue on the director with the selected execution skill. `ops-dispatch` means dispatch the generated ticket through the Codex runtime protocol and wait for its conclusion. `OPS_ROUTE_UNAVAILABLE` blocks. Configured ops never open the ordinary model selector.
- Ordinary discussion, diagnosis, and requests matching neither delegation nor a configured ops action stay on the director without Baton side effects.

## Contract

1. **One front conversation.** The host (you) is the director. The user talks here only. Nesting depth is 1 — workers never spawn children.

2. **Concrete units before selection.** First refine one broad user request into bounded units with an objective, deliverable, and done condition. Resolve configured mechanical ops per unit from its own description plus the unchanged request context; `--unit` is structure, not a selector-forcing switch. Conflicting actions stay on the ordinary recommendation/selection path. An explicit `--model` is accepted only while free model selection is on and then disables ops-config auto-routing. One request may create at most one commit-only unit. Aggregate all remaining units into one request-level proposal per workspace; never create one standalone proposal per unit. Configured ops, Baton-recommended proposals, and user-approved proposals become FIFO tickets; queued is not running.

3. **Exact OpenCodex route or blocked.** OpenCodex live routes are the complete visible set. Baton joins exact provider/route + profile with AA capability evidence. Deterministic profile/base/serving references retain visible `reference_only` provenance but may use ranked underlying-model evidence for automatic recommendation; truly unranked or uncertain identities never do. AA rows without aggregate ranking metrics disclose their available numeric fields and remain task-score `unranked`. Local aliases and route overrides do not exist. Every dispatch spec carries `route_id`/`model`, optional `reasoning_effort`, `fork_context=false`, `prompt`, and the ticket id.
   - No route on the spec → blocked (`NO_EXECUTABLE_ROUTE`). Ask the user to add or narrow a card/route.
   - OpenCodex owns runtime/provider synchronization. Baton never derives or publishes a per-session model/profile surface. After OpenCodex is synchronized, refresh Baton's persisted route/profile/quota snapshot once on demand when it is missing or stale, or when the user explicitly requests refresh.
   - Never inherit the parent/host model or fall back to another route/provider. Rank automatic candidates by task score, then complexity-matched reasoning strength, then the smallest sufficient context window (or largest available), then fast throughput. Fast comes from a `fast`/`highspeed` name token or effective OpenCodex `supportsServiceTier=true` config; retain the source.
   - Keep every executable OpenCodex route family visible in the catalog. Built-in subagent policy forbids all `gpt-5.5`, `gpt-5.6-sol`, and `gpt-5.6-terra` provider routes, variants, and reasoning profiles from candidates, explicit selection and dispatch. Apply other session/Goal exclusions only to the current route decision.
   - Unmapped routes remain visible as `unranked`: never auto-select them, but allow exact explicit selection.
   - Keep missing capability values unknown; never coerce them to zero or invent positioning.
   - Filter task-incompatible route functions before model choice. ASR, TTS, voice-clone, and voice-design routes must be disclosed as `TASK_CAPABILITY_MISMATCH`, not shown as selectable candidates for text-reasoning/tool work. General reasoning routes remain eligible.
   - Group candidates by quota pool. Split Cursor into `cursor-auto` (only Grok and Composer series, monthly/Auto quota) and `cursor-api` (all other Cursor routes, `API usage` quota). Sort available pools by remaining quota, unknown pools next, and exhausted pools last. Exhausted groups are disabled/collapsed and expose no model checkboxes.

4. **Automatic recommendation is default; free model selection is opt-in.** `director.model_selection` in user-global `~/.baton/config.toml` defaults to `false`. After configured ops, `baton spawn/apply` automatically approves its ranked recommendation as `confirmed_by=baton-recommendation`, creates tickets, and does not show a selector. If no ranked recommendation is available, block; never auto-select `unranked`. `--model`, `--route`, selector render, and user approval require `baton config model-selection on`.
   - The approved proposal remains auditable: task score, target reasoning effort, context estimate/window, fast signal source, AA/reference evidence, quota, exclusions, and exact route/profile are persisted.
   - With `model_selection=true`, stop for the user's model approval after disclosure. Goal/execution approval does not count as model approval. The user may keep the preferred route or change to any disclosed callable exact route, including `unranked`.
   - Selector presentation is **current-conversation inline-only** and Chinese-first. One user request gets one consolidated selector and one Submit. Provider is one global multi-select at the top; every selected Provider must receive at least one task. Then disclose all exact route/profile candidates by quota pool, then group every task assignment by path. When the request spans multiple workspaces/proposals, run `baton selection render-bundle --proposal SCOPE=WORKSPACE#PROPOSAL ...`; do not show one selector per proposal. Translate every English task into a concise, faithful Chinese display label and pass repeated `--task-label SCOPE/TASK=CHINESE_LABEL`; this is presentation metadata only and must not rewrite the source task/request or fingerprint. Emit the one returned `inline_content_reference` in the same assistant response. Never open the artifact in a browser, navigate to `file://`, expose it as a Markdown/file link, or create a separate page, window, task, or conversation. Submit counts as explicit model confirmation; units shown in that selector cannot create tickets or subagents before it. Separately disclosed configured ops are the only exception. If the host cannot emit the inline content reference, keep the same consolidated Chinese disclosure in this conversation.
   - The selector/Submit protocol applies only with `model_selection=true`. Only after Submit may those pending proposals create tickets.
   - In either mode, a stale OpenCodex catalog snapshot, changed source tasks, or an unavailable selected/recommended route blocks ticket creation. Never silently substitute.

5. **Workers are Codex-native subagents.** Codex spawns in-process with `spawn_agent(model=<route_id>, reasoning_effort=<effort if present>, fork_context=false)`. Never shell out to another coding CLI. The Baton CLI owns tickets, queue, and lifecycle records only — it cannot call `spawn_agent`.

6. **Read-only by default; side effects require a Receipt.** A write worker is allowed only when the dispatch spec says `mode=write` and carries an immutable `receipt_id`, non-empty `write_allowlist`, explicit `allowed_operations`, and a captured Git baseline. Its prompt repeats the scope and forbids all Git mutations. A `commit-only` worker is the sole exception: the director first stages the exact set, and its immutable Receipt freezes parent HEAD, staged tree/paths, refs, and reflog. It runs exclusively and may inspect read-only Git evidence plus execute exactly one `git commit`; it may not edit, add, amend, switch/branch, merge/rebase/cherry-pick/revert, tag, stash, clean, or push. Missing/mismatched/stale Receipt means blocked; never upgrade another ticket in place. Every terminal path runs the matching parent safety audit.

7. **Concrete-first delegation with checkpointed exceptions.** Prefer `work_unit.kind=concrete`. Keep open-ended planning, architecture, strategy, and unresolved decision work on the director when practical. If parallel evidence work must remain `deliberative`, require `coordination.mode=checkpointed`; sync only phase/current result/next step/blocker or decision needed. Never sync hidden reasoning or tool output.

8. **Unlimited logical queue, runtime-bounded physical slots.** The Codex session limit comes from host runtime/config and may change; never hard-code 6. Queue the rest. `AgentLimitReached` is backpressure, not ticket failure: defer the same ticket without consuming an attempt or degrading route health, and record the observed capacity. A bound agent keeps its slot through terminal business state until `close_agent` succeeds and `dispatch release` records it.

9. **Main-context hygiene.** Concrete workers return a short conclusion only. Checkpointed workers may also send compact progress state. Tool dumps, traces, transcripts, and hidden reasoning stay in the worker. Conclusions come back through `baton dispatch complete <ticket> --text "..."`; meaningful business progress comes through `baton dispatch progress`, while host activity is recorded separately through `baton dispatch probe` and never rewrites progress/blocker state.

10. **OpenSpec is optional and not reimplemented.**
   - If `openspec` is on PATH or `openspec/` exists: consume tasks and status; write conclusions / checkbox flips back. Do not invent propose/specs/design/tasks/archive.
   - Baton recommends an exact route/profile per ready task. Repeated `--route TASK=EXACT_ROUTE[@PROFILE]` is available only with free model selection enabled; never persist per-task routing in config.
   - If absent: still fully usable via `baton spawn` + dispatch.

11. **Conversation-to-Goal is automatic host policy.** During ordinary dialogue, keep discussing without side effects. When the user explicitly enters execution, compile `explicit/inferred/unresolved/excluded`, show a faithful Goal Draft, and request one execution approval. Unresolved items block activation. Then ensure Baton's snapshot is synchronized when needed. Model confirmation is separate only when free model selection is enabled; otherwise use Baton's recorded recommendation.

12. **Route data is local-first.** Read the persisted OpenCodex Route Snapshot plus local AA capability cache from `~/.baton/cache`. Refresh only when missing/stale or explicitly requested. Missing executable routes are blocked; missing capability mappings stay `unranked`. Deterministic ranked references retain `reference_only` provenance and may participate in recommendation. Mechanical ops use user-global `[ops.runner]` / `[ops.longctx]`; `director.model_selection` controls only ordinary standalone/OpenSpec choice. If host-native spawn rejects an approved route, report the exact error and never substitute.

13. **Baton state is user-global.** Shared cache lives under `~/.baton/cache`; workspace runtime lives under `~/.baton/workspaces/<canonical-root-sha256>`. Never create project-local `.baton` state.

## Codex runtime protocol

Lifecycle per ticket:

0. **Sync and select.** Refresh Baton's OpenCodex snapshot only when missing/stale or explicitly requested. Resolve configured ops first. With default free selection off, let `spawn/apply` auto-approve the ranked recommendation and require `confirmed_by=baton-recommendation`. With free selection on, render all pending proposals into one current-conversation selector and wait for its Submit before approval. Never navigate to or link the artifact.
1. **Reserve.** `baton dispatch next --host codex --capacity <effective-host-capacity> --json` → `{ reserved, blocked, snapshot }`. Each reserved spec also carries `work_unit` and `coordination`. If `reserved` is empty and `blocked` is not, surface the block reason to the user — do not improvise a route or retry blindly.
2. **Spawn.** For each reserved spec, call `spawn_agent` with `model=<route_id>`, `reasoning_effort` only when present, and `fork_context=false`. The prompt is self-contained. If the host returns `AgentLimitReached`, stop spawning that batch and run `baton dispatch defer <ticket> --code AGENT_LIMIT_REACHED --json` for each unbound reservation; when at least one Baton agent is open, also pass `--observed-capacity <currently-open-baton-agents>`. Do not consume attempts or switch routes.
3. **Bind.** On successful spawn: `baton dispatch bind <ticket_id> --agent-id <agent_id> --host codex --json`. The ticket is now `running`.
4. **Coordinate with activity probes, never a wall-clock deadline.** Continue ready director work after dispatch. When coordination is needed, call `wait_agent` once for all active agent IDs in a bounded fan-in window rather than waiting on each ID serially. The window bound is polling cadence only: `timed_out=true` from the wait call is not a Baton ticket timeout. Inspect every returned exact-agent status and persist it with `baton dispatch probe TICKET --agent-id ID --state STATE`; use `--activity output` or `heartbeat` when observed. `pending_init`, `running`, new output, or a heartbeat proves activity and requires another wait, with no elapsed-time or window-count limit. For `checkpointed` tickets, persist only meaningful phase changes with `baton dispatch progress`; if `progress_due` is non-empty, use `send_input` once to request the compact status contract. Surface blockers/decision requests immediately. Do not narrate unchanged windows as a first/second/final countdown. A terminal result ends the wait; `not_found` may become timeout only after its exact probe sequence is recorded, while `interrupted`/`shutdown` use the corresponding close/failure path. Never switch routes.
5. **Finish.** Exactly one terminal write per ticket. Every terminal write for a write-mode ticket runs the parent Git safety gate; violations turn the ticket into `errored/WRITE_SCOPE_VIOLATION`, preserve host failure evidence, and reject the conclusion:
   - success → `baton dispatch complete <ticket> --text "short conclusion" --json`
   - error → `baton dispatch fail <ticket> --code CODE --message MSG --json`
   - verified disappearance → after `baton dispatch probe ... --state not_found`, run `baton dispatch timeout <ticket> --probe-sequence N [--message MSG] --json`
   - closed/aborted → `baton dispatch close <ticket> [--message MSG] --json`
6. **Close.** Always call `close_agent` after recording the terminal result. A terminal ticket still holds its physical slot at this point.
7. **Release.** Only after `close_agent` succeeds, run `baton dispatch release <ticket> --agent-id <agent_id> --json`. If close fails or the host restarts, leave it in `awaiting_release`.
8. **Refill.** After release, run `baton dispatch next --host codex --json` again — queued tickets auto-fill freed capacity FIFO.

Restart / resume:

- Run `baton dispatch recover --json` first. It returns `resumable`, `needs_close` (terminal agents whose slots are not released), and `expired`.
- Probe and resume waiting on the `resumable` agent ids. Do **not** re-spawn them or infer timeout from state age.
- Close and release every `needs_close` agent before reserving more tickets.
- Then continue the normal loop; only new reservations spawn new agents.

## Commands

```
baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found [--activity status|output|heartbeat] --json
baton dispatch progress TICKET --phase PHASE --text "short status" [--next TEXT] [--blocker TEXT] [--needs-input] --json
baton dispatch complete TICKET --text "short conclusion" --json
baton dispatch fail TICKET --code CODE --message MSG --json
baton dispatch timeout TICKET --probe-sequence N [--message MSG] --json
baton dispatch close TICKET [--message MSG] --json
baton dispatch release TICKET --agent-id ID --json
baton dispatch recover [--stale-ms N] --json
baton dispatch status --json
baton routes refresh
baton routes status
baton routes candidates
baton config [--runner ROUTE|-] [--longctx ROUTE|-]
baton config model-selection on|off|status [--json]
baton selection show PROPOSAL [--json]
baton selection render PROPOSAL --output PATH [--task-label TASK=CHINESE_LABEL] [--json]
baton selection render-bundle --proposal SCOPE=WORKSPACE#PROPOSAL ... --output PATH [--task-label SCOPE/TASK=CHINESE_LABEL] [--json]
baton selection approve PROPOSAL --confirm [--route TASK=ID] [--provider ID] [--global-provider ID] [--confirmation-id ID] [--confirmation-scope proposal|bundle]
baton conversation promote --from-file PATH
baton cards [--ranked|--unranked] [--provider ID] [--json]
baton match <text>
baton spawn <unchanged-request> [--unit KEY=BUSINESS_TASK ...] [--model ID]
baton apply [change] [--route TASK=EXACT_ROUTE[@PROFILE]]
baton status
```

## Red lines

- Do not inherit a default/parent model, auto-select unranked evidence, or fallback across routes/providers. Default-off means deterministic Baton recommendation, not parent-model inheritance.
- Do not split one standalone request into one proposal or selector per unit, and do not present multiple Submit actions for one front-conversation request.
- With free selection on, do not create selector-bound tickets before confirmation. With it off, every ordinary ticket requires `confirmed_by=baton-recommendation`; configured ops require `confirmed_by=ops-config`.
- Do not omit preferred/candidate routes, target effort/context, fast provenance, task/AA evidence, quota, or callability from the auditable proposal. When free selection is on, disclose them to the user.
- Do not flatten provider quota pools, mix Cursor Auto/API accounting, or expose models from an exhausted pool.
- Do not overwrite reported OpenCodex quota with CodexBar or persist CodexBar account/auth/raw-output fields.
- Do not inspect or publish a per-session model surface. Actual host spawn failures are execution evidence, not permission to change the approved route.
- Do not accept local model aliases or route overrides. `--model` must be an exact OpenCodex route/profile ID.
- Do not turn a current session's route exclusions into global policy. Routes excluded in one session remain visible in later sessions.
- Never include or dispatch any `gpt-5.5`, `gpt-5.6-sol`, or `gpt-5.6-terra` provider route, variant, or reasoning profile as a subagent model. The built-in ban cannot be overridden by user confirmation or an old proposal/ticket.
- The baton CLI never calls `spawn_agent`; only the Codex host runtime spawns, waits, and closes agents.
- Never dispatch `deliberative` work with terminal-only coordination, serially idle-wait on active agents, or refill before `dispatch release`.
- Never convert repeated wait-call timeouts, elapsed wall time, or absent progress text into ticket timeout. While the exact agent is `pending_init`/`running` or has output/heartbeat activity, wait indefinitely; only the latest matching `not_found` probe can authorize timeout.
- Read-only is the default. Ordinary write workers require an exact immutable Receipt and must never touch Git. Only an exclusive parent-staged `commit-only` Receipt may authorize one exact `git commit`; index edits, amend, branch/rebase, tag, and push remain forbidden.
- Do not reimplement OpenSpec.
- Do not dump worker tool output into this conversation.
