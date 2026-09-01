# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

**English** | [中文](README.zh.md)

Baton is a CLI-neutral, manifest-driven scheduling and policy layer. It keeps
the director conversation focused, chooses from the selected adapter's live
catalog, and runs authorized work through native child execution.

Subagent capacity belongs to one root-agent tree, identified by the hashed
`BATON_SESSION_ID`. The root itself is excluded from the count; direct children,
grandchildren, and deeper descendants share the same tree-local pool.

The package can run standalone or consume a structured change plan when one is
available. It requires Node.js 22.5 or newer.

```bash
npm install -g @zhouliuya/openbaton
baton init
baton config
```

`baton config` is a guided TTY flow: arrow keys select, space toggles CLIs
and the Coding-model order. It asks which adapter to configure, then `runner`,
`longctx`, and `coding_models`. Pass flags only to skip the prompts.

![Select CLI](assets/config/01-select-cli.png)

![Select Coding models](assets/config/03-select-coding-models.png)

These captures use the in-repo `sample-adapter`. The prompts are the same for
Codex; the model list comes from that adapter's live catalog.

## Source checkout

From a checkout, build and install the linked command with:

```bash
python3 scripts/update_local_baton.py
```

The script installs dependencies, runs the repository checks, builds the
package, detects the installation state, and completes the appropriate fresh
or clean-reinstall plan. Use
`--skip-tests` only when you have explicitly accepted that verification is
omitted. The day-to-day checkout command is:

```bash
bun install
bun run baton -- <command> ...
```

The installer detects fresh versus existing state from the visible `baton`
command, the `~/.baton` home, and registered host-skill footprints, then
executes the corresponding plan. A clean-reinstall plan builds and verifies first, runs the
built CLI's clean-uninstall preflight and apply, removes recognized package
registrations, links this checkout, runs profile-free `baton init` with
noninteractive stdin, and verifies the result. The fresh plan omits only the
cleanup stages.

Package-manager registration is not an independent installation footprint. When
a visible `baton` command exists, the installer validates its supported Bun/npm
package registration and provenance before cleanup; it does not independently
scan package registrations or manifests when no visible command exists.

Use `--dry-run` to render the full selected plan without executing it, including
cleanup and registration removal. It must not invoke package-manager unlink:
Bun 1.4.0 package-manager dry-run is unsafe.

The plan stops when active tickets remain, an owned-file/package conflict is
found, state is invalid or incomplete, or a recognized removal command is
ambiguous. Resolve the blocker and rerun. Never use `rm -rf ~/.baton`.

After installation, configure a host explicitly (there is no implicit model
selection during init):

```bash
baton config --cli <adapter-id> --runner <model-id> --longctx <model-id> --coding-model <model-id>
```

This writes only `[cli.<adapter-id>]`. Use `-` to clear `runner` or `longctx`,
and `--coding-model all` only when the complete catalog order is intended. Do
not use the obsolete `--enable` form. The profile at `~/.baton/config.toml`
is user-owned; an empty profile is allowed after init but blocks classified
routing until explicitly configured.

Core has no built-in catalog. An adapter package is discovered from
`adapter.json` under `~/.baton/adapters/<adapter-id>/` or
`BATON_ADAPTER_PATHS`. There is no interactive model-choice step during
execution.

## Getting started

An isolated walkthrough lives at [`samples/getting-started/`](samples/getting-started/).
It uses the in-repo `sample-adapter`, so you can run init through dispatch
without a paid host.

From the repository root:

```bash
bun samples/getting-started/walkthrough.mjs
```

Or follow [samples/getting-started/README.md](samples/getting-started/README.md).

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

## Using Baton inside Codex

### Setup

```bash
npm install -g @zhouliuya/openbaton
# or from a checkout: bun run baton -- <command> ...
baton init --cli codex
```

`baton init --cli codex` installs bundled adapters and host skills. The Codex
adapter manifest (`adapters/codex/adapter.json`) copies `runtime/SKILL.md` to
`.codex/skills/baton/SKILL.md` and its companion policy to
`.codex/skills/baton/agents/openai.yaml`. That is how Codex sees Baton and
keeps implicit invocation disabled.

