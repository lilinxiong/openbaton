# Baton capability samples

This sample validates the same read-only incident audit through two paths:

- `standalone`: the workspace has no `openspec/`; the Codex director must derive five bounded tickets from an ordinary request.
- `openspec`: the workspace contains a strict-valid OpenSpec change with five stable tasks; Baton must consume those tasks and write conclusions back by task number.

Neither user request names Baton, subagents, dispatch, routes, or OpenSpec. If delegation only happens after adding such words, automatic triggering has failed.

## Prerequisites

From the OpenBaton checkout:

```bash
npm test
npm run build
npm link
baton update
baton routes refresh
baton cards --ranked
```

At least one ranked executable exact route/profile must be visible. `npm link` is required only when testing this source checkout; a normally installed package already provides `baton` on `PATH`.

## Standalone path

```bash
node samples/bootstrap.mjs standalone
```

Open a new Codex task at the printed workspace and paste the printed request unchanged. After it finishes:

```bash
node samples/verify.mjs <workspace> standalone
```

Expected properties:

- no `openspec/` exists;
- five standalone tickets are created from the ordinary request;
- four are `concrete/terminal-only` and one is `deliberative/checkpointed`;
- the deliberative ticket reports at least one progress checkpoint;
- all tickets have a real agent id, one attempt, terminal completion, close, and slot release;
- no workspace file changes.

## OpenSpec path

```bash
node samples/bootstrap.mjs openspec
```

Open a new Codex task at the printed workspace and paste the printed request unchanged. After it finishes:

```bash
node samples/verify.mjs <workspace> openspec
```

Expected properties:

- five tickets use `source=openspec` and stable task numbers `1.1` through `2.1`;
- completion checks each task and adds one child `conclusion:` line;
- `openspec validate incident-audit --strict` passes;
- only `openspec/changes/incident-audit/tasks.md` changes in the workspace;
- the same lifecycle/progress assertions as the standalone path pass.

Business answers are listed in [EXPECTED.md](EXPECTED.md). Read them after the run, not before asking Codex to perform the audit.
