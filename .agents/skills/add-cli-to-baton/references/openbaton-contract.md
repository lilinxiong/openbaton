# OpenBaton adapter contract

Use the repository itself as the living contract. File names may evolve, so locate callers and tests rather than assuming this reference is an exhaustive patch list.

## Build the parity baseline

Before editing, inspect the current Codex and Grok implementations and create a compact capability-closure matrix with these columns:

| Capability | Codex | Grok | Target | Required action | Evidence |
|---|---|---|---|---|---|

Cover every shared feature and every host-specific feature you encounter. Shared features are mandatory for a successful target adapter. A host-specific feature such as a native hook is not automatically mandatory merely because one host has it, but it must be evaluated and mapped when the target exposes an equivalent.

Search the current repository for the following extension surfaces and their tests:

- adapter id type, adapter contract, registry, and compatibility exports;
- executable resolution, version probing, model discovery, model normalization, pagination, and coded errors;
- host metadata, concurrency caps, runtime-skill source, install destination, init, and update;
- config defaults, normalization, serialization, legacy migration, enabled profiles, and host resolution;
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
- Each `cli.<id>` profile has its own `enabled`, `runner`, `longctx`, and `subagent_models` values.
- `cli.active` is a deprecated default for commands without explicit host context, not a global execution switch.
- Explicit host resolution never falls through to another enabled profile.
- Runner and longctx are user routing labels, not capability claims, and configured labels belong in the target allowlist.
- Dispatch validates the exact selected model and effort against the captured target catalog. A rejected execution remains a rejected exact attempt.

## Runtime skill and native protocol

Write a target-specific runtime skill instead of copying an existing template verbatim. It must accurately name the target's native child-agent tool, exact-model parameter, context-isolation setting, lifecycle calls, concurrency behavior, and skill/guard limitations.

The runtime sequence remains logically equivalent across hosts:

1. select the explicit target profile;
2. create and reserve a Baton ticket with an immutable Receipt;
3. call the target host's native child-agent tool with the ticket's exact model and supported options;
4. bind the returned stable identity immediately;
5. wait using native activity and record meaningful progress only when appropriate;
6. record exactly one terminal outcome and release before refilling capacity.

Do not substitute a shell-launched coding CLI, print mode, or new top-level session for a native child agent.

OpenSpec apply intercept lives in the target host's Baton skill, not in OpenSpec's apply skill. Do not edit `.agents/skills/openspec-apply-change` or `opsx-apply` to force Baton dispatch. When the target profile is enabled, the host skill consumes original `tasks.md` waves through `baton apply --dispatch` and native children.

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
