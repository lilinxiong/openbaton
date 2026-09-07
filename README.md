# Baton

**English** | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/%40zhouliuya%2Fopenbaton)](https://www.npmjs.com/package/@zhouliuya/openbaton)
[![CI](https://github.com/lilinxiong/openbaton/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lilinxiong/openbaton/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Baton helps your coding agent select models, prepare focused tasks, and delegate
work through the current host's native subagents.

## Why Baton?

- **Focused context:** send workers a compact brief with scope, settled decisions,
  and acceptance criteria instead of the full conversation.
- **Batch preparation:** prepare independent tasks with one shared model catalog
  lookup, while keeping model choices and constraints specific to each task.
- **Incremental follow-ups:** reuse the existing native worker for feedback on the
  same task and send only what changed.
- **Usage visibility:** summarize host-reported observations with `observe` to
  inspect token usage and completion. Actual savings depend on the workload,
  selected models, and context supplied by the host.

## Install

Requires Node.js **22.5+** and a supported host with native subagent execution.
Bundled hosts are **Codex** and **Grok**.

```bash
npm install -g @zhouliuya/openbaton@latest
baton --version
```

### Upgrade

```bash
npm install -g @zhouliuya/openbaton@latest
baton update
baton --version
```

`baton update` refreshes Baton-owned skills and bundled adapter files, preserving
configured model pools. It does not upgrade the npm package itself.

Stable versions are published automatically to npm through GitHub Actions with
build provenance. See the [npm package](https://www.npmjs.com/package/@zhouliuya/openbaton)
and [publish workflow](https://github.com/lilinxiong/openbaton/actions/workflows/publish.yml).

## Quick start

For Codex, initialize Baton and inspect the available models:

```bash
baton init --cli codex
baton models --host codex
```

Choose an actual model ID from that catalog and configure the implementation pool:

```bash
baton config --cli codex --implementation-model MODEL_ID --enable
```

Replace `MODEL_ID` with your chosen ID. Configure `--execution-model` for settled
steps and `--investigation-model` for open questions as needed. Each work mode has
its own ordered pool; selection stays within that pool. Run `baton config` without
`--cli` in a terminal to use the interactive picker.

Then explicitly invoke Baton in your Codex conversation, for example:

```text
$baton Implement the agreed input validation in src/parser.ts.
Keep the public API unchanged and verify malformed-input handling.
```

Use a task and file path from your own project. The host prepares a bounded brief,
starts a native worker, and reviews its result. For Grok, use `--cli grok` and
`--host grok` during setup, then invoke `/baton` in the conversation.

## How it works

Baton selects an exact model route and produces a structured handoff. The current
host executes it through its native subagent API. `baton spawn` prepares that
handoff and returns `spawned: false`; it does not start a worker itself.

The installed skill activates only when explicitly invoked. Small tasks use one
worker; independent tasks can be prepared together with `spawn --briefs FILE`.
The host decides concurrency and coordinates overlapping writes. Task scope is a
prompt contract, not a filesystem sandbox.

The root agent chooses reasoning effort per task with `--effort`; omitting it
keeps the host default. `status` shows recorded results rather than live worker
state, while `observe --file FILE --json` summarizes host-reported usage.

## Documentation

- [User guide](docs/guide.md): work modes, briefs, batch selection, and observations.
- [Getting-started walkthrough](samples/getting-started/README.md): an isolated fake-adapter example.
- [Adapter contract](samples/manifest-example/): integrate another host.

## Local development

From a source checkout, install Bun, then run:

```bash
bun install --frozen-lockfile
bun run test
bun run baton -- --help
bun samples/getting-started/walkthrough.mjs
```

The walkthrough runs `init`, `config`, `models`, `match`, `spawn`, `record`, and
`status` in a temporary HOME. It performs no paid model execution.

## License

[MIT](LICENSE)
