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

- Before any `Bash`, `apply_patch`/ `Edit`/ `Write`, or native `Agent` call, run `baton guard status --host HOST` on a guard-capable host. Baton init/update installs only the host-supported scoped mutation guards while preserving unrelated hook configuration. Codex enforce uses a scoped `PreToolUse`; Codex off has zero Baton hooks and is audit-only. Grok and Claude Code user-global hooks apply without a separate trust prompt and should still be reviewed with `/hooks`. Cursor has no equivalent guard surface and must not claim interception.
- Ticket presence is the declared-work signal: with no reserved ticket for this host, director mutating tools are allowed (undeclared / empty-label work). While this host has a reserved, dispatching, or running worker ticket, director implementation writes are denied. The guard serves only its own host's tickets: a Codex guard never satisfies itself with a Claude ticket, and the reverse. Reserve a Baton ticket, native-spawn the exact worker, and bind the returned identity with `baton dispatch bind ...` before the worker uses tools. A child starting during the spawn-to-bind race remains denied until the bind is visible.
- Only guard claim/status/hook, dispatch lifecycle/status, `spawn`/`apply` with `--dispatch`, and read-only status/match/models/cards are direct-command exemptions. `init`, `update`, `config`, `uninstall`, and activation mutations remain guarded control-plane operations; do not hide them behind a shell wrapper or chained command.
- Every native spawn for a reserved ticket MUST pass the returned `prompt` unchanged and, when supported, the returned `description` unchanged. The reservation envelope is dispatch audit data. Codex has no lifecycle hook or Agent matcher: enforce performs only a synchronous mutation deny/claim check, while off installs zero Baton hooks and is audit-only. Codex native `task_name` is the execution handle for attach/liveness/release; `agent_id` is only an optional host diagnostic on hosts that expose it. Hooks never replace immutable Receipts, worker path allowlists, and the parent Git safety audit.

### Activation and cleanup

Use `baton disable all|curproject --host HOST` and the matching `enable` commands
to control only the invoking CLI host. `all` is user-global; `curproject` is
workspace/host scoped. In `guard_mode=enforce`, valid disabled activation bypasses
Baton only for an idle current canonical workspace: the hook abstains with empty
successful output, without a permission decision or model-visible policy, so Codex
and unrelated hooks continue normally. Current `reserved`, `dispatching`, or
`running` tickets make that workspace `draining` and retain claim/write/Git/director
boundaries until terminal release; queued-only tickets do not block bypass. Invalid
activation or unreadable lifecycle state is `invalid` and fails closed.
`guard_mode=off` remains configured zero-hook, audit-only behavior, not dynamic
bypass. Only the trusted director may use the exact standalone
`baton enable|disable all|curproject --host HOST` command; worker calls, wrappers,
substitutions, and shell composition are rejected. OpenSpec apply
is intercepted by Baton to create tickets and dispatch native subagents. Hooks
only provide an optional scoped mutation guard and audit observation; they do not
classify or dispatch tasks.

`baton uninstall --dry-run` reports only the selected host's integration files;
state is preserved. `baton uninstall --clean --dry-run` additionally lists the
complete Baton footprint and active-ticket constraints. `--clean --yes` removes
the complete Baton footprint only after active reserved/dispatching/running
tickets are drained; it does not cancel work and retains the package executable.

## Native identity adapters

Native child APIs do not share one identity field. Baton uses each host's native execution handle for attach, liveness, and release; Codex `task_name` is the execution handle, not a `SubagentStart` prerequisite. Do not infer identity from a ticket prefix or use a unique-ticket fallback.

## Model and configuration contract

1. **The selected CLI owns visibility.** baton config first selects a CLI. For Codex, Baton calls the public app-server model/list method with hidden models excluded. For Grok, Baton runs `grok models` and stores exactly the listed picker-visible ids (JSON stdout if Grok emits it; otherwise the Available models listing). For Cursor, Baton runs `cursor-agent models` and stores exactly the listed picker-visible ids (JSON stdout if cursor-agent emits it; otherwise the Available models listing). For Claude Code, Baton issues the SDK control-protocol `list_models` request and stores each row's `resolvedModel` wire id, excluding the deferred `default` alias row and any row marked `disabled`; `claude models` prose is not a catalog. Never invent ids from login or prose lines. Never obtain or augment this list from OpenCodex, a hard-coded catalog, a session-tool prose snapshot, or Artificial Analysis. Never execute work via `grok -p`, `cursor-agent -p`, or `claude -p`.

