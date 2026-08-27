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

If Baton is already installed locally, run the same script to rebuild and update skills and config defaults from the latest checkout. Baton does not install or depend on runtime hooks.

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

The user-global ~/.baton/config.toml always has director fallbacks and contains
only the CLI profiles selected during init/config:

    [director]
    max_concurrent = 4
    max_depth = 1

`max_concurrent` and `max_depth` are independent fallbacks. If a CLI discovery
response explicitly reports either limit, Baton writes that field under the
selected `[cli.<id>]` profile and uses it for that host. An unreported field is
omitted and continues to use `[director]`. Adapter defaults and environment
variables are not persisted as if the CLI had reported them.

    [cli.codex]
    enabled = true
    runner = "gpt-5.4-mini"
    longctx = "gpt-5.5"
    coding_models = [
      "gpt-5.6-luna",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]

runner and longctx are labels only. They do not claim that a model is fast, has a particular context window, or supports any other capability. Both labels use the same CLI-returned model surface.

`coding_models` is an explicit ordered multi-select: the array order is the Coding priority. Runner and longctx remain independent labels and are never inserted into or reordered within this array. A disabled profile contributes no candidates.
Unselected CLIs have no placeholder table in the file.

Baton has no runtime hook layer. The director owns classification, dependency
ordering, native-subagent orchestration, and the Receipt/Git safety boundary.
Host integrations are configuration and dispatch adapters only; no host hook is
installed, trusted, or used as an execution signal.

Migration note: older installations may contain `subagent_models`. It is read
only at the schema migration boundary, copied to `coding_models` in its existing
order, and never written again. The removed `--subagent-model` flag reports
`LEGACY_FLAG_REMOVED`; use repeated `--coding-model` flags instead.

Non-interactive setup is also supported:

    baton config \
      --cli codex|grok|cursor|claude \
      --runner gpt-5.4-mini \
      --longctx gpt-5.5 \
      --coding-model gpt-5.3-codex-spark \
      --coding-model gpt-5.6-luna \
      --coding-model gpt-5.4-mini \
      --guard-mode enforce \
      --enable

Run baton models refresh when the selected CLI's picker surface changes.

## Mini and Spark

If Codex returns gpt-5.4-mini or gpt-5.3-codex-spark from model/list, Baton displays them and lets the user put them in `coding_models`.

Catalog visibility and actual host execution are distinct evidence:

- picker-visible means the model is configurable;
- the configured allowlist means Baton may select it;
- dispatch revalidates the model and reasoning effort against the captured CLI catalog;
- only an actual host-native rejection is execution-failure evidence.

Baton has no hard-coded family bans. It does not label Mini or Spark unsupported merely because a particular tool schema or help string omitted them.

## Automatic routing

baton spawn and baton apply never ask the user to pick a model. After hard eligibility gates (host, effort, context, availability, and activation), a simple implementation uses the first eligible `coding_models` entry. More complex work follows the same configured order. Baton does not reorder this list by score; the selected reason and skipped-route diagnostics are recorded.

Baton automatically chooses:

- a configured model based on the work-unit text and CLI model description;
- one of the reasoning efforts that the CLI returned, fitted to task complexity;
- a fast model or exact service tier when the task asks for speed and the CLI description or speed/service-tier metadata supports that preference;
- optional local capability and recent route-health evidence as refinements.

Artificial Analysis data is optional. Missing benchmark data leaves the evidence unranked; it does not make a Codex-returned, configured model unusable.

Explicit --model, --route, baton config model-selection, selector rendering, and user model approval are removed. The automatic decision is still persisted in the proposal, ticket, and Delegation Receipt for auditability.

Baton never inherits the parent model, chooses outside the enabled allowlist, invents a reasoning effort or speed flag, or silently switches a failed ticket to another model.

## Director/worker routing