Then run `baton config --cli codex`. On a TTY it is a guided flow: arrow keys
select, space toggles. It walks through `runner`, `longctx`, and Coding-model
priority. Model ids come from the live Codex CLI catalog (`BATON_CODEX_PATH`
if Codex is not on `PATH`).

Flags skip the prompts for non-interactive use and write only `[cli.codex]`:

```bash
baton config --cli codex --runner <model-id> --longctx <model-id> --coding-model <model-id>
```

Ticket commands need `BATON_SESSION_ID` (opaque; hashed to `session_uid`). The
Codex director creates one before the first control-plane call.

### Triggering Baton (`$baton` only)

The installed host skill does **not** auto-load. Codex applies its rules only
when you explicitly mention `$baton`. Ordinary conversation, implementation
requests, and implied intent must not load the skill or follow its routing
rules.

The installed `agents/openai.yaml` sets `policy.allow_implicit_invocation` to
`false`, while explicit `$baton` invocation remains available through Codex's
skill picker.

When `$baton` is used and the Codex profile is configured:

- Discussion and read-only analysis stay in the Codex director session. These
  do **not** create Baton tickets.
- Authorized implementation, mechanical, long-context, and OpenSpec units go
  through Baton (`spawn`/`apply` plus a native Codex child), not inline in
  the director.

`$baton` still requires a director **structured classification**. Baton does
not infer a route from prose. Missing classification blocks ticket creation.

### CLI commands

You or the director can also run the CLI yourselves:

```bash
export BATON_SESSION_ID="<opaque-session>"
baton models refresh --host codex
baton match "<work description>" --host codex
baton spawn "<request>" --host codex --classification <class> [--write-path ...]
baton dispatch next --host codex --json
# bind the Codex native handle:
baton dispatch bind TICKET --host codex --execution-handle task_name=CODEX_TASK_NAME --json
baton dispatch complete TICKET --host codex --text "..." --release --json
```

`baton apply` plans an OpenSpec change. `--dispatch` needs per-unit
`--write-path` or `--read-only`. Without OpenSpec, use `spawn`.
`baton match` discloses the preferred model without creating work.

### What runs where

`--classification` is required:
`mechanical|long-context|implementation|analysis|discussion|general`.

- `discussion` / `analysis` → director only. No worker ticket.
- `mechanical` → configured `runner` label. Empty runner blocks; classified
  mechanical work is not executable on the director. Commit-only capability
  is mechanical only.
- `long-context` → configured `longctx` label. Empty longctx blocks.
- `implementation` and `general` → automatic selection over the ordered
  `coding_models` allowlist (Coding priority). `general` is `not-ops` for
  runner/longctx. `runner` and `longctx` are labels, not Coding-priority
  entries.

`--operation` is audit metadata only; it never selects a route.

Deep lifecycle stays in [docs/guide.md](docs/guide.md).

## Using Baton inside Grok

### Setup

```bash
npm install -g @zhouliuya/openbaton
# or from a checkout: bun run baton -- <command> ...
baton init --cli grok
```

`baton init --cli grok` installs bundled adapters and host skills. The Grok
adapter manifest (`adapters/grok/adapter.json`) copies `runtime/SKILL.md` to
`.grok/skills/baton/SKILL.md`. That is how Grok sees Baton.

Then run `baton config --cli grok`. On a TTY it is a guided flow: arrow keys
select, space toggles. It walks through `runner`, `longctx`, and Coding-model
priority. Model ids come from the live Grok ACP catalog (`BATON_GROK_PATH`
if Grok is not on `PATH`).

Flags skip the prompts for non-interactive use and write only `[cli.grok]`:

```bash
baton config --cli grok --runner <model-id> --longctx <model-id> --coding-model <model-id>
```

Ticket commands need `BATON_SESSION_ID` (opaque; hashed to `session_uid`). The
Grok director creates one before the first control-plane call.

### Triggering Baton (`/baton` only)

The installed host skill does **not** auto-load. Grok applies its rules only
when you explicitly run `/baton`. Ordinary conversation, implementation
requests, and implied intent must not load the skill or follow its routing
rules.

