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
        ├── coding_models
        ├── max_concurrent?  (only when CLI-reported)
        └── max_depth?       (only when CLI-reported)

runner and longctx are labels, not capability assertions. The ordered coding_models list is the complete configured Coding priority for that CLI. Configured labels remain independent and are not automatically inserted. Disabled profiles contribute no routes.
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
      -> run the read-only director impact/dependency pass for write units
      -> require complete per-unit write paths and allowed operations before ticket creation
      -> intersect configured ids with saved CLI catalog
      -> create model@effort cards from CLI-supported efforts
      -> score task/model/effort/speed automatically
      -> persist an exact service tier only when the selected CLI exposed it and the task requests speed
      -> create approved audit proposal, ticket, and Receipt
      -> host-native dispatch (Codex spawn_agent / Grok spawn_subagent)

There is no runtime human model selector. Explicit model or route flags and the former model-selection toggle are rejected.

Standalone syntax carries one director classification/operation for the request
or per-unit overrides when decomposing a request:

    baton spawn REQUEST [--classification CLASS] [--operation LABEL]
      [--unit KEY=TEXT ...]
      [--unit-classification KEY=CLASS ...] [--unit-operation KEY=LABEL ...]
      [--write-path PATH] [--write-ops write,create,delete,rename,chmod]

Every standalone request is persisted in the same multi-unit proposal shape;
without `--unit`, the request becomes the single `standalone` unit. Classification
values are exact structured values. No operation or request prose is inferred.

An enabled host rejects missing or conflicting classifications before creating
a ticket. `mechanical` always selects `runner`; `long-context` selects
`longctx`; operation labels are audit metadata. Empty or unusable class routes
fail closed, including when a write path is present.

## Visibility versus execution

A model returned by the selected CLI is picker-visible and therefore configurable. For Codex this includes gpt-5.4-mini and gpt-5.3-codex-spark whenever they occur in model/list.

Tool documentation is not execution proof and cannot remove a picker-visible model. Dispatch validates the exact model, effort, and any selected service tier against the saved catalog. Codex `spawn_agent` and its namespaced collaboration variants can pass model, effort, and tier; the returned `task_name` is the native execution handle for attach/liveness/release, while `agent_id` is optional diagnostics. Grok `spawn_subagent` takes an exact `model` and independent context; if a ticket has effort or tier that the installed Grok tool cannot express, that option is unavailable rather than silently claimed. Omitting Grok `model` inherits the parent model and is forbidden. A native host rejection is recorded as route-health evidence for that exact attempt; the ticket is not rewritten in place.

## Automatic policy

Selection is deterministic within the configured allowlist:

1. task affinity from the CLI model description and optional local capability evidence;
2. supported reasoning effort fitted to task complexity;
3. fast preference from CLI descriptions and speed or service-tier metadata;
4. current quota and health evidence when available;
5. stable id for the final tie.

Unranked capability evidence is allowed. Missing third-party benchmark data does not override the selected CLI's model surface or the user's configured allowlist.

## Automatic workflow contract

An enabled selected CLI profile and an explicit user execution authorization are prerequisites for native implementation work. The director classifies every executable request and passes that structured classification to Baton before dispatch. Baton persists the resulting tickets and Receipts; it does not invent or own a separate task DAG.

Discussion and read-only analysis remain on the director. Authorized implementation nodes are dispatched through the selected host's native child-agent tool. Mechanical classification chooses `runner` (and `long-context` chooses `longctx`); its operation label is retained for audit only and is not a fixed action-name routing key. Empty or unusable classified routes fail closed rather than executing on the director. Commit/publish remain deterministic Receipt/Git capabilities. Missing authorization, a disabled host profile, or unresolved classification fail closed.

The decomposition and ordering graph belongs to the director workflow or OpenSpec; it is not a new Baton-persisted DAG runtime. When OpenSpec is present, its task/status graph remains authoritative. Baton persists only the resulting host-scoped tickets and Receipts and applies write-set/capacity checks without rewriting `tasks.md`.

## Write-scope readiness

Before creating or dispatching any write ticket, the director performs a read-only impact/dependency pass for the unit. The pass must produce a complete, exact per-unit write-path set and the allowed operations for those paths. Paths are explicit; allowed operations are `write`, `create`, `delete`, `rename`, and `chmod`. Unknown impact, dependency, path, or operation keeps classification unresolved and creates no implementation ticket.

Parallel dispatch is permitted only for units with complete, pairwise disjoint write sets, including rename source/destination paths and path-prefix overlaps. Incomplete or intersecting scopes are sequenced or remain director-local. A worker that discovers an undeclared path or operation stops before mutation and returns a scope decision to the director. It never edits first and relies on terminal retry or audit for authorization. Mechanical routing remains class-based, and operation labels are opaque audit metadata rather than route selectors.

## Streaming Git safety contract

