---
name: baton
description: "Use this director automatically for approved Goal or multi-model execution, configured mechanical operations, and OpenSpec apply including /openspec-apply-change. Intercept those here; do not implement them in the director session. Before any shell, patch, or native-agent tool call, complete the Baton host-guard preflight. Skip ordinary discussion."
---

# baton

You are the director. Baton is a CLI-neutral scheduling and policy layer. Its registered CLI adapters are Codex, Grok, Cursor, and Claude Code; it does not use OpenCodex for model discovery, authentication, or execution.

## Director/worker routing

Same table on every host. Do not invent a host-specific split.

- **Director-owned classification is authoritative.** Discussion and read-only analysis stay on the director. When the selected `cli.<host>` profile is enabled, every ordinary implementation request—including tiny edits—must be delegated to that host's native subagent; do not apply a tiny-edit shortcut. A missing/disabled profile or unresolved classification fails closed. A classified mechanical unit never falls back to director execution when its configured route is empty or unusable.
- **Declared classified work → native subagents.** Classified mechanical/long-context units, authorized implementation requests, and OpenSpec executable tasks on an enabled host go through Baton tickets and this host's native child-agent tool. The director MUST NOT implement those units in the parent session.
- **OpenSpec only lightens orchestration.** OpenSpec supplies breakdown and status; it does not change who writes declared classified tasks. With or without OpenSpec, declared classified work still goes to native subagents. Do not rewrite OpenSpec apply skills; intercept execution from this Baton skill.

## Automatic workflow contract

The loaded Baton workflow becomes executable only when the selected `cli.<host>` profile is enabled and the user has authorized execution. Model auto-approval is not a second user decision. Before creating any native ticket, the director MUST classify every executable request and pass the structured classification to Baton. Baton persists the resulting tickets and Receipts; it does not invent or own a separate DAG. Operation labels are audit metadata; they are never a fixed action-name routing table.

- Discussion and read-only analysis remain director-owned, even when a CLI profile is enabled.
- Authorized implementation nodes go to native subagents. Mechanical nodes use the configured `runner` route while retaining their operation label only as audit metadata. Commit/publish authority remains the deterministic Receipt/Git capability gate.
- A node is ready only after every dependency is terminal. Independent ready nodes with disjoint write sets may run in parallel, bounded by the selected CLI's `max_concurrent` and `max_depth`; later nodes remain queued until their dependencies complete.
- Missing authorization, a disabled/missing selected profile, invalid director/OpenSpec ordering data, or an unresolved classification fails closed to the director. Never infer a dependency, borrow another host, or dispatch an implementation unit from prose alone.

### Write-scope readiness

Before creating or dispatching any write ticket, the director MUST perform a read-only impact/dependency pass for that unit. The pass must resolve the unit's affected dependencies and record a complete, exact per-unit write-path set together with its allowed operations. Every path is explicit; allowed operations are one or more of `write`, `create`, `delete`, `rename`, and `chmod`. An unknown impact, dependency, path, or operation keeps the classification unresolved, so no implementation ticket is created or dispatched.

Parallel dispatch is permitted only when every participating unit has a complete scope and the write sets are pairwise disjoint, including rename source/destination paths and path-prefix overlaps. Otherwise the director sequences the units or keeps them director-local. If a worker discovers an undeclared path or operation, it MUST stop before mutation and return a scope decision to the director. It must never edit first and rely on a terminal retry or audit to authorize the change. Mechanical routing still uses the structured execution class; operation labels remain opaque audit metadata and never choose the route.

Ordinary discussion and diagnosis that need neither delegation nor a configured mechanical route stay on the director. For approved multi-agent execution, create immutable tickets, dispatch them through the current host's native subagent tool, and wait for their conclusions. If another execution skill is explicitly requested, preserve it as workflow owner only; when this host's `cli.<id>.enabled` is true, executable work still goes through Baton.

## Host-guard preflight (mandatory in Codex, Grok, and Claude Code)