The skill frontmatter sets `disable-model-invocation: true` so the host cannot
invoke it automatically, and `user-invocable: true` so `/baton` remains the
slash command.

When `/baton` is used and the Grok profile is configured:

- Discussion and read-only analysis stay in the Grok director session. These
  do **not** create Baton tickets.
- Authorized implementation, mechanical, long-context, and OpenSpec units go
  through Baton (`spawn`/`apply` plus a native Grok child), not inline in
  the director.

`/baton` still requires a director **structured classification**. Baton does
not infer a route from prose. Missing classification blocks ticket creation.

### CLI commands

You or the director can also run the CLI yourselves:

```bash
export BATON_SESSION_ID="<opaque-session>"
baton models refresh --host grok
baton match "<work description>" --host grok
baton spawn "<request>" --host grok --classification <class> [--write-path ...]
baton dispatch next --host grok --json
# bind the Grok native handle:
baton dispatch bind TICKET --host grok --execution-handle subagent_id=GROK_SUBAGENT_ID --json
baton dispatch complete TICKET --host grok --text "..." --release --json
```

`baton apply` plans an OpenSpec change. `--dispatch` needs per-unit
`--write-path` or `--read-only`. Without OpenSpec, use `spawn`.
`baton match` discloses the preferred model without creating work.

Classification, routing labels, and lifecycle match the Codex host section
above and [docs/guide.md](docs/guide.md).

## Compiled OpenSpec apply (dual skill)

OpenSpec apply is an explicit two-skill path. In Codex, invoke `$baton` and
`$openspec-apply-change` together; in Grok, run `/baton` and include
`$openspec-apply-change` in the same director conversation. Baton is
hookless, so neither an ordinary OpenSpec request nor a prompt watcher creates
a ticket. The OpenSpec task ledger remains canonical. The main agent reads
apply instructions, every returned `contextFiles` file, repository guidance,
and affected code before compiling a versioned plan.

Each plan records the source snapshot and revision, exact task references and
dependencies, read context, write paths and allowed operations, an imperative
patch recipe, done criteria, permitted validation, parent gates, and task
mappings. A unit is either `patch-only` or `verification-only`. This supports
mapping one broad task to several disjoint units, mapping coupled tasks to one
patch, and ordering a later integration unit that overlaps an earlier scope.
The plan is validated and persisted before Baton computes the maximal safe
ready frontier.

For every unit, routing derives minimum capability from complexity, context
size, code scope, reasoning, and execution needs, then walks only the user's
configured `coding_models` in exact order. Spark is only the first candidate:
an under-capable or current-session-exhausted Spark is skipped silently when a
later configured route qualifies. A route outside the profile is never used.
The user is notified only when no configured route is both available in the
current session and capable; the `NO_QUALIFIED_CANDIDATE` diagnostic lists every
candidate and every exclusion reason. Quota and uncallability are session-local
Baton cache facts; a new session rechecks them.

The parent passes each reservation prompt unchanged to a fresh exact-model
native worker, binds its opaque handle immediately, waits on real liveness,
records one terminal result, and releases before refilling. Terminal scopes
remain held until release. Workers cannot redesign or broaden scope, spawn
children, touch Git or OpenSpec, or choose models. The parent alone accepts
gates and reconciles checkboxes after all mapped units and gates pass, so no
checkbox is completed early.

The compiled run protocol is:

```text
baton apply <change> --host <host> --plan-file <plan.json> [--dispatch] --json
baton apply <change> --host <host> --run <run-id> --status --json
baton apply <change> --host <host> --run <run-id> --accept-gate <gate-id> --text "..." --json
baton apply <change> --host <host> --run <run-id> --reconcile [--task <number>] --json
baton apply <change> --host <host> --run <run-id> --plan-file <successor.json> [--dispatch] --json
```

