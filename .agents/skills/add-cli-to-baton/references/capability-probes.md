# Adapter capability probes

Run these probes against the invoking CLI before publishing its manifest, then
repeat the decisive path after isolated installation. Use a disposable Git
repository for writes and keep credentials and raw account output out of
fixtures.

## Required evidence

1. Resolve the executable and version deterministically. Classify override,
   missing executable, authentication, permission, timeout, malformed response,
   and ordinary command failures.
2. Query the CLI's picker or RPC catalog. Exercise pagination, hidden entries,
   duplicate ids, defaults, reasoning/service metadata, empty success,
   malformed data, timeout, and prose/login output. An empty or prose result is
   not a catalog.
3. Call the actual native child-agent API. Prove a stable opaque execution
   handle, fresh context, exact valid model, invalid-model rejection, bounded
   completion, cancellation, release, and capacity/backpressure behavior.
4. Require `BATON_SESSION_ID` and prove that the identity handoff binds
   `session_id`, `ticket_id`, `session_ordinal`, and the native handle. On quota
   exhaustion, prove that the immutable successor keeps the originating session,
   host, scope, and quota lineage while receiving a new ordinal and Receipt.
5. In a disposable repository, verify working-directory, filesystem, index,
   reference, explicit scope, and cleanup semantics.
6. Install the manifest package and runtime skill into an isolated home. Verify
   discovery in a fresh session and that `baton init` can select and enable the
   adapter from its live catalog.

Use these outcomes: `READY_TO_INTEGRATE`, `CATALOG_ONLY`, `UNSUPPORTED`, or
`BLOCKED`. A catalog without exact native child support is not executable
support, and catalog presence alone does not prove current-session callability.
