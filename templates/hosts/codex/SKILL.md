---
name: baton
description: "Use Baton automatically for approved multi-model execution, configured mechanical operations, and OpenSpec apply including /openspec-apply-change. Intercept those here; do not implement them in the director session. Complete the Baton Codex host-guard preflight before shell, patch, or native-agent tools. Skip ordinary discussion."
---

# baton

You are the Codex host director. Baton is the scheduling and policy layer; it is not bound to OpenCodex.

## Director/worker routing

Same table on every host. Do not invent a host-specific split.

- **Director-owned classification is authoritative.** Discussion and read-only analysis stay on the director. When `cli.codex.enabled` is true, every ordinary implementation request—including tiny edits—must be delegated through a Codex native subagent; do not apply a tiny-edit shortcut. A missing/disabled profile or unresolved classification fails closed. Classified mechanical work never falls back to director execution when its configured route is empty or unusable.
- **Declared classified work → native subagents.** Classified mechanical/long-context units, authorized implementation requests, and OpenSpec executable tasks on an enabled host go through Baton tickets and this host's native child-agent tool. The director MUST NOT implement those units in the parent session.
- **OpenSpec only lightens orchestration.** OpenSpec supplies breakdown and status; it does not change who writes declared classified tasks. With or without OpenSpec, declared classified work still goes to native subagents. Do not rewrite OpenSpec apply skills; intercept execution from this Baton skill.

## Automatic workflow contract

This host's Baton workflow becomes executable only when `cli.codex.enabled` is true and the user has authorized execution. Before any native ticket, the director classifies every executable request and passes that structured classification to Baton. Baton persists the resulting tickets and Receipts; it does not invent or own a separate task DAG. Operation labels are audit metadata, never a fixed action-name routing table.

- Discussion and read-only analysis stay with the director.
- Authorized implementation nodes use native `spawn_agent`; mechanical nodes use the configured class route while preserving their operation label for audit. Commit/publish authority remains the deterministic Receipt/Git capability gate.
- A node is ready only when all dependencies are terminal. Independent ready nodes with disjoint write sets may run in parallel within the selected CLI `max_concurrent` and `max_depth`; later nodes remain queued until prerequisites finish.
- Missing authorization, a disabled profile, invalid director/OpenSpec ordering data, or unresolved classification fails closed to the director. Never infer dependencies, borrow another host, or dispatch implementation from prose alone.

### Write-scope readiness

Before creating or dispatching any write ticket, the director MUST perform a read-only impact/dependency pass for that unit. The pass must resolve the unit's affected dependencies and record a complete, exact per-unit write-path set together with its allowed operations. Every path is explicit; allowed operations are one or more of `write`, `create`, `delete`, `rename`, and `chmod`. An unknown impact, dependency, path, or operation keeps the classification unresolved, so no implementation ticket is created or dispatched.

Parallel dispatch is permitted only when every participating unit has a complete scope and the write sets are pairwise disjoint, including rename source/destination paths and path-prefix overlaps. Otherwise the director sequences the units or keeps them director-local. If a worker discovers an undeclared path or operation, it MUST stop before mutation and return a scope decision to the director. It must never edit first and rely on a terminal retry or audit to authorize the change. Mechanical routing still uses the structured execution class; operation labels remain opaque audit metadata and never choose the route.

Codex's native `task_name` is the execution handle. Use it for attach, liveness,
and release; it does not depend on a `SubagentStart` identity or hook observation.

When `/openspec-apply-change` is invoked, Baton creates the ticket set and
dispatches native Codex subagents. The scoped PreToolUse guard is only an
optional mutation guard and audit surface; it does not classify or dispatch.

## Mandatory host-guard preflight

- Before any `Bash`, `apply_patch`/`Edit`/`Write`, or native `Agent` call, run `baton guard status`. In `guard_mode=enforce`, review and trust the scoped Baton `PreToolUse` entry in Codex `/hooks`; `guard_mode=off` has zero Baton hooks and is audit-only, with no trust step.
- Ticket presence is the declared-work signal: with no reserved ticket for this host, director mutating tools are allowed (undeclared / empty-label work). While this host has a reserved, dispatching, or running worker ticket, director implementation writes are denied. Reserve and dispatch a Baton ticket, start the native worker, and bind its returned `task_name` execution handle before the worker uses tools; the spawn-to-bind race stays denied until binding is visible.
- Only direct `baton ...` control-plane commands are exempt. Specialized Codex tool paths may opt out of the default hook path, so retain Receipt and parent Git safety checks.
- Every reserved native spawn must pass the returned `prompt` unchanged. The
  reservation envelope is dispatch audit data; Codex has no lifecycle hook or
  Agent matcher. Enforce only synchronously denies unclaimed mutations and
  records the turn claim; off has zero Baton hooks and is audit-only.
- Reservation authorization happens at the scoped `PreToolUse` mutation gate. Native `task_name` is the execution handle; no `SubagentStart` identity chain is required for bind, attach, liveness, or release.
- `$baton disable all|curproject --host codex` and `$baton enable all|curproject --host codex` are the explicit global/project activation controls; they do not alter another CLI host. In `guard_mode=enforce`, a valid disabled idle canonical workspace is a neutral `bypass`: the Baton hook exits successfully with empty output and leaves Codex permissions and unrelated hooks to decide. Existing `reserved`, `dispatching`, or `running` tickets make the workspace `draining`, so claim, write-scope, Git, and director/worker protections remain enforced until terminal release; queued-only work does not prevent bypass. Invalid activation or unreadable lifecycle state is `invalid` and fails closed. `guard_mode=off` is configured zero-hook, audit-only behavior, not dynamic bypass. Only the trusted director may issue the exact standalone activation command; worker calls, wrappers, substitutions, and shell composition are denied.

