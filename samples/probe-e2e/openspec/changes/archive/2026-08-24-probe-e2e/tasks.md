## 1. Utility modules

These two modules are independent and MUST be implemented in parallel. Neither waits for the other.

- [x] 1.1 Implement `src/utils/format.js` exporting `formatLabel(value)` that trims whitespace and uppercases the result
  - conclusion: formatLabel trims and uppercases in src/utils/format.js
- [x] 1.2 Implement `src/utils/validate.js` exporting `isNonEmpty(value)` that returns true only when trimmed length is greater than zero
  - conclusion: isNonEmpty checks trimmed length in src/utils/validate.js

## 2. Integration

This section depends on section 1 and MUST run after both utility modules exist.

- [x] 2.1 Implement `src/index.js` to re-export both utilities and export `runSmoke()` returning `{ ok: true }` when `formatLabel("  probe ")` is `"PROBE"` and `isNonEmpty` behaves correctly on sample inputs
  - conclusion: index re-exports utilities and runSmoke passes probe checks
