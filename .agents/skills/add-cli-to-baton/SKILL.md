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
6. Install the package in an isolated home and run `baton init`. Verify manifest
   discovery, runtime-skill installation, and live catalog choices, but do not
   create a ticket or persist a model before the user's selection checkpoint.
7. Require the user to choose exactly one model from the target CLI's
   picker-visible catalog. Stop before config, ticket creation, or native
   spawn until the user has made that choice. Persist the selected route id as
   `runner`, `longctx`, and the sole entry in the coding allowlist with:

   ```text
   baton config --cli <target> --runner <model> --longctx <model> --coding-model <model> --enable --json
   ```

   Do not silently choose a default, add aliases, or persist another model.
8. In the same target-CLI main conversation, run both real end-to-end inputs:
   `$baton <ordinary multi-task implementation request>`, then
   `$baton $openspec-apply-change probe-e2e`. Generate the disposable workspace
   and the two paste-ready inputs with `samples/bootstrap-probe.mjs`, then
   validate its five-ticket evidence with `samples/verify-probe.mjs`. The main
   agent only performs read-only scoping, dispatch, observation, and waiting.
   Live children own the executable paths and all requested
   implementation/probe execution; the parent must not execute those paths
   itself.

   ```text
   bun samples/bootstrap-probe.mjs --host <target> --model <model> --output <prompt-file>
   bun samples/verify-probe.mjs --host <target> --model <model> <workspace>
   ```
9. Keep invalid-model rejection and quota/backpressure/successor checks as
   separate conformance cases. Neither case may be substituted for the two
   successful inputs, and a valid model must never be inherited or replaced
   when either negative case is exercised.

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

The root target-CLI conversation creates one opaque `BATON_SESSION_ID` before
the first control-plane or ticket-producing call. It passes the exact same
value unchanged to every descendant and control-plane operation, including
`spawn`/`apply`, reserve, bind, probe, complete, release, reconnect, and quota
successor handling. No adapter, child, or reconnect may mint, derive, or
replace the session id. Baton derives a `session_uid` and allocates a
contiguous `session_ordinal` within that session. Every adapter handoff must
preserve `session_id`, `ticket_id`, `session_ordinal`, and its opaque native
execution handle. Do not infer identity from ticket text or require a
provider-specific identity field.

Capacity is scoped to the `(host, session_uid)` root-agent tree. The root agent
is excluded from the subagent count; direct children, grandchildren, and
deeper descendants all consume the same tree-local pool. A reservation holds a
slot while `dispatching`, while its bound native execution is running, and
after a terminal result until native release is confirmed. Native
`AGENT_LIMIT_REACHED` is tree-local backpressure: defer the same reservation
without changing its model, attempt, or session identity.

Use one effective capacity meaning everywhere: active descendants in one root
tree. Baton resolves the minimum of known `host_limit`, configured
`configured_policy`, and an optional current-operation `operation_limit`; the
`capacity_sources` output records each source's `kind`, `value`, and `applied`
status. `--capacity` is a non-persistent reduction for the current tree, and
`max_depth` remains a separate policy. Legacy `dispatch-<host>.json` values are
inert rollback residue and must not drive scheduling.

Tree capacity does not grant permission to bypass broader controls. Workspace
path ownership, Git/repository safety, activation and dispatch locks, and
host/profile model availability or quota retain their existing scopes across
root trees. General status may inventory all workspace tickets, but capacity
must be shown as separately grouped `(host, session_uid)` trees rather than one
aggregate workspace pool.

With the live acceptance profile containing one coding route, explicit quota
exhaustion is `BLOCKED` and must not fall back. Exercise the immutable
successor separately in a conformance fixture with an explicitly configured
second route and a clean pre-mutation baseline. The successor receives the next
configured coding route, a new session ordinal and Receipt, and records
`successor_from_ticket_id` and `successor_reason` while retaining host, scope,
authorization, and quota lineage. It reruns all hard gates; the original ticket
is never rewritten and quota is never reset.

## Completion

Claim `PASS` only with SDK conformance, isolated build/package checks, manifest
discovery, init/enable persistence, native exact-model proof, invalid-model
rejection, both same-conversation live inputs, terminal/release proof,
separate quota-successor fixture evidence, no leaked tickets, and an exact
changed-path audit. Report static, package, catalog, native, and ticket evidence
separately. Do not commit or publish unless separately asked.