2. **Configuration is per CLI and user-global.** Store only selected `cli.<id>` profiles in ~/.baton/config.toml; never create placeholders for unselected CLIs. A selected profile owns its enabled flag, runner label, longctx label, and ordered `coding_models` allowlist. Store optional max_concurrent/max_depth values only when that CLI's discovery response explicitly reports them; each missing field uses the corresponding director fallback. There is no global default CLI.
   - An explicit `--host codex|grok|cursor|claude` resolves only that host's profile; multiple profiles may be enabled at once. Host resolution also accepts `BATON_HOST` or a unique runtime invoking-host signal; otherwise fail closed with `HOST_REQUIRED`.
   - A missing or disabled requested host fails closed. Baton never substitutes another enabled host.
   - runner and longctx are routing labels only. They do not claim speed, context-window size, or any other capability.
   - Configured runner and longctx values are independent labels and are never inserted into `coding_models`.
   - A disabled CLI profile contributes no candidates.

3. **Picker visibility and host execution are separate evidence.** Any model returned by the selected CLI must appear in configuration, including gpt-5.4-mini and gpt-5.3-codex-spark when Codex returns them. Never mark a returned model unsupported merely because a host tool description omitted it. At dispatch, validate that the model and selected reasoning effort are still in the captured CLI catalog. An actual host-native rejection is execution evidence for that exact attempt; record and report it without inventing a replacement inside the ticket.

4. **No human model selector.** After configuration, Baton always chooses from the ordered `coding_models` set. --model, --route, baton config model-selection, selector rendering, and model-confirmation flows are not supported. Keep the automatic decision auditable in the proposal, ticket, and Receipt.

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

7. **Immutable ticket routing.** A ticket contains one exact model and optional supported effort. Missing config, a disabled CLI profile, a stale/absent model, or an absent effort blocks that ticket; it is never changed in place, across hosts, or silently switched to another model. After explicit quota evidence and a clean pre-mutation baseline, dispatch may create an auditable immutable successor using the next configured Coding priority and rerun all hard gates. If mutation has begun, successor creation requires reconciliation rather than an automatic retry.

## Execution contract

8. **Concrete tickets before native dispatch.** Approved automatic decisions create queued tickets plus immutable Delegation Receipts. Compact dispatch applies to every reserved ticket: runner ops, longctx ops, and ordinary `coding_models` units. Prefer `baton spawn ... --dispatch --json` so enqueue and reserve are one call; use `baton dispatch next --host HOST --json` only for already-queued work. Then call the native subagent tool: Codex `spawn_agent`, Grok `spawn_subagent`, Cursor `Task`, Claude Code the `Agent` tool. Pass the returned reservation-bearing prompt unchanged on every CLI, and the returned description unchanged whenever the tool exposes it. Pass the exact model and only host-supported effort/service-tier values; Claude Code pins the exact id in an agent definition's `model:` frontmatter. Codex's native `task_name` is the execution handle used for attach/liveness/release; no `SubagentStart` identity chain is required. The Baton CLI itself never claims it can call host tools and never shells out to a coding CLI print mode.

9. **Read-only by default.** Writes require an explicit path/operation allowlist and a parent Git safety audit. Ordinary workers never mutate Git. The only exception is an exclusive commit-only Receipt: the parent stages and freezes the exact tree first, and the worker may perform exactly one git commit. It may not edit, add, amend, switch, branch, merge, rebase, cherry-pick, revert, tag, stash, clean, or push.

10. **Flat, host-bounded concurrency.** Children cannot spawn children. Queue unlimited logical work and respect the host's current physical capacity. AgentLimitReached is backpressure: defer the same reservation without consuming an attempt or switching models.

11. **Activity-driven lifecycle.** Concrete workers return concise conclusions; checkpointed deliberative workers may also return compact phase/result/next-step/blocker state. Persist host probes separately from business progress. Native completion is the activity signal. Probe only while the agent is still running, or to record exact not_found. A wait timeout is polling cadence, not ticket timeout. Finish with complete/fail/timeout/close plus `--release` before refilling capacity. Do not add probe or close round-trips after a native terminal result.

