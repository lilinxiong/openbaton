# Adapter acceptance

Acceptance must prove behavior, not merely the presence of new names or files. Keep static tests, build/package checks, live catalog evidence, native host evidence, and Baton end-to-end evidence separate in the final report.

## Automated coverage

Add or extend tests for all applicable items.

### Adapter and catalog

- every registered id has exactly one adapter and matching host metadata;
- command resolution, explicit override priority, missing binary, and version behavior;
- real target response shapes plus sanitized fixtures;
- hidden models, pagination, duplicate ids, empty catalog, malformed data, timeout, command failure, authentication/prose rejection, and coded errors;
- exact preservation of model ids and exposed effort/tier metadata without invented values;
- the compatibility model-discovery facade routes to the target adapter.

### Config, init, and installation

- default and normalized config contains one independent target profile;
- serialization and migration preserve existing Codex/Grok profiles;
- target enable/disable is host-scoped and never falls back across hosts;
- `baton init` interactive CLI selection includes the target and proceeds through its returned models;
- `baton init --cli <target>` and `baton config --cli <target>` work in non-interactive flows;
- target runner, longctx, and subagent allowlist validation uses only its own catalog;
- init/update installs the target runtime skill at the verified path without overwriting unrelated user files;
- help, status, package contents, and user documentation list the target where appropriate.

### Matching, tickets, and lifecycle

- automatic matching never selects outside the enabled target allowlist;
- stale model, unsupported effort/tier, missing profile, and disabled profile fail closed;
- proposal, ticket, Receipt, reservation, binding, terminal outcome, and release retain the immutable target host;
- reserve/bind/complete/release under a different host returns a host-mismatch failure;
- concurrency/backpressure defers the same target ticket without consuming an attempt or switching models;
- recovery and status do not leak or relabel target tickets;
- target-specific write and Git semantics match the verified host behavior and existing Receipt rules.

Prefer shared conformance assertions over duplicated target-only tests. Add target-specific fixtures and behavior tests only where its protocol differs. Avoid tests that merely regex-match documentation wording.

## Director/worker routing acceptance

A new host is incomplete unless these gates pass. Keep the automated coverage above; this section is a completeness check on the runtime skill and shared guard.

### Runtime skill completeness

Inspect the installed target runtime Baton skill. It MUST name the shared director/worker table with the same three rows:

- Empty labels / undeclared / unclassified → director
- Declared classified work → native subagents
- OpenSpec only lightens orchestration

Omitting the table or substituting a host-specific exception is not `PASS`. Unit tests still must not merely regex-match documentation wording; this gate is an acceptance completeness check that the runtime skill contains the table, not a wording-regex unit test.

### Hook-capable hosts

If the target exposes a PreToolUse-compatible hook that Baton installs, acceptance MUST require ticket-presence:

- no reserved ticket → director mutating tools allowed
- reserved/dispatching/running worker tickets → director implementation writes denied; standalone baton control-plane commands still allowed
- bound workers stay inside the Receipt

`fail-closed-always` and `allow-always` are both incomplete.

### Hookless hosts

Hosts without a compatible hook (Cursor today) still MUST ship the table in the runtime skill. Missing a hook is not a license to implement declared classified work in the parent. Do not pretend a missing hook enforces the table.

## Repository gates

Run focused tests while implementing, then run all repository-standard gates. At minimum for the current repository:

```text
npm test
npm run build
npm pack --dry-run
```

Also run the repository's diff/format check and inspect the exact changed-path allowlist. Exercise the locally built Baton executable with an isolated temporary home so testing does not overwrite the user's real `~/.baton` configuration, installed skills, hooks, cache, or tickets.

Any pre-existing baseline failure must be reported separately. A regression caused by the adapter must be fixed before proceeding.

## User-visible init/config acceptance

Using an isolated home and the locally built package:

1. Start interactive `baton init` and verify the target appears alongside existing hosts.
2. Select the target and verify the next phase queries the target's real model source.
3. Select runner, longctx, and subagent candidates from only that returned catalog, then enable the target.
4. Verify the persisted `cli.<target>` profile without altering another host profile.
5. Disable the target and prove an explicit target operation fails closed rather than using Codex, Grok, or the legacy active default.
6. Exercise the equivalent non-interactive init/config path.

Fixtures may test prompt behavior, but final acceptance requires the locally built CLI and the live target catalog.

## Native and Baton end-to-end acceptance

Use the shortest harmless read-only task and one exact picker-visible model.

1. Refresh or capture the target catalog and verify the exact model and selected options are present.
2. Create and reserve a real Baton ticket explicitly targeting the new host.
3. Call the target's native child-agent tool with the ticket's exact model and verified no-context-inheritance setting.
4. Bind the returned stable child identity immediately.
5. Wait for native completion; do not convert a polling interval into ticket failure.
6. Record the exact terminal conclusion and release the ticket.
7. Verify final status has no queued/running/awaiting-release leak for the acceptance ticket.
8. Repeat the invalid-model negative check when post-registration plumbing could introduce inheritance or fallback.

The native call proves current host/session/account callability only. Do not generalize that result to future versions.

## Final repository audit

- inspect `git status`, the complete diff, and changed paths;
- preserve unrelated user changes;
- verify no raw model response with credentials, account identifiers, tokens, or sensitive paths entered fixtures;
- verify temporary homes and repositories did not alter the user's real configuration;
- do not commit or push unless separately requested.

## Terminal outcomes

- `PASS`: every required automated, build/package, live catalog, native child-agent, init/config, Baton lifecycle, director/worker routing, leak, and repository audit gate passed.
- `CATALOG_ONLY`: the target's catalog is usable but it lacks a qualifying native exact-model child agent; do not leave it registered as executable.
- `UNSUPPORTED`: a required target capability is intrinsically unavailable; identify the failed gate and evidence.
- `BLOCKED`: authentication, permission, installation, trust, quota, network, or another external condition prevents completion; state the exact next action.
- `REVISE`: an intermediate implementation or test failure. Continue fixing; do not deliver this as the final result when the issue is repository-controlled.

The final report should include: target/version, catalog source and visible count, native tool and exact-model result, context/lifecycle/workspace findings, changed paths, test/build/package results, live Baton ticket result, final leak and Git audit, and the terminal outcome.
