# Baton capability samples

This sample validates the same read-only incident audit and mandatory model-selection handshake through two paths:

- `standalone`: the workspace has no `openspec/`; the Codex director must derive five bounded units in one request-level proposal from an ordinary request.
- `openspec`: the workspace contains a strict-valid OpenSpec change with five stable tasks; Baton must consume those tasks and write conclusions back by task number.

Neither user request names Baton, subagents, dispatch, routes, or OpenSpec. If delegation only happens after adding such words, automatic triggering has failed.

## Prerequisites

From the OpenBaton checkout:

```bash
bun run test
bun run build
bun link
baton update
baton routes refresh
baton cards --ranked
```

At least one ranked executable exact route/profile must be visible. `bun link` is required only when testing this source checkout; a normally installed package already provides `baton` on `PATH`.

The current Codex task must derive the complete current calling-host model and reasoning-effort surface from the model selector/tool schema and silently run `baton host sync` before it proposes models. Do not manually maintain a model list or truncate it to a shorter `spawn_agent` optional-override hint. OpenCodex may expose more catalog routes/profiles than the current Codex task can spawn; the proposal must show that difference.

Quota uses `OpenCodex reported > local CodexBar fallback > unknown`. A sample run must preserve source/reason, never overwrite an OpenCodex reported window, and never persist CodexBar account/auth/raw-output fields. CodexBar is optional; absence or provider failure remains an explicit unknown state.

## Required confirmation interaction

The pasted business request is intentionally trigger-neutral. Codex must not ask the user to invoke Baton. It should first break down the work and present comparison-table model-selection disclosure containing:

- one preferred exact route/profile when scoring has a unique positive winner, otherwise an explicit manual-choice state;
- all policy-eligible currently callable candidates, strengths, task score, raw/available AA data, reference-only status/provenance, remaining quota/reset or an explicit unknown reason, and callability;
- an auditable built-in exclusion for every `gpt-5.5`, `gpt-5.6-sol`, and `gpt-5.6-terra` route/profile; none of those families may appear as a candidate or ticket even if the Codex host advertises it;
- OpenCodex providers/routes unavailable from the current Codex host.

At this point no ticket may exist. When both paths are tested in one front conversation, Codex combines the standalone proposal and OpenSpec proposal into one selector. Provider is one global multi-select for the entire request; the two path groups and all ten task assignments appear below it. Reply with one Submit that:

1. keeps any suitable preferred choices;
2. changes or manually selects at least one disclosed exact candidate;
3. uses at least two providers across the paired bundle when at least two providers are callable in this Codex session.

That single Submit sends one confirmation id to both proposals. Codex should then approve both and execute the tickets. Never ask it to choose an unavailable route, and never accept fallback.

The selector is a Chinese, current-conversation inline-only artifact. Codex must faithfully translate every English source task into a Chinese `--task-label SCOPE/TASK=CHINESE_LABEL` used only for rendering, then emit the one `inline_content_reference` returned by `baton selection render-bundle ... --json` in the current response. The original business requests, source tasks, and fingerprints stay unchanged. Codex must never open a browser, navigate to `file://`, show a file link, or create a separate page/window/task for model selection. If inline rendering is unavailable, the complete Chinese disclosure and one confirmation remain as text in this same conversation.

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
- five standalone tickets are created from the ordinary request;
- one five-unit standalone selection proposal is approved before those tickets exist;
- every ticket carries immutable user model-approval evidence; at least one choice differs from the recommendation/manual default;
- candidate disclosure covers strengths, task/AA scores and available data, reference-only provenance, quota, callability, and unavailable providers;
- every proposal discloses all three built-in family bans, and no candidate or ticket belongs to any of those families;
- if at least two providers are callable, selected tickets across the paired bundle cover at least two providers;
- four are `concrete/terminal-only` and one is `deliberative/checkpointed`;
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
- one five-unit OpenSpec selection proposal is approved before tickets are created, including at least one user route change/manual choice;
- completion checks each task and adds one child `conclusion:` line;
- `openspec validate incident-audit --strict` passes;
- only `openspec/changes/incident-audit/tasks.md` changes in the workspace;
- the same lifecycle/progress assertions as the standalone path pass.

## Combined one-Submit gate

For the required paired run, bootstrap both fresh workspaces in this same Codex task, create one pending proposal in each, and render them together:

```bash
baton selection render-bundle \
  --proposal 'standalone=/absolute/standalone#sel-0001' \
  --proposal 'openspec=/absolute/openspec#sel-0001' \
  --output /absolute/selection-bundle.html \
  --task-label standalone/TASK=中文说明 \
  --task-label openspec/TASK=中文说明 \
  --json
```

There must be one global Provider control, one combined task table, and one Submit. After both path verifiers pass, verify that they came from that same Submit:

```bash
bun samples/verify-bundle.mjs <standalone-workspace> <openspec-workspace>
```

Business answers are listed in [EXPECTED.md](EXPECTED.md). Read them after the run, not before asking Codex to perform the audit.
