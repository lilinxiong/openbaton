# Samples

**English** | [中文](README.zh.md)

Newcomers should start with [getting-started](getting-started/README.md).
That walkthrough uses the catalog fixture below to run init, config, match,
spawn, and dispatch in an isolated HOME.

# Adapter manifest sample

`manifest-example/` is a small external adapter package. It demonstrates the
public SDK boundary without embedding a real CLI, account, or model catalog.
Baton discovers the package from `adapter.json`; the package supplies
the catalog command and a runtime skill.

## Inspect the package

```bash
sed -n '1,240p' samples/manifest-example/adapter.json
sed -n '1,240p' samples/manifest-example/runtime/SKILL.md
```

The manifest covers the SDK schema, stable adapter id, package metadata,
catalog command/protocol, invocation signal, opaque native execution-handle
kind, runtime-skill paths, and quota/backpressure facts. The catalog command
returns a normalized JSON response with one adapter id and exact model
metadata.

## Isolated discovery

Build the checkout first, then point discovery at the sample package:

```bash
npm run build
BATON_ADAPTER_PATHS="$PWD/samples/manifest-example" \
  baton init
BATON_ADAPTER_PATHS="$PWD/samples/manifest-example" \
  baton config --cli sample-adapter --enable
BATON_ADAPTER_PATHS="$PWD/samples/manifest-example" \
  baton models refresh --host sample-adapter
```

Use a temporary home for a repeatable run:

```bash
sample_home="$(mktemp -d)"
HOME="$sample_home" BATON_ADAPTER_PATHS="$PWD/samples/manifest-example" \
  baton config --cli sample-adapter --enable
```

The result should contain only the selected `cli.sample-adapter` profile and
the catalog returned by its own command. No core source change is needed to
add another adapter.

## Acceptance shape

An adapter release is ready when it passes SDK conformance, isolated package
checks, manifest discovery, live catalog checks, exact native child execution,
invalid-model rejection, ticket lifecycle, and cleanup audits. The native
identity handoff must include `session_id`, `ticket_id`, `session_uid`,
`session_ordinal`, and the adapter's opaque execution handle.

On explicit quota exhaustion, a clean write baseline permits an immutable
successor with a new per-session ordinal and Receipt. It records
`successor_from_ticket_id` and `successor_reason`, retains host/scope/session
and quota lineage, and reruns all routing checks. The original ticket remains
unchanged.

See [EXPECTED.md](EXPECTED.md) for the concise acceptance checklist.
