# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

Director for multi-model work. One front conversation, capability-routed native spawn, a clean director context.

Complete on its own. Strictly better with OpenSpec.

```
bun add -g baton
baton init
```

From a source checkout: `bun install && bun run baton -- <command>`. Requires Node.js 22.5+ or Bun 1.3.14+.

To update the locally linked Baton from this checkout:

```sh
python3 scripts/update_local_baton.py
```

The script installs locked dependencies, runs tests and type checking, builds, runs `bun link`, and finishes with `baton update`. It does not pull Git or refresh OpenCodex routes/cache. Use `--skip-install --skip-tests` for a quick local update or `--dry-run` to preview the commands.

Chinese: [README.zh.md](README.zh.md)

## What it is

Not another coding CLI. Baton is a Codex-only skill pack. `baton init` installs a director into Codex so one front conversation can assign work to exact OpenCodex routes.

Being able to spawn different models is only the execution primitive. Real work still needs to decide which exact route should handle each unit, bound what that worker may write, queue past the host concurrency limit, and return only the evidence the main agent needs.

Baton turns each unit into a routed, auditable ticket. Workers can analyze, implement, or review in parallel. They stay at depth 1: never a recursive agent tree, and never a second front conversation.

## How a session works

The user talks to Codex as usual. The director runs Baton; the user does not have to type these commands.

1. **Split the work.** An ordinary request is refined into bounded units with an objective, deliverable, and done condition. Tiny rename or typo work may stay on the director. Implementation, exploration, and similar work always leaves.
2. **Sync Baton on demand.** OpenCodex owns runtime/provider synchronization. Baton refreshes one persisted route/profile/quota snapshot from OpenCodex only when it is missing or stale, or when the user explicitly requests it. There is no per-session host sync.
3. **Propose once, do not ticket.** One ordinary request becomes one request-level proposal containing all of its bounded units. `baton spawn --unit ...` or `baton apply` writes that proposal only.
4. **Disclose once and confirm once.** Provider is one global multi-select. Below it, the director shows every candidate and all task assignments together. Multiple workspace proposals from the same front request are rendered as one bundle with one Submit. Until that Submit, ticket count and subagent count stay at zero.
5. **Mint tickets.** `baton selection approve ... --confirm` creates queued tickets and immutable Delegation Receipts. A bundled Submit binds the same confirmation id and global Provider choice into every proposal. A changed OpenCodex catalog snapshot or source task invalidates the proposal.
6. **Dispatch in-process.** Codex reserves with `baton dispatch next`, calls host-native `spawn_agent`, binds the returned agent id, then writes exactly one terminal result. `close_agent` plus `dispatch release` frees the physical slot; FIFO refill follows.
7. **Wait by activity, not elapsed time.** Bounded `wait_agent` windows are polling cadence only. Persist exact-agent host state with `baton dispatch probe`; `pending_init`, `running`, output, or heartbeat activity keeps the same ticket alive indefinitely. Business progress stays separate. Timeout requires the latest matching `not_found` probe sequence.
8. **Keep the front conversation clean.** Concrete workers return one short conclusion. Deliberative workers may checkpoint phase, current result, next step, and blockers. Tool dumps and hidden reasoning stay in the child.

Mechanical ops can skip the selector when the user-global `~/.baton/config.toml` names an executable route in the synced OpenCodex snapshot. Empty means the director runs that class itself.

## Rules that stay true

