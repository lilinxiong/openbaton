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
baton config --cli <adapter-id> --enable
```

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

Core has no built-in catalog. An adapter package is discovered from
`adapter.json` under `~/.baton/adapters/<adapter-id>/` or
`BATON_ADAPTER_PATHS`. There is no interactive model-choice step during
execution.

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

Automatic routing uses only the enabled profile's `coding_models` allowlist,
the live catalog, task shape, supported reasoning options, service-tier
metadata, route health, and capacity evidence.

## Commands

```text
baton init
baton config --cli <adapter-id> --enable
baton models refresh --host <adapter-id>
baton models status --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton apply <change> --host <adapter-id>
baton dispatch next --host <adapter-id> [--capacity <n>] --json
baton dispatch status --host <adapter-id> [--capacity <n>] --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

`dispatch status` is scoped to the current root tree. General `baton status`
keeps workspace ticket inventory but groups capacity under `capacity_trees`.

## Documentation

- [Product guide](docs/guide.md) — adapter SDK, configuration, scheduling,
  ticket lifecycle, safety, and the measured OpenSpec apply
- [Architecture notes](docs/architecture/baton-dynamic-director.md)
- [Architecture diagram](docs/architecture/openbaton-architecture.html)
- [Layered runtime](docs/architecture/openbaton-layered-architecture.html)
- [Runtime skill](SKILL.md)

