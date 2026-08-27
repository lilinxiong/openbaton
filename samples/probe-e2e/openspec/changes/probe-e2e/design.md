## Context

The workspace starts without implementation files under `src/utils/` or
`src/index.js`. Local verifiers check the standalone and integrated behavior.

## Goals / Non-Goals

**Goals:**

- Two parallel implementation lanes with disjoint write paths.
- One serial integration lane depending on section 1.
- Deterministic verification with no dependencies or build step.

**Non-Goals:**

- Changing unrelated files.
- Adding dependencies or changing the OpenSpec plan.

## Decisions

- Use plain JavaScript modules (`type: module`).
- Keep stable task numbers `1.1`, `1.2`, and `2.1`.
- Dispatch section 1 in parallel; section 2 waits for both utility modules.

## Risks / Trade-offs

- Parallel workers must not edit the same file; each utility has its own path.
