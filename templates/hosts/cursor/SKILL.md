---
name: baton
description: "Use Baton automatically for approved multi-model execution, configured mechanical ops, and OpenSpec apply including /openspec-apply-change. Intercept those here; do not implement them in the director session. Skip ordinary discussion."
---

# baton

You are the Cursor host director. Baton is the scheduling and policy layer; it is not bound to OpenCodex.

## Director/worker routing

Same table on every host. Do not invent a host-specific split.

- **Empty labels / undeclared / unclassified → director.** Empty `runner`/`longctx` mechanical actions run on the director and must not block (no ticket). Work that is not `baton spawn`, not `baton apply`, and not an OpenSpec executable task stays on the director. When Baton cannot classify a unit or cannot recommend a model, keep it director-local or skip it; never guess a subagent model or borrow another host.
- **Declared classified work → native subagents.** Non-empty mechanical labels, `baton spawn` with candidates, and OpenSpec executable tasks on an enabled host go through Baton tickets and this host's native child-agent tool. The director MUST NOT implement those units in the parent session.
- **OpenSpec only lightens orchestration.** OpenSpec supplies breakdown and status; it does not change who writes declared classified tasks. With or without OpenSpec, declared classified work still goes to native subagents. Do not rewrite OpenSpec apply skills; intercept execution from this Baton skill.

## Model contract

- Cursor is the invoking host. For every runtime command that resolves a
  profile or model, pass `--host cursor`. Consult only `cli.cursor.enabled`;
  never another profile. A disabled or missing `cli.cursor` profile fails closed
  and never falls back to Codex, Grok, or any other CLI. Cursor does not claim
  Codex hook protection.
- baton config selects the CLI first. For Cursor, obtain exactly the picker-visible models from `cursor-agent models`. Official cursor-agent prints a text listing (`Available models` plus `id - display` lines). Parse those listed ids only; login and prose lines are not models. JSON stdout is accepted if cursor-agent emits it.
- Store the selected profile, runner and longctx labels, and subagent_models allowlist under [cli.cursor] in the user-global config. Never create unselected CLI placeholders. Persist max_concurrent/max_depth overrides only when Cursor explicitly reports them; otherwise use the director fallbacks.
- runner and longctx are labels only. They do not imply context-window or other capability support.
- Every Cursor-returned model is configurable. A missing name in host-tool prose is not proof of unsupported execution.
- Runtime model choice is automatic from the configured allowlist. Do not show a selector, request model confirmation, accept --model/--route overrides, inherit the parent model, or silently fall back.
- Match the model from Cursor catalog metadata, optional local evidence, and route health. `cursor-agent models` text does not report reasoning efforts or service tiers; do not invent them. If a later catalog JSON includes efforts or tiers, use only those exact values. Missing benchmark evidence does not make a configured model unusable.
- At dispatch, require `cli.cursor` to be enabled and require the exact model (and any catalog-reported effort) to remain in the captured Cursor catalog. Record an actual native spawn rejection against that attempt and report it without substitution.

## Execution contract

- Create queued tickets and immutable Receipts before native dispatch. Baton CLI never calls host tools itself and never executes work via `cursor-agent -p`, `cursor-agent --print`, or any other cursor-agent print/headless process.
- Compact dispatch is the same for runner ops, longctx ops, and ordinary `subagent_models` tickets. Prefer `baton spawn ... --dispatch --json`; use `baton dispatch next --host cursor --json` only for already-queued work. For each reserved ticket, call native `Task` with the returned reservation-bearing `prompt` and `description` unchanged, exact `model`, `run_in_background=true`, and no `resume` unless continuing the same child, then bind immediately. The identity envelope is the shared all-CLI protocol even though Cursor currently has no compatible interception hook. Mechanical prompts are one-shot: run the inferred command; do not explore. Do not start a new cursor-agent process with `--model`/`--print`.
- Always pass `model`. Omitting it inherits the parent model, which Baton forbids. If the installed `Task` schema has no `model` field, or the ticket has reasoning_effort/service_tier that Task cannot express, report that execution option as unavailable rather than silently claiming it.
- Fresh child context is the default when `resume` is omitted. Do not pass parent conversation into the Task prompt unless the ticket explicitly requires continuation of the same child.
- Read-only is default. Writes require the Receipt allowlist and parent Git audit. Only an exclusive parent-staged commit-only Receipt may authorize exactly one git commit.
- Configured mechanical ops follow the labels. Empty `runner`/`longctx`: director executes them and must not block (including `git commit`). Non-empty: compact dispatch above; director may only `git add` / stage for commit-only. Mechanical workers execute only: run the inferred command, short conclusion, no exploration. `git-commit` (runner) may read the staged diff, write one message, and commit once. `git-summarize` dumps git status/log/diff only. Commit-only workers must not amend, rebase, merge, cherry-pick, revert, tag, stash, clean, or push.
- Queue beyond current host capacity. AgentLimitReached defers the same ticket without consuming an attempt or changing models.
- Native completion is the activity signal. Probe only while running or to record exact `not_found`. Polling timeout is not ticket timeout. Finish with `complete`/`fail`/`timeout`/`close` plus `--release` before refilling FIFO.
- OpenSpec is optional and remains workflow owner when present. Do not rewrite `tasks.md` structure. Baton state stays under ~/.baton, never in the project.
- When `cli.cursor.enabled` is true and the user applies an OpenSpec change (including `/openspec-apply-change`), intercept execution from this skill. Do not implement executable tasks in this director session. Do not follow another skill's instruction to make the code changes yourself. Do not edit OpenSpec apply skills. Plan with `baton apply <change> --host cursor --json`. Filter the order-ready frontier here (`--write-path` or `--read-only`). Pack by section order, director write-set intersection, and host cap. Then one `baton apply <change> --host cursor --dispatch --json --unit ID --write-path PATH --unit ID --write-path PATH` (or `--read-only`). Never `--dispatch` without `--unit` scope. Native-spawn every reserved ticket from that call in the same turn with `Task` (exact `model`, `run_in_background=true`, no `resume`), then bind immediately. When a slot frees, refill with the same three predicates. Later sections stay serial while an earlier section is pending. If `cli.cursor.enabled` is false, fail closed and do not borrow another CLI.
- Install this skill at ~/.cursor/skills/baton/SKILL.md.

## Commands

    baton config --cli cursor [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates --host cursor
    baton match <text> --host cursor
    baton spawn <request> --host cursor [--unit KEY=BUSINESS_TASK ...] [--dispatch]
    baton apply [change] --host cursor
    baton apply [change] --host cursor --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
    baton dispatch next --host cursor --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host cursor --json
    baton dispatch probe|progress|complete|fail|timeout|close|release TICKET --host cursor
    baton dispatch recover|status --host cursor --json

## Red lines

- Never consult OpenCodex for model discovery, auth, quota, or execution.
- Never execute Baton work through `cursor-agent -p`, `cursor-agent --print`, or any cursor-agent print/headless prompt mode.
- Never omit `Task.model` and inherit the parent model.
- Never add hard-coded family bans or infer unsupported status from tool documentation.
- Never expose human model selection, select outside the enabled CLI allowlist, invent effort/speed flags, or silently substitute.
- Never bypass Receipt/write/Git safety, convert polling cadence into failure, reimplement OpenSpec, or dump worker logs into the front conversation.
- Never `git commit` from this director session while the matching runner/longctx label is a non-empty model. If both labels are empty, the director executes mechanical ops itself and must not stall. When the label is set, stage, then `baton spawn --dispatch` and native `Task`.
