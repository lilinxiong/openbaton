## Context

The workspace contains one frozen incident JSON file and one policy JSON file. The audit must remain read-only.

## Goals / Non-Goals

**Goals:**

- Compute independently verifiable findings.
- Keep each audit lane bounded and suitable for independent execution.
- Return checkpoint state for the prioritization analysis.

**Non-Goals:**

- Editing incident or policy data.
- Implementing an incident-management application.

## Decisions

- Use five stable tasks so completion and conclusion writeback can be verified independently.
- Treat prioritization as deliberative work; the other four lanes are concrete evidence extraction.
- Keep all workers read-only and let the main Codex task own final synthesis.

## Risks / Trade-offs

- Parallel workers may phrase findings differently → verifier checks lifecycle structure while `samples/EXPECTED.md` supplies the human business oracle.