- Before any `Bash`, `apply_patch`/ `Edit`/ `Write`, or native `Agent` call, run `baton guard status --host HOST` on a guard-capable host. Baton init/update installs Codex, Grok, and Claude Code `PreToolUse`/`SubagentStart` guards while preserving unrelated hook configuration. In Codex open `/hooks`, review and trust the Baton-owned entries; Grok and Claude Code user-global hooks apply without a separate trust prompt and should still be reviewed with `/hooks`. Cursor has no equivalent guard surface and must not claim interception.
- Ticket presence is the declared-work signal: with no reserved ticket for this host, director mutating tools are allowed (undeclared / empty-label work). While this host has a reserved, dispatching, or running worker ticket, director implementation writes are denied. The guard serves only its own host's tickets: a Codex guard never satisfies itself with a Claude ticket, and the reverse. Reserve a Baton ticket, native-spawn the exact worker, and bind the returned identity with `baton dispatch bind ...` before the worker uses tools. A child starting during the spawn-to-bind race remains denied until the bind is visible.
- Baton control-plane commands (`baton init`, `baton guard`, `baton spawn`, `baton dispatch`, `baton status`, and related inspection/configuration commands) are the narrow direct-command exemption. Do not hide work behind a shell wrapper or a chained command.
- Every native spawn for a reserved ticket, including when only one is dispatching, MUST pass the returned `prompt` unchanged. If the native tool exposes `description`, pass the returned `description` unchanged too. Both start with Baton's structured reservation envelope. At `PreToolUse`, the guard authorizes only an exact `reservation_id + ticket_id + attempt + host` match; it never infers identity from a ticket prefix, business prose, or a unique-ticket fallback. Missing, stale, conflicting, or reconstructed identity fails closed.
- Codex and Claude Code `SubagentStart` payloads identify the child but do not repeat the spawn input, so those lifecycle hooks never guess a reservation; the explicit dispatch bind establishes identity. Grok can associate its child session because its lifecycle payload carries the exact returned description. Specialized tool paths may opt out of Codex's default hook path, and in Claude Code `SubagentStart` cannot cancel a child (`PreToolUse` is the enforcing gate). The hook is an enforcement guardrail, not a replacement for immutable Receipts, worker path allowlists, and the parent Git safety audit.

## Native identity adapters

Native child APIs do not share one identity field. Baton resolves identity through the serving CLI adapter: Codex uses the hook-observed child UUID and treats native `task_name` only as non-authoritative bind metadata; Claude Code uses the hook-observed child id; Grok uses its `subagentId`/session lifecycle carrier; Cursor uses the native `Task` return because it has no compatible guard hook. Dispatch binds the adapter's normalized identity and rejects caller/observation mismatches. Do not assume a universal `agent_id`, infer identity from a ticket prefix, or use a unique-ticket fallback.

## Model and configuration contract

1. **The selected CLI owns visibility.** baton config first selects a CLI. For Codex, Baton calls the public app-server model/list method with hidden models excluded. For Grok, Baton runs `grok models` and stores exactly the listed picker-visible ids (JSON stdout if Grok emits it; otherwise the Available models listing). For Cursor, Baton runs `cursor-agent models` and stores exactly the listed picker-visible ids (JSON stdout if cursor-agent emits it; otherwise the Available models listing). For Claude Code, Baton issues the SDK control-protocol `list_models` request and stores each row's `resolvedModel` wire id, excluding the deferred `default` alias row and any row marked `disabled`; `claude models` prose is not a catalog. Never invent ids from login or prose lines. Never obtain or augment this list from OpenCodex, a hard-coded catalog, a session-tool prose snapshot, or Artificial Analysis. Never execute work via `grok -p`, `cursor-agent -p`, or `claude -p`.

2. **Configuration is per CLI and user-global.** Store only selected `cli.<id>` profiles in ~/.baton/config.toml; never create placeholders for unselected CLIs. A selected profile owns its enabled flag, runner label, longctx label, and subagent_models allowlist. Store optional max_concurrent/max_depth values only when that CLI's discovery response explicitly reports them; each missing field uses the corresponding director fallback. There is no global default CLI.
   - An explicit `--host codex|grok|cursor|claude` resolves only that host's profile; multiple profiles may be enabled at once. Host resolution also accepts `BATON_HOST` or a unique runtime invoking-host signal; otherwise fail closed with `HOST_REQUIRED`.
   - A missing or disabled requested host fails closed. Baton never substitutes another enabled host.
   - runner and longctx are routing labels only. They do not claim speed, context-window size, or any other capability.
   - Configured runner and longctx values are included in subagent_models.
   - A disabled CLI profile contributes no candidates.

3. **Picker visibility and host execution are separate evidence.** Any model returned by the selected CLI must appear in configuration, including gpt-5.4-mini and gpt-5.3-codex-spark when Codex returns them. Never mark a returned model unsupported merely because a host tool description omitted it. At dispatch, validate that the model and selected reasoning effort are still in the captured CLI catalog. An actual host-native rejection is execution evidence for that exact attempt; record and report it without inventing a replacement inside the ticket.

4. **No human model selector.** After configuration, Baton always chooses from the enabled subagent_models set. --model, --route, baton config model-selection, selector rendering, and model-confirmation flows are not supported. Keep the automatic decision auditable in the proposal, ticket, and Receipt.

