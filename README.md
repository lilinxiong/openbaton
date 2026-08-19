# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

Director for multi-model work. One front conversation, card-routed native spawn, clean director context.

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

Not another coding CLI. A skill pack + `init` that sits in front of the host you already use (Claude Code, Cursor, Grok, Codex, …).

- **Cards only.** Each model is `id` + strengths. The CLI picks per task. No subagent default. No inherit-parent-as-default. No match → blocked.
- **All routes stay visible.** OpenCodex discovery is the executable catalog. Cards opt routes into scheduling; session/Goal exclusions apply only to that session and never become global route-family bans.
- **Host-native workers.** Spawn in-process subagents. Do not shell out to `claude -p` / `cursor-agent -p` / `grok -p`. Grok and Codex init install into `~/.grok` and `~/.codex` (not the project); cards live in `~/.baton`.
- **Unlimited logical spawn.** Queue if the host has a hard cap. Never refuse. Depth 1.
- **Hygiene.** Workers return a short conclusion. Tool dumps stay out of the main session.

## OpenSpec

If OpenSpec is present, it owns breakdown and status. baton owns who runs each task and writes conclusions back.

If OpenSpec is absent, `baton spawn` still works.

Do not reimplement OpenSpec.

## OpenCodex

OpenCodex is consumed through Baton's package dependency/runtime resolver. It owns provider accounts, authentication, model discovery, and route execution. baton only schedules (cards, match, director); the repository does not vendor an OpenCodex submodule or reimplement that wiring.

Account login is consumed, not reimplemented — same idea as OpenSpec. Sign in with a browser:

```
baton login kimi      # Moonshot Kimi
baton login cursor    # Cursor (experimental PKCE)
baton login grok      # xAI Grok account
```

Do not paste a base URL or API key. Do not paste Cursor keys.

既能独立，又能 1+1>2 — baton routes; OpenCodex holds the account.

## Capability cache

Artificial Analysis is an optional, replaceable capability source. Refresh it explicitly with a secure temporary key file; ordinary routing reads only the user-global SQLite snapshot at `~/.baton/cache/capabilities/artificial-analysis.sqlite3`.

```
baton capabilities refresh --provider aa --key-file /private/tmp/openbaton-aa-api-key
baton capabilities status
baton capabilities show gpt-5.6-luna --profile high
```

No fuzzy model matching. Routes without an exact canonical mapping stay `unranked`, not blocked and not assigned an invented score. See [Artificial Analysis capability cache](docs/data-sources/artificial-analysis.md).

## State layout

All Baton-owned state is global under `~/.baton`; Baton never creates a project-local `.baton` directory.

- `config.toml` and `SKILL.md`: user-global policy and skill.
- `cache/`: shared OpenCodex Route Snapshot and capability data.
- `workspaces/<sha256-of-canonical-root>/`: isolated tickets, Receipts, runs, locks, and remembered host capacity for one workspace.

## Commands

```
baton init [--force] [--tools claude,cursor,grok,codex,agents]
baton login kimi
baton capabilities status
baton capabilities show MODEL [--profile PROFILE]
baton routes refresh
baton routes status
baton routes candidates
baton conversation promote --from-file PATH
baton cards
baton cards add --id opus --strengths "hard reasoning, long refactors" --route MODEL
baton match "fix the flaky auth tests"
baton spawn "explore why CI is red"
baton spawn "edit one file" --model k3 --write-path src/file.ts --write-ops write
baton apply
baton dispatch next --host codex --capacity 6 --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch complete TICKET --text "short outcome" --json
baton status
```

中文说明见 [README.zh.md](README.zh.md).

## License

MIT
