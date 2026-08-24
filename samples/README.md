# Baton automatic-routing samples

These samples validate the same read-only incident audit through two paths, with no runtime model picker or confirmation step:

- `standalone`: the workspace has no `openspec/`; the director derives five bounded units from an ordinary request.
- `openspec`: the workspace contains a strict-valid OpenSpec change with five stable tasks; Baton consumes those tasks and writes conclusions back by task number.

Both paths fan out five independent tickets at once (four concrete evidence lanes plus one deliberative priority lane). None waits for another worker. That parallel dispatch is the speed case versus one sequential parent agent. Token use is a separate question: five workers still pay five contexts.

Neither request names Baton, subagents, dispatch, models, routes, or OpenSpec. If delegation only happens after adding such words, automatic triggering has failed.

## Prerequisites

From the OpenBaton checkout:

```bash
bun run test
bun run build
bun link
baton update
baton config
baton models
baton cards
```

`baton config` must enable the invoking CLI profile, assign optional `runner` and `longctx` labels, and choose the models subagents may call. The catalog shown by the command comes directly from that CLI's own model source; Baton does not obtain or augment it from OpenCodex. `runner` and `longctx` are labels only and do not assert model context-window capabilities.

When running from Codex, configure `[cli.codex]`. From Cursor, configure `[cli.cursor]`. From Grok, configure `[cli.grok]`. Verification resolves the invoking host dynamically from runtime signals, `BATON_HOST`, or `--host`; it does not assume `cli.active`.

`bun link` is required only when testing this source checkout. A normally installed package already provides `baton` on `PATH`.

## Automatic routing contract

The ordinary business request is decomposed once. Baton records an auditable proposal and immediately chooses a model, reasoning effort, and available speed signal from the enabled CLI candidate set. It then creates tickets without rendering a selector or waiting for user confirmation.

Every automatic choice must satisfy all of the following:

- the exact base model was returned by the invoking CLI catalog and is present in that host's enabled `subagent_models`;
- when the catalog reports reasoning efforts or service tiers, the chosen values must come from that model's catalog entry;
- `confirmed_by=baton-recommendation` and `changed_by_user=false` are persisted as audit evidence;
- a zero benchmark score, score tie, or missing Artificial Analysis record does not open a manual-choice flow;
- no hard-coded family ban removes a configured model that the invoking CLI returned and the user enabled.

## Standalone path

```bash
bun samples/bootstrap.mjs standalone
```

Use the printed workspace in the current host task and pass the printed request to the trigger unchanged. After it finishes:

```bash
bun samples/verify.mjs <workspace> standalone
```

The verifier resolves the invoking host automatically. Override with `BATON_HOST=cursor` or `bun samples/verify.mjs --host cursor <workspace> standalone` when needed.

Expected properties:

- no `openspec/` exists;
- one five-unit proposal is automatically approved and creates five standalone tickets;
- every ticket uses the proposal's recommended model and carries immutable automatic-selection evidence;
- four tickets are `concrete/terminal-only` and one is `deliberative/checkpointed`;
- the five tickets are reserved together and may run in parallel; none is blocked on another unit's conclusion;
- the deliberative ticket reports at least one progress checkpoint;
- all tickets have a real agent id, one attempt, terminal completion, close, and slot release;
- no workspace file changes.

## OpenSpec path

```bash
bun samples/bootstrap.mjs openspec
```

Use the printed workspace in the current Codex task and pass the printed request to the trigger unchanged. After it finishes:

```bash
bun samples/verify.mjs <workspace> openspec
```

Expected properties:

- five tickets use `source=openspec` and stable task numbers `1.1` through `2.1`;
- one five-unit proposal is automatically approved without a selector;
- completion checks each task and adds one child `conclusion:` line;
- `openspec validate incident-audit --strict` passes;
- only `openspec/changes/incident-audit/tasks.md` changes in the workspace;
- the same lifecycle and automatic-routing assertions as the standalone path pass.

## Paired gate

After running both fresh workspaces, verify that each request independently used the automatic recommendation path:

```bash
bun samples/verify-bundle.mjs <standalone-workspace> <openspec-workspace>
```

Business answers are listed in [EXPECTED.md](EXPECTED.md). Read them after the run, not before asking Codex to perform the audit.

## Probe E2E path (post-adapter coding)

Use after `/add-cli-to-baton` to verify parallel implement tasks, serial integration, and OpenSpec apply in an isolated git worktree.

The fixed template lives in `samples/probe-e2e/` (including its embedded `openspec/` tree). It is **not** stored in the repo-root `openspec/` directory, which is gitignored.

```bash
bun samples/bootstrap-probe.mjs --host cursor --worktree ../openbaton-probe-cursor
```

Open a fresh chat in the printed worktree and run:

```text
/openspec-apply-change probe-e2e
```

Pass `REQUEST.txt` unchanged. After apply:

```bash
bun samples/verify-probe.mjs --host cursor ../openbaton-probe-cursor
```

Expected properties:

- change `probe-e2e` with three tasks: `1.1`, `1.2` parallel, then `2.1` serial;
- workers create `src/utils/format.js`, `src/utils/validate.js`, and `src/index.js`;
- `bun verify-local.mjs` exits zero;
- OpenSpec strict validation passes;
- Baton tickets use automatic recommendation evidence and release without leak.

Cleanup after PASS:

```bash
git worktree remove ../openbaton-probe-cursor
git branch -D probe/cursor-e2e
```

Orchestration skill: `/verify-cli-baton-e2e <target>`.
