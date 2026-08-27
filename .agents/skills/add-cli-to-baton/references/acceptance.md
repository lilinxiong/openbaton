# Adapter conformance and acceptance

Acceptance proves the external package and manifest behavior, not names in
Baton core. Keep automated, package, live catalog, native, ticket, and
repository evidence separate.

## Automated conformance

- Manifest fields validate, SDK versions negotiate, package discovery is
  deterministic, and no core-specific branch is required.
- Adapter tests cover executable resolution and version errors; sanitized live
  catalog shapes; pagination, visibility, duplicate ids, empty and malformed
  responses, timeout; exact ids and metadata; and adapter-owned discovery.
- Init/config tests prove one selected profile, no unselected profiles, scoped
  enablement, reported limits, live catalog choices, runtime-skill installation,
  and interactive plus non-interactive paths.
- Matching and lifecycle tests prove allowlist-only selection, invalid model
  rejection, reservation, Receipt, binding, terminal, release, identity
  handoff, session-unique ticket ids, and host-mismatch rejection.
- Quota tests prove capacity backpressure returns the same reservation without
  changing its model, while an exhaustion successor receives a new ticket
  ordinal and retains `successor_from_ticket_id`, session identity, host, scope,
  and quota lineage.
- Negative tests prove missing profile, invalid authorization, unresolved
  classification, unknown scope/operation, path conflicts, rename conflicts,
  and path-prefix overlap create no ticket or native call.

## Native and ticket acceptance

1. Install the manifest package in an isolated home. Confirm `baton init` lists
   it, queries its live catalog, and persists only its enabled profile.
2. Select one exact catalog model and create a ticket with explicit host and
   complete read-only/write scope as applicable.
3. Reserve it, call the adapter's native child API with the exact model and a
   fresh context, immediately bind `session_id`, `ticket_id`, and the opaque
   native handle, and wait on native activity.
4. Record exactly one terminal result and release. Verify no queued, running, or
   awaiting-release ticket remains.
5. Repeat with an invalid model and verify rejection without parent identity,
   model substitution, or quota reset. Exercise the immutable successor path
   after an explicit quota result and a clean pre-mutation baseline.

## Write scheduling and repository gates

Before any write ticket, perform the read-only impact/dependency pass, record
exact per-unit paths and operations (`write`, `create`, `delete`, `rename`,
`chmod`), reject conflicts atomically, and fill every available slot from the
maximal safe ready frontier. Section order is only a tie-breaker. An undeclared
worker path stops before mutation.

Run focused tests, `npm test`, `npm run build`, `npm pack --dry-run`, and format
checks. Exercise the built package with an isolated temporary home. Audit the
complete diff, changed-path allowlist, temporary repositories, and fixture
content. Preserve unrelated changes and do not commit or publish unless asked.

## Outcomes

- `PASS`: conformance, package, catalog, native, negative, lifecycle, quota,
  leak, and repository gates pass.
- `CATALOG_ONLY`: catalog works but exact native child support is absent; do not
  expose executable support.
- `UNSUPPORTED`: an intrinsic SDK capability is absent.
- `BLOCKED`: an external prerequisite prevents a decisive probe; state the next
  action.
- `REVISE`: a repository-controlled failure must be fixed before completion.

Report adapter/version, manifest and SDK versions, catalog source/count, native
handle and session evidence, quota-successor evidence, changed paths, gate
results, ticket lifecycle, leak audit, and outcome.
