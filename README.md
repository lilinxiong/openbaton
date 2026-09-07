# Baton

**English** | [中文](README.zh.md)

Baton 2.0 is a host-native CLI for discovering models, selecting an exact
native route, and producing a structured handoff. It does not run managed
tickets or dispatch another CLI. `spawn` returns `spawned: false`; the host
decides whether and how to execute the handoff.

Requires Node.js 22.5+.

Bundled hosts include Codex (`--cli codex`) and Grok (`--cli grok`). The
installed host skill is explicit-invocation only: `$baton` in Codex, `/baton`
in Grok.

```bash
npm install -g @zhouliuya/openbaton
baton init --cli <host>
baton config --cli <host> --implementation-model <model-id> --enable
baton models --host <host>
baton match --host <host> --work-mode implementation
baton spawn --brief brief.json --host <host> --work-mode implementation --json
```

Each work mode has its own ordered model pool. Selection never falls back
to another mode. The root chooses reasoning effort per task with `--effort`;
omitting it leaves the host default unchanged.

See [docs/guide.md](docs/guide.md) for the adapter contract and
[samples/getting-started/](samples/getting-started/) for an isolated fake
adapter walkthrough. From a checkout:

```bash
bun install
bun run baton -- <command> ...
bun samples/getting-started/walkthrough.mjs
```

The walkthrough runs `init`, `config`, `models`, `match`, `spawn`, `record`, and
`status` in a temporary HOME. It performs no paid model execution.