Discussion and read-only analysis stay on the director. When the selected CLI profile is enabled, every ordinary implementation request—including tiny edits—runs through that host's native subagent; do not apply a tiny-edit shortcut. Missing/disabled profiles or unresolved classifications fail closed. Classified mechanical work never falls back to director execution when its configured route is empty or unusable. OpenSpec only lightens orchestration; it does not change who writes executable tasks. The same rule applies on every host.

## Automatic workflow contract

With the selected CLI profile enabled and the user authorizing execution, the director classifies each executable request and passes that structured classification to Baton before dispatch. Baton persists the resulting tickets and Receipts; it does not invent or own a separate DAG. Discussion and read-only analysis stay on the director. Authorized implementation nodes use the current host's native subagent tool. A `mechanical` classification selects the configured `runner` route (and `long-context` selects `longctx`); operation labels are audit metadata and never a fixed action-name matcher. Commit/publish authority remains the deterministic Receipt/Git capability gate. Missing authorization, a disabled profile, or unresolved classification fails closed.

## Write-scope readiness

Before creating or dispatching any write ticket, the director performs a read-only impact/dependency pass for that unit. The pass must resolve the affected dependencies and record a complete, exact per-unit write-path set with allowed operations. Paths are explicit; allowed operations are `write`, `create`, `delete`, `rename`, and `chmod`. Unknown impact, dependency, path, or operation keeps classification unresolved, so no implementation ticket is created or dispatched.

Parallel dispatch is permitted only when every participating unit has a complete scope and pairwise disjoint write sets, including rename source/destination paths and path-prefix overlaps. Otherwise units are sequenced or remain director-local. If a worker discovers an undeclared path or operation, it stops before mutation and returns a scope decision to the director. It must never edit first and rely on terminal retry or audit to authorize the change. Mechanical routing remains based on the structured class; operation labels stay opaque audit metadata and never select a route.

## Execution lifecycle

The Baton CLI creates tickets and lifecycle state; only the selected host (Codex, Grok, Cursor, or Claude Code) calls native subagent tools.

1. baton spawn or baton apply creates automatically routed tickets and immutable Receipts.
2. The host reserves work with baton dispatch next.
3. The host calls its native subagent tool (Codex `spawn_agent`, including namespaced collaboration variants, Grok `spawn_subagent`, Cursor `Task`, or Claude Code `Agent`) with the returned `prompt` and, when supported, `description` unchanged, plus the exact model and only the effort/service-tier options the tool can express. The first-line JSON envelope is dispatch audit data; ticket ids are never classified by prefix. Codex `task_name` is the native execution handle for attach/liveness/release; `agent_id` is only an optional diagnostic. Grok must pass `spawn_subagent.model`; omitting it inherits the parent model.
4. The host binds the returned agent id, persists activity and progress, and records exactly one terminal result.
5. The host closes the native agent and runs dispatch release before refilling FIFO.

Logical work is uncapped; physical concurrency follows the current host limit. AgentLimitReached defers the same ticket without consuming an attempt or changing its model. Polling timeouts are not worker failures; a ticket can time out only after its exact native execution handle is probed as not_found.

Read-only is the default. Write tickets require an immutable path and operation allowlist plus parent Git safety checks. Pre-existing uncommitted work is kept as baseline dirt; the worker may continue allowlisted files incrementally and must not mutate unrelated dirt. The sole Git exception is an exclusive commit-only ticket over an exact parent-staged tree; it may create one audited commit and may not stage, amend, branch, rebase, tag, or push.

For a standalone write, pass the exact path and operations explicitly:

    baton spawn "implement the migration" --host HOST --classification implementation \
      --write-path src/migration.ts --write-ops write,create

For OpenSpec, scope each unit before dispatch; only complete, disjoint scopes may share a wave:

    baton apply CHANGE --host HOST --dispatch \
      --unit ID --write-path src/migration.ts --unit ID --write-path src/config.ts

## Git safety snapshots and runtime compatibility

