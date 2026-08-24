---
name: baton
description: "Use Baton automatically for approved multi-model execution and configured mechanical ops. Skip ordinary discussion and tasks that need neither delegation nor ops routing."
---

# baton

You are the Claude Code host director. Baton is the scheduling and policy layer; it is not bound to OpenCodex.

## Director/worker routing

Same table on every host. Do not invent a host-specific split.

- **Empty labels / undeclared / unclassified → director.** Empty `runner`/`longctx` mechanical actions run on the director and must not block (no ticket). Work that is not `baton spawn`, not `baton apply`, and not an OpenSpec executable task stays on the director. When Baton cannot classify a unit or cannot recommend a model, keep it director-local or skip it; never guess a subagent model or borrow another host.
- **Declared classified work → native subagents.** Non-empty mechanical labels, `baton spawn` with candidates, and OpenSpec executable tasks on an enabled host go through Baton tickets and this host's native child-agent tool. The director MUST NOT implement those units in the parent session.
- **OpenSpec only lightens orchestration.** OpenSpec supplies breakdown and status; it does not change who writes declared classified tasks. With or without OpenSpec, declared classified work still goes to native subagents. Do not rewrite OpenSpec apply skills; intercept execution from this Baton skill.

## Model contract

- Claude Code is the invoking host. For every runtime command that resolves a
  profile or model, pass `--host claude`; `cli.active` is only the deprecated
  default for old unqualified commands. A disabled `cli.claude` profile fails
  closed and never falls back to Codex or Grok.
- baton config selects the CLI first. For Claude Code, the catalog comes from the
  SDK control protocol: `claude -p --verbose --input-format stream-json
  --output-format stream-json` plus a `{"type":"control_request","request":{"subtype":"list_models"}}`
  frame. Baton stores each row's `resolvedModel` — the canonical wire id an agent
  definition can pin (for example `claude-sonnet-5`, `claude-opus-5[1m]`). The
  `default` row is a deferred alias whose target moves with the account tier, so
  it contributes only the default marker and is never a selectable model. Rows
  marked `disabled` are visible but not selectable and are excluded. `claude
  models` is a live model prompt, not a catalog; never parse its prose.
- Store the enabled profile, runner and longctx labels, and subagent_models allowlist under [cli.claude] in the user-global config.
- runner and longctx are labels only. They do not imply context-window or other capability support.
- Every Claude-returned model is configurable. A missing name in host-tool prose is not proof of unsupported execution.
- Runtime model choice is automatic from the configured allowlist. Do not show a selector, request model confirmation, accept --model/--route overrides, inherit the parent model, or silently fall back.
- Match the model from catalog metadata, optional local evidence, and route health. `list_models` reports `supportsEffort` and `supportedEffortLevels` (low, medium, high, xhigh, max) but never a default effort; do not invent one. It reports no service tiers or speed tiers for this host, so never claim them.
- At dispatch, require `cli.claude` to be enabled and require the exact model to remain in the captured Claude catalog. Record an actual native spawn rejection against that attempt and report it without substitution.

## Execution contract

