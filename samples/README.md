# Baton automatic-routing samples

These samples validate the same read-only incident audit through two paths, with no runtime model picker or confirmation step:

- `standalone`: the workspace has no `openspec/`; the Codex director derives five bounded units from an ordinary request.
- `openspec`: the workspace contains a strict-valid OpenSpec change with five stable tasks; Baton consumes those tasks and writes conclusions back by task number.

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

`baton config` must select and enable the Codex profile, assign optional `runner` and `longctx` labels, and choose the models subagents may call. The catalog shown by the command comes directly from Codex `model/list`; Baton does not obtain or augment it from OpenCodex. `runner` and `longctx` are labels only and do not assert model context-window capabilities.

`bun link` is required only when testing this source checkout. A normally installed package already provides `baton` on `PATH`.

## Automatic routing contract

The ordinary business request is decomposed once. Baton records an auditable proposal and immediately chooses a model, reasoning effort, and available speed signal from the enabled CLI candidate set. It then creates tickets without rendering a selector or waiting for user confirmation.

Every automatic choice must satisfy all of the following:

- the exact base model was returned by the active Codex catalog and is present in `cli.codex.subagent_models`;
- the chosen reasoning effort and any non-null service tier are values Codex returned for that model;
- `confirmed_by=baton-recommendation` and `changed_by_user=false` are persisted as audit evidence;
- a zero benchmark score, score tie, or missing Artificial Analysis record does not open a manual-choice flow;
- no hard-coded family ban removes a configured Codex model, including `gpt-5.4-mini` or `gpt-5.3-codex-spark`.

## Standalone path

```bash
bun samples/bootstrap.mjs standalone
```

Use the printed workspace in the current Codex task and pass the printed request to the trigger unchanged. After it finishes:

```bash
bun samples/verify.mjs <workspace> standalone
```

Expected properties:

- no `openspec/` exists;
- one five-unit proposal is automatically approved and creates five standalone tickets;
- every ticket uses the proposal's recommended model and carries immutable automatic-selection evidence;
- four tickets are `concrete/terminal-only` and one is `deliberative/checkpointed`;
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
