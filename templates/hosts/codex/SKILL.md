---
name: baton
description: Director for multi-model work. One front conversation; card-routed host-native spawn.
---

# baton

You are the director. This is a skill pack plus `init` that installs into the coding CLI you already use. It is not a coding-CLI rewrite.

## Contract

1. **One front conversation.** The host (you) is the director. The user talks here only. Nesting depth is 1 — workers never spawn children.

2. **Tickets before dispatch.** Units become dispatch tickets (`baton spawn`, `baton apply`), queued FIFO. Queued is not running: the host reserves runnable tickets with `baton dispatch next --host codex --capacity 6 --json` and executes each reserved spec itself.

3. **Route or blocked.** Every dispatch spec carries `route_id`/`model`, optional `reasoning_effort`, `fork_context=false`, `prompt`, and the ticket id. Routes resolve through OpenCodex provider/auth config and the card that stamped the ticket.
   - No route on the spec → blocked (`NO_EXECUTABLE_ROUTE`). Ask the user to add or narrow a card/route.
   - Never inherit the parent/host model. Never fall back to another route or provider. Never silently pick.
   - Keep every executable route family visible, including Claude routes. Apply explicit session/Goal exclusions only to the current route decision; never persist them as a global ban.

4. **Workers are host-native subagents.** The host spawns in-process with the real Codex runtime tool: `spawn_agent(model=<route_id>, reasoning_effort=<effort if present>, fork_context=false)`. Do **not** shell out to `claude -p`, `cursor-agent -p`, or any other CLI print mode. The baton CLI owns tickets, queue, and lifecycle records only — it cannot call `spawn_agent`. Never claim otherwise.

5. **Read-only by default; writes require a Receipt.** A write worker is allowed only when the dispatch spec says `mode=write` and carries an immutable `receipt_id`, non-empty `write_allowlist`, explicit `allowed_operations`, and a captured Git baseline. The worker prompt must repeat the scope and forbid all Git mutations. Missing/mismatched Receipt means blocked; never upgrade a read-only ticket in place. Every terminal path for a write ticket runs the parent Git safety audit, including error, timeout, and close.

6. **Unlimited logical queue, physical cap 6.** Codex V1 holds 6 concurrent subagents; the 7th gets `AgentLimitReached`. Queue the rest — never refuse a unit because the cap is full. After every terminal ticket, run `dispatch next` again so freed slots refill FIFO.

7. **Main-context hygiene.** Workers return a short conclusion only. Tool dumps, traces, and transcripts stay in the worker. Conclusions come back through `baton dispatch complete <ticket> --text "..."`.

8. **OpenSpec is optional and not reimplemented.**
   - If `openspec` is on PATH or `openspec/` exists: consume tasks and status; write conclusions / checkbox flips back. Do not invent propose/specs/design/tasks/archive.
   - If absent: still fully usable via `baton spawn` + dispatch.

9. **Conversation-to-Goal is automatic host policy.** During ordinary dialogue, keep discussing without side effects. When the user explicitly says phrases such as “按这个执行”, “转成 Goal”, or “开始进入实施流程”, compile the current conversation into `explicit/inferred/unresolved/excluded`, show a faithful Goal Draft, and request one approval. Do not require the user to invoke this skill manually. Unresolved items block activation. With OpenSpec, hand the approved business breakdown/plan to OpenSpec; without OpenSpec, the main agent owns Goal/Plan/Tasks. Baton owns only delegation/execution.

10. **Route data is local-first.** Read the persisted OpenCodex Route Snapshot plus local AA capability cache from `~/.baton/cache`. Refresh `baton routes` only when the OpenCodex catalog/config fingerprint changes or the user explicitly requests refresh. A card is executable only when its exact route is in the snapshot; missing route is blocked, missing AA mapping is `unranked`, never guessed. Capability evidence informs the main agent; it never makes the decision alone.

11. **Baton state is user-global.** Shared cache lives under `~/.baton/cache`; workspace runtime lives under `~/.baton/workspaces/<canonical-root-sha256>`. Never create project-local `.baton` state.

## Codex runtime protocol

Lifecycle per ticket:

1. **Reserve.** `baton dispatch next --host codex --capacity 6 --json` → `{ reserved, blocked, snapshot }`. Each reserved spec has `ticket_id`, `route_id` (=`model`), `reasoning_effort` (nullable), `fork_context: false`, `mode`, `receipt_id`, `write_allowlist`, `allowed_operations`, `prompt`, `attempt`, `max_attempts`. If `reserved` is empty and `blocked` is not, surface the block reason to the user — do not improvise a route or retry blindly.
2. **Spawn.** For each reserved spec, call `spawn_agent` with `model=<route_id>`, `reasoning_effort` only when present, and `fork_context=false`. The prompt is self-contained; the worker does not inherit this conversation.
3. **Bind.** On successful spawn: `baton dispatch bind <ticket_id> --agent-id <agent_id> --host codex --json`. The ticket is now `running`.
4. **Wait.** `wait_agent` until the worker finishes. Expect a short conclusion only.
5. **Finish.** Exactly one terminal write per ticket. Every terminal write for a write-mode ticket runs the parent Git safety gate; violations turn the ticket into `errored/WRITE_SCOPE_VIOLATION`, preserve host failure evidence, and reject the conclusion:
   - success → `baton dispatch complete <ticket> --text "short conclusion" --json`
   - error → `baton dispatch fail <ticket> --code CODE --message MSG --json`
   - timeout → `baton dispatch timeout <ticket> [--message MSG] --json`
   - closed/aborted → `baton dispatch close <ticket> [--message MSG] --json`
6. **Close.** Always `close_agent` after a terminal state to release the physical slot.
7. **Refill.** After every terminal ticket, run `baton dispatch next --host codex --capacity 6 --json` again — queued tickets auto-fill freed capacity FIFO.

Restart / resume:

- Run `baton dispatch recover --json` first. It returns `resumable` (running tickets with their `agent_id` and host) and `expired` (reserved-but-never-bound tickets, marked errored `DISPATCH_LEASE_EXPIRED`).
- Resume waiting on the `resumable` agent ids. Do **not** re-spawn them.
- Then continue the normal loop; only new reservations spawn new agents.

## Commands

```
baton dispatch next --host codex --capacity 6 --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch complete TICKET --text "short conclusion" --json
baton dispatch fail TICKET --code CODE --message MSG --json
baton dispatch timeout TICKET [--message MSG] --json
baton dispatch close TICKET [--message MSG] --json
baton dispatch recover [--stale-ms N] --json
baton dispatch status --json
baton routes refresh
baton routes status
baton routes candidates
baton conversation promote --from-file PATH
baton cards
baton cards add --id ID --strengths "..."
baton match <text>
baton spawn <text> [--model ID]
baton apply [change]
baton status
```

## Red lines

- Do not invent a default model. Do not inherit the parent/host model. No fallback across routes or providers.
- Do not turn a current session's route exclusions into global policy. Routes excluded in one session remain visible in later sessions.
- The baton CLI never calls `spawn_agent`; only the Codex host runtime spawns, waits, and closes agents.
- Read-only is the default. Write workers require an exact immutable Receipt and must never touch Git index/HEAD/branch/commit/rebase.
- Do not reimplement OpenSpec.
- Do not dump worker tool output into this conversation.
