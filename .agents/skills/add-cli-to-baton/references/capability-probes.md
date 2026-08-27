# Target CLI capability probes

Run these probes before registering a target and repeat the decisive execution path after integration. Use minimal read-only tasks and isolate any filesystem or Git mutation in a disposable temporary repository.

## Evidence priorities

Use evidence in this order:

1. installed executable, bundled schemas, local protocol, and native tool inventory;
2. official target documentation or source for protocol semantics;
3. observed target output from a controlled probe.

Official documentation may identify how to query a catalog, but the actual configured model ids must come from the target CLI. Do not use web search, third-party catalogs, OpenCodex, another CLI, or remembered model names to populate Baton's target catalog.

Record the target version, host/session, account or workspace scope when relevant, and observation time. Callability evidence is session-specific and must not be generalized across versions or accounts.

## Probe matrix

### Executable and authentication

- Resolve the actual executable deterministically and record its version.
- Verify that an explicit override wins over PATH when the adapter supports one.
- Separate missing executable, invalid override, authentication required, permission denied, timeout, malformed response, and ordinary command failure.
- Never automate login, capture tokens, print secrets, or commit raw authentication output.

### Picker-visible model catalog

- Use the target's supported RPC, structured command, or stable picker listing.
- Exercise pagination when the protocol supports it.
- Verify hidden-model behavior, exact ids, duplicate-id handling, default markers, reasoning efforts, service/speed tiers, and optional metadata.
- Add a negative fixture for login/prose output so friendly text cannot become invented model ids.
- Treat an empty successful catalog as a classified failure, not a supported host.

### Native child-agent mechanism

- Identify the child-agent tool available inside the invoking host. A command that starts a new top-level CLI process or print session is not native subagent support.
- Confirm that the call returns a stable identity that later lifecycle operations use.
- Confirm that a minimal read-only child reaches a native terminal state and returns a bounded result.

### Exact model and no fallback

Use one picker-visible model and the shortest harmless challenge that proves execution.

- Positive probe: pass the exact model id and, when supported, an exact valid reasoning effort or service tier. Record the requested values and native outcome.
- Negative probe: pass a deliberately invalid model id. The host must reject it rather than inherit the parent model, choose a default, or silently substitute another model.
- If the host cannot express an exact model, classify `EXACT_MODEL_UNAVAILABLE`; do not integrate it as an executable Baton host.
- Catalog presence is discovery evidence, not execution evidence. Only the native positive probe proves current-session callability.

### Context isolation

Prove that the child starts with a fresh context or use the host's explicit no-inheritance setting.

For a behavioral probe, keep a synthetic parent-only nonce outside the child task and ask the child to report whether it received prior conversation context. Do not use secrets or personal data. If the child can recover the nonce without it being passed, context isolation failed.

Classify an unavoidable inherited parent context as `CONTEXT_ISOLATION_UNAVAILABLE`.

### Lifecycle and backpressure

Verify the native equivalents of:

- spawn and stable identity;
- pending/running observation when exposed;
- activity-driven wait;
- successful and failed terminal outcomes;
- cancellation or interruption;
- release/closure without leaked capacity;
- a recognizable capacity/backpressure outcome.

Do not treat a polling timeout as a worker timeout. If the safe concurrent ceiling cannot be established, start at one and retain a classified backpressure path rather than inventing a larger cap.

### Workspace, filesystem, and Git semantics

Use a disposable temporary Git repository and explicit allowlisted files.

- Confirm the child's working directory.
- Confirm whether parent and child see the same filesystem changes.
- Test a single allowlisted write separately from read-only behavior.
- Determine whether index, HEAD, refs, and branches are shared before enabling write or commit-only flows.
- Audit the temporary repository after each probe and remove it only when its exact path is known.

Never run these mutation probes in the user's real OpenBaton checkout.

### Runtime skill and guard surface

- Determine the target's documented skill-discovery location and whether symlinks or copied skill directories are supported.
- Install the Baton runtime skill into an isolated target home or profile first, then verify discovery from a fresh host session when the host requires restart.
- Confirm the host is operated hooklessly: no runtime hook installation, trust, observation, or tool-interception surface is required. Verify director command-boundary checks, Receipts, execution handles, and Git audits instead.

## Pre-registration result

Use one of these outcomes:

- `READY_TO_INTEGRATE`: all core probes passed; proceed to implementation.
- `CATALOG_ONLY`: authoritative models are discoverable, but there is no qualifying native exact-model child agent.
- `UNSUPPORTED`: a required capability is intrinsically absent or incompatible.
- `BLOCKED`: an external condition prevents a decisive result; provide the exact user or environment action needed.

Do not use `PASS` before post-registration Baton end-to-end acceptance.
