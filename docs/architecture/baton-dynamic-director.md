# Baton dynamic director architecture

## Decision

Baton is a CLI-neutral scheduling and policy layer. It does not own provider authentication or a universal model registry. Each CLI adapter owns its model-discovery boundary.

Adapters:

- Codex obtains models from the public app-server model/list method with includeHidden=false. This is the picker-facing surface Codex exposes to clients.
- Grok obtains models from `grok models`. Official grok prints a text listing; JSON stdout is accepted if present. Login and prose lines are not model ids. `grok models --json` is not part of the official CLI.

Baton persists the returned model ids and any display, reasoning-effort, or speed/service-tier metadata the CLI actually reported, without augmenting the catalog from OpenCodex or hard-coded lists. Grok's text listing currently reports ids only.

## Configuration model

    director
    ├── max_concurrent   (fallback)
    └── max_depth        (fallback)
    cli
    └── <selected id>
        ├── enabled
        ├── runner       (label only)
        ├── longctx      (label only)
        ├── subagent_models
        ├── max_concurrent?  (only when CLI-reported)
        └── max_depth?       (only when CLI-reported)

runner and longctx are labels, not capability assertions. The subagent_models list is the complete configured allowlist for that CLI. Configured labels are members of the allowlist. Disabled profiles contribute no routes.
Unselected CLIs have no placeholder profile. Each missing scheduling limit falls
back independently to the director value; adapter guesses do not become
CLI-reported configuration.

## Data flow

    baton config
      -> choose CLI
      -> CLI adapter model discovery
      -> display exact picker-visible models
      -> choose labels + subagent allowlist + enabled
      -> persist the selected profile, explicit CLI-reported limits, and CLI catalog snapshot

    baton spawn/apply
      -> resolve the invoking host and load only its enabled profile
      -> intersect configured ids with saved CLI catalog
      -> create model@effort cards from CLI-supported efforts
      -> score task/model/effort/speed automatically
      -> persist an exact service tier only when the selected CLI exposed it and the task requests speed
      -> create approved audit proposal, ticket, and Receipt
      -> host-native dispatch (Codex spawn_agent / Grok spawn_subagent)

There is no runtime human model selector. Explicit model or route flags and the former model-selection toggle are rejected.

## Visibility versus execution

A model returned by the selected CLI is picker-visible and therefore configurable. For Codex this includes gpt-5.4-mini and gpt-5.3-codex-spark whenever they occur in model/list.

Tool documentation is not execution proof and cannot remove a picker-visible model. Dispatch validates the exact model, effort, and any selected service tier against the saved catalog. Codex spawn_agent can pass model, effort, and tier. Grok spawn_subagent takes an exact `model` and independent context; if a ticket has effort or tier that the installed Grok tool cannot express, that option is unavailable rather than silently claimed. Omitting Grok `model` inherits the parent model and is forbidden. A native host rejection is recorded as route-health evidence for that exact attempt; the ticket is not silently rewritten to another model.

## Automatic policy

Selection is deterministic within the configured allowlist:

1. task affinity from the CLI model description and optional local capability evidence;
2. supported reasoning effort fitted to task complexity;
3. fast preference from CLI descriptions and speed or service-tier metadata;
4. current quota and health evidence when available;
5. stable id for the final tie.

Unranked capability evidence is allowed. Missing third-party benchmark data does not override the selected CLI's model surface or the user's configured allowlist.

## Safety and lifecycle invariants

- No parent-model inheritance, cross-model fallback, or invented effort or speed fields.
- Tickets are immutable model assignments with Delegation Receipts.
- Depth is one; physical concurrency is host-bounded and logical work queues FIFO.
- AgentLimitReached defers the same ticket without changing its model.
- Polling timeout is not worker timeout; exact not_found evidence is required.
- Writes are allowlisted and parent-audited. Only an exclusive parent-staged commit-only Receipt can authorize one Git commit.
- Baton state is user-global under ~/.baton; OpenSpec remains optional and is not reimplemented.
