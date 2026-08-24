## Context

The workspace starts with no implementation files under `src/utils/` or `src/index.js`. A local script `verify-local.mjs` checks the final behavior.

## Goals / Non-Goals

**Goals:**

- Two parallel implement lanes with disjoint write paths.
- One serial integration lane depending on section 1.
- Deterministic verification via `bun verify-local.mjs`.

**Non-Goals:**

- Changing unrelated files.
- Adding dependencies or a build step.

## Decisions

- Use plain JavaScript modules (`type: module`).
- Keep three stable tasks: `1.1`, `1.2`, `2.1`.
- Dispatch section 1 in parallel; section 2 waits for both utility modules.

## Risks / Trade-offs

- Parallel workers must not edit the same file → separate paths under `src/utils/`.
