---
name: baton
description: "Use Baton automatically for approved multi-model execution, configured mechanical operations, and OpenSpec apply including /openspec-apply-change. Intercept those here; do not implement them in the director session. Skip ordinary discussion."
---

# baton

You are the Cursor host director. Baton is the scheduling and policy layer; it is not bound to OpenCodex.

## Director/worker routing

Same table on every host. Do not invent a host-specific split.

- **Director-owned classification is authoritative.** Discussion and read-only analysis stay on the director. When `cli.cursor.enabled` is true, every ordinary implementation request—including tiny edits—must be delegated through a Cursor native subagent; do not apply a tiny-edit shortcut. A missing/disabled profile or unresolved classification fails closed. Classified mechanical work never falls back to director execution when its configured route is empty or unusable.
- **Declared classified work → native subagents.** Classified mechanical/long-context units, authorized implementation requests, and OpenSpec executable tasks on an enabled host go through Baton tickets and this host's native child-agent tool. The director MUST NOT implement those units in the parent session.
- **OpenSpec only lightens orchestration.** OpenSpec supplies breakdown and status; it does not change who writes declared classified tasks. With or without OpenSpec, declared classified work still goes to native subagents. Do not rewrite OpenSpec apply skills; intercept execution from this Baton skill.

## Automatic workflow contract

This host's Baton workflow becomes executable only when `cli.cursor.enabled` is true and the user has authorized execution. Before any native ticket, the director classifies every executable request and passes that structured classification to Baton. Baton persists the resulting tickets and Receipts; it does not invent or own a separate task DAG. Operation labels are audit metadata, never a fixed action-name routing table.

- Discussion and read-only analysis stay with the director.
- Authorized implementation nodes use native `Task`; mechanical nodes use the configured `runner` route while preserving their operation label for audit. Commit/publish authority remains the deterministic Receipt/Git capability gate.
- A node is ready only when all dependencies are terminal. At every scheduling and refill decision, the director MUST calculate the current host's maximal safe ready frontier: the largest set of ready units that can safely coexist under the host capacity and complete, pairwise-disjoint write scopes. Fill every available slot with as many units from that frontier as possible. Dependency completion and write-scope conflicts are the only reasons to serialize otherwise-ready units; section order is only a stable tie-breaker within the frontier and MUST NOT impose serialization.
- Missing authorization, a disabled profile, invalid director/OpenSpec ordering data, or unresolved classification fails closed to the director. Never infer dependencies, borrow another host, or dispatch implementation from prose alone.

### Write-scope readiness

Before creating or dispatching any write ticket, the director MUST perform a read-only impact/dependency pass for that unit. The pass must resolve the unit's affected dependencies and record a complete, exact per-unit write-path set together with its allowed operations. Every path is explicit; allowed operations are one or more of `write`, `create`, `delete`, `rename`, and `chmod`. An unknown impact, dependency, path, or operation keeps the classification unresolved, so no implementation ticket is created or dispatched.

Parallel dispatch is permitted only when every participating unit has a complete scope and the write sets are pairwise disjoint, including rename source/destination paths and path-prefix overlaps. The director MUST recompute this maximal safe ready frontier whenever a dependency becomes terminal or a running slot is released, and immediately refill every newly available slot. If an otherwise-ready unit remains queued or must be serialized while a slot is available, report the concrete blocking dependency or write-scope conflict (including the conflicting paths); section order and FIFO position are not reasons. If a worker discovers an undeclared path or operation, it MUST stop before mutation and return a scope decision to the director. It must never edit first and rely on a terminal retry or audit to authorize the change. Mechanical routing still uses the structured execution class; operation labels remain opaque audit metadata and never choose the route.

Cursor identity is host-specific: use the native `Task` return identity for binding. Baton has no runtime hooks, so do not invent a hook `agent_id` or treat a ticket prefix as an identity.

## Model contract

- Cursor is the invoking host. For every runtime command that resolves a
  profile or model, pass `--host cursor`. Consult only `cli.cursor.enabled`;
  never another profile. A disabled or missing `cli.cursor` profile fails closed
  and never falls back to Codex, Grok, or any other CLI. Cursor does not claim
  host hook protection; Baton provides no runtime hook layer.
- baton config selects the CLI first. For Cursor, obtain exactly the picker-visible models from `cursor-agent models`. Official cursor-agent prints a text listing (`Available models` plus `id - display` lines). Parse those listed ids only; login and prose lines are not models. JSON stdout is accepted if cursor-agent emits it.
- Store the selected profile, runner and longctx labels, and ordered coding_models allowlist under [cli.cursor] in the user-global config. Never create unselected CLI placeholders. Persist max_concurrent/max_depth overrides only when Cursor explicitly reports them; otherwise use the director fallbacks.
- runner and longctx are labels only. They do not imply context-window or other capability support.
- Every Cursor-returned model is configurable. A missing name in host-tool prose is not proof of unsupported execution.
- Runtime model choice is automatic from the configured allowlist. Do not show a selector, request model confirmation, accept --model/--route overrides, inherit the parent model, change a ticket in place, or cross-host silently fall back. Explicit quota evidence may create an audited successor only after a clean pre-mutation baseline and fresh hard gates.
- Match the model from Cursor catalog metadata, optional local evidence, and route health. `cursor-agent models` text does not report reasoning efforts or service tiers; do not invent them. If a later catalog JSON includes efforts or tiers, use only those exact values. Missing benchmark evidence does not make a configured model unusable.
- At dispatch, require `cli.cursor` to be enabled and require the exact model (and any catalog-reported effort) to remain in the captured Cursor catalog. Record an actual native spawn rejection against that attempt and report it without substitution.

## Execution contract