- **Codex only.** The skill installs into `~/.codex`. Baton state lives under `~/.baton`. There is no other coding-CLI host, no print-mode shell-out, and no Baton login.
- **OpenCodex owns route availability.** Baton selects only exact, non-disabled routes/profiles from its synced OpenCodex snapshot. It does not prefilter them through a session model list. If host-native spawn still rejects a selected route, the director reports that execution error and never substitutes another route.
- **No silent substitution.** No parent-model inherit, no route/provider fallback, no local aliases or overrides. Explicit selection uses an exact OpenCodex route/profile id.
- **Catalog and eligibility are separate.** OpenCodex discovery stays fully inspectable. Built-in policy forbids every `gpt-5.5`, `gpt-5.6-sol`, and `gpt-5.6-terra` provider route, variant, and reasoning profile from candidates, confirmation, tickets, and dispatch. Proposals disclose those exclusions. Other session or Goal exclusions remain temporary.
- **Unranked is not invented.** Missing-profile and serving-variant (`-fast` / `-highspeed`) base scores are `reference_only` and cannot drive automatic recommendation. A user may pick a disclosed callable `unranked` route. Forbidden families cannot be overridden.
- **Logical work is uncapped.** The host/session concurrency limit is runtime capability, not a hard-coded six. Saturation returns the same ticket to FIFO without consuming its attempt. A terminal agent still occupies a slot until close and release succeed. Depth is 1.
- **No timer-based worker death.** Repeated wait-call timeouts and missing progress text never make a running agent dead. Baton records host liveness separately and allows ticket timeout only after the current exact agent is probed as `not_found`.
- **Workers never own Git.** They do not stage, commit, branch, rebase, or push. Write tickets need an explicit allowlist and pass the parent Git safety gate on every terminal path, including error, timeout, and close.

## OpenSpec

If OpenSpec is present, it owns breakdown and status. Baton owns who runs each ready task and writes conclusions back by stable task number.

If OpenSpec is absent, `baton spawn` still works.

Do not reimplement OpenSpec.

## OpenCodex

OpenCodex is consumed through Baton's package dependency and runtime resolver. It owns provider accounts, authentication, model discovery, primary quota reporting, and route execution. Baton only schedules.

Baton has no login, account, token, or credential command. Do not paste a base URL or API key into this project.

## Model selection

`spawn` / `apply` disclose, for every delegated unit:

- preferred exact route/profile when scoring has a unique positive winner, otherwise an explicit manual-choice state
- every policy-eligible executable OpenCodex candidate, with strengths, task score, raw/available Artificial Analysis data, reference-only provenance, remaining quota or an explicit unknown reason, and snapshot callability
- the built-in `gpt-5.5` / `gpt-5.6-sol` / `gpt-5.6-terra` family exclusions

Candidates are grouped by quota pool, not shown as one flat list. Most providers are one pool. Cursor is two: `cursor-auto` (Grok and Composer series, monthly/Auto allowance) and `cursor-api` (every other Cursor route, reported API usage). Available pools sort by remaining quota, unknown pools follow, and exhausted pools are disabled, collapsed, and last. ASR, TTS, voice-clone, and voice-design routes are disclosed as `TASK_CAPABILITY_MISMATCH` for text-reasoning work.

Quota precedence is `OpenCodex reported > local CodexBar fallback > unknown`. CodexBar is informational, may represent its locally selected account, and never overwrites a reported OpenCodex window or changes provider/auth/route ownership. Baton stores only sanitized percentage/reset windows with a `codexbar:...` source. An unreported quota is never treated as zero or "enough". See [CodexBar quota fallback](docs/data-sources/codexbar.md).

The selector is inline in the current Codex conversation and is presented in Chinese. One request produces one consolidated selector: a global Provider control first, every candidate route/profile second, all tasks grouped by path third, and one Submit last. Multiple workspace proposals use `baton selection render-bundle`. Codex translates English source tasks into Chinese display labels via `--task-label`; those labels never rewrite the source request, task, or fingerprint. Codex must emit the single returned `inline_content_reference` in the same reply. It must not open a browser, navigate to `file://`, show a file link, or create a separate selector surface. If inline rendering is unavailable, the same consolidated Chinese disclosure stays as text in this conversation.

## Global ops routes

`~/.baton/config.toml` stores optional exact routes for two mechanical classes under `[ops.runner]` and `[ops.longctx]`. The same choices apply in every workspace. There is no built-in default.

