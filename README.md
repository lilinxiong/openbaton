# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

Director for multi-model work. One front conversation, capability-routed native spawn, clean director context.

既能独立，又能 1+1>2 — complete standalone; strictly better with OpenSpec.

```
bun add -g baton   # source checkout: bun run baton -- <command>
baton init
```

## Why OpenBaton

Being able to spawn different models is only the execution primitive. Real work still needs to decide which exact route should handle each task, bound what that worker may do, queue work beyond host limits, and return only the evidence the main agent needs.

OpenBaton turns each execution unit into a routed, auditable ticket. The main-agent director chooses per task from explicit cards and currently executable OpenCodex routes. Workers can analyze, implement, or review in parallel, but remain depth 1 and never become a recursive agent tree or a second front conversation.

The goal is not simply “more agents.” It is one accountable workflow that can use multiple models safely, explainably, and without silent fallback.

## What it is

Not another coding CLI. A Codex-only skill pack + `init` that adds a multi-model director to Codex.

- **Dynamic Cards.** Every OpenCodex live provider/route stays visible. Exact AA evidence adds structured capability vectors and inferred positioning. Missing-profile and serving-variant base scores are labelled reference-only and cannot drive automatic recommendation; AA rows without aggregate rankings still disclose their available data.
- **Config is director-only.** `~/.baton/config.toml` stores concurrency/depth settings only. Local model aliases and route overrides are not supported.
- **Catalog visibility is separate from subagent eligibility.** OpenCodex discovery remains fully inspectable. Built-in policy forbids every `gpt-5.5`, `gpt-5.6-sol`, and `gpt-5.6-terra` provider route, variant, and reasoning profile from subagent candidates; proposals disclose those exclusions. Other session/Goal exclusions remain temporary.
- **Current-host intersection.** A route is spawnable only when it is both executable in OpenCodex and advertised by the current Codex session. Catalog-only routes remain visible as `HOST_ROUTE_UNAVAILABLE`.
- **Mandatory model confirmation.** `spawn/apply` first disclose the preferred and candidate exact routes in comparison tables, including strengths, task and raw/available AA data, reference route/profile provenance, provider quota remaining/reset (or an explicit unknown reason), and callability. They create no ticket until the user confirms or changes the route.
- **Quota provenance and local fallback.** Reported OpenCodex quota is authoritative. Only for an absent/unknown provider report, Baton may call an installed local CodexBar CLI and persist its sanitized percentage/reset windows as `codexbar:...`; otherwise quota remains explicitly unknown.
- **Codex-native workers.** Spawn in-process Codex subagents. Baton does not integrate with other coding CLI hosts or shell out to print modes. The skill installs into `~/.codex`; Baton state lives in `~/.baton`.
- **Unlimited logical spawn.** The host/session concurrency limit is runtime capability, not a hard-coded six. Saturation returns tickets to FIFO without consuming attempts, and slots release only after the host confirms `close_agent`. Depth 1.
- **Concrete work first.** Tickets distinguish `concrete` from `deliberative` work. Prefer bounded objective/deliverable/done-condition units; necessary reasoning workers use checkpointed state sync.
- **Hygiene.** Normal workers return one short conclusion. Checkpoints contain only phase, current result, next step, and blockers. Tool dumps and hidden reasoning stay out of the main conversation.

## OpenSpec

If OpenSpec is present, it owns breakdown and status. baton owns who runs each task and writes conclusions back.

If OpenSpec is absent, `baton spawn` still works.

Do not reimplement OpenSpec.

## OpenCodex

OpenCodex is consumed through Baton's package dependency/runtime resolver. It owns provider accounts, authentication, model discovery, and route execution. Baton only schedules (cards, match, director) and intentionally has no login or credential command.

既能独立，又能 1+1>2 — baton routes; OpenCodex holds the account.

## Capability cache

Artificial Analysis is an optional, replaceable capability source. Refresh it explicitly with a secure temporary key file; ordinary routing reads only the user-global SQLite snapshot at `~/.baton/cache/capabilities/artificial-analysis.sqlite3`.

```
baton capabilities refresh --provider aa --key-file /private/tmp/openbaton-aa-api-key
baton capabilities status
baton capabilities show gpt-5.6-luna --profile high
```

No fuzzy model matching. A missing profile may show its base-profile score, and serving variants such as `-fast`/`-highspeed` may show the suffix-free base-model score; both are explicitly reference-only and excluded from automatic recommendation. Routes without exact or deterministic reference evidence stay `unranked`, not blocked and not assigned an invented score. See [Artificial Analysis capability cache](docs/data-sources/artificial-analysis.md).

Dynamic Card matching uses AA intelligence/coding/agentic, cost, throughput, and latency evidence. Missing metrics stay unknown. Provider health, quota, authorization, and session policy remain separate gates.

