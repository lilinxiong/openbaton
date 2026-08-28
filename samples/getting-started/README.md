# Getting started with Baton

**English** | [中文](README.zh.md)

This walkthrough uses the in-repo `sample-adapter` catalog fixture so you can
run `baton init`, `baton config`, `baton match`, `baton spawn`, and
`dispatch` without a paid host. It does not call a real native child CLI.

The adapter package lives in [`../manifest-example`](../manifest-example).
For a paid host, replace `--host sample-adapter` with that adapter id after
it is installed under `~/.baton/adapters/<adapter-id>/`.

## What you will do

1. Install Baton or use a source checkout.
2. Point discovery at the sample adapter.
3. `init` and enable the profile with catalog model ids.
4. Refresh the catalog and `match` a simple request.
5. Set `BATON_SESSION_ID`, `spawn` a write ticket, then `dispatch` it.
6. Bind a teaching execution handle and `complete --release`.

A throwaway home is used so this does not rewrite your real `~/.baton`.

## Install

Requires Node.js 22.5 or newer.

Install the published package globally, or use this checkout with bun install
and bun run baton -- help. The commands below assume a baton executable.
From a checkout, prefix each command with bun run baton -- instead.

## Isolated discovery

Use a temporary HOME and BATON_ADAPTER_PATHS so discovery reads only the
sample package. From the repository root:

```bash
REPO="$PWD"
ADAPTER="$REPO/samples/manifest-example"
sample_home="$(mktemp -d)"
work="$(mktemp -d)"
export HOME="$sample_home"
export BATON_ADAPTER_PATHS="$ADAPTER"
export BATON_SESSION_ID="getting-started-session"
```

init discovers manifests and installs bundled adapter packages into
~/.baton/adapters/. config --cli sample-adapter queries that adapter catalog
and writes only the selected profile.

```bash
baton init --cli sample-adapter
baton config --cli sample-adapter --runner sample-model --longctx sample-model --coding-model sample-model --enable
```

The catalog fixture currently reports one model id: sample-model. runner and
longctx are routing labels. coding_models is the ordered allowlist used by
automatic selection.

```bash
baton models refresh --host sample-adapter
baton models status --host sample-adapter
```

## match

match discloses the preferred model without creating work. The sample catalog
only reports reasoning effort low. A standard-complexity phrase can fail with
CODING_MODELS_EXHAUSTED / REASONING_EFFORT_UNSUPPORTED. Use a simple request
that Baton classifies as simple/low, for example:

```bash
baton match "tiny typo in one file" --host sample-adapter
```

Expected shape: preferred sample-model@low (CODING_PRIORITY).

## spawn and apply

Ticket-producing commands require BATON_SESSION_ID. spawn needs a director
classification. mechanical uses the runner label. analysis and discussion stay
on the director. Write tickets also need a git worktree and --write-path.

```bash
cd "$work"
git init -q
printf 'demo\n' > README.md
git add README.md
git -c user.email=gs@example.invalid -c user.name=GS commit -qm init
baton spawn "tiny typo in one file" --host sample-adapter --classification mechanical --write-path README.md --json
```

The JSON ticket includes session_uid, session_ordinal, ticket id, selected
model, Receipt id, and write_allowlist. Keep that ticket id for dispatch.

apply without OpenSpec exits and points at spawn:

```
OpenSpec is not in this project. baton still works standalone:
  baton spawn "explore the auth module"
```

With an OpenSpec change, plan then dispatch only scoped units:

```text
baton apply <change> --host sample-adapter
baton apply <change> --host sample-adapter --dispatch --unit <id> --write-path <path> --json
```

--dispatch without --unit is rejected (TASK_SCOPE_REQUIRED).

## dispatch

Capacity-sensitive dispatch commands also require BATON_SESSION_ID. Capacity
is per (host, session_uid) root-agent tree.

```bash
baton dispatch next --host sample-adapter --json
baton dispatch status --host sample-adapter --json
```

dispatch next reserves the ticket and returns the exact prompt, model, scope,
and reservation envelope. status reports host, session_uid, capacity,
capacity_sources, active, and available.

sample-adapter has no native child process. The manifest declares
native.execution_handle_kind = sample-native-task. Bind a teaching handle of
that kind so the control plane can complete. A real adapter returns this
handle from its native child API; do not invent a different kind.

```bash
baton dispatch bind <ticket> --execution-handle sample-native-task=demo-1 --host sample-adapter --json
baton dispatch complete <ticket> --host sample-adapter --text "fixed the typo" --release --json
baton dispatch status --host sample-adapter --json
```

After release, active should return to 0 and the ticket appears under
terminal as completed.

## Run the isolated script

From the repository root:

```bash
bun samples/getting-started/walkthrough.mjs
```

The script creates a temporary HOME and git worktree, then runs the sequence
above. It prints each command and the preferred model / ticket id.

## Notes

- Do not use this fixture against your real HOME if you already have Baton
  state you care about. The script isolates HOME.
- baton init may also copy bundled adapters (for example adapters/codex)
  into the isolated ~/.baton/adapters/. This walkthrough still addresses
  --host sample-adapter.
- There is no interactive model picker at execution time.
- probe-e2e is a separate paid-host fixture; see ../probe-e2e/README.md.

