# Baton product guide

**English** | [中文](guide.zh.md)

This is the technical reference for Baton. The [landing README](../README.md)
covers install and the first commands.

## Public adapter boundary

Baton core has no built-in catalog. An external adapter package is installed
under `~/.baton/adapters/<adapter-id>/` (or supplied through
`BATON_ADAPTER_PATHS`) and is discovered from `adapter.json`. The package owns
executable resolution, its live model catalog, native child calls, and
adapter-specific lifecycle details. Baton consumes the normalized SDK surface.

The package exports the SDK from `@zhouliuya/openbaton/adapters` and
`@zhouliuya/openbaton/adapters/sdk`.

### Manifest

Manifest schema `1` is intentionally small and exact:

```json
{
  "schema": 1,
  "adapter": {
    "id": "sample-adapter",
    "display_name": "Sample Adapter",
    "package_name": "sample-adapter-package",
    "package_version": "1.0.0",
    "sdk_version": "1.0"
  },
  "catalog": {
    "command": "catalog.js",
    "args": [],
    "protocol": "json",
    "timeout_ms": 15000
  },
  "invocation": { "signal": "SAMPLE_ADAPTER_SESSION" },
  "native": { "execution_handle_kind": "sample-native-task" },
  "runtime_skill": {
    "source": "runtime/SKILL.md",
    "destination": ".baton/skills/sample-adapter/SKILL.md"
  },
  "quota": {
    "max_concurrent_subagents": 3,
    "max_depth": 1,
    "backpressure": "defer"
  }
}
```

The manifest identifies the adapter, package, SDK version, catalog command and
protocol, invocation signal, opaque native handle kind, runtime skill paths,
and any limits reported by the adapter. `quota.max_concurrent_subagents` means
the maximum number of active descendants in one root-agent tree, excluding the
root; it is not a workspace, host-wide, process, model-list, or total-agent
count. Runtime-skill paths are package-relative and traversal-free; the catalog
command may be a package path or an absolute executable. Duplicate ids or
invalid fields stop discovery.

The catalog command returns one JSON object with the matching `adapter_id`, an
optional version, and `models`. Each model preserves its exact `id` and any
reported display name, description, visibility, reasoning efforts, modalities,
speed tiers, service tiers, and defaults. Missing optional values remain
unknown. No catalog row or execution option is synthesized by Baton.

## Configuration and automatic routing

`baton init` discovers available manifests and `baton config --cli <id>` queries
that adapter's live catalog. Only the explicitly selected profile is written
to `~/.baton/config.toml`:

```toml
[director]
max_concurrent = 3
max_depth = 1

[cli.sample-adapter]
runner = "<model-id>"
longctx = "<model-id>"
coding_models = ["<model-id>", "<another-model-id>"]
max_concurrent = 3
```

`[cli.<id>].max_concurrent` is that CLI's reported per-root-tree subagent
ceiling. Discovery writes the live catalog value, else the adapter manifest
quota, else preserves an existing positive reported value. Only when none of
those sources is available does it write `-1`; `0` also normalizes to unknown.
At runtime a positive profile value is the resolved host limit and replaces
the manifest fallback. `director.max_concurrent` applies only while that host
limit is unknown; it is not a workspace-wide pool. `max_depth` is an
independent descendant-depth policy. A live depth value replaces the manifest
depth, which otherwise replaces the director fallback.

`runner` and `longctx` are routing labels. `coding_models` is an ordered
allowlist and its order is the Coding priority. Automatic selection uses only
that allowlist, the current catalog, task shape, supported reasoning options,
service-tier metadata, route health, and capacity evidence. The selected
model and options are recorded in the proposal, ticket, and Receipt; dispatch
checks them again against the captured catalog.

There is no interactive model-choice step during execution. An unavailable or
invalid adapter, model, effort, service tier, authorization, or classification
stops before native execution. Baton never chooses outside the configured
profile or invents a model option.

Non-interactive config can also set labels in one command:

```text
baton config --cli <adapter-id> --runner <model> --longctx <model> --coding-model <model>
```

`--coding-model all` selects every picker-visible catalog row. `--runner -`
or `--longctx -` clears that label; a missing label blocks the corresponding
classified work.

## Compiled OpenSpec apply

OpenSpec apply is an explicit dual-skill workflow. In Codex, invoke
`$baton $openspec-apply-change <change>`; in Grok, invoke `/baton
$openspec-apply-change <change>`. Baton is hookless and activates only after
that explicit host invocation. Ordinary OpenSpec discussion does not create a
ticket. The OpenSpec task ledger remains canonical and is never delegated to a
worker.

The main agent first reads the apply instructions, every file returned in
`contextFiles`, applicable repository guidance, and the affected code. It then
compiles a versioned, fine-grained plan before creating tickets. The plan
contains exact task references and dependencies, read context, write paths and
allowed operations, an imperative patch recipe, done criteria, permitted
validation, parent gates, and task mappings. Its units are exactly one of:

