# Optional subagent capacity test

## Accepted behavior

- Store the user's concurrent subagent budget in each Baton CLI profile.
- Interactive config offers an optional capacity test, skipped by default.
- Skipping or cancelling this step stores 3; this is a Baton default, not a
  claim that the host capacity was measured.
- A successful test offers 1 through min(measured capacity, 20).
- Hold probes open until capacity is reached; completed probes still count.
  Stop only on an identified capacity rejection or at 20, then close every probe.
- Authentication, network, model, protocol and cleanup failures are not capacity
  measurements. Report an inconclusive test and use the default, not a false cap.
- An isolated Codex test measures that CLI's fresh root session, not remaining
  slots or overrides in an already running desktop task. Do not change host limits.
- Include the configured budget in native handoff output and tell the host agent
  to respect it. Baton still does not own the host scheduler.

## Acceptance

- Verify config persistence, skip/cancel default, 1..N validation and 20 cap.
- Verify probe evidence, unexpected failures and cleanup before accepting results.
- Verify existing model selection and legacy profiles remain usable.
- Run type checking, relevant tests, and a real isolated Codex probe if available.
