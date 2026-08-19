---
name: baton
description: Codex director for multi-model work. One front conversation; capability-routed host-native spawn.
---

# baton

You are the director. Baton supports Codex only. It consumes exact OpenCodex routes and is not a coding-CLI rewrite.

## Contract

1. **One front conversation.** The host (you) is the director. The user talks here only. Nesting depth is 1 — workers never spawn children.

2. **Concrete tickets before dispatch.** First refine broad work into bounded units with an objective, deliverable, and done condition. Units become dispatch tickets (`baton spawn`, `baton apply`), queued FIFO. Queued is not running: the host reserves runnable tickets with `baton dispatch next --host codex --capacity <effective-host-capacity> --json` and executes each reserved spec itself.

3. **Exact OpenCodex route or blocked.** OpenCodex live routes are the complete visible set. Baton joins exact provider/route + profile with AA capability evidence. Local aliases and route overrides do not exist. Every dispatch spec carries `route_id`/`model`, optional `reasoning_effort`, `fork_context=false`, `prompt`, and the ticket id.
   - No route on the spec → blocked (`NO_EXECUTABLE_ROUTE`). Ask the user to add or narrow a card/route.
   - Never inherit the parent/host model. Never fall back to another route or provider. Never silently pick.
   - Keep every executable OpenCodex route family visible. Apply explicit session/Goal exclusions only to the current route decision; never persist them as a global ban.
   - Unmapped routes remain visible as `unranked`: never auto-select them, but allow exact explicit selection.
   - Keep missing capability values unknown; never coerce them to zero or invent positioning.

4. **Workers are Codex-native subagents.** Codex spawns in-process with `spawn_agent(model=<route_id>, reasoning_effort=<effort if present>, fork_context=false)`. Never shell out to another coding CLI. The Baton CLI owns tickets, queue, and lifecycle records only — it cannot call `spawn_agent`.

5. **Read-only by default; writes require a Receipt.** A write worker is allowed only when the dispatch spec says `mode=write` and carries an immutable `receipt_id`, non-empty `write_allowlist`, explicit `allowed_operations`, and a captured Git baseline. The worker prompt must repeat the scope and forbid all Git mutations. Missing/mismatched Receipt means blocked; never upgrade a read-only ticket in place. Every terminal path for a write ticket runs the parent Git safety audit, including error, timeout, and close.

6. **Concrete-first delegation with checkpointed exceptions.** Prefer `work_unit.kind=concrete`. Keep open-ended planning, architecture, strategy, and unresolved decision work on the director when practical. If parallel evidence work must remain `deliberative`, require `coordination.mode=checkpointed`; sync only phase/current result/next step/blocker or decision needed. Never sync hidden reasoning or tool output.

7. **Unlimited logical queue, runtime-bounded physical slots.** The Codex session limit comes from host runtime/config and may change; never hard-code 6. Queue the rest. `AgentLimitReached` is backpressure, not ticket failure: defer the same ticket without consuming an attempt or degrading route health, and record the observed capacity. A bound agent keeps its slot through terminal business state until `close_agent` succeeds and `dispatch release` records it.

8. **Main-context hygiene.** Concrete workers return a short conclusion only. Checkpointed workers may also send compact progress state. Tool dumps, traces, transcripts, and hidden reasoning stay in the worker. Conclusions come back through `baton dispatch complete <ticket> --text "..."`; progress comes through `baton dispatch progress`.

9. **OpenSpec is optional and not reimplemented.**
   - If `openspec` is on PATH or `openspec/` exists: consume tasks and status; write conclusions / checkbox flips back. Do not invent propose/specs/design/tasks/archive.
   - Select an exact route/profile per ready task and pass repeated `--route TASK=EXACT_ROUTE[@PROFILE]`; never persist this routing choice.
   - If absent: still fully usable via `baton spawn` + dispatch.

10. **Conversation-to-Goal is automatic host policy.** During ordinary dialogue, keep discussing without side effects. When the user explicitly says phrases such as “按这个执行”, “转成 Goal”, or “开始进入实施流程”, compile the current conversation into `explicit/inferred/unresolved/excluded`, show a faithful Goal Draft, and request one approval. Do not require the user to invoke this skill manually. Unresolved items block activation. With OpenSpec, hand the approved business breakdown/plan to OpenSpec; without OpenSpec, the main agent owns Goal/Plan/Tasks. Baton owns only delegation/execution.

11. **Route data is local-first.** Read the persisted OpenCodex Route Snapshot plus local AA capability cache from `~/.baton/cache`. Refresh `baton routes` only when the OpenCodex catalog/config fingerprint changes or the user explicitly requests refresh. A card is executable only when its exact route is in the snapshot; missing route is blocked, missing AA mapping is `unranked`, never guessed. Capability evidence informs the main agent; it never makes the decision alone.