## Model selection handshake

The Codex director performs this automatically after an ordinary request enters execution; the user does not need to know Baton commands:

1. Sync the exact models and allowed reasoning efforts exposed by the current Codex calling-host model selector/tool schema with `baton host sync --model ... --profile ROUTE=...`. Do not truncate this to a shorter `spawn_agent` optional-override hint. Baton reads sanitized quota reports from OpenCodex first; a callable local CodexBar is tried only for providers OpenCodex did not report.
2. `baton spawn` or `baton apply` writes a selection proposal only. It does not create a ticket.
3. The director shows the preferred route and all policy-eligible callable candidates with strengths, task score, AA scores/available data, reference-only provenance, remaining quota, reset time, and availability. It separately discloses the built-in `gpt-5.5`/`gpt-5.6-sol`/`gpt-5.6-terra` family exclusions.
4. After the user keeps or changes the choice, `baton selection approve ... --confirm` creates the immutable Receipt and queued ticket. A changed host snapshot or source task invalidates the proposal.

Candidates are grouped by quota pool. Normal providers have one pool; Cursor is split into `Cursor Auto` (Grok and Composer series only) and `Cursor API` (all other Cursor routes). Available pools sort by remaining quota, unknown pools follow, and zero-quota pools are disabled, hide their models, and sort last. ASR, TTS, voice-clone, and voice-design routes are disclosed as `TASK_CAPABILITY_MISMATCH` for text-reasoning work. `baton selection render PROPOSAL --output PATH --task-label TASK=CHINESE_LABEL --json` returns a Chinese, current-conversation inline-only content reference for the check-models, assign-tasks, Submit flow. English source tasks require faithful Chinese display labels; those labels never modify the source request, task, or fingerprint. The Codex host must emit that reference in its current response; it must never open the artifact in a browser, navigate to `file://`, expose a file link, or create a separate selector surface. Ticket and subagent counts remain zero until Submit is confirmed.

Quota precedence is `OpenCodex reported > local CodexBar fallback > unknown`. CodexBar is an informational local fallback and may represent its locally selected account; it does not change OpenCodex provider/auth/route ownership. Baton stores no CodexBar account email/id, login method, cookie, token, or raw error. An unreported quota is never treated as zero or sufficient. A user may explicitly select a disclosed callable `unranked` route, but cannot override the built-in forbidden families. Baton never auto-recommends an unranked route and never falls back between models/providers. See [CodexBar quota fallback](docs/data-sources/codexbar.md).

## State layout

All Baton-owned state is global under `~/.baton`; Baton never creates a project-local `.baton` directory.

- `config.toml` and `SKILL.md`: user-global director settings and skill.
- `cache/`: shared OpenCodex Route Snapshot and capability data.
- `workspaces/<sha256-of-canonical-root>/`: isolated tickets, Receipts, runs, locks, and remembered host capacity for one workspace.
- `workspaces/<sha256-of-canonical-root>/selections/`: pending/approved model disclosures and user approvals.

## Commands

```
baton init [--force]
baton capabilities status
baton capabilities show MODEL [--profile PROFILE]
baton routes refresh
baton routes status
baton routes candidates
baton host sync --model gpt-5.6-luna --profile gpt-5.6-luna=low,medium,high,xhigh,max --model alibaba-token-plan/glm-5.2 --profile alibaba-token-plan/glm-5.2=low,medium,high,xhigh,max
baton host status
baton conversation promote --from-file PATH
baton cards --ranked
baton cards --unranked --provider kimi
baton match "fix the flaky auth tests"
baton spawn "explore why CI is red"
baton spawn "edit one file" --model kimi/k3[1m] --write-path src/file.ts --write-ops write
baton apply
baton selection show sel-0001
baton selection render sel-0001 --output /absolute/path/selection.html --task-label '1.1=中文任务说明' --json
baton selection approve sel-0001 --confirm
baton selection approve sel-0002 --confirm --model gpt-5.6-luna@low
baton selection approve sel-0003 --confirm --route 1.1=gpt-5.6-luna@high
baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
baton dispatch progress TICKET --phase working --text "mapped the state machine" --next "check recovery" --json
baton dispatch complete TICKET --text "short outcome" --json
baton dispatch release TICKET --agent-id ID --json
baton status
```

## Samples

[`samples/`](samples/README.md) contains two built-in, repeatable capability paths over the same incident-audit data:

- standalone, with no OpenSpec artifacts;
- strict-valid OpenSpec tasks with stable conclusion writeback.

Both user requests are trigger-neutral and do not name Baton or subagents.

中文说明见 [README.zh.md](README.zh.md).

## License

MIT
