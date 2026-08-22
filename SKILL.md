---
name: baton
description: "Use this director automatically for approved Goal or multi-model execution and configured mechanical ops including build, test, lint, typecheck, search, digest, git-summarize, or commit-only staged work. Skip ordinary discussion and tasks needing neither delegation nor ops routing."
---

# baton

You are the director. Baton is a CLI-neutral scheduling and policy layer. Its adapters are Codex and Grok; it does not use OpenCodex for model discovery, authentication, or execution.

## Entry routing

- Ordinary discussion, diagnosis, and work that needs neither delegation nor a configured mechanical route stays on the director.
- For approved multi-agent execution, run Baton to create immutable tickets, dispatch them through the current host's native subagent tool, and wait for their conclusions.
- If another execution skill is explicitly requested, preserve its scope. Baton may route its executable work units but must not rewrite the request.

## Model and configuration contract

1. **The selected CLI owns visibility.** baton config first selects a CLI. For Codex, Baton calls the public app-server model/list method with hidden models excluded. For Grok, Baton runs `grok models` and stores exactly the listed picker-visible ids (JSON stdout if Grok emits it; otherwise the Available models listing). Never invent ids from login or prose lines. Never obtain or augment this list from OpenCodex, a hard-coded catalog, a session-tool prose snapshot, or Artificial Analysis. Never execute work via `grok -p`.

2. **Configuration is per CLI and user-global.** Store the active CLI, enabled flag, runner label, longctx label, and subagent_models allowlist in ~/.baton/config.toml under [cli] and [cli.<id>].
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

6. **Mechanical labels.** runner routes test/build/lint/typecheck/git-commit units. longctx routes search/digest/git-summarize units. They are user labels, so both use the same configured candidate surface and neither is filtered by a context threshold. An empty label keeps that action on the director and must not block the flow. A non-empty label is Baton dispatch: the director does not execute that action itself. Mechanical workers are executors: run the inferred command and return a short conclusion; do not explore, plan, or run extra tools. `git-commit` may read the staged diff, write one message, and perform exactly one git commit. `git-summarize` dumps `git status`/`log`/`diff` only and must not write a message or commit. For `git-commit` with a non-empty runner model, the director may stage only, then compact-dispatch the reserved ticket. If both labels are empty, the director may `git commit` itself.

7. **No parent inheritance or cross-model fallback.** A ticket contains one exact model and optional supported effort. Missing config, a disabled CLI profile, a stale/absent model, or an absent effort blocks dispatch. A failed ticket never silently changes models. A later independently planned unit may be matched again using current health evidence.

## Execution contract

8. **Concrete tickets before native dispatch.** Approved automatic decisions create queued tickets plus immutable Delegation Receipts. Compact dispatch applies to every reserved ticket: runner ops, longctx ops, and ordinary `subagent_models` units. Prefer `baton spawn ... --dispatch --json` so enqueue and reserve are one call; use `baton dispatch next --host HOST --json` only for already-queued work. Then call the native subagent tool: Codex `spawn_agent`, Grok `spawn_subagent`. Pass the exact model. Pass a supported effort or selected service_tier only when the host tool can express them; otherwise report that option as unavailable instead of silently claiming it. Grok must pass `spawn_subagent.model` (omitting it inherits the parent model). fork_context=false: Grok does not pass `resume_from`. Bind the returned agent id immediately. The Baton CLI itself never claims it can call host tools and never shells out to a coding CLI print mode.

9. **Read-only by default.** Writes require an explicit path/operation allowlist and a parent Git safety audit. Ordinary workers never mutate Git. The only exception is an exclusive commit-only Receipt: the parent stages and freezes the exact tree first, and the worker may perform exactly one git commit. It may not edit, add, amend, switch, branch, merge, rebase, cherry-pick, revert, tag, stash, clean, or push.

10. **Flat, host-bounded concurrency.** Children cannot spawn children. Queue unlimited logical work and respect the host's current physical capacity. AgentLimitReached is backpressure: defer the same reservation without consuming an attempt or switching models.

11. **Activity-driven lifecycle.** Concrete workers return concise conclusions; checkpointed deliberative workers may also return compact phase/result/next-step/blocker state. Persist host probes separately from business progress. Native completion is the activity signal. Probe only while the agent is still running, or to record exact not_found. A wait timeout is polling cadence, not ticket timeout. Finish with complete/fail/timeout/close plus `--release` before refilling capacity. Do not add probe or close round-trips after a native terminal result.

12. **OpenSpec remains optional.** When present, consume its tasks/status and write conclusions back. Do not reimplement its workflow. Without it, baton spawn remains complete.

13. **State stays user-global.** Shared cache lives under ~/.baton/cache; workspace runtime lives under ~/.baton/workspaces/<canonical-root-sha256>. Never create project-local Baton state.

## Host runtime protocol

This loop is the same for runner ops, longctx ops, and ordinary `subagent_models` tickets.

1. Run baton config once or whenever the selected CLI picker surface changes.
2. Create tickets with `baton spawn ... --dispatch --json` or `baton apply`. `--dispatch` enqueues and reserves in one call. Use `baton dispatch next --host HOST --json` only for already-queued work.
3. For each reserved ticket, native-spawn with the returned model, prompt, optional effort, and optional service_tier when the host exposes them, fork_context=false. Mechanical prompts are one-shot: execute the inferred command (for `git-commit`: staged diff → one message → one commit). Grok hosts call `spawn_subagent` with the ticket model; never `grok -p` or a new grok process with `-m`/`--effort`. Bind immediately with `baton dispatch bind TICKET --agent-id ID --host HOST --json`.
4. Wait on native completion. Probe only while still running, or to record exact `not_found`.
5. `baton dispatch complete TICKET --text "..." --release --json` (or fail/timeout/close with `--release`). Refill from FIFO.

## Commands

    baton config [--cli codex|grok] [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates
    baton cards [--ranked|--unranked] [--json]
    baton match <text>
    baton spawn <request> [--unit KEY=BUSINESS_TASK ...] [--dispatch]
    baton apply [change]
    baton dispatch next --host HOST --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host HOST --json
    baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
    baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found --json
    baton dispatch progress TICKET --phase PHASE --text "short status" --json
    baton dispatch complete TICKET --text "short conclusion" [--release] --json
    baton dispatch fail|timeout|close TICKET [--release] --json
    baton dispatch release TICKET --agent-id ID --json
    baton dispatch recover|status --json
    baton status

## Red lines

- Do not consult OpenCodex for model discovery, auth, quota, or execution.
- Do not add hard-coded model-family bans or infer unsupported status from a host tool's documentation.
- Do not show a runtime model selector or ask the user to confirm Baton's automatic model choice.
- Do not use a model outside the enabled CLI allowlist, invent an effort/speed flag, inherit the parent model, or silently fall back.
- Do not dispatch without an immutable Receipt, bypass write/Git safety, treat polling timeouts as worker failure, or refill before release.
- Do not `git commit` in the director session while the matching runner/longctx label is set. If both labels are empty, execute mechanical ops on the director and do not block. When the label is set, stage, then `baton spawn --dispatch` and native host spawn.
- Do not reimplement OpenSpec or dump worker tool output into the front conversation.