The first plan is revision `1`. A successor must use the current run's parent
revision and fingerprint, preserve selected-task coverage, and pass fresh
catalog, capability, scope, and baseline checks. `--status` exposes run state;
`--accept-gate` records parent-owned gate evidence; only `--reconcile` writes
task conclusions and checkboxes. Source staleness, changed contracts, scope
changes, safety-blocked partial mutation, and `PLAN_INSUFFICIENT` return to the
director for a new decision. Legacy manual `baton apply` with explicit scopes
and `--read-only` remains compatible; compiled mode rejects manual scope flags.

## Rolling v2: fast, source-neutral startup

New large changes do not need a complete whole-change plan before the first
worker starts. A director accepts one bounded, dependency-ready `PlanDelta`,
dispatches its safe frontier, and appends later deltas while earlier workers
are queued or running. Every dispatched unit is still complete and immutable;
only discovery of future work remains open.

OpenSpec is optional. A `TaskSourceDescriptor` selects either the built-in
director source or an installed source adapter. The OpenSpec adapter uses the
stable Markdown task number (for example `1.1`) for reconciliation and keeps a
transient Apply ordinal only as diagnostics, so reordered Apply JSON cannot
change task identity.

```text
baton run start --host <host> --source-file <source.json|-> [--plan-delta-file <delta.json|->] [--run-id <run>] [--dispatch] --json
baton run <run> --append-plan <delta.json|-> [--dispatch] --json
baton run <run> --status --json
baton run <run> --accept-gate <gate>@<version> --text "..." [--dispatch] --json
baton run <run> --seal-task <task-key> --seal-file <seal.json|-> --json
baton run <run> --reconcile [--task <task-key>] --json
```

Status is task-first and distinguishes unplanned, planned, active,
terminal-unreleased, blocked, accepted, sealed, and reconciled work. Terminal
success, the safety verdict, parent acceptance, and release are separate
idempotent facts. Gates are typed as `safety-precondition`,
`integration-acceptance`, or `evidence`, and block only explicit dependencies.
A failed version remains auditable; the director may append an immutable
successor only when the failed lineage is replaceable. Tasks become complete
only after an exact non-superseded seal and adapter-owned reconciliation.

Rolling state lives under the current workspace runtime in
`runs/rolling-runs-v2/`. Clean uninstall inventories and retains these
append-only facts and accepted documents. Existing manual and compiled-v1
`baton apply` runs keep their original commands and are never silently
migrated.

## First session

Ticket-producing and capacity-sensitive dispatch commands require
`BATON_SESSION_ID`. Baton hashes that value into `session_uid` and keeps the
same identity for the root and every descendant.

```bash
export BATON_SESSION_ID="<opaque-session>"
baton models refresh --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton dispatch next --host <adapter-id> --json
baton dispatch status --host <adapter-id> --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

`baton apply` plans an OpenSpec change. `--dispatch` requires per-unit
`--write-path` or `--read-only`. Without OpenSpec, use `baton spawn`.

Automatic routing uses only the configured profile's `coding_models` allowlist,
the live catalog, task shape, supported reasoning options, service-tier
metadata, route health, and capacity evidence.

## Commands

```text
baton init
baton config --cli <adapter-id>
baton models refresh --host <adapter-id>
baton models status --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton apply <change> --host <adapter-id>
baton run start --host <adapter-id> --source-file <source.json> --plan-delta-file <delta.json> --dispatch --json
baton run <run-id> --status --json
baton dispatch next --host <adapter-id> [--capacity <n>] --json
baton dispatch status --host <adapter-id> [--capacity <n>] --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

`dispatch status` is scoped to the current root tree. General `baton status`
keeps workspace ticket inventory but groups capacity under `capacity_trees`.

## Documentation

- [Getting started](samples/getting-started/README.md) — isolated init through dispatch
- [Samples](samples/README.md) — adapter manifest sample and acceptance shape
- [Product guide](docs/guide.md) — adapter SDK, configuration, scheduling,
  ticket lifecycle, safety, and the measured OpenSpec apply
- [Architecture notes](docs/architecture/baton-dynamic-director.md)
- [Architecture diagram](docs/architecture/openbaton-architecture.html)
- [Layered runtime](docs/architecture/openbaton-layered-architecture.html)
- [Runtime skill](SKILL.md)
