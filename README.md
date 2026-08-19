# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

Director for multi-model work. One front conversation, capability-routed native spawn, clean director context.

既能独立，又能 1+1>2 — complete standalone; strictly better with OpenSpec.

```
npm i -g baton   # source checkout: npm run baton -- <command>
baton init
```

## Why OpenBaton

Being able to spawn different models is only the execution primitive. Real work still needs to decide which exact route should handle each task, bound what that worker may do, queue work beyond host limits, and return only the evidence the main agent needs.

OpenBaton turns each execution unit into a routed, auditable ticket. The main-agent director chooses per task from explicit cards and currently executable OpenCodex routes. Workers can analyze, implement, or review in parallel, but remain depth 1 and never become a recursive agent tree or a second front conversation.

The goal is not simply “more agents.” It is one accountable workflow that can use multiple models safely, explainably, and without silent fallback.

## What it is

Not another coding CLI. A Codex-only skill pack + `init` that adds a multi-model director to Codex.

- **Dynamic Cards.** Every OpenCodex live provider/route stays visible. Exact AA mappings add structured capability vectors and inferred positioning; unmapped routes remain `unranked`.
- **Config is director-only.** `~/.baton/config.toml` stores concurrency/depth settings only. Local model aliases and route overrides are not supported.
- **All routes stay visible.** OpenCodex discovery is the complete executable catalog. Explicit selection requires the exact route/profile ID; session/Goal exclusions remain temporary.
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

No fuzzy model matching. Routes without an exact canonical mapping stay `unranked`, not blocked and not assigned an invented score. See [Artificial Analysis capability cache](docs/data-sources/artificial-analysis.md).

Dynamic Card matching uses AA intelligence/coding/agentic, cost, throughput, and latency evidence. Missing metrics stay unknown. Provider health, quota, authorization, and session policy remain separate gates.

## State layout

All Baton-owned state is global under `~/.baton`; Baton never creates a project-local `.baton` directory.

- `config.toml` and `SKILL.md`: user-global director settings and skill.
- `cache/`: shared OpenCodex Route Snapshot and capability data.
- `workspaces/<sha256-of-canonical-root>/`: isolated tickets, Receipts, runs, locks, and remembered host capacity for one workspace.

## Commands

```
baton init [--force]
baton capabilities status
baton capabilities show MODEL [--profile PROFILE]
baton routes refresh
baton routes status
baton routes candidates
baton conversation promote --from-file PATH
baton cards --ranked
baton cards --unranked --provider kimi
baton match "fix the flaky auth tests"
baton spawn "explore why CI is red"
baton spawn "edit one file" --model kimi/k3[1m] --write-path src/file.ts --write-ops write
baton apply
baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
baton dispatch progress TICKET --phase working --text "mapped the state machine" --next "check recovery" --json
baton dispatch complete TICKET --text "short outcome" --json
baton dispatch release TICKET --agent-id ID --json
baton status
```

中文说明见 [README.zh.md](README.zh.md).

## License

MIT