- `patch-only`: a concrete mutation with non-empty write paths and an
  operation allowlist;
- `verification-only`: checks/evidence only, with no write paths or patch
  fields.

Task mappings are many-to-many by design. For example, one broad task can map
to two disjoint utility units, two coupled tasks can map to one patch unit, and
a later integration unit can overlap that patch only when its dependency
orders it after the earlier unit. The persisted plan and run keep the source
snapshot, immutable plan fingerprint, current revision, unit/gate state, and
ticket lineage separate from the task ledger.

Baton validates the whole plan atomically, persists revision `1`, computes the
maximal safe ready frontier, and derives a per-unit minimum capability from
complexity, estimated context, code scope, required reasoning, and native/tool
execution needs. It then walks only the configured `coding_models` in exact
priority order. Spark is only the first candidate: when Spark is
under-capable or exhausted in the current session, a later configured route
may qualify and is selected silently. No unconfigured route is eligible. The
user is notified only when no configured route is both current-session
available and capable. In that case the complete
`NO_QUALIFIED_CANDIDATE` result lists every configured route and every
candidate exclusion reason (catalog absence, quota, current-session quota or
uncallability, context, reasoning, execution capability, and task mismatch).
Quota and uncallability are current Baton session cache facts only; a new
session rechecks them.

For each reserved unit, the runtime passes the reservation prompt unchanged to
a fresh native worker with the exact selected model/options, binds the returned
opaque execution handle immediately, waits on real native liveness, records
one terminal result, and releases before refilling. A terminal ticket keeps
its paths owned until release. The worker returns to the director only for
source staleness, changed contracts, scope changes, safety-blocked partial
mutation, or structured `PLAN_INSUFFICIENT`. Workers do not redesign or
broaden scope, spawn children, touch Git/OpenSpec, or choose models.

The parent alone accepts unit evidence and parent gates. It runs a gate only
after its mapped units are accepted, and reconciles OpenSpec conclusions and
checkboxes only after every mapped unit and gate passes. A checkbox is never
marked early. Manual apply remains compatible: legacy `baton apply` can still
use explicit per-unit scopes or `--read-only`; compiled mode rejects manual
scope flags rather than guessing a plan.

### Compiled run commands

```text
baton apply <change> --host <host> --plan-file <plan.json> [--dispatch] --json
baton apply <change> --host <host> --run <run-id> --status --json
baton apply <change> --host <host> --run <run-id> --accept-gate <gate-id> --text "..." --json
baton apply <change> --host <host> --run <run-id> --reconcile [--task <number>] --json
baton apply <change> --host <host> --run <run-id> --plan-file <successor.json> [--dispatch] --json
```

`--status` reports unit, gate, task, terminal-unreleased, and linked-ticket
state. `--accept-gate` stores sanitized parent-owned evidence. `--reconcile`
is the only operation that writes the canonical task ledger. A successor plan
is submitted against the current run's parent revision and fingerprint; it
must preserve selected-task coverage and pass fresh catalog, routing,
capability, scope, and baseline checks. Source staleness, changed contracts,
scope changes, safety-blocked partial mutation, stale successor revisions, and
`PLAN_INSUFFICIENT` fail closed and return to the director for a new plan.

## Director, scope, and scheduling

Discussion and read-only analysis stay in the director session. Authorized
implementation units and classified mechanical units use the selected
adapter's native child API. The director supplies the structured execution
class; operation labels are retained only as audit data.

Before a write ticket is created, the director performs a read-only impact and
dependency pass. Every unit records exact paths and allowed operations from
`write`, `create`, `delete`, `rename`, and `chmod`. Baton validates all units
atomically, including rename endpoints, path-prefix overlap, and scopes owned
by active tickets. Unknown scope or operation stops before mutation.

At each scheduling and refill decision, Baton calculates the maximal safe ready
frontier for the current `(host, session_uid)` root-agent tree: all order-ready
units with complete, pairwise-disjoint scopes that fit its effective subagent
capacity. Direct and nested descendants consume one shared tree-local slot;
the root does not. It fills every available slot, while another root tree's
queued or active tickets are neither counted nor refilled. Section order only
breaks an otherwise equal choice.

The effective capacity is the minimum of each known source: the native/adapter
`host_limit`, configured `configured_policy`, and an optional current-operation
`operation_limit`. Dispatch snapshots expose the same value and provenance in
`capacity_sources`, whose entries contain `kind`, `value`, and `applied`. An
explicit `--capacity` only lowers the current tree and is never persisted;
legacy `dispatch-<host>.json` values are inert rollback residue.

## Ticket identity and lifecycle

Every ticket-producing and capacity-sensitive dispatch command requires
`BATON_SESSION_ID`. Baton hashes that value into `session_uid`, the immutable
root-agent-tree identity, and allocates a contiguous `session_ordinal` for each
ticket in that session. Root and descendant tickets retain that same identity;
a descendant, reconnect, or successor cannot mint a new session to obtain more
capacity. Ticket ids contain the opaque prefix, session uid, and ordinal; ids
are opaque data and are not route selectors. Preserve the `session_id`,
`ticket_id`, and native execution handle in the identity handoff.