Write and commit-only tickets use a fail-closed Git safety snapshot. Every
size-unknown Git result is consumed as a stream: stdout and stderr are drained
concurrently, backpressure is respected, and the child is reaped before Baton
accepts the facts. There is no Node or Bun aggregate `maxBuffer` limit on this
path, so a valid stream may exceed the former 1 MiB boundary or 128 MiB without
being rejected merely for being large. Baton retains only the compact facts
needed by the Receipt or verdict. Scalar commands retain a deliberately small
contract; exceeding that contract is an error, not permission to treat scalar
output as a snapshot. Partial, malformed, truncated, interrupted, or failed
streams are discarded and never become a valid baseline.

Receipt schema v4 and the public CLI syntax remain unchanged. New write
baselines record:

    index_control_algorithm = "git-index-control-framed-sha256-v2"
    index_control_checksum = "<sha256>"
    index_control_entry_count = <number>

Commit-only baselines use the corresponding `staged_index_control_*` fields.
The v2 fingerprint frames entries in canonical Git index order with raw
pathname bytes, a pathname length, and the semantic control flags after masking
only Git's volatile fsmonitor-valid bit (`0x80000000`), then appends the entry
count. The staged-tree fingerprint remains separate. This makes fingerprints
stable across Node and Bun and keeps additional parser memory proportional to a
single record rather than the complete `ls-files --debug -z` output.

Collection and metadata failures share one structured safety-failure contract
with stable meanings. The `GIT_*` collection codes are `GitSafetyError` codes;
the `INDEX_CONTROL_*` codes are separate Receipt/index metadata validation
codes, not `GitSafetyError` values:

- `GIT_SAFETY_COMMAND_FAILED`: Git could not be spawned, exited unsuccessfully,
  terminated by a signal, or failed while its streams were being consumed.
- `GIT_SAFETY_SCALAR_LIMIT`: a command declared to return one small scalar
  exceeded its explicit scalar contract.
- `GIT_SAFETY_STREAM_MALFORMED`: a streamed record was malformed or truncated,
  including an index entry that never supplied its terminal flags field.
- `INDEX_CONTROL_ALGORITHM_UNSUPPORTED`: a Receipt names an algorithm Baton does
  not implement.
- `INDEX_CONTROL_BASELINE_INVALID`: v2 metadata is incomplete or has an invalid
  checksum or entry count.
- `GIT_BASELINE_RACED` and `GIT_AUDIT_RACED`: the complete safety observation
  changed during collection and still did not stabilize after one full retry.

Collection failures happen before a new Receipt or worker is made durable, so
they leave no successful Receipt or spawn. A terminal audit cannot record a
successful verdict until its stable observation succeeds. Existing public
safety verdict mapping is preserved; collection failures are not fabricated as
write-scope mutations.

An algorithm-less existing schema-v4 Receipt is interpreted as
`legacy-json-sorted-v1`. The new runtime streams its Git input but retains the
compact pathname and masked-flag records needed to reproduce the established
sort, JSON, and SHA-256 checksum exactly. New Receipts always use v2. Unknown
algorithms, missing required v2 fields, invalid checksums, and inconsistent
counts fail closed; Baton never guesses or silently falls back. Thus a new
runtime can finish tickets created by an older one without rewriting their
immutable Receipts, while an older runtime cannot safely audit a v2 Receipt.

Before replacing Baton with an older runtime, drain all active v2 write and
commit-only tickets: each must reach a terminal state (using explicit close
when appropriate) and then be released before rollback. Do not roll back
across an active v2 ticket, bypass the safety check, or rewrite a Receipt to
make the old runtime accept it.

## Mechanical ops

The director's structured execution class selects `runner` or `longctx`; operation labels are retained for audit only. Empty or unusable labels fail closed for classified mechanical work. Mechanical workers execute the director-specified operation and do not infer commands from prose or explore. Commit-only additionally requires an explicit commit capability and the Receipt/Git safety gate; `operation = "git-commit"` alone is not authority.

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

