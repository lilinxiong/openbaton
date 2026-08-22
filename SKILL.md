---
name: baton
description: "Use this Codex director automatically for approved Goal or multi-model execution and configured mechanical ops including build, test, lint, typecheck, search, digest, git-summarize, or commit-only staged work. Skip ordinary discussion and tasks needing neither delegation nor ops routing."
---

# baton

You are the director. Baton is a CLI-neutral scheduling and policy layer. Its current adapter is Codex; it does not use OpenCodex for model discovery, authentication, or execution.

## Entry routing

- Ordinary discussion, diagnosis, and work that needs neither delegation nor a configured mechanical route stays on the director.
- For approved multi-agent execution, run Baton to create immutable tickets, dispatch them through the current host's native subagent tool, and wait for their conclusions.
- If another execution skill is explicitly requested, preserve its scope. Baton may route its executable work units but must not rewrite the request.

## Model and configuration contract

1. **The selected CLI owns visibility.** baton config first selects a CLI. For Codex, Baton calls the public app-server model/list method with hidden models excluded and stores exactly the picker-visible response. Never obtain or augment this list from OpenCodex, a hard-coded catalog, a session-tool prose snapshot, or Artificial Analysis.

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

6. **Mechanical labels.** runner routes test/build/lint/typecheck units. longctx routes search/digest/git-summarize/commit-only units. They are user labels, so both use the same configured candidate surface and neither is filtered by a context threshold. An empty label keeps that action on the director.

7. **No parent inheritance or cross-model fallback.** A ticket contains one exact model and optional supported effort. Missing config, a disabled CLI profile, a stale/absent model, or an absent effort blocks dispatch. A failed ticket never silently changes models. A later independently planned unit may be matched again using current health evidence.

## Execution contract

8. **Concrete tickets before native dispatch.** Approved automatic decisions create queued tickets plus immutable Delegation Receipts. The host reserves with baton dispatch next, calls its native spawn_agent with the exact model, supported effort when present, selected service_tier when non-null and exposed by the host, and fork_context=false, then binds the returned agent id. If the host cannot express a selected tier, report that execution option as unavailable instead of silently claiming Fast mode. The Baton CLI itself never claims it can call host tools and never shells out to a coding CLI print mode.

9. **Read-only by default.** Writes require an explicit path/operation allowlist and a parent Git safety audit. Ordinary workers never mutate Git. The only exception is an exclusive commit-only Receipt: the parent stages and freezes the exact tree first, and the worker may perform exactly one git commit. It may not edit, add, amend, switch, branch, merge, rebase, cherry-pick, revert, tag, stash, clean, or push.

10. **Flat, host-bounded concurrency.** Children cannot spawn children. Queue unlimited logical work and respect the host's current physical capacity. AgentLimitReached is backpressure: defer the same reservation without consuming an attempt or switching models.

11. **Activity-driven lifecycle.** Concrete workers return concise conclusions; checkpointed deliberative workers may also return compact phase/result/next-step/blocker state. Persist host probes separately from business progress. A wait timeout is polling cadence, not ticket timeout. Only an exact not_found probe can authorize a timeout. Close and release terminal agents before refilling capacity.

12. **OpenSpec remains optional.** When present, consume its tasks/status and write conclusions back. Do not reimplement its workflow. Without it, baton spawn remains complete.

13. **State stays user-global.** Shared cache lives under ~/.baton/cache; workspace runtime lives under ~/.baton/workspaces/<canonical-root-sha256>. Never create project-local Baton state.

## Codex runtime protocol

1. Run baton config once or whenever the Codex picker surface changes.
2. Plan with baton spawn or baton apply; Baton automatically records the chosen configured model and effort.
3. Reserve with baton dispatch next --host codex --capacity N --json.
4. Spawn every reservation through the native host tool using the returned exact model, optional effort, optional service_tier when the host exposes it, fork_context=false, and the self-contained prompt.
5. Bind with baton dispatch bind TICKET --agent-id ID --host codex --json.
6. Probe and wait until terminal; record success or failure through dispatch complete, fail, timeout, or close.
7. Close the native agent, then run baton dispatch release; refill from FIFO.

## Commands

    baton config [--cli codex] [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates
    baton cards [--ranked|--unranked] [--json]
    baton match <text>
    baton spawn <request> [--unit KEY=BUSINESS_TASK ...]
    baton apply [change]
    baton dispatch next --host codex --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host codex --json
    baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
    baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found --json
    baton dispatch progress TICKET --phase PHASE --text "short status" --json
    baton dispatch complete TICKET --text "short conclusion" --json
    baton dispatch fail|timeout|close TICKET --json
    baton dispatch release TICKET --agent-id ID --json
    baton dispatch recover|status --json
    baton status

## Red lines

- Do not consult OpenCodex for model discovery, auth, quota, or execution.
- Do not add hard-coded model-family bans or infer unsupported status from a host tool's documentation.
- Do not show a runtime model selector or ask the user to confirm Baton's automatic model choice.
- Do not use a model outside the enabled CLI allowlist, invent an effort/speed flag, inherit the parent model, or silently fall back.
- Do not dispatch without an immutable Receipt, bypass write/Git safety, treat polling timeouts as worker failure, or refill before release.
- Do not reimplement OpenSpec or dump worker tool output into the front conversation.
