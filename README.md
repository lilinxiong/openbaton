# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

Baton is a CLI-neutral, manifest-driven scheduling and policy layer. It keeps
the director conversation focused, chooses from the selected adapter's live
catalog, and runs authorized work through native child execution.

The package can run standalone or consume a structured change plan when one is
available. It requires Node.js 22.5 or newer.

```bash
npm install -g @zhouliuya/openbaton
baton init
baton config --cli <adapter-id> --enable
```

Chinese: [README.zh.md](README.zh.md)

## Source checkout

From a checkout, build and refresh the linked command with:

```bash
python3 scripts/update_local_baton.py
```

The script installs dependencies, runs the repository checks, builds the
package, links `baton`, and refreshes the shared runtime files. Use
`--skip-tests` only when you have explicitly accepted that verification is
omitted. The day-to-day checkout command is:

```bash
bun install
bun run baton -- <command> ...
```

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
    "max_concurrent": 4,
    "max_depth": 1,
    "backpressure": "defer"
  }
}
```

The manifest identifies the adapter, package, SDK version, catalog command and
protocol, invocation signal, opaque native handle kind, runtime skill paths,
and any limits reported by the adapter. Runtime-skill paths are package-relative
and traversal-free; the catalog command may be a package path or an absolute
executable. Duplicate ids or invalid fields stop discovery.

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
max_concurrent = 4
max_depth = 1

[cli.sample-adapter]
enabled = true
runner = "<model-id>"
longctx = "<model-id>"
coding_models = ["<model-id>", "<another-model-id>"]
```

`runner` and `longctx` are routing labels. `coding_models` is an ordered
allowlist and its order is the Coding priority. Automatic selection uses only
that allowlist, the current catalog, task shape, supported reasoning options,
service-tier metadata, route health, and capacity evidence. The selected
model and options are recorded in the proposal, ticket, and Receipt; dispatch
checks them again against the captured catalog.

There is no interactive model-choice step during execution. An unavailable or
invalid adapter, model, effort, service tier, authorization, or classification
stops before native execution. Baton never chooses outside the enabled profile
or invents a model option.

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
frontier: all order-ready units with complete, pairwise-disjoint scopes that
fit the adapter's physical capacity. It fills every available slot. Section
order only breaks an otherwise equal choice.

## Ticket identity and lifecycle

Every ticket-producing command requires `BATON_SESSION_ID`. Baton hashes that
value into `session_uid` and allocates a contiguous `session_ordinal` for each
ticket in that session. Ticket ids contain the opaque prefix, session uid, and
ordinal; ids are opaque data and are not route selectors. Preserve the
`session_id`, `ticket_id`, and native execution handle in the identity handoff.

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
replace a native handle with a local identifier. A capacity response defers the
same reservation without consuming
an attempt or changing its model.

## Quota exhaustion and successors

An explicit quota-exhaustion result is recorded as availability evidence. For
a write ticket whose pre-mutation baseline is unchanged, Baton may create an
immutable successor from the next configured Coding priority. The successor
receives a new per-session ordinal and Receipt, records
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
commit; all other repository operations remain outside the worker.

Receipts, ticket state, catalogs, and installation records live under the
user-global `~/.baton` directory. Worktree files remain the caller's files.

## Commands

```text
baton init
baton config --cli <adapter-id> --enable
baton models refresh --host <adapter-id>
baton models status --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton apply <change> --host <adapter-id>
baton dispatch next --host <adapter-id> --capacity <n> --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

For a release check, report SDK conformance, manifest discovery, package/build
results, live catalog evidence, native execution-handle evidence, ticket and
quota lineage, cleanup, and the exact changed-path audit separately.