12. **OpenSpec remains optional.** When present, consume its tasks/status and write conclusions back. Do not reimplement its workflow and do not rewrite `tasks.md` structure. Without it, baton spawn remains complete. When the invoking host profile is enabled and the user applies an OpenSpec change (including `/openspec-apply-change`), intercept execution as: plan with `baton apply <change> --host HOST --json`; filter the order-ready frontier in this director session (`--write-path` or `--read-only`); pack by section order, director write-set intersection, and host cap; then one `baton apply <change> --host HOST --dispatch --json --unit ID --write-path PATH --unit ID --write-path PATH` (or `--read-only`). Never call `--dispatch` without per-unit scope. Native-spawn every reserved ticket from that call in the same turn, bind immediately, then refill when a slot frees with the same three predicates. Independent order-ready units with disjoint write sets run in parallel up to host cap; later sections stay serial while an earlier section is pending.

13. **State stays user-global.** Shared cache lives under ~/.baton/cache, including
host-keyed `cli-models-<host>.json` snapshots and model-availability state;
workspace runtime lives under ~/.baton/workspaces/<canonical-root-sha256>. Never
create project-local Baton state.

## Host runtime protocol

This loop is the same for runner ops, longctx ops, and ordinary `coding_models` tickets.

1. Run `baton config --cli HOST` once or whenever that host's picker surface changes.
2. Create tickets with `baton spawn ... --dispatch --json` or one scoped `baton apply ... --dispatch --unit ID --write-path PATH --unit ID --write-path PATH`. Plan apply first; the director filters the order-ready frontier and packs by section order, write-set intersection, and host cap. Use `baton dispatch next --host HOST --json` only for already-queued work.
3. For each reserved ticket, native-spawn with the returned model and unchanged prompt, the unchanged returned description when supported, optional effort, and optional service_tier when the host exposes them, fork_context=false. Do not strip, move, or recreate the first-line reservation envelope. Mechanical prompts are one-shot: execute the director-supplied operation (for an explicitly capability-authorized commit-only ticket: staged diff → one message → one commit). Codex binds `--task-name`; Grok, Cursor, and Claude bind their native `--agent-id`. Bind immediately with the host-specific form.
4. Wait on native completion for the requested host. Probe only while still running, or to record exact `not_found`.
5. `baton dispatch complete TICKET --host HOST --text "..." --release --json` (or fail/timeout/close with `--host HOST --release`). Refill from that host's FIFO.

## Commands

    baton guard status|install|hook [--json]
    baton config --cli codex|grok|cursor|claude [--runner MODEL|-] [--longctx MODEL|-]
                 [--coding-model MODEL|all] [--guard-mode enforce|off] [--enable|--disable]
    baton enable|disable all|curproject --host HOST [--json]
    baton models refresh|status|candidates [--host codex|grok|cursor|claude]
    baton models reset ROUTE --host codex|grok|cursor|claude [--json]
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
    baton dispatch bind TICKET --task-name CODEX_TASK_NAME --host codex --json
    baton dispatch bind TICKET --agent-id ID --host HOST --json                 # other hosts
    baton dispatch defer TICKET --host HOST --code AGENT_LIMIT_REACHED --observed-capacity N --json
    baton dispatch probe TICKET --host HOST --agent-id ID --state pending_init|running|interrupted|shutdown|not_found --json
    baton dispatch progress TICKET --host HOST --phase PHASE --text "short status" --json
    baton dispatch complete TICKET --host HOST --text "short conclusion" [--release] --json
    baton dispatch fail|timeout|close TICKET --host HOST [--release] --json
    baton dispatch release TICKET --host HOST --agent-id ID --json
    baton dispatch recover --host HOST --json
    baton dispatch status --host HOST --json
    baton status [--host codex|grok|cursor|claude] [--json]
    baton uninstall [--host HOST] [--dry-run]
    baton uninstall --clean --yes

## Red lines

- Do not consult OpenCodex for model discovery, auth, quota, or execution.
- Do not add hard-coded model-family bans or infer unsupported status from a host tool's documentation.
- Do not show a runtime model selector or ask the user to confirm Baton's automatic model choice.
- Do not use a model outside the enabled CLI allowlist, invent an effort/speed flag, inherit the parent model, or silently fall back.
- Do not dispatch without an immutable Receipt, bypass write/Git safety, treat polling timeouts as worker failure, or refill before release.
- Do not `git commit` in the director session for a classified unit. Commit-only requires an explicit commit capability and the staged Receipt/Git gate; an operation label alone is not authority. A classified mechanical unit with an empty or unusable route fails closed.
- Do not reimplement OpenSpec or dump worker tool output into the front conversation.
