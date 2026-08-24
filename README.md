# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

A CLI-neutral director for Codex, Grok, Cursor, and Claude Code: one front conversation, automatic model and effort routing, native subagents, configured mechanical ops, and a clean main context.

Baton works standalone and can consume OpenSpec tasks when OpenSpec is present.

    npm install -g @zhouliuya/openbaton
    baton init
    baton config

Requires Node.js 22.5+.

Chinese: [README.zh.md](README.zh.md)

## Install from a source checkout

After cloning this repository, link the checkout to your machine and refresh global Baton files from it:

```bash
python3 scripts/update_local_baton.py
```

This installs dependencies, runs tests, builds, runs `bun link`, and then `baton update` so the global `baton` command points at this checkout's `dist/bin/baton.js`.

On a fresh machine, run initialization once after the script succeeds:

```bash
baton init
baton config
```

If Baton is already installed locally, run the same script to rebuild and update skills, config defaults, and hooks from the latest checkout.

For a faster dev loop when you accept skipping tests:

```bash
python3 scripts/update_local_baton.py --skip-tests
```

In Cursor, you can also run the `install-local-baton` skill after cloning; it follows the same workflow.

Day-to-day commands from the checkout without linking: `bun install && bun run baton -- COMMAND`.

## What changed

Baton is no longer coupled to OpenCodex. A CLI adapter owns model discovery. Adapters are Codex, Grok, Cursor, and Claude Code:

1. baton config asks which CLI to configure.
2. For Codex, Baton starts codex app-server and calls model/list with hidden models excluded. For Grok, Baton runs `grok models` and keeps only listed ids (JSON stdout if Grok emits it; otherwise the Available models listing, ignoring login/prose lines). For Cursor, Baton runs `cursor-agent models` and keeps only listed ids (JSON stdout if cursor-agent emits it; otherwise the Available models listing, ignoring login/prose lines). For Claude Code, Baton issues the SDK control-protocol `list_models` request and keeps each row's `resolvedModel` wire id, skipping the deferred `default` alias row and any row the host marks not selectable.
3. Baton displays exactly the picker-visible models returned by that CLI.
4. The user assigns optional runner and longctx labels, chooses the models subagents may call, and enables or disables that CLI profile.
5. Later work is routed automatically within that configured candidate set. There is no runtime model selector or model confirmation.

Baton never executes work via `grok -p`, `cursor-agent -p`, or `claude -p`. Dispatch host ids are `codex`, `grok`, `cursor`, and `claude`.

Claude Code's native `Agent` tool takes only a model alias, so Baton pins each ticket's exact model in an agent definition's `model:` frontmatter and selects it by `subagent_type`. Its host cap is 20 concurrent children (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).

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
    actions = ["test", "build", "lint", "typecheck", "git-commit"]

    [ops.longctx]
    actions = ["search", "digest", "git-summarize"]

runner and longctx are labels only. They do not claim that a model is fast, has a particular context window, or supports any other capability. Both labels use the same CLI-returned model surface.

Configured label values are automatically included in subagent_models. A disabled profile contributes no candidates.

Non-interactive setup is also supported:

    baton config \
      --cli codex|grok|cursor|claude \
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

`ops.runner` and `ops.longctx` label which mechanical actions leave the director. runner: `test`, `build`, `lint`, `typecheck`, `git-commit`. longctx: `search`, `digest`, `git-summarize`. Empty labels keep those units on the director. Mechanical workers execute the inferred command and do not explore; `git-commit` may read the staged diff, write one message, and create one commit.

Benchmark: the same local command with Baton tickets (spawn, bind, run, complete/release) vs without Baton (run the command). No host model is spawned. Default mode runs in this repo and skips `git commit`; `--fixture` uses a temp repo and includes commit.

    bun scripts/compare-mechanical-ops.ts
    bun scripts/compare-mechanical-ops.ts --fixture
    bun scripts/compare-mechanical-ops.ts --json

This checkout, 2026-08-22. `cli=grok` `ok=true`. Opening six tickets once: **221 ms**.

`test` is `bun run test` in this repo: typecheck plus the full suite, so the command itself is about **12 s** either way. That is not Baton.

Baton vs without. **Baton wrapper** is bind + complete (what Baton adds). **Command run-to-run** is the same command measured twice and is not Baton:

| task | via | without Baton (ms) | command via Baton (ms) | Baton wrapper (ms) | command run-to-run (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| test | runner/test | 12292.3 | 13318.2 | 50.8 | 1025.9 |
| build | runner/build | 188.9 | 203.0 | 55.1 | 14.1 |
| typecheck | runner/typecheck | 96.7 | 111.0 | 61.5 | 14.3 |
| search | longctx/search | 5.7 | 5.8 | 53.9 | 0.1 |
| summarize | longctx/git-summarize | 7.3 | 8.0 | 51.8 | 0.7 |
| ordinary | subagent | 29.8 | 31.8 | 52.0 | 2.0 |
| commit | skipped | — | — | — | — |

Phases (milliseconds):

| task | bind (ms) | execute (ms) | complete (ms) |
| --- | ---: | ---: | ---: |
| test | 18.7 | 13318.2 | 32.1 |
| build | 18.2 | 203.0 | 36.9 |
| typecheck | 24.7 | 111.0 | 36.8 |
| search | 19.6 | 5.8 | 34.3 |
| summarize | 19.7 | 8.0 | 32.1 |
| ordinary | 20.4 | 31.8 | 31.6 |

Baton adds about **50–62 ms** per task, plus **221 ms** once to open the tickets. Re-run the script to refresh these numbers.

## Sample incident audit

Same frozen incident request, 2026-08-22. Five independent units. Grok default stayed on **grok-4.6** and did **not** spawn (children would inherit 4.6 if it had). Baton ran five **grok-4.5** workers in parallel.

| sample | Grok 4.6 default (s) | Grok 4.6 sequential, no spawn (s) | Baton, five Grok 4.5 in parallel (s) |
| --- | ---: | ---: | ---: |
| standalone | 490.6 | 57.9 | 18.3 |
| openspec | 608.2 | 100.0 | 26.0 |

Tokens from each session's `end_turn.usage` (not an invoice). Baton is the five grok-4.5 workers only.

| sample | Grok 4.6 default (tokens) | Grok 4.6 sequential (tokens) | Baton, five Grok 4.5 (tokens) |
| --- | ---: | ---: | ---: |
| standalone | 1,497,407 | 37,439 | 144,056 |
| openspec | 1,791,283 | 224,853 | 198,195 |

Peak context: default grok-4.6 about 110k–124k tokens; each Baton grok-4.5 worker about 11k–13k.

## OpenSpec and state

OpenSpec remains optional. When present, it owns task breakdown and status; Baton routes ready tasks and writes conclusions back by stable task number. Without OpenSpec, baton spawn is complete.

Baton never creates project-local runtime state:

- ~/.baton/config.toml — director and per-CLI profiles
- ~/.baton/cache/cli-models.json — selected CLI catalog snapshot
- ~/.baton/cache/capabilities/ — optional local capability evidence
- ~/.baton/workspaces/CANONICAL-ROOT-SHA256/ — tickets, Receipts, selections, locks, and lifecycle state

## Commands

    baton init [--force] [--cli codex|grok|cursor|claude]
    baton update
    baton config [--cli codex|grok|cursor|claude] [--runner MODEL|-] [--longctx MODEL|-]
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