| Class | When it runs | Empty means |
| --- | --- | --- |
| `runner` | terminating test / build / lint / typecheck | the director runs it |
| `longctx` | search / digest / git-summarize, and a commit message from already-staged files; needs about 1M context | the director runs it |

`baton config` refreshes the route/quota snapshot directly through OpenCodex, lists policy-eligible executable routes, and interactively writes the global choices. It does not depend on a Codex session snapshot. Dispatch validates that the configured route still exists in the synced OpenCodex snapshot and fails with `OPS_ROUTE_UNAVAILABLE` otherwise. It never inherits the parent model. Wait for the worker conclusion, including command failure. Workers never `git commit`.

## Capability cache

Artificial Analysis is an optional, replaceable capability source. Ordinary routing reads only the user-global SQLite snapshot at `~/.baton/cache/capabilities/artificial-analysis.sqlite3`.

```
baton capabilities refresh --provider aa --key-file /private/tmp/openbaton-aa-api-key
baton capabilities status
baton capabilities show gpt-5.6-luna --profile high
```

No fuzzy model matching. Missing metrics stay unknown. Capability evidence does not replace route health, quota, authorization, or session policy. See [Artificial Analysis capability cache](docs/data-sources/artificial-analysis.md).

## State

Baton never creates project-local `.baton/` runtime state or a project `.baton.toml`. Mechanical ops policy shares the user-global `~/.baton/config.toml` with director settings.

Under `~/.baton`:

- `config.toml` and `SKILL.md` — user-global director/ops settings and skill
- `cache/` — shared OpenCodex Route Snapshot and capability data
- `workspaces/<sha256-of-canonical-root>/` — tickets, Receipts, runs, locks, and remembered host capacity
- `workspaces/<sha256-of-canonical-root>/selections/` — pending and approved model disclosures

## Commands

```
baton init [--force]
baton update
baton config [--runner ROUTE|-] [--longctx ROUTE|-]

baton routes refresh|status|candidates
baton cards [--ranked|--unranked] [--provider ID] [--json]
baton match "fix the flaky auth tests"
baton capabilities refresh --provider aa --key-file PATH
baton capabilities status
baton capabilities show ROUTE [--profile PROFILE]

baton spawn "explore why CI is red" --unit audit="audit the failures" --unit report="report the findings"
baton spawn "edit one file" --model kimi/k3[1m] --write-path src/file.ts --write-ops write
baton apply [change] [--route TASK=EXACT_ROUTE]
baton selection show PROPOSAL
baton selection render PROPOSAL --output PATH --task-label TASK=LABEL [--json]
baton selection render-bundle --proposal 'SCOPE=WORKSPACE#PROPOSAL' ... --output PATH --task-label SCOPE/TASK=LABEL [--json]
baton selection approve PROPOSAL --confirm [--route TASK=ID] [--provider ID] [--global-provider ID] [--confirmation-id ID] [--confirmation-scope proposal|bundle]

baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found [--activity status|output|heartbeat] --json
baton dispatch progress TICKET --phase PHASE --text "short status" --json
baton dispatch complete TICKET --text "short conclusion" --json
baton dispatch fail TICKET --json
baton dispatch timeout TICKET --probe-sequence N --json
baton dispatch close TICKET --json
baton dispatch release TICKET --agent-id ID --json
baton dispatch recover|status --json

baton conversation promote --from-file PATH
baton status
```

`baton update` refreshes the installed Codex skill and merges global director/ops defaults without replacing configured ops routes. `~/.baton/config.toml` stores concurrency, depth, and the optional mechanical-route choices; every route value is still an exact OpenCodex route.

## Samples

[`samples/`](samples/README.md) ships two repeatable paths over the same incident-audit data:

- standalone, with no OpenSpec artifacts
- strict-valid OpenSpec tasks with stable conclusion writeback

Both user requests are trigger-neutral and do not name Baton or subagents.

## License

MIT
