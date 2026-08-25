## Why

New Baton hosts need a reproducible coding probe that exercises parallel implement tasks, serial integration, and OpenSpec task writeback without touching the main adapter worktree.

## What Changes

- Implement two independent utility modules in parallel.
- Wire them through a single index module after both exist.
- Record one conclusion per completed task in the OpenSpec checklist.

## Capabilities

### New Capabilities

- `probe-e2e`: Minimal format/validate utilities with a deterministic local verifier.

### Modified Capabilities

None.

## Impact

Only the probe workspace source files and OpenSpec task checklist are affected.
