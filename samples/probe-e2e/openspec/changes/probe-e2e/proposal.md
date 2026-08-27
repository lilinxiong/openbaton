## Why

New Baton hosts need a reproducible coding probe that exercises parallel
implementation, serial integration, and OpenSpec task writeback in an
isolated Git workspace.

## What Changes

- Implement two independent utility modules in parallel.
- Wire them through one integration module after both exist.
- Record one concise conclusion per completed task.

## Capabilities

### New Capabilities

- `probe-e2e`: Minimal format/validate utilities with deterministic verifiers.

### Modified Capabilities

None.

## Impact

Only the disposable probe workspace source files and OpenSpec checklist are
affected.