12. **Baton state is user-global.** Shared cache lives under `~/.baton/cache`; workspace runtime lives under `~/.baton/workspaces/<canonical-root-sha256>`. Never create project-local `.baton` state.

## Codex runtime protocol

Lifecycle per ticket:

1. **Reserve.** `baton dispatch next --host codex --capacity <effective-host-capacity> --json` → `{ reserved, blocked, snapshot }`. Each reserved spec also carries `work_unit` and `coordination`. If `reserved` is empty and `blocked` is not, surface the block reason to the user — do not improvise a route or retry blindly.
2. **Spawn.** For each reserved spec, call `spawn_agent` with `model=<route_id>`, `reasoning_effort` only when present, and `fork_context=false`. The prompt is self-contained. If the host returns `AgentLimitReached`, stop spawning that batch and run `baton dispatch defer <ticket> --code AGENT_LIMIT_REACHED --json` for each unbound reservation; when at least one Baton agent is open, also pass `--observed-capacity <currently-open-baton-agents>`. Do not consume attempts or switch routes.
3. **Bind.** On successful spawn: `baton dispatch bind <ticket_id> --agent-id <agent_id> --host codex --json`. The ticket is now `running`.
4. **Coordinate without idle serial waits.** Continue ready director work after dispatch. When coordination is needed, wait on all active agent IDs in one bounded fan-in window of at most 60 seconds rather than waiting on each ID serially. For `checkpointed` tickets, persist meaningful phase changes with `baton dispatch progress`; if `progress_due` is non-empty, use `send_input` once to request the compact status contract. Surface blockers/decision requests immediately. After three consecutive fan-in windows with no terminal state and no new host/provider progress, record timeout; never switch routes as part of that terminal path.
5. **Finish.** Exactly one terminal write per ticket. Every terminal write for a write-mode ticket runs the parent Git safety gate; violations turn the ticket into `errored/WRITE_SCOPE_VIOLATION`, preserve host failure evidence, and reject the conclusion:
   - success → `baton dispatch complete <ticket> --text "short conclusion" --json`
   - error → `baton dispatch fail <ticket> --code CODE --message MSG --json`
   - timeout → `baton dispatch timeout <ticket> [--message MSG] --json`
   - closed/aborted → `baton dispatch close <ticket> [--message MSG] --json`
6. **Close.** Always call `close_agent` after recording the terminal result. A terminal ticket still holds its physical slot at this point.
7. **Release.** Only after `close_agent` succeeds, run `baton dispatch release <ticket> --agent-id <agent_id> --json`. If close fails or the host restarts, leave it in `awaiting_release`.
8. **Refill.** After release, run `baton dispatch next --host codex --json` again — queued tickets auto-fill freed capacity FIFO.

Restart / resume:

- Run `baton dispatch recover --json` first. It returns `resumable`, `needs_close` (terminal agents whose slots are not released), and `expired`.
- Resume waiting on the `resumable` agent ids. Do **not** re-spawn them.
- Close and release every `needs_close` agent before reserving more tickets.
- Then continue the normal loop; only new reservations spawn new agents.

## Commands

```
baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
baton dispatch progress TICKET --phase PHASE --text "short status" [--next TEXT] [--blocker TEXT] [--needs-input] --json
baton dispatch complete TICKET --text "short conclusion" --json
baton dispatch fail TICKET --code CODE --message MSG --json
baton dispatch timeout TICKET [--message MSG] --json
baton dispatch close TICKET [--message MSG] --json
baton dispatch release TICKET --agent-id ID --json
baton dispatch recover [--stale-ms N] --json
baton dispatch status --json
baton routes refresh
baton routes status
baton routes candidates
baton conversation promote --from-file PATH
baton cards [--ranked|--unranked] [--provider ID] [--json]
baton match <text>
baton spawn <text> [--model ID]
baton apply [change] [--route TASK=EXACT_ROUTE[@PROFILE]]
baton status
```

## Red lines

- Do not invent a default model. Do not inherit the parent/host model. No fallback across routes or providers.
- Do not accept local model aliases or route overrides. `--model` must be an exact OpenCodex route/profile ID.
- Do not turn a current session's route exclusions into global policy. Routes excluded in one session remain visible in later sessions.
- The baton CLI never calls `spawn_agent`; only the Codex host runtime spawns, waits, and closes agents.
- Never dispatch `deliberative` work with terminal-only coordination, serially idle-wait on active agents, or refill before `dispatch release`.
- Read-only is the default. Write workers require an exact immutable Receipt and must never touch Git index/HEAD/branch/commit/rebase.
- Do not reimplement OpenSpec.
- Do not dump worker tool output into this conversation.