OpenSpec remains optional. When present, it owns task breakdown and status; Baton routes ready tasks and writes conclusions back by stable task number (or the validated source line for an unnumbered task). Without OpenSpec, baton spawn is complete.

Baton never creates project-local runtime state:

- ~/.baton/config.toml — director and per-CLI profiles
- ~/.baton/cache/cli-models-<host>.json — selected CLI catalog snapshots
- ~/.baton/state/model-availability.json — durable host/account route availability
- ~/.baton/cache/capabilities/ — optional local capability evidence
- ~/.baton/workspaces/CANONICAL-ROOT-SHA256/ — tickets, Receipts, selections, locks, and lifecycle state

## Commands

    baton init [--force] [--cli codex|grok|cursor|claude]
    baton update
    baton config [--cli codex|grok|cursor|claude] [--runner MODEL|-] [--longctx MODEL|-]
                 [--coding-model MODEL|all] [--guard-mode enforce|off] [--enable|--disable]
    baton enable|disable all|curproject --host HOST [--json]
    baton models refresh|status|candidates
    baton models reset ROUTE --host HOST [--json]
    baton cards [--ranked|--unranked] [--json]
    baton match "fix the flaky auth tests quickly"
    baton spawn "implement the migration" [--unit KEY=TEXT ...]
                 [--classification CLASS] [--operation LABEL]
                 [--unit-classification KEY=CLASS ...] [--unit-operation KEY=LABEL ...]
                 [--write-path PATH] [--write-ops write,create,delete,rename,chmod]
    baton apply [change]
    baton apply [change] --host HOST --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
    baton dispatch next --host HOST --capacity N --json
    baton dispatch bind TICKET --task-name CODEX_TASK_NAME --host codex --json
    baton dispatch bind TICKET --agent-id ID --host HOST --json  # other hosts
    baton dispatch defer TICKET --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
    baton dispatch probe TICKET --task-name CODEX_TASK_NAME --host codex --state pending_init|running|interrupted|shutdown|not_found --json
    baton dispatch progress TICKET --phase PHASE --text "short status" --json
    baton dispatch complete TICKET --text "short conclusion" --json
    baton dispatch fail|timeout|close TICKET --json
    baton dispatch release TICKET --host HOST --task-name CODEX_TASK_NAME --json
    baton dispatch recover|status --json
    baton status [--host HOST] [--json]

    baton match "fix the flaky auth tests quickly" --host HOST
    baton uninstall [--host HOST] [--dry-run]
    baton uninstall --clean --yes

`all` changes only the selected CLI host globally; `curproject` changes only the
current canonical workspace and host. An explicit disabled state bypasses Baton
and returns the host's ordinary native behavior only when that workspace is idle.
Activation and dispatch state are evaluated by the director and Baton CLI at
command boundaries. There is no hook posture, hook observation, bypass mode, or
runtime hook trust/rewrite step. Native execution handles, immutable Receipts,
write allowlists, and the parent Git audit are the evidence and enforcement
surfaces.

Model availability remembers explicit quota exhaustion (including remaining=0)
across projects and sessions. Generic 429/network/timeout failures remain
transient route health. Known reset times schedule a probe; unknown resets use a
bounded backoff and a single durable probe lease. Until a host exposes a stable
account identity, this state uses the documented opaque `host-profile` scope.
Use
`baton models reset ROUTE --host HOST` to clear one route. `uninstall --dry-run`
shows only the selected host's integration files and preserves all Baton state;
`--clean --yes` removes recognized integrations for every host plus Baton state,
only when no active tickets are draining. Package executables are retained.

Standalone requests use one proposal shape: without `--unit`, the request is
stored as the `standalone` unit. Classification values and fields are strict;
operation labels are audit metadata, and neither operation nor request prose is
used to infer a route.

## License

MIT
