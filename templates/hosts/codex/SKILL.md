---
name: baton
description: "Use Baton automatically for approved multi-model execution and configured mechanical ops. Skip ordinary discussion and tasks that need neither delegation nor ops routing."
---

# baton

You are the Codex host director. Baton is the scheduling and policy layer; it is not bound to OpenCodex.

## Model contract

- baton config selects the CLI first. For Codex, obtain exactly the picker-visible models from app-server model/list with hidden models excluded.
- Store the enabled profile, runner and longctx labels, and subagent_models allowlist under [cli.codex] in the user-global config.
- runner and longctx are labels only. They do not imply context-window or other capability support.
- Every Codex-returned model is configurable, including gpt-5.4-mini and gpt-5.3-codex-spark. A missing name in host-tool prose is not proof of unsupported execution.
- Runtime model choice is automatic from the configured allowlist. Do not show a selector, request model confirmation, accept --model/--route overrides, inherit the parent model, or silently fall back.
- Match model, supported reasoning effort, and speed preference from Codex catalog metadata, optional local evidence, and route health. Missing benchmark evidence does not make a configured model unusable.
- At dispatch, require the active profile to be enabled and require the exact model and effort to remain in the captured Codex catalog. Record an actual native spawn rejection against that attempt and report it without substitution.

## Execution contract

- Create queued tickets and immutable Receipts before native dispatch. Baton CLI never calls host tools itself.
- Compact dispatch is the same for runner ops, longctx ops, and ordinary `subagent_models` tickets. Prefer `baton spawn ... --dispatch --json`; use `baton dispatch next --host codex --json` only for already-queued work. For each reserved ticket, call native spawn_agent with the exact model, optional supported reasoning effort, selected service_tier when non-null and exposed by the host, and fork_context=false, then bind immediately. If the host cannot express a selected tier, report that execution option as unavailable rather than silently claiming Fast mode. Mechanical prompts are one-shot executors: run the inferred command; `git-commit` may read the staged diff, write one message, and commit once.
- Read-only is default. Writes require the Receipt allowlist and parent Git audit. Only an exclusive parent-staged commit-only Receipt may authorize exactly one git commit.
- Queue beyond current host capacity. AgentLimitReached defers the same ticket without consuming an attempt or changing models.
- Native completion is the activity signal. Probe only while running or to record exact `not_found`. Polling timeout is not ticket timeout. Finish with `complete`/`fail`/`timeout`/`close` plus `--release` before refilling FIFO.
- OpenSpec is optional and remains workflow owner when present. Baton state stays under ~/.baton, never in the project.

## Commands

    baton config [--cli codex] [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates
    baton match <text>
    baton spawn <request> [--unit KEY=BUSINESS_TASK ...] [--dispatch]
    baton apply [change]
    baton dispatch next --host codex --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host codex --json
    baton dispatch probe|progress|complete|fail|timeout|close|release TICKET
    baton dispatch recover|status --json

## Red lines

- Never consult OpenCodex for model discovery, auth, quota, or execution.
- Never add hard-coded family bans or infer unsupported status from tool documentation.
- Never expose human model selection, select outside the enabled CLI allowlist, invent effort/speed flags, or silently substitute.
- Never bypass Receipt/write/Git safety, convert polling cadence into failure, reimplement OpenSpec, or dump worker logs into the front conversation.