The lifecycle is:

1. Create a ticket and immutable Receipt with `baton spawn` or scoped
   `baton apply`.
2. Reserve the ticket and receive its exact prompt, description, model, options,
   scope, and reservation envelope.
3. Call the adapter's native child API with a fresh context and the exact
   selected values.
4. Immediately bind the returned opaque native execution handle to the
   `session_id` and ticket id.
5. Wait on native activity, record concise progress, and record one terminal
   result.
6. Release the ticket before refilling capacity.

The handle kind is adapter-defined. Baton does not infer identity from text or
replace a native handle with a local identifier. A capacity response
(`AGENT_LIMIT_REACHED`) defers the same reservation in its originating tree
without consuming an attempt or changing its model, session identity, or
another tree's state. A slot remains held from `dispatching` through bound
running and terminal-awaiting-release until native release is confirmed.

## Quota exhaustion and successors

An explicit host/profile model quota-exhaustion result is recorded as
availability evidence across all root trees using that route. For a write
ticket whose pre-mutation baseline is unchanged, Baton may create an immutable
successor from the next configured Coding priority. The successor receives a new per-session ordinal and Receipt, records
`successor_from_ticket_id` and `successor_reason`, and retains the originating
session, adapter, scope, authorization, and quota lineage. It reruns catalog,
option, capacity, and scope checks.

The original ticket is never rewritten with a different model, and quota is
never reset. If mutation has started or the baseline cannot be reconciled,
stop and report reconciliation instead of creating a successor.

## Repository safety

Read-only is the default. Write tickets carry a path/operation allowlist and a
parent-owned repository observation. Workers do not perform Git operations. An
explicit exclusive commit ticket over the parent-staged tree may create one
commit; all other repository operations remain outside the worker. Tree-local
capacity never weakens workspace-wide path ownership, Git safety audits,
activation/dispatch locks, or cross-tree write-conflict checks.

Receipts, ticket state, catalogs, and installation records live under the
user-global `~/.baton` directory. Worktree files remain the caller's files.

## Commands

```text
baton init
baton config --cli <adapter-id>
baton models refresh --host <adapter-id>
baton models status --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton apply <change> --host <adapter-id>
baton dispatch next --host <adapter-id> [--capacity <n>] --json
baton dispatch status --host <adapter-id> [--capacity <n>] --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

`dispatch status` is scoped to the current root tree and reports `host`,
`session_uid`, `capacity`, `capacity_sources`, `active`, `available`, and its
queue/lifecycle ticket lists. General `baton status` keeps workspace ticket
inventory but groups capacity diagnostics under `capacity_trees`; it never
publishes one aggregate workspace `available` value. Missing or mismatched tree
identity, or an active record without a valid `session_uid`, fails closed with a
compatibility diagnostic rather than rewriting ticket or Receipt history.

For a release check, report SDK conformance, manifest discovery, package/build
results, live catalog evidence, native execution-handle evidence, ticket and
quota lineage, cleanup, and the exact changed-path audit separately.

## Measured OpenSpec apply

One completed change, `scope-subagent-capacity-per-agent-tree`, was applied
through Baton with native subagents. The change scoped dispatch capacity to
one immutable `(host, session_uid)` root-agent tree: session identity,
tree-local slots, status provenance, cross-tree safety isolation, adapter
quota wording, and installed-runtime acceptance.

### Task scale

| Dimension | Size |
|---|---|
| OpenSpec work | 7 sections, 30 tasks |
| Spec contract | 10 requirements, 26 scenarios |
| Implementation commit `2aca248` | 46 files, +3,293 / −246 |
| Source verification | 223 tests passed, 1 skipped |

### Execution

The comparison excludes 33m36s of unrelated compatibility-gate wait from
another task. Amounts are public-API equivalent cost, not a subscription
invoice. The solo-director row is a counterfactual: the same productive
token volume priced and serialized on `gpt-5.6-sol`, not a second live run.

| | Solo director estimate | Baton (1 director + 36 subagents) |
|---|---|---|
| Models | `gpt-5.6-sol` throughout | director `gpt-5.6-sol` (`high`, 3 auto-compacts); subagents `gpt-5.6-luna` (no auto-compacts) |
| Effective wall clock | 2h 34m 33s | 1h 58m 05s (−36m 28s, 1.31×) |
| Productive tokens | ~137.16M | ~137.16M |
| API-equivalent cost | $79.70 | $30.56 (−$49.14, −61.7%) |

Subagents carried more than half of the tokens; at `gpt-5.6-luna` prices
their combined equivalent cost was about $2.66.

## Related documentation

- [Getting started](../samples/getting-started/README.md)
- [Samples](../samples/README.md)
- [Architecture notes](architecture/baton-dynamic-director.md)
- [Architecture diagram](architecture/openbaton-architecture.html)
- [Layered runtime](architecture/openbaton-layered-architecture.html)
