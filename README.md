# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

Director for multi-model work. One front conversation, card-routed native spawn, clean director context.

既能独立，又能 1+1>2 — complete standalone; strictly better with OpenSpec.

```
npm i -g baton   # or: node bin/baton.js
baton init
```

## What it is

Not another coding CLI. A skill pack + `init` that sits in front of the host you already use (Claude Code, Cursor, Grok, Codex, …).

- **Cards only.** Each model is `id` + strengths. The CLI picks per task. No subagent default. No inherit-parent-as-default. No match → blocked.
- **Host-native workers.** Spawn in-process subagents. Do not shell out to `claude -p` / `cursor-agent -p` / `grok -p`. On Grok, init writes `.grok/agents/<card-id>.md` so spawn uses `subagent_type` = card id (official spawn has no `model` param).
- **Unlimited logical spawn.** Queue if the host has a hard cap. Never refuse. Depth 1.
- **Hygiene.** Workers return a short conclusion. Tool dumps stay out of the main session.

## OpenSpec

If OpenSpec is present, it owns breakdown and status. baton owns who runs each task and writes conclusions back.

If OpenSpec is absent, `baton spawn` still works.

Do not reimplement OpenSpec.

## Commands

```
baton init [--force] [--tools claude,cursor,grok,codex,agents]
baton cards
baton cards add --id opus --strengths "hard reasoning, long refactors"
baton match "fix the flaky auth tests"
baton spawn "explore why CI is red"
baton apply
baton conclude spn-0001 --text "short outcome"
baton status
```

中文说明见 [README.zh.md](README.zh.md).

## License

MIT
