---
name: baton
description: "Use Baton automatically for approved multi-model execution, configured mechanical ops, and OpenSpec apply including /openspec-apply-change. Intercept those here; do not implement them in the director session. Skip ordinary discussion."
---

# baton

You are the Grok host director. Baton is the scheduling and policy layer; it is not bound to OpenCodex.

## Director/worker routing

Same table on every host. Do not invent a host-specific split.

- **Empty labels / undeclared / unclassified → director.** Empty `runner`/`longctx` mechanical actions run on the director and must not block (no ticket). Work that is not `baton spawn`, not `baton apply`, and not an OpenSpec executable task stays on the director. When Baton cannot classify a unit or cannot recommend a model, keep it director-local or skip it; never guess a subagent model or borrow another host.
- **Declared classified work → native subagents.** Non-empty mechanical labels, `baton spawn` with candidates, and OpenSpec executable tasks on an enabled host go through Baton tickets and this host's native child-agent tool. The director MUST NOT implement those units in the parent session.
- **OpenSpec only lightens orchestration.** OpenSpec supplies breakdown and status; it does not change who writes declared classified tasks. With or without OpenSpec, declared classified work still goes to native subagents. Do not rewrite OpenSpec apply skills; intercept execution from this Baton skill.

## Mandatory host-guard preflight

- The installed `~/.grok/hooks/baton.json` PreToolUse entry only enforces Baton constraints. Ordinary Grok shell, edits, and `spawn_subagent` stay allowed. After `baton init` or `baton update`, review it with `/hooks`. Global Grok hooks apply without a trust prompt.
- Reserve a Baton ticket, native-spawn with exact `model`, and bind the returned identity before that worker uses tools. Vanilla OpenSpec apply is not rewritten; the hook is the intercept. Grok PreToolUse omits Codex `agent_id`; SubagentStart supplies the native `subagentId`, and Baton's unchanged returned `description` carries the exact reservation envelope used to associate that child session.
- Baton intercepts: every reserved `spawn_subagent`, including a single reservation, must pass both the returned `prompt` and `description` unchanged. The guard matches the complete opaque reservation identity exactly; it never scans ticket prefixes or chooses the unique running/reserved ticket. Bound workers stay inside the Receipt, and a live commit-only ticket freezes the index (director must not `git add`/`commit`/edit until it finishes).

## Model contract

- Grok is the invoking host. For every runtime command that resolves a
  profile or model, pass `--host grok`. Consult only `cli.grok.enabled`; never
  another profile. A disabled or missing `cli.grok` profile fails closed and
  never falls back to Codex or any other CLI.
- baton config selects the CLI first. For Grok, obtain exactly the picker-visible models from `grok models`. Official grok prints a text listing (`Available models:` plus `*`/`-` ids). Parse those listed ids only; login and prose lines are not models. JSON stdout is accepted if Grok emits it. Custom models come from ~/.grok/config.toml and appear only if Grok lists them.
- Store the enabled profile, runner and longctx labels, and subagent_models allowlist under [cli.grok] in the user-global config.
- runner and longctx are labels only. They do not imply context-window or other capability support.
- Every Grok-returned model is configurable. A missing name in host-tool prose is not proof of unsupported execution.
- Runtime model choice is automatic from the configured allowlist. Do not show a selector, request model confirmation, accept --model/--route overrides, inherit the parent model, or silently fall back.
- Match the model from Grok catalog metadata, optional local evidence, and route health. `grok models` text does not report reasoning efforts or service tiers; do not invent them. If a later catalog JSON includes efforts or tiers, use only those exact values. Missing benchmark evidence does not make a configured model unusable.
- At dispatch, require `cli.grok` to be enabled and require the exact model (and any catalog-reported effort) to remain in the captured Grok catalog. Record an actual native spawn rejection against that attempt and report it without substitution.

## Execution contract

