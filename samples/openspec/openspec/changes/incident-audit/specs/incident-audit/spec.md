## Purpose

Provide a reproducible read-only audit that turns a frozen incident snapshot and SLA policy into independently verifiable operational findings.

## ADDED Requirements

### Requirement: Produce five read-only audit lanes

The audit SHALL report incident counts, SLA breaches, unresolved priority, duplicate ownership combinations, and data-quality findings without modifying business inputs.

#### Scenario: Complete audit

- **WHEN** the frozen incident snapshot and policy are audited
- **THEN** all five lanes produce evidence-backed conclusions and the input files remain unchanged

### Requirement: Preserve task identity and conclusions

The audit SHALL preserve each stable task number and attach one concise conclusion when that task completes.

#### Scenario: Task completion writeback

- **WHEN** an audit task is accepted
- **THEN** only its matching checkbox is completed and its conclusion is stored directly beneath it