Write and commit-only ticket materialization, reservation, and terminal audit use
one safety-owned asynchronous Git process boundary. Commands whose output size is
unknown are streamed with concurrent stdout/stderr drains, backpressure, bounded
stderr diagnostics, abort/signal propagation, and child reaping. The consumer must
reach a complete valid end state before its facts are used; partial output is never
a baseline. These commands do not use Node/Bun aggregate `maxBuffer`, so valid
streams above the former 1 MiB limit, including an opt-in stream above 128 MiB,
remain valid when the compact facts fit in memory. Scalar commands have a separate
explicit small-output contract and report an overflow rather than being buffered
as a general snapshot. The streaming layer retains only facts needed by a Receipt
or verdict, not verbose Git diagnostic text.

The safety transaction keeps activation and dispatch ownership across the complete
asynchronous observation. It captures the required facts, obtains a fresh
stability token for HEAD, branch, refs, reflog summary, staged tree, and index
controls, and retries the entire observation once if the token changes. A second
mismatch is `GIT_BASELINE_RACED` for baseline creation or `GIT_AUDIT_RACED` for an
audit. Locks are released in `finally` on success, failure, or interruption; no
Receipt, spawn, or successful terminal verdict is persisted from a failed or
mixed-time observation.

### Versioned index-control metadata

Every new schema-v4 write Receipt carries the immutable baseline fields
`index_control_algorithm`, `index_control_checksum`, and
`index_control_entry_count`. Commit-only Receipts carry the corresponding
`staged_index_control_algorithm`, `staged_index_control_checksum`, and
`staged_index_control_entry_count`. New baselines select
`git-index-control-framed-sha256-v2`: canonical Git index order, raw pathname
bytes, an unambiguous length-prefixed frame, semantic control flags after masking
only `CE_FSMONITOR_VALID` (`0x80000000`), and a terminal entry count. The staged
tree remains a separate content/mode fingerprint. Raw bytes and framing make the
result independent of text decoding, runtime, delimiter-like pathnames, and chunk
boundaries; parser memory is bounded by one record.

### Structured failures and forward compatibility

Collection and metadata failures use one structured safety-failure contract
instead of prose-only diagnostics. The `GIT_*` collection codes below are
`GitSafetyError` codes; the `INDEX_CONTROL_*` codes are separate Receipt/index
metadata validation codes and must not be treated as `GitSafetyError` values:

- `GIT_SAFETY_COMMAND_FAILED` covers spawn, non-zero exit, signal termination, and
  child-stream errors.
- `GIT_SAFETY_SCALAR_LIMIT` means a scalar command violated its explicit output
  contract.
- `GIT_SAFETY_STREAM_MALFORMED` means a streamed record was malformed or
  truncated.
- `INDEX_CONTROL_ALGORITHM_UNSUPPORTED` means a Receipt names an unknown
  fingerprint algorithm (metadata validation).
- `INDEX_CONTROL_BASELINE_INVALID` means a known v2 baseline is incomplete or its
  checksum or count is invalid (metadata validation).
- `GIT_BASELINE_RACED` and `GIT_AUDIT_RACED` distinguish a persistent repository
  race after one complete retry from an ordinary scope mutation.

Receipt schema v4 and public ticket syntax stay unchanged. A pre-existing
algorithm-less Receipt is explicitly verified as `legacy-json-sorted-v1`: Baton
streams the input but retains the compact pathname/masked-flag records needed to
reproduce the historical sort, JSON serialization, and SHA-256 checksum. New
Receipts always use v2. Unknown or incomplete metadata fails closed; no algorithm
guessing or silent fallback is allowed. This is forward compatibility: a new
runtime can finish old tickets without rewriting immutable Receipts, but an old
runtime cannot safely audit a v2 baseline.

Runtime rollback is therefore a safety boundary. Before replacing the runtime with
an older version, the director must drain every active v2 write and commit-only
ticket until it reaches a terminal state (explicitly closing it when appropriate)
and is then released. Rollback while one of those tickets is active, bypassing
the check, and rewriting a Receipt are all unsupported.

## Safety and lifecycle invariants

- No parent-model inheritance, in-place model change, cross-host fallback, or invented effort or speed fields. Explicit quota exhaustion may create an immutable, auditable successor after a clean pre-mutation baseline; successors rerun all hard gates.
- Tickets are immutable model assignments with Delegation Receipts.
- Depth is one; physical concurrency is host-bounded and logical work queues FIFO.
- AgentLimitReached defers the same ticket without changing its model.
- Polling timeout is not worker timeout; exact not_found evidence is required.
- Writes are allowlisted and parent-audited. Each write Receipt carries exact paths and allowed operations; only an exclusive parent-staged commit-only Receipt can authorize one Git commit.
- Active v2 write and commit-only tickets are a runtime rollout boundary: each must reach a terminal state (explicitly closed when appropriate) and then be released before rollback to an older Baton runtime.
- Baton state is user-global under ~/.baton; OpenSpec remains optional and is not reimplemented.