5. **Automatic matching.** For each work unit, use the CLI description and supported reasoning efforts, then optional local capability evidence and recent route health. Match:
   - the model to task shape;
   - a supported reasoning effort to task complexity;
   - fast/speed preference from CLI-provided model descriptions or speed/service-tier metadata.
   Missing Artificial Analysis data means unranked evidence, not an unusable model. Never select outside the configured allowlist or invent an effort or speed parameter the CLI did not expose.

6. **Structured mechanical classification.** The director supplies the execution class (`mechanical` or `long-context`) before routing. Baton selects the configured `runner` or `longctx` label from that class; the operation label is retained only as audit metadata and never selects a profile. An empty or unusable configured route fails closed for a classified unit. Mechanical workers are executors: run the director-specified operation and return a short conclusion; do not infer a command from prose, explore, or run extra tools. Commit-only requires an explicit commit capability in the structured classification plus the deterministic Receipt/Git gate; an operation label such as `git-commit` alone is not authority.

   Standalone proposals use one canonical multi-unit shape. A request without
   `--unit` is represented as the `standalone` unit; do not emit or consume a
   separate single-request payload. Classification accepts only the documented
   structured values and fields; compatibility aliases and prose inference are
   not part of the contract.

7. **No parent inheritance or cross-model fallback.** A ticket contains one exact model and optional supported effort. Missing config, a disabled CLI profile, a stale/absent model, or an absent effort blocks dispatch. A failed ticket never silently changes models. A later independently planned unit may be matched again using current health evidence.

## Execution contract

8. **Concrete tickets before native dispatch.** Approved automatic decisions create queued tickets plus immutable Delegation Receipts. Compact dispatch applies to every reserved ticket: runner ops, longctx ops, and ordinary `subagent_models` units. Prefer `baton spawn ... --dispatch --json` so enqueue and reserve are one call; use `baton dispatch next --host HOST --json` only for already-queued work. Then call the native subagent tool: Codex `spawn_agent` (including namespaced collaboration variants that still carry the same unchanged prompt/message envelope), Grok `spawn_subagent`, Cursor `Task`, Claude Code the `Agent` tool. Pass the returned reservation-bearing prompt unchanged on every CLI, and the returned description unchanged whenever the tool exposes it. Claude Code cannot express an exact model on that call (its `model` parameter is an alias enum), so pin the exact id in an agent definition's `model:` frontmatter and select it with `subagent_type`, passing no `model` parameter. Pass the exact model. Pass a supported effort or selected service_tier only when the host tool can express them; otherwise report that option as unavailable instead of silently claiming it. Grok must pass `spawn_subagent.model` (omitting it inherits the parent model). Cursor must pass `Task.model` (omitting it inherits the parent model). Fresh child context is the default when Grok omits `resume_from` and Cursor omits `resume`. Codex may pass `baton dispatch bind --task-name ...`, but the bound ticket identity still comes from the authoritative `SubagentStart` UUID. The Baton CLI itself never claims it can call host tools and never shells out to a coding CLI print mode.

9. **Read-only by default.** Writes require an explicit path/operation allowlist and a parent Git safety audit. Ordinary workers never mutate Git. The only exception is an exclusive commit-only Receipt: the parent stages and freezes the exact tree first, and the worker may perform exactly one git commit. It may not edit, add, amend, switch, branch, merge, rebase, cherry-pick, revert, tag, stash, clean, or push.

10. **Flat, host-bounded concurrency.** Children cannot spawn children. Queue unlimited logical work and respect the host's current physical capacity. AgentLimitReached is backpressure: defer the same reservation without consuming an attempt or switching models.

11. **Activity-driven lifecycle.** Concrete workers return concise conclusions; checkpointed deliberative workers may also return compact phase/result/next-step/blocker state. Persist host probes separately from business progress. Native completion is the activity signal. Probe only while the agent is still running, or to record exact not_found. A wait timeout is polling cadence, not ticket timeout. Finish with complete/fail/timeout/close plus `--release` before refilling capacity. Do not add probe or close round-trips after a native terminal result.

