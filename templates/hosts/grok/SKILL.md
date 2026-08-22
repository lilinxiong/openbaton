---
name: baton
description: "Use Baton automatically for approved multi-model execution and configured mechanical ops. Skip ordinary discussion and tasks that need neither delegation nor ops routing."
---

# baton

You are the Grok host director. Baton is the scheduling and policy layer; it is not bound to OpenCodex.

## Model contract

- baton config selects the CLI first. For Grok, obtain exactly the picker-visible models from `grok models`. Official grok prints a text listing (`Available models:` plus `*`/`-` ids). Parse those listed ids only; login and prose lines are not models. JSON stdout is accepted if Grok emits it. Custom models come from ~/.grok/config.toml and appear only if Grok lists them.
- Store the enabled profile, runner and longctx labels, and subagent_models allowlist under [cli.grok] in the user-global config.
- runner and longctx are labels only. They do not imply context-window or other capability support.
- Every Grok-returned model is configurable. A missing name in host-tool prose is not proof of unsupported execution.
- Runtime model choice is automatic from the configured allowlist. Do not show a selector, request model confirmation, accept --model/--route overrides, inherit the parent model, or silently fall back.
- Match the model from Grok catalog metadata, optional local evidence, and route health. `grok models` text does not report reasoning efforts or service tiers; do not invent them. If a later catalog JSON includes efforts or tiers, use only those exact values. Missing benchmark evidence does not make a configured model unusable.
- At dispatch, require the active profile to be enabled and require the exact model (and any catalog-reported effort) to remain in the captured Grok catalog. Record an actual native spawn rejection against that attempt and report it without substitution.

## Execution contract

- Create queued tickets and immutable Receipts before native dispatch. Baton CLI never calls host tools itself and never executes work via `grok -p` or any other grok print/headless process.
- Reserve with `baton dispatch next --host grok`. Call native `spawn_subagent` with the exact ticket model on the `model` field, `background=true`, no `resume_from` (independent context, fork_context=false), then bind the returned subagent id. Do not start a new grok process with `-m`/`--model`/`--effort`/`-p`.
- Always pass `model`. Omitting it inherits the parent model, which Baton forbids. If the installed `spawn_subagent` schema has no `model` field, or the ticket has reasoning_effort/service_tier that spawn_subagent cannot express, report that execution option as unavailable rather than silently claiming it.
- Read-only is default. Writes require the Receipt allowlist and parent Git audit. Only an exclusive parent-staged commit-only Receipt may authorize exactly one git commit.
- Queue beyond current host capacity. AgentLimitReached defers the same ticket without consuming an attempt or changing models.
- Wait using activity probes. Polling timeout is not ticket timeout. Close and release terminal agents before refilling FIFO.
- OpenSpec is optional and remains workflow owner when present. Baton state stays under ~/.baton, never in the project.
- Install this skill at ~/.grok/skills/baton/SKILL.md. `grok inspect [--json]` shows discovered config including skills.

## Commands

    baton config [--cli grok] [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates
    baton match <text>
    baton spawn <request> [--unit KEY=BUSINESS_TASK ...]
    baton apply [change]
    baton dispatch next --host grok --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host grok --json
    baton dispatch probe|progress|complete|fail|timeout|close|release TICKET
    baton dispatch recover|status --json

## Red lines

- Never consult OpenCodex for model discovery, auth, quota, or execution.
- Never execute Baton work through `grok -p`, `grok -m`, or any Grok print/headless prompt mode.
- Never omit `spawn_subagent.model` and inherit the parent model.
- Never add hard-coded family bans or infer unsupported status from tool documentation.
- Never expose human model selection, select outside the enabled CLI allowlist, invent effort/speed flags, or silently substitute.
- Never bypass Receipt/write/Git safety, convert polling cadence into failure, reimplement OpenSpec, or dump worker logs into the front conversation.
