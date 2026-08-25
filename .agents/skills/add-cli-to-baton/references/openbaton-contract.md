# OpenBaton adapter contract

Use the repository itself as the living contract. File names may evolve, so locate callers and tests rather than assuming this reference is an exhaustive patch list.

## Build the parity baseline

Before editing, inspect the current Codex and Grok implementations and create a compact capability-closure matrix with these columns:

| Capability | Codex | Grok | Target | Required action | Evidence |
|---|---|---|---|---|---|

Cover every shared feature and every host-specific feature you encounter. Shared features are mandatory for a successful target adapter. A host-specific feature such as a native hook is not automatically mandatory merely because one host has it, but it must be evaluated and mapped when the target exposes an equivalent.

Search the current repository for the following extension surfaces and their tests:

- adapter id type, adapter contract, registry, and selected-adapter entry points;
- executable resolution, version probing, model discovery, model normalization, pagination, and coded errors;
- host metadata, concurrency caps, runtime-skill source, install destination, init, and update;
- config defaults, normalization, current-format serialization, enabled profiles, and host resolution;
- route snapshots, model candidates, automatic matching, stale-catalog validation, and model/effort metadata;
- ticket creation, immutable host capture, reserve, bind, progress, wait/probe, terminal recording, release, recovery, and status;
- runner and longctx mechanical labels, read-only/write/commit-only boundaries, Receipts, and Git safety;
- interactive and non-interactive CLI flows, usage/help text, package contents, and English/Chinese documentation;
- host guard or hook integration where the target offers a compatible interception mechanism.

Useful current anchors include `src/adapters/`, `src/lib/config.ts`, `src/lib/hosts.ts`, `src/commands/config.ts`, `src/commands/init.ts`, route/match/spawn/dispatch modules, `templates/hosts/`, and the adapter, model, init, profile, CLI, and dispatch tests. Follow imports and registry-derived callers from those anchors.

## Adapter boundary

Keep host-specific behavior behind the adapter boundary. The target implementation should own:

- stable CLI id and display metadata;
- executable lookup and an explicit executable override when appropriate;
- version discovery that can fail without corrupting the catalog result;
- the target-owned model-list protocol or command;
- conversion to Baton's normalized model and reasoning/service-tier metadata;
- hidden, pagination, duplicate-id, malformed-output, timeout, authentication, and unavailable-command behavior;
- runtime-skill destination and host concurrency/backpressure facts.

Extend the contract when a capability is genuinely shared and callers need it. Do not add a generic field solely to mirror one host's incidental implementation detail.

Implement and test the target module before production registration when practical. Add it to the registered id list and registry only when core host probes have passed and the rest of the code can treat it as supported.

## Model and configuration invariants

- The target CLI is the sole live model-discovery authority.
- Preserve exact model ids. Do not synthesize aliases or fill missing models from another source.
- Exclude hidden models only according to the target's own visibility semantics.
- Preserve supported reasoning efforts, default effort, modalities, speed/service tiers, and default markers when the target exposes them. Missing optional metadata is empty or null, not guessed.
- Only selected CLIs have `cli.<id>` profiles; init never writes unselected placeholder tables. Each present profile has its own `enabled`, `runner`, `longctx`, and `subagent_models` values.
- Director max_concurrent/max_depth are independent fallbacks. Persist a profile override only when the target CLI explicitly reports that value; never turn an adapter guess into CLI-reported configuration.
- There is no global default CLI and no `cli.active` field. Host resolution requires `--host`, `BATON_HOST`, or a unique runtime invoking-host signal.
- Explicit host resolution never falls through to another enabled profile.
- Runner and longctx are user routing labels, not capability claims, and configured labels belong in the target allowlist.
- Dispatch validates the exact selected model and effort against the captured target catalog. A rejected execution remains a rejected exact attempt.

## Director/worker routing invariant

Every new CLI MUST ship the same director/worker routing table in its runtime skill. Same words on every host. Do not invent a host-specific split. A host is incomplete if its runtime skill omits this table or substitutes a host-specific exception.

- **Director-owned classification is authoritative.** Discussion and read-only analysis stay on the director. When the selected profile is enabled, every ordinary implementation request—including tiny edits—must be delegated to that host's native subagent; do not apply a tiny-edit shortcut. Missing/disabled profiles or unresolved classifications fail closed. Classified mechanical work never falls back to director execution when its configured route is empty or unusable.
- **Declared classified work → native subagents.** Classified mechanical/long-context units, authorized implementation requests, and OpenSpec executable tasks on an enabled host go through Baton tickets and this host's native child-agent tool. The director MUST NOT implement those units in the parent session.
- **OpenSpec only lightens orchestration.** OpenSpec supplies breakdown and status; it does not change who writes declared classified tasks. With or without OpenSpec, declared classified work still goes to native subagents. Do not rewrite OpenSpec apply skills; intercept execution from this Baton skill.

Every adapter MUST use the shared dispatch reservation protocol: `dispatch next` returns an opaque per-attempt `reservation` plus `prompt` and `description` with the same first-line JSON envelope. The native tool receives the returned `prompt` unchanged and, when it exposes a description field, the returned `description` unchanged. Ticket ids are opaque data; adapters and guards MUST NOT infer reservation identity from a prefix, business prose, or a unique-ticket fallback.