12. **OpenSpec remains optional.** When present, consume its tasks/status and write conclusions back. Do not reimplement its workflow and do not rewrite `tasks.md` structure. Without it, baton spawn remains complete. When the invoking host profile is enabled and the user applies an OpenSpec change (including `/openspec-apply-change`), intercept execution as: plan with `baton apply <change> --host HOST --json`; filter the order-ready frontier in this director session (`--write-path` or `--read-only`); pack by section order, director write-set intersection, and host cap; then one `baton apply <change> --host HOST --dispatch --json --unit ID --write-path PATH --unit ID --write-path PATH` (or `--read-only`). Never call `--dispatch` without per-unit scope. Native-spawn every reserved ticket from that call in the same turn, bind immediately, then refill when a slot frees with the same three predicates. Independent order-ready units with disjoint write sets run in parallel up to host cap; later sections stay serial while an earlier section is pending.

13. **State stays user-global.** Shared cache lives under ~/.baton/cache; workspace runtime lives under ~/.baton/workspaces/<canonical-root-sha256>. Never create project-local Baton state.

## Host runtime protocol

This loop is the same for runner ops, longctx ops, and ordinary `subagent_models` tickets.

1. Run `baton config --cli HOST` once or whenever that host's picker surface changes.
2. Create tickets with `baton spawn ... --dispatch --json` or one scoped `baton apply ... --dispatch --unit ID --write-path PATH --unit ID --write-path PATH`. Plan apply first; the director filters the order-ready frontier and packs by section order, write-set intersection, and host cap. Use `baton dispatch next --host HOST --json` only for already-queued work.
3. For each reserved ticket, native-spawn with the returned model and unchanged prompt, the unchanged returned description when supported, optional effort, and optional service_tier when the host exposes them, fork_context=false. Do not strip, move, or recreate the first-line reservation envelope. Mechanical prompts are one-shot: execute the director-supplied operation (for an explicitly capability-authorized commit-only ticket: staged diff → one message → one commit). Grok hosts call `spawn_subagent` with the ticket model; never `grok -p` or a new grok process with `-m`/`--effort`. Cursor hosts call `Task` with the ticket model; never `cursor-agent -p`/`--print` or a new cursor-agent process with `--model`. Claude Code hosts call the `Agent` tool with a `subagent_type` whose definition pins the ticket's exact model; never `claude -p` or `claude --model`. Bind immediately with `baton dispatch bind TICKET --agent-id ID --host HOST --json`.
4. Wait on native completion for the requested host. Probe only while still running, or to record exact `not_found`.
5. `baton dispatch complete TICKET --host HOST --text "..." --release --json` (or fail/timeout/close with `--host HOST --release`). Refill from that host's FIFO.

## Commands

    baton guard status|install|hook [--json]
    baton config --cli codex|grok|cursor|claude [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates [--host codex|grok|cursor|claude]
    baton cards [--ranked|--unranked] [--json]
    baton match <text> [--host codex|grok|cursor|claude]
    baton spawn <request> [--host codex|grok|cursor|claude] [--unit KEY=BUSINESS_TASK ...]
                 [--classification CLASS] [--operation LABEL]
                 [--unit-classification KEY=CLASS ...] [--unit-operation KEY=LABEL ...] [--dispatch]
    baton spawn REQUEST --host HOST --classification implementation
                 --write-path PATH --write-ops write,create,delete,rename,chmod
    baton apply [change] [--host codex|grok|cursor|claude]
    baton apply [change] [--host HOST] --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
    baton dispatch next --host HOST --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host HOST --json
    baton dispatch defer TICKET --host HOST --code AGENT_LIMIT_REACHED --observed-capacity N --json
    baton dispatch probe TICKET --host HOST --agent-id ID --state pending_init|running|interrupted|shutdown|not_found --json
    baton dispatch progress TICKET --host HOST --phase PHASE --text "short status" --json
    baton dispatch complete TICKET --host HOST --text "short conclusion" [--release] --json
    baton dispatch fail|timeout|close TICKET --host HOST [--release] --json
    baton dispatch release TICKET --host HOST --agent-id ID --json
    baton dispatch recover --host HOST --json
    baton dispatch status --host HOST --json
    baton status [--host codex|grok|cursor|claude]

## Red lines

- Do not consult OpenCodex for model discovery, auth, quota, or execution.
- Do not add hard-coded model-family bans or infer unsupported status from a host tool's documentation.
- Do not show a runtime model selector or ask the user to confirm Baton's automatic model choice.
- Do not use a model outside the enabled CLI allowlist, invent an effort/speed flag, inherit the parent model, or silently fall back.
- Do not dispatch without an immutable Receipt, bypass write/Git safety, treat polling timeouts as worker failure, or refill before release.
- Do not `git commit` in the director session for a classified unit. Commit-only requires an explicit commit capability and the staged Receipt/Git gate; an operation label alone is not authority. A classified mechanical unit with an empty or unusable route fails closed.
- Do not reimplement OpenSpec or dump worker tool output into the front conversation.
