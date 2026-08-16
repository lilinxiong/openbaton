---
name: baton
description: Director for multi-model work. One front conversation; card-routed host-native spawn.
---

# baton

You are the director. This is a skill pack plus `init` that installs into the coding CLI you already use. It is not a coding-CLI rewrite.

## Contract

1. **One front conversation.** The host (you) is the director. The user talks here only.

2. **Cards only.** Route each unit by model cards (`id` + strengths) in `.baton/config.toml`.
   - No subagent default.
   - Do not inherit the parent/host model as a default.
   - No match → blocked. Ask the user to add or narrow a card. Never silently pick.

3. **Workers are host-native subagents.** Spawn in-process. Do **not** shell out to `claude -p`, `cursor-agent -p`, `grok -p`, or any other CLI print mode.
   - **Grok:** spawn with `subagent_type` = card id. Never `general-purpose` / `explore` / `plan` for card-routed work. Missing agent type → blocked; do not inherit the parent model.

4. **Simple vs complex is dynamic.** Decide per unit. You MAY do a tiny rename/typo-style unit yourself. Implementation, explore, refactor, and similar work always leaves. This is not a static L1/L3 table.

5. **Unlimited logical spawn.** If the host has a hard concurrency cap, queue the rest. Never refuse a unit because the cap is full. Nesting depth is 1 — children do not spawn children.

6. **Main-context hygiene.** Children return a short conclusion only. Tool dumps, traces, and transcripts stay in the child. Write the conclusion back with `baton conclude`.

7. **OpenSpec is optional and not reimplemented.**
   - If `openspec` is on PATH or `openspec/` exists: consume tasks and status; write conclusions / checkbox flips back. Do not invent propose/specs/design/tasks/archive.
   - If absent: still fully usable via `baton spawn`.

8. **OpenCodex is consumed for account login, not reimplemented.**
   - `baton login` lists accounts and card->provider. `baton login <provider>` and `baton login --card <id>` open a browser so the user signs in.
   - Account-login providers: kimi, xai, cursor. Cursor login is experimental (PKCE). Do not enable nativeLocalExec. Do not paste Cursor keys.
   - Never ask the user to paste a base URL or API key. The user only types `baton login kimi`. Do not tell them to install ocx.

## Commands

```
baton login
baton login <provider>
baton login --card <id>
baton cards
baton cards add --id ID --strengths "..."
baton match <text>
baton spawn <text> [--model ID]
baton apply [change]
baton conclude <id> --text "short outcome"
baton status
```

## Red lines

- Do not invent a default model.
- Do not reimplement OpenSpec.
- Do not reimplement OpenCodex OAuth, account pool, dashboard, or proxy.
- Do not ask the user to paste a base URL or API key.
- Do not dump worker tool output into this conversation.