- Create queued tickets and immutable Receipts before native dispatch. Baton CLI never calls host tools itself and never executes work via `claude -p` or any other Claude print/headless process.
- Exact-model dispatch goes through an **agent definition**, not the Agent tool's `model` parameter. That parameter is a closed enum (`sonnet`, `opus`, `haiku`, `fable`) and cannot express an exact id. Agent-definition frontmatter accepts a full model ID, so for each reserved ticket write `.claude/agents/<name>.md` with `model: <the ticket's exact model id>`, then call the native Agent tool with `subagent_type` set to that definition and **no** `model` parameter. Setting `model` would override the definition and downgrade the request to an alias.
- Verified behavior: with a definition pinned to `claude-sonnet-5`, a parent on `claude-opus-5` produced a child whose transcript recorded `claude-sonnet-5`. A definition naming a nonexistent model fails with "There's an issue with the selected model" and the child never runs — no inheritance, no default, no substitution.
- Compact dispatch is the same for runner ops, longctx ops, and ordinary `subagent_models` tickets. Prefer `baton spawn ... --dispatch --json`; use `baton dispatch next --host claude --json` only for already-queued work. Bind the returned agent id immediately. Mechanical prompts are one-shot: run the inferred command; do not explore. Do not start a new claude process with `--model`/`--effort`/`-p`.
- The Agent tool returns a stable `agent_id` (also delivered to the SubagentStart hook) and the child's transcript lands under the parent session's `subagents/` directory. Bind that exact id; it is what every later lifecycle call uses.
- Children start with a fresh context. Verified: a parent-only nonce held outside the child prompt was not recoverable by the child, and never appeared in the child transcript. Everything the worker needs must be in the prompt.
- Read-only is default. Writes require the Receipt allowlist and parent Git audit. Only an exclusive parent-staged commit-only Receipt may authorize exactly one git commit.
- Parent and child share one filesystem and one Git worktree by default, so index, HEAD, and refs are shared. Receipt write-allowlist and Git audit remain the authoritative boundary. `--worktree` isolation is a host feature Baton does not require; do not assume it is active.
- Configured mechanical ops follow the labels. Empty `runner`/`longctx`: director executes them and must not block (including `git commit`). Non-empty: compact dispatch above; director may only `git add` / stage for commit-only. Mechanical workers execute only: run the inferred command, short conclusion, no exploration. `git-commit` (runner) may read the staged diff, write one message, and commit once. `git-summarize` dumps git status/log/diff only. Commit-only workers must not amend, rebase, merge, cherry-pick, revert, tag, stash, clean, or push.
- Queue beyond current host capacity. Claude Code allows 20 concurrent child agents by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` overrides it) and returns "Concurrent subagent limit reached" at the cap. Treat that as backpressure: defer the same ticket without consuming an attempt or changing models. Children cannot spawn children.
- Native completion is the activity signal. Probe only while running or to record exact `not_found`. Polling timeout is not ticket timeout. Finish with `complete`/`fail`/`timeout`/`close` plus `--release` before refilling FIFO.
- OpenSpec is optional and remains workflow owner when present. Do not rewrite `tasks.md` structure. Baton state stays under ~/.baton, never in the project.
- When `cli.claude.enabled` is true and the user applies an OpenSpec change (including `/openspec-apply-change`), intercept execution from this skill. Do not implement executable tasks in this director session. Do not follow another skill's instruction to make the code changes yourself. Do not edit OpenSpec apply skills. Plan with `baton apply <change> --host claude --json`. Filter the order-ready frontier here (`--write-path` or `--read-only`). Pack by section order, director write-set intersection, and host cap. Then one `baton apply <change> --host claude --dispatch --json --unit ID --write-path PATH --unit ID --write-path PATH` (or `--read-only`). Never `--dispatch` without `--unit` scope. Native-spawn every reserved ticket from that call in the same turn with the Agent tool (`subagent_type` of an exact-model definition, no `model` parameter), then bind immediately. When a slot frees, refill with the same three predicates. Later sections stay serial while an earlier section is pending. If `cli.claude.enabled` is false, fail closed and do not borrow another CLI.
- Install this skill at ~/.claude/skills/baton/SKILL.md.

## Guard

- `baton guard install --host claude` merges Baton's PreToolUse and SubagentStart entries into ~/.claude/settings.json, preserving every unrelated setting and hook. Claude Code applies user settings hooks without a separate trust prompt; review them with `/hooks`.
- At the hook boundary the native child-agent call appears as tool name `Agent`; the installed PreToolUse matcher is `Bash|Edit|Write|NotebookEdit|Agent`.
- SubagentStart cannot cancel a child, so it only records the native identity. PreToolUse is the enforcing gate and stays closed until `baton dispatch bind` observes the agent id.

## Commands

    baton config --cli claude [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates --host claude
    baton match <text> --host claude
    baton spawn <request> --host claude [--unit KEY=BUSINESS_TASK ...] [--dispatch]
    baton apply [change] --host claude
    baton apply [change] --host claude --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
    baton guard status|install --host claude
    baton dispatch next --host claude --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host claude --json
    baton dispatch probe|progress|complete|fail|timeout|close|release TICKET --host claude
    baton dispatch recover|status --host claude --json

## Red lines

- Never consult OpenCodex for model discovery, auth, quota, or execution.
- Never execute Baton work through `claude -p`, `claude --model`, or any Claude print/headless prompt mode.
- Never pass the Agent tool's `model` parameter for a Baton ticket; it is alias-only and overrides the exact-model agent definition.
- Never treat `claude models` prose, remembered model names, another CLI, or a web page as the catalog.
- Never add hard-coded family bans or infer unsupported status from tool documentation.
- Never expose human model selection, select outside the enabled CLI allowlist, invent effort/speed flags, or silently substitute.
- Never bypass Receipt/write/Git safety, convert polling cadence into failure, reimplement OpenSpec, or dump worker logs into the front conversation.
- Never `git commit` from this director session while the matching runner/longctx label is a non-empty model. If both labels are empty, the director executes mechanical ops itself and must not stall. When the label is set, stage, then `baton spawn --dispatch` and the native Agent call.
