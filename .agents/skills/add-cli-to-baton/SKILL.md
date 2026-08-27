---
name: add-cli-to-baton
description: Add the invoking CLI through OpenBaton's public Adapter SDK, manifest, and conformance path. Use when a CLI needs model discovery, native exact-model subagents, host-scoped init/config, and live acceptance; do not use for ordinary dispatch or report-only reviews.
---

# Add a CLI through the Adapter SDK

Deliver a versioned external adapter package, not a Baton-core implementation.
The adapter owns executable discovery, live model discovery, normalization,
native child-agent calls, and host-specific lifecycle details. Baton consumes
the public normalized contract and manifest. Keep all CLI-specific behavior in
the adapter package.

## Read before acting

- Read [references/openbaton-contract.md](references/openbaton-contract.md) for
  the SDK boundary, manifest fields, identity handoff, and ticket invariants.
- Read [references/capability-probes.md](references/capability-probes.md)
  before live probes; it defines evidence and outcome classes.
- Read [references/acceptance.md](references/acceptance.md) before tests or a
  completion claim.

## Workflow

1. Identify the invoking CLI, executable/version, session scope, and adapter
   package boundary. Preserve unrelated worktree changes.
2. Query the CLI's own picker or RPC for its current catalog. Preserve exact
   ids and exposed metadata; do not add rows from another source.
3. Implement the public Adapter SDK surface and an `adapter.json` manifest with
   the stable id, display metadata, package and SDK versions, catalog command,
   invocation signal, native execution-handle kind, runtime-skill paths, and
   quota/backpressure facts.
4. Keep native spawn, fresh context, activity, wait, cancellation, terminal,
   and release operations inside the adapter package. Expose the handle as
   opaque data to Baton.
5. Run SDK conformance and negative tests before publication. A catalog without
   an exact native child path is `CATALOG_ONLY`; an intrinsic missing SDK
   capability is `UNSUPPORTED`; an external prerequisite is `BLOCKED`.
6. Install the package in an isolated home, run `baton init` and
   `baton config --cli <id>`, and verify manifest discovery, profile persistence,
   runtime-skill installation, and live catalog choices.
7. Execute a real acceptance ticket with one exact picker-visible model:
   reserve, native spawn, immediate identity handoff, activity wait, terminal
   recording, release, and leak audit. Repeat with an invalid model and prove
   rejection without inheritance or substitution.

## Routing and scope contract

The director owns discussion, read-only analysis, authorization, and
classification. Authorized implementation units and declared mechanical units
use native children. The structured class selects `runner` or `longctx`;
operation labels remain audit metadata.

Before a write ticket, perform a read-only impact/dependency pass and record
exact paths plus allowed operations from `write`, `create`, `delete`, `rename`,
and `chmod`. Validate all units atomically, including path-prefix and rename
conflicts, before ticket creation. Schedule the maximal safe ready frontier;
section order only breaks otherwise equal choices. An undeclared worker path or
operation stops before mutation and returns a scope decision.

Every ticket-producing command requires `BATON_SESSION_ID`. Baton derives a
`session_uid` and allocates a contiguous `session_ordinal` within that session.
The adapter handoff must preserve `session_id`, `ticket_id`, and its opaque
native execution handle. Do not infer identity from ticket text or require a
provider-specific identity field.

On explicit quota exhaustion, Baton may create an immutable successor only
after a clean pre-mutation baseline. The successor receives the next configured
coding route, a new session ordinal and Receipt, and records
`successor_from_ticket_id` and `successor_reason` while retaining host, scope,
authorization, and quota lineage. It reruns all hard gates; the original ticket
is never rewritten and quota is never reset.

## Completion

Claim `PASS` only with SDK conformance, isolated build/package checks, manifest
discovery, init/enable persistence, native exact-model proof, invalid-model
rejection, terminal/release proof, quota-successor evidence, no leaked tickets,
and an exact changed-path audit. Report static, package, catalog, native, and
ticket evidence separately. Do not commit or publish unless separately asked.