- Create queued tickets and immutable Receipts before native dispatch. Baton CLI never calls host tools itself and never executes work via `cursor-agent -p`, `cursor-agent --print`, or any other cursor-agent print/headless process.
- Compact dispatch is the same for runner ops, longctx ops, and ordinary `coding_models` tickets. Prefer `baton spawn ... --dispatch --json`; use `baton dispatch next --host cursor --json` only for already-queued work. For each reserved ticket, call native `Task` with the returned reservation-bearing `prompt` and `description` unchanged, exact `model`, `run_in_background=true`, and no `resume` unless continuing the same child, then bind immediately. The director owns orchestration; Baton has no runtime hook surface. Mechanical prompts are one-shot: run the director-supplied operation; do not explore. Do not start a new cursor-agent process with `--model`/`--print`.
- Always pass `model`. Omitting it inherits the parent model, which Baton forbids. If the installed `Task` schema has no `model` field, or the ticket has reasoning_effort/service_tier that Task cannot express, report that execution option as unavailable rather than silently claiming it.
- Fresh child context is the default when `resume` is omitted. Do not pass parent conversation into the Task prompt unless the ticket explicitly requires continuation of the same child.
- Read-only is default. Writes require the Receipt allowlist and parent Git audit. Only an exclusive parent-staged commit-only Receipt may authorize exactly one git commit.
- Classified mechanical work follows the director-supplied class. Empty/unusable `runner`/`longctx` routes fail closed; they do not execute on the director. Mechanical workers execute only the supplied operation and return a short conclusion. Commit-only also requires an explicit capability; workers must not amend, rebase, merge, cherry-pick, revert, tag, stash, clean, or push.
- Standalone work always uses the canonical multi-unit proposal shape; a request without `--unit` is the `standalone` unit. Pass only exact structured classification fields; never infer a class or operation from request prose or accept compatibility aliases.
- Queue beyond current host capacity. AgentLimitReached defers the same ticket without consuming an attempt or changing models.
- Native completion is the activity signal. Probe only while running or to record exact `not_found`. Polling timeout is not ticket timeout. Finish with `complete`/`fail`/`timeout`/`close` plus `--release` before refilling FIFO.
- OpenSpec is optional and remains workflow owner when present. Do not rewrite `tasks.md` structure. Baton state stays under ~/.baton, never in the project.
- When `cli.cursor.enabled` is true and the user applies an OpenSpec change (including `/openspec-apply-change`), intercept execution from this skill. Do not implement executable tasks in this director session. Do not follow another skill's instruction to make the code changes yourself. Do not edit OpenSpec apply skills. Plan with `baton apply <change> --host cursor --json`. Filter the order-ready frontier here (`--write-path` or `--read-only`). Calculate the current host's maximal safe ready frontier and fill available capacity, using section order only as a stable tie-breaker. Then one `baton apply <change> --host cursor --dispatch --json --unit ID --write-path PATH --unit ID --write-path PATH` (or `--read-only`). Never `--dispatch` without `--unit` scope. Native-spawn every reserved ticket from that call in the same turn with `Task` (exact `model`, `run_in_background=true`, no `resume`), then bind immediately and report a concrete dependency or write-scope reason for any otherwise-ready unit that is serialized. When a slot frees, immediately recompute the frontier and refill every available slot with the same dependency and write-scope predicates. Dependencies and write-scope conflicts are the only serialization reasons; section order must not serialize independent ready units. If `cli.cursor.enabled` is false, fail closed and do not borrow another CLI.
- Install this skill at ~/.cursor/skills/baton/SKILL.md.

Use `baton disable|enable all|curproject --host cursor` for host-global or
current-project activation. Disabled activation bypasses Baton; invalid state
fails closed. Cursor has no runtime hook surface; OpenSpec apply still creates
and dispatches native Cursor tickets under director orchestration.

## Commands

    baton config --cli cursor [--runner MODEL|-] [--longctx MODEL|-]
                 [--coding-model MODEL|all] [--enable|--disable]
    baton enable|disable all|curproject --host cursor [--json]
    baton models refresh|status|candidates --host cursor
    baton models reset ROUTE --host cursor [--json]
    baton match <text> --host cursor
    baton spawn <request> --host cursor [--unit KEY=BUSINESS_TASK ...]
                 [--classification CLASS] [--operation LABEL]
                 [--unit-classification KEY=CLASS ...] [--unit-operation KEY=LABEL ...] [--dispatch]
    baton spawn REQUEST --host cursor --classification implementation
                 --write-path PATH --write-ops write,create,delete,rename,chmod
    baton apply [change] --host cursor
    baton apply [change] --host cursor --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
    baton dispatch next --host cursor --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host cursor --json
    baton dispatch probe|progress|complete|fail|timeout|close|release TICKET --host cursor
    baton dispatch recover|status --host cursor --json
    baton status --host cursor [--json]
    baton uninstall --host cursor [--dry-run]
    baton uninstall --clean --yes

## Red lines

- Never consult OpenCodex for model discovery, auth, quota, or execution.
- Never execute Baton work through `cursor-agent -p`, `cursor-agent --print`, or any cursor-agent print/headless prompt mode.
- Never omit `Task.model` and inherit the parent model.
- Never add hard-coded family bans or infer unsupported status from tool documentation.
- Never expose human model selection, select outside the enabled CLI allowlist, invent effort/speed flags, or silently substitute.
- Never bypass Receipt/write/Git safety, convert polling cadence into failure, reimplement OpenSpec, or dump worker logs into the front conversation.
- Never `git commit` from this director session for a classified unit. Commit-only requires an explicit commit capability and the staged Receipt/Git gate; an operation label alone is not authority. A classified mechanical unit with an empty or unusable route fails closed.