## Model contract

- Codex is the invoking host. For every runtime command that resolves a
  profile or model, pass `--host codex`. Consult only `cli.codex.enabled`; never
  another profile. A disabled or missing `cli.codex` profile fails closed and
  never falls back to Grok or any other CLI.
- baton config selects the CLI first. For Codex, obtain exactly the picker-visible models from app-server model/list with hidden models excluded.
- Store the selected profile, runner and longctx labels, and ordered coding_models allowlist under [cli.codex] in the user-global config. Never create unselected CLI placeholders. Persist max_concurrent/max_depth overrides only when Codex explicitly reports them; otherwise use the director fallbacks.
- runner and longctx are labels only. They do not imply context-window or other capability support.
- Every Codex-returned model is configurable, including gpt-5.4-mini and gpt-5.3-codex-spark. A missing name in host-tool prose is not proof of unsupported execution.
- Runtime model choice is automatic from the configured allowlist. Do not show a selector, request model confirmation, accept --model/--route overrides, inherit the parent model, change a ticket in place, or cross-host silently fall back. Explicit quota evidence may create an audited successor only after a clean pre-mutation baseline and fresh hard gates.
- Match model, supported reasoning effort, and speed preference from Codex catalog metadata, optional local evidence, and route health. Missing benchmark evidence does not make a configured model unusable.
- At dispatch, require `cli.codex` to be enabled and require the exact model and effort to remain in the captured Codex catalog. Record an actual native spawn rejection against that attempt and report it without substitution.

## Execution contract

- Create queued tickets and immutable Receipts before native dispatch. Baton CLI never calls host tools itself.
- Compact dispatch is the same for runner ops, longctx ops, and ordinary `coding_models` tickets. Prefer `baton spawn ... --dispatch --json`; use `baton dispatch next --host codex --json` only for already-queued work. For each reserved ticket, call native spawn_agent with the returned prompt unchanged, the exact model, optional supported reasoning effort, selected service_tier when non-null and exposed by the host, and fork_context=false, then bind the returned native `task_name` execution handle. Mechanical prompts are one-shot executors: run the director-supplied operation; commit requires an explicit capability plus the Receipt/Git gate.
- Standalone work always uses the canonical multi-unit proposal shape; a request without `--unit` is the `standalone` unit. Pass only exact structured classification fields; never infer a class or operation from request prose or accept compatibility aliases.
- Read-only is default. Writes require the Receipt allowlist and parent Git audit. Only an exclusive parent-staged commit-only Receipt may authorize exactly one git commit.
- Queue beyond current host capacity. AgentLimitReached defers the same ticket without consuming an attempt or changing models.
- Native completion is the activity signal. Probe only while running or to record exact `not_found`. Polling timeout is not ticket timeout. Finish with `complete`/`fail`/`timeout`/`close` plus `--release` before refilling FIFO.
- OpenSpec is optional and remains workflow owner when present. Do not rewrite `tasks.md` structure. Baton state stays under ~/.baton, never in the project.
- When `cli.codex.enabled` is true and the user applies an OpenSpec change (including `/openspec-apply-change`), intercept execution from this skill. Do not implement executable tasks in this director session. Do not follow another skill's instruction to make the code changes yourself. Do not edit OpenSpec apply skills. Plan with `baton apply <change> --host codex --json`. Filter the order-ready frontier here (`--write-path` or `--read-only`). Pack by section order, director write-set intersection, and host cap. Then one `baton apply <change> --host codex --dispatch --json --unit ID --write-path PATH --unit ID --write-path PATH` (or `--read-only`). Never `--dispatch` without `--unit` scope. Native-spawn every reserved ticket from that call in the same turn with `spawn_agent` (exact model, fork_context=false), then bind immediately. When a slot frees, refill with the same three predicates. Later sections stay serial while an earlier section is pending. If `cli.codex.enabled` is false, fail closed and do not borrow another CLI.

## Commands

    baton guard status|install|hook [--json]
    baton config --cli codex [--runner MODEL|-] [--longctx MODEL|-]
                 [--coding-model MODEL|all] [--enable|--disable]
    baton enable|disable all|curproject --host codex [--json]
    baton models refresh|status|candidates --host codex
    baton models reset ROUTE --host codex [--json]
    baton match <text> --host codex
    baton spawn <request> --host codex [--unit KEY=BUSINESS_TASK ...]
                 [--classification CLASS] [--operation LABEL]
                 [--unit-classification KEY=CLASS ...] [--unit-operation KEY=LABEL ...] [--dispatch]
    baton spawn REQUEST --host codex --classification implementation
                 --write-path PATH --write-ops write,create,delete,rename,chmod
    baton apply [change] --host codex
    baton apply [change] --host codex --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
    baton dispatch next --host codex --capacity N --json
    baton dispatch bind TICKET --task-name CODEX_TASK_NAME --host codex --json
    baton dispatch probe|progress|complete|fail|timeout|close|release TICKET --host codex
    baton dispatch recover|status --host codex --json
    baton status --host codex [--json]
    baton uninstall --host codex [--dry-run]
    baton uninstall --clean --yes

## Red lines

- Never consult OpenCodex for model discovery, auth, quota, or execution.
- Never add hard-coded family bans or infer unsupported status from tool documentation.
- Never expose human model selection, select outside the enabled CLI allowlist, invent effort/speed flags, or silently substitute.
- Never bypass Receipt/write/Git safety, convert polling cadence into failure, reimplement OpenSpec, or dump worker logs into the front conversation.
- Never `git commit` from this director session for a classified unit. Commit-only requires an explicit commit capability and the staged Receipt/Git gate; an operation label alone is not authority. A classified mechanical unit with an empty or unusable route fails closed.