Native identity is adapter-specific. Codex and Claude Code expose the authoritative child id through lifecycle hooks; Grok carries `subagentId`/session identity in its native lifecycle payload; Cursor has no compatible guard hook and binds the identity returned by `Task`. Keep these field names in per-CLI identity adapters and hand dispatch one normalized identity. A universal `agent_id` assumption, ticket-prefix inference, or unique-ticket fallback is invalid; caller and hook observations must match before a worker is bound.

## Automatic workflow contract

With an enabled selected CLI profile and explicit user authorization, the director classifies every executable request and passes that structured classification before creating native tickets. Baton persists the resulting tickets and Receipts; it does not invent or own a separate task DAG. Discussion and read-only analysis stay on the director. Authorized implementation nodes use the target's native child-agent tool. Mechanical nodes route through the configured class profile; operation labels are audit metadata rather than routing keys, while commit/publish remain deterministic Receipt/Git capabilities. Missing authorization, disabled profile, or unresolved classification fails closed.

### Complete write-scope invariant

Before creating or dispatching any write ticket, the director MUST perform a read-only impact/dependency pass for that unit. The pass records a complete, exact per-unit write-path set and the allowed operations for those paths. Paths must be explicit, and allowed operations are drawn from `write`, `create`, `delete`, `rename`, and `chmod`. Unknown impact, dependency, path, or operation leaves the classification unresolved; no implementation ticket is created or dispatched until the scope decision is complete.

Parallel dispatch is allowed only for units whose write scopes are complete and pairwise disjoint, including rename source/destination paths and path-prefix overlaps. Otherwise units are sequenced or remain director-local. If a worker discovers an undeclared path or operation, it stops before mutation and returns a scope decision to the director. It must never edit first and rely on terminal retry or audit to authorize an undeclared change. Mechanical routing continues to use the structured class; operation labels stay opaque audit metadata and never select a route.

The installed global Baton skill and every host runtime skill are release artifacts of this same contract. `scripts/update_local_baton.py` must build/link this checkout and invoke the linked `baton update`, which refreshes the active global `~/.baton/SKILL.md` from the checkout as well as installed host skills that already exist.

If the target exposes a PreToolUse-compatible hook, the shared host guard MUST implement ticket-presence: no reserved ticket → director mutating tools allowed; reserved/dispatching/running worker tickets → director implementation writes denied; every reserved native spawn → exact reservation envelope required even when only one ticket exists; bound workers stay inside the Receipt. MUST NOT ship fail-closed-always or allow-always. Cursor and other hookless hosts still MUST ship the table and reservation protocol in the runtime skill; missing a hook is not a license to implement declared classified work in the parent.

Keep the adapter-boundary and model/configuration invariants above. Do not rewrite OpenSpec apply skills. OpenSpec apply intercept remains in the target host Baton skill via `baton apply` plan → read-only director impact/dependency pass → filter the order-ready frontier (`--write-path`/`--read-only`) → pack only complete, disjoint write scopes by section order and host cap → one scoped `--dispatch` with multiple `--unit` flags. A write scope also carries its allowed operations (`write`, `create`, `delete`, `rename`, `chmod`); the standalone write surface is `--write-path PATH --write-ops OPS`.

## Runtime skill and native protocol

Write a target-specific runtime skill instead of copying an existing template verbatim. It must accurately name the target's native child-agent tool, exact-model parameter, context-isolation setting, lifecycle calls, concurrency behavior, and skill/guard limitations. It MUST include the director/worker routing table above.

The runtime sequence remains logically equivalent across hosts:

1. select the explicit target profile;
2. create and reserve a Baton ticket with an immutable Receipt;
3. call the target host's native child-agent tool with the ticket's exact model and supported options;
4. bind the returned stable identity immediately;
5. wait using native activity and record meaningful progress only when appropriate;
6. record exactly one terminal outcome and release before refilling capacity.

Do not substitute a shell-launched coding CLI, print mode, or new top-level session for a native child agent.

OpenSpec apply intercept lives in the target host's Baton skill, not in OpenSpec's apply skill. Do not edit `.agents/skills/openspec-apply-change` or `opsx-apply` to force Baton dispatch. When the target profile is enabled, the host skill consumes original `tasks.md` through `baton apply` plan → read-only director impact/dependency pass → filter the order-ready frontier (`--write-path`/`--read-only`) → pack only complete, disjoint write scopes by section order and host cap → one scoped `baton apply --dispatch` with multiple `--unit` flags and same-turn native children. A worker that finds an undeclared path or operation stops before mutation and returns a scope decision; it does not edit and defer the decision to terminal retry or audit.

## User-visible completion

The registry is the source for shared UI whenever possible. After registration, the existing init/config flow should gain the target naturally:

```text
baton init
  Select CLI: ... target ...
  target model discovery
  Select runner
  Select longctx
  Select models callable by subagents
  Enable this target configuration?
```

Also preserve `baton init --cli <target>` and `baton config --cli <target>` for non-interactive or scripted use. A new adapter is incomplete if only the code module exists but this flow does not work.
