# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

A director for multi-model work: one front conversation, automatic model and effort routing, native subagents, and a clean main context.

Baton works standalone and can consume OpenSpec tasks when OpenSpec is present.

    npm install -g @zhouliuya/openbaton
    baton init
    baton config

Requires Node.js 22.5+. From a source checkout: bun install && bun run baton -- COMMAND.

Chinese: [README.zh.md](README.zh.md)

## What changed

Baton is no longer coupled to OpenCodex. A CLI adapter owns model discovery. Adapters are Codex and Grok:

1. baton config asks which CLI to configure.
2. For Codex, Baton starts codex app-server and calls model/list with hidden models excluded. For Grok, Baton runs `grok models` and keeps only listed ids (JSON stdout if Grok emits it; otherwise the Available models listing, ignoring login/prose lines).
3. Baton displays exactly the picker-visible models returned by that CLI.
4. The user assigns optional runner and longctx labels, chooses the models subagents may call, and enables or disables that CLI profile.
5. Later work is routed automatically within that configured candidate set. There is no runtime model selector or model confirmation.

Baton never executes work via `grok -p`. Dispatch host ids are `codex` and `grok`.

Baton does not query OpenCodex, merge in a hard-coded catalog, or treat a model as unsupported because a host tool description did not list it.

## Configuration

The user-global ~/.baton/config.toml has one profile per CLI:

    [director]
    max_concurrent = 4
    max_depth = 1

Selecting Grok (`baton init --cli grok` or `baton config --cli grok`) writes Grok's host cap of 8 into max_concurrent, or GROK_MAX_CONCURRENT_SUBAGENTS when set.

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

    [cli.grok]
    enabled = false
    runner = ""
    longctx = ""
    subagent_models = []

    [ops.runner]
    actions = ["test", "build", "lint", "typecheck"]

    [ops.longctx]
    actions = ["search", "digest", "git-summarize", "git-commit"]

runner and longctx are labels only. They do not claim that a model is fast, has a particular context window, or supports any other capability. Both labels use the same CLI-returned model surface.

Configured label values are automatically included in subagent_models. A disabled profile contributes no candidates.

Non-interactive setup is also supported:

    baton config \
      --cli codex|grok \
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

The Baton CLI creates tickets and lifecycle state; only the selected host (Codex or Grok) calls native subagent tools.

1. baton spawn or baton apply creates automatically routed tickets and immutable Receipts.
2. The host reserves work with baton dispatch next.
3. The host calls its native subagent tool (Codex `spawn_agent`, Grok `spawn_subagent`) with the exact model, plus supported reasoning effort and selected service tier only when the host tool can express them, and fork_context=false. A host that cannot express a selected option reports it instead of silently claiming it. Grok must pass `spawn_subagent.model`; omitting it inherits the parent model.
4. The host binds the returned agent id, persists activity and progress, and records exactly one terminal result.
5. The host closes the native agent and runs dispatch release before refilling FIFO.

Logical work is uncapped; physical concurrency follows the current host limit. AgentLimitReached defers the same ticket without consuming an attempt or changing its model. Polling timeouts are not worker failures; a ticket can time out only after the exact agent is probed as not_found.

Read-only is the default. Write tickets require an immutable path and operation allowlist plus parent Git safety checks. The sole Git exception is an exclusive commit-only ticket over an exact parent-staged tree; it may create one audited commit and may not stage, amend, branch, rebase, tag, or push.

## Mechanical ops

`ops.runner` and `ops.longctx` label which mechanical actions leave the director (`test`, `build`, `lint`, `typecheck`, `search`, `digest`, `git-summarize`, `git-commit`). Empty labels keep those units on the director.

The compare script runs each unit twice: through Baton tickets (spawn, bind, the same local command, complete/release), then as that command directly. It does not call host spawn tools. Live mode never git-commits; `--fixture` commits only inside a temp repo.

    bun scripts/compare-mechanical-ops.ts
    bun scripts/compare-mechanical-ops.ts --fixture
    bun scripts/compare-mechanical-ops.ts --json

Live run on this checkout, 2026-08-22. `cli=grok` `host=grok` `runner=grok-4.5` `longctx=grok-4.5` `spawn_cli_ms=202.5` `ok=true`.

| task | via | direct_ms | baton_ms | overhead_ms | model | result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| test | runner/test | 15244.1 | 17671.3 | 2427.2 | grok-4.5 | pass / pass |
| build | runner/build | 182.1 | 243.6 | 61.5 | grok-4.5 | pass / pass |
| typecheck | runner/typecheck | 96.3 | 146.3 | 50.0 | grok-4.5 | pass / pass |
| search | longctx/search | 5.6 | 56.6 | 51.0 | grok-4.5 | pass / pass |
| summarize | longctx/git-summarize | 6.6 | 56.0 | 49.4 | grok-4.5 | pass / pass |
| ordinary | subagent | 29.0 | 80.7 | 51.7 | grok-4.5 | pass / pass |
| commit | skipped | — | — | — | — | live mode does not git commit |

Cheap commands add about 50ms for bind + complete. Baton lanes run first, so `test` overhead includes suite variance, not only ticket cost. Re-run the script to refresh these numbers.

## OpenSpec and state

OpenSpec remains optional. When present, it owns task breakdown and status; Baton routes ready tasks and writes conclusions back by stable task number. Without OpenSpec, baton spawn is complete.

Baton never creates project-local runtime state:

- ~/.baton/config.toml — director and per-CLI profiles
- ~/.baton/cache/cli-models.json — selected CLI catalog snapshot
- ~/.baton/cache/capabilities/ — optional local capability evidence
- ~/.baton/workspaces/CANONICAL-ROOT-SHA256/ — tickets, Receipts, selections, locks, and lifecycle state

## Commands

    baton init [--force] [--cli codex|grok]
    baton update
    baton config [--cli codex|grok] [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates
    baton cards [--ranked|--unranked] [--json]
    baton match "fix the flaky auth tests quickly"
    baton spawn "implement the migration" [--unit KEY=TEXT ...]
    baton apply [change]
    baton dispatch next --host HOST --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host HOST --json
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