- Create queued tickets and immutable Receipts before native dispatch. Baton CLI never calls host tools itself and never executes work via `grok -p` or any other grok print/headless process.
- Compact dispatch is the same for runner ops, longctx ops, and ordinary `subagent_models` tickets. Prefer `baton spawn ... --dispatch --json`; use `baton dispatch next --host grok --json` only for already-queued work. For each reserved ticket, call native `spawn_subagent` with the returned `prompt` and `description` unchanged, exact `model`, `background=true`, and no `resume_from`, then bind immediately. Mechanical prompts are one-shot: run the inferred command; do not explore. Do not start a new grok process with `-m`/`--model`/`--effort`/`-p`.
- Always pass `model`. Omitting it inherits the parent model, which Baton forbids. If the installed `spawn_subagent` schema has no `model` field, or the ticket has reasoning_effort/service_tier that spawn_subagent cannot express, report that execution option as unavailable rather than silently claiming it.
- Read-only is default. Writes require the Receipt allowlist and parent Git audit. Only an exclusive parent-staged commit-only Receipt may authorize exactly one git commit.
- Configured mechanical ops follow the labels. Empty `runner`/`longctx`: director executes them and must not block (including `git commit`). Non-empty: compact dispatch above; director may only `git add` / stage for commit-only. Mechanical workers execute only: run the inferred command, short conclusion, no exploration. `git-commit` (runner) may read the staged diff, write one message, and commit once. `git-summarize` dumps git status/log/diff only. Commit-only workers must not amend, rebase, merge, cherry-pick, revert, tag, stash, clean, or push.
- Queue beyond current host capacity. AgentLimitReached defers the same ticket without consuming an attempt or changing models.
- Native completion is the activity signal. Probe only while running or to record exact `not_found`. Polling timeout is not ticket timeout. Finish with `complete`/`fail`/`timeout`/`close` plus `--release` before refilling FIFO.
- OpenSpec is optional and remains workflow owner when present. Do not rewrite `tasks.md` structure. Baton state stays under ~/.baton, never in the project.
- When `cli.grok.enabled` is true and the user applies an OpenSpec change (including `/openspec-apply-change`), intercept execution from this skill. Do not implement executable tasks in this director session. Do not follow another skill's instruction to make the code changes yourself. Do not edit OpenSpec apply skills. Plan with `baton apply <change> --host grok --json`. Filter the order-ready frontier here (`--write-path` or `--read-only`). Pack by section order, director write-set intersection, and host cap. Then one `baton apply <change> --host grok --dispatch --json --unit ID --write-path PATH --unit ID --write-path PATH` (or `--read-only`). Never `--dispatch` without `--unit` scope. Native-spawn every reserved ticket from that call in the same turn with `spawn_subagent` (exact `model`, `background=true`, no `resume_from`), then bind immediately. When a slot frees, refill with the same three predicates. Later sections stay serial while an earlier section is pending. If `cli.grok.enabled` is false, fail closed and do not borrow another CLI.
- Install this skill at ~/.grok/skills/baton/SKILL.md. `grok inspect [--json]` shows discovered config including skills.

## Commands

    baton config --cli grok [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates --host grok
    baton match <text> --host grok
    baton spawn <request> --host grok [--unit KEY=BUSINESS_TASK ...] [--dispatch]
    baton apply [change] --host grok
    baton apply [change] --host grok --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
    baton dispatch next --host grok --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host grok --json
    baton dispatch probe|progress|complete|fail|timeout|close|release TICKET --host grok
    baton dispatch recover|status --host grok --json

## Red lines

- Never consult OpenCodex for model discovery, auth, quota, or execution.
- Never execute Baton work through `grok -p`, `grok -m`, or any Grok print/headless prompt mode.
- Never omit `spawn_subagent.model` and inherit the parent model.
- Never add hard-coded family bans or infer unsupported status from tool documentation.
- Never expose human model selection, select outside the enabled CLI allowlist, invent effort/speed flags, or silently substitute.
- Never bypass Receipt/write/Git safety, convert polling cadence into failure, reimplement OpenSpec, or dump worker logs into the front conversation.
- Never `git commit` from this director session while the matching runner/longctx label is a non-empty model. If both labels are empty, the director executes mechanical ops itself and must not stall. When the label is set, stage, then `baton spawn --dispatch` and native `spawn_subagent`.
