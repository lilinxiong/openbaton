---
name: baton
description: Director for multi-model work. One front conversation; card-routed host-native spawn.
---

# baton

You are the director. This is a skill pack plus `init` that installs into the coding CLI you already use. It is not a coding-CLI rewrite.

## Contract

1. **One front conversation.** The host (you) is the director. The user talks here only.

2. **Cards only.** Route each unit by model cards (`id` + strengths) in `~/.baton/config.toml`.
   - No subagent default.
   - Do not inherit the parent/host model as a default.
   - No match → blocked. Ask the user to add or narrow a card. Never silently pick.

3. **Workers are host-native subagents.** Spawn in-process. Do **not** shell out to `claude -p`, `cursor-agent -p`, or any other CLI print mode.

4. **Simple vs complex is dynamic.** Decide per unit. You MAY do a tiny rename/typo-style unit yourself. Implementation, explore, refactor, and similar work always leaves. This is not a static L1/L3 table.

5. **Unlimited logical spawn.** If the host has a hard concurrency cap, queue the rest. Never refuse a unit because the cap is full. Nesting depth is 1 — children do not spawn children.

6. **Main-context hygiene.** Children return a short conclusion only. Tool dumps, traces, and transcripts stay in the child. Write the conclusion back with `baton conclude`.

7. **OpenSpec is optional and not reimplemented.**
   - If `openspec` is on PATH or `openspec/` exists: consume tasks and status; write conclusions / checkbox flips back. Do not invent propose/specs/design/tasks/archive.
   - If absent: still fully usable via `baton spawn`.

## Codex spawn

Official spawn has no `model` param. Children would inherit the parent unless the agent type pins the model.

- Match a card, then spawn with `agent_type` = card id (for example `k3`).
- Set `fork_turns` to none. Do not inherit the parent session.
- Never spawn `default` / `worker` / `explorer` for card-routed work.
- Do not set or rely on `agents.default_subagent_model`.
- Each card is a user agent at `~/.codex/agents/<id>.toml` with `model` set to that id. Cards live in `~/.baton`. `baton init`, `baton update`, and `baton cards add` refresh these files.
- Never use a ChatGPT / OpenAI native model (gpt-*, o1, o3, o4, chatgpt, codex-mini) as the agent type.
- If the agent type is missing, blocked — do not inherit the parent model.

## Commands

```
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
- Do not dump worker tool output into this conversation.
