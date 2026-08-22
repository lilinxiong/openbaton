# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

A director for multi-model work: one front conversation, automatic model and effort routing, native subagents, and a clean main context.

Baton works standalone and can consume OpenSpec tasks when OpenSpec is present.

    bun add -g baton
    baton init
    baton config

From a source checkout: bun install && bun run baton -- COMMAND. Requires Node.js 22.5+ or Bun 1.3.14+.

Chinese: [README.zh.md](README.zh.md)

## What changed

Baton is no longer coupled to OpenCodex. A CLI adapter owns model discovery. The current adapter is Codex:

1. baton config asks which CLI to configure.
2. For Codex, Baton starts codex app-server and calls model/list with hidden models excluded.
3. Baton displays exactly the picker-visible models returned by Codex.
4. The user assigns optional runner and longctx labels, chooses the models subagents may call, and enables or disables that CLI profile.
5. Later work is routed automatically within that configured candidate set. There is no runtime model selector or model confirmation.

Baton does not query OpenCodex, merge in a hard-coded catalog, or treat a model as unsupported because a host tool description did not list it.

## Configuration

The user-global ~/.baton/config.toml has one profile per CLI:

    [director]
    max_concurrent = 4
    max_depth = 1

    [cli]
    active = "codex"

    [cli.codex]
    enabled = true
    runner = "gpt-5.4-mini"
    longctx = "gpt-5.5"
    subagent_models = [
      "gpt-5.6-luna",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]

    [ops.runner]
    actions = ["test", "build", "lint", "typecheck"]

    [ops.longctx]
    actions = ["search", "digest", "git-summarize", "git-commit"]

runner and longctx are labels only. They do not claim that a model is fast, has a particular context window, or supports any other capability. Both labels use the same Codex-returned model surface.

Configured label values are automatically included in subagent_models. A disabled profile contributes no candidates.

Non-interactive setup is also supported:

    baton config \
      --cli codex \
      --runner gpt-5.4-mini \
      --longctx gpt-5.5 \
      --subagent-model gpt-5.6-luna \
      --subagent-model gpt-5.4-mini \
      --subagent-model gpt-5.3-codex-spark \
      --enable

Run baton models refresh when the selected CLI's picker surface changes.

## Mini and Spark

If Codex returns gpt-5.4-mini or gpt-5.3-codex-spark from model/list, Baton displays them and lets the user put them in subagent_models.

Catalog visibility and actual host execution are distinct evidence:

- picker-visible means the model is configurable;
- the configured allowlist means Baton may select it;
- dispatch revalidates the model and reasoning effort against the captured CLI catalog;
- only an actual host-native rejection is execution-failure evidence.

Baton has no hard-coded family bans. It does not label Mini or Spark unsupported merely because a particular tool schema or help string omitted them.

## Automatic routing

baton spawn and baton apply never ask the user to pick a model. Baton automatically chooses:

- a configured model based on the work-unit text and CLI model description;
- one of the reasoning efforts that the CLI returned, fitted to task complexity;
- a fast model or exact service tier when the task asks for speed and the CLI description or speed/service-tier metadata supports that preference;
- optional local capability and recent route-health evidence as refinements.

Artificial Analysis data is optional. Missing benchmark data leaves the evidence unranked; it does not make a Codex-returned, configured model unusable.

Explicit --model, --route, baton config model-selection, selector rendering, and user model approval are removed. The automatic decision is still persisted in the proposal, ticket, and Delegation Receipt for auditability.

Baton never inherits the parent model, chooses outside the enabled allowlist, invents a reasoning effort or speed flag, or silently switches a failed ticket to another model.

## Execution lifecycle

The Baton CLI creates tickets and lifecycle state; only the Codex host calls native subagent tools.

1. baton spawn or baton apply creates automatically routed tickets and immutable Receipts.
2. The host reserves work with baton dispatch next.
3. The host calls native spawn_agent with the exact model, supported reasoning effort and selected service tier when present and exposed by the host, and fork_context=false. A host that cannot express a selected tier reports it instead of silently claiming Fast mode.
4. The host binds the returned agent id, persists activity and progress, and records exactly one terminal result.
5. The host closes the native agent and runs dispatch release before refilling FIFO.

Logical work is uncapped; physical concurrency follows the current host limit. AgentLimitReached defers the same ticket without consuming an attempt or changing its model. Polling timeouts are not worker failures; a ticket can time out only after the exact agent is probed as not_found.

Read-only is the default. Write tickets require an immutable path and operation allowlist plus parent Git safety checks. The sole Git exception is an exclusive commit-only ticket over an exact parent-staged tree; it may create one audited commit and may not stage, amend, branch, rebase, tag, or push.

## OpenSpec and state

OpenSpec remains optional. When present, it owns task breakdown and status; Baton routes ready tasks and writes conclusions back by stable task number. Without OpenSpec, baton spawn is complete.

Baton never creates project-local runtime state:

- ~/.baton/config.toml — director and per-CLI profiles
- ~/.baton/cache/cli-models.json — selected CLI catalog snapshot
- ~/.baton/cache/capabilities/ — optional local capability evidence
- ~/.baton/workspaces/CANONICAL-ROOT-SHA256/ — tickets, Receipts, selections, locks, and lifecycle state

## Commands

    baton init [--force]
    baton update
    baton config [--cli codex] [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates
    baton cards [--ranked|--unranked] [--json]
    baton match "fix the flaky auth tests quickly"
    baton spawn "implement the migration" [--unit KEY=TEXT ...]
    baton apply [change]
    baton dispatch next --host codex --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host codex --json
    baton dispatch defer TICKET --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
    baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found --json
    baton dispatch progress TICKET --phase PHASE --text "short status" --json
    baton dispatch complete TICKET --text "short conclusion" --json
    baton dispatch fail|timeout|close TICKET --json
    baton dispatch release TICKET --agent-id ID --json
    baton dispatch recover|status --json
    baton status

## License

MIT
