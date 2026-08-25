## Purpose

Provide a minimal coding probe that validates parallel and serial OpenSpec apply execution with deterministic local verification.

## ADDED Requirements

### Requirement: Parallel utility modules

The probe SHALL implement `formatLabel` and `isNonEmpty` in separate files that can be built independently in parallel.

#### Scenario: Parallel implement

- **WHEN** section 1 tasks run
- **THEN** `src/utils/format.js` and `src/utils/validate.js` exist with the specified exports and do not block each other

### Requirement: Serial integration barrel

The probe SHALL export both utilities from `src/index.js` and expose `runSmoke()` that returns `{ ok: true }` when both utilities behave correctly.

#### Scenario: Integration after utilities

- **WHEN** both utility modules exist
- **THEN** `src/index.js` re-exports them and `bun verify-local.mjs` exits zero

### Requirement: Task identity and conclusions

Each task SHALL keep its stable number and receive one concise conclusion when accepted.

#### Scenario: Task completion writeback

- **WHEN** a task is accepted
- **THEN** only its matching checkbox is completed and its conclusion is stored directly beneath it
