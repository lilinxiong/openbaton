## Why

Release owners need a reproducible, evidence-backed audit of the frozen incident snapshot before deciding response priority.

## What Changes

- Produce five independent read-only audit conclusions from the incident data and SLA policy.
- Preserve stable task identity and write each accepted conclusion back to the checklist.

## Capabilities

### New Capabilities

- `incident-audit`: Read-only incident statistics, SLA, prioritization, duplicate ownership, and data-quality audit.

### Modified Capabilities

None.

## Impact

Only audit conclusions and the OpenSpec task checklist are affected. Business input files remain unchanged.
