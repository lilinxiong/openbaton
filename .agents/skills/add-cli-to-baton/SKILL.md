---
name: add-cli-to-baton
description: Add the invoking coding CLI to OpenBaton end to end, including CLI-owned model discovery, native exact-model subagents, host-scoped configuration, runtime skill installation, tests, and live acceptance. Use when making a new CLI a supported Baton host that appears in baton init with its own model catalog. Do not use for ordinary Baton dispatch, model selection, or report-only compatibility reviews.
---

# Add a CLI to Baton

Make the invoking coding CLI a first-class OpenBaton host. Unless the user names a different target, treat the CLI running this skill as the target. For example, when this skill runs inside Cursor, complete the Cursor integration rather than merely writing a Cursor compatibility report.

The job is complete only when the target has the Baton capabilities that apply to the existing hosts, its automated and live acceptance pass, and `baton init` can select the target and then configure models returned by that target. Assessment is a gate to implementation, not the normal deliverable.

## Load the workflow references

- Read [references/openbaton-contract.md](references/openbaton-contract.md) before changing OpenBaton. It defines the living parity baseline and integration surfaces.
- Read [references/capability-probes.md](references/capability-probes.md) before running target-host or model probes.
- Read [references/acceptance.md](references/acceptance.md) before adding tests or claiming completion.

## Establish the target and scope

1. Confirm that the working repository is OpenBaton and locate its root. Do not create an adapter in an unrelated checkout.
2. Identify the invoking CLI from host identity, available native tools, local executable, and official host documentation. If the identity is genuinely ambiguous and the user did not name it, ask one concise question before editing.
3. Record the target CLI id, display name, detected executable, detected version, and the evidence source for each. Use a stable lowercase id suitable for config keys and command-line flags.
4. Inspect the current worktree before editing. Preserve unrelated and pre-existing changes, and keep the adapter change set narrowly scoped.
5. Run or record an appropriate baseline before edits. Distinguish pre-existing failures from regressions introduced by the adapter work.

## Respect the bootstrap boundary

An unregistered target cannot use a verified Baton profile to bootstrap its own integration.

- If the invoking host is already registered and its Baton runtime and guard are active, obey that host's existing Baton workflow.
- If the invoking host is the unregistered target, use its normal development tools under the user's authorization for this integration. Keep initial host probes read-only, scope writes to the OpenBaton change, and do not claim that pre-registration work had Baton Receipt or guard coverage.
- Repeat the decisive native-subagent probe through a real Baton ticket after registration. Pre-registration tool availability alone is not final Baton acceptance.

## Assess before implementing

Use the target CLI as the sole authority for its live model catalog. Inspect local schemas, RPCs, structured commands, or stable picker output. Official documentation may explain a protocol, but a web page, OpenCodex, a static table, another CLI, or host-tool prose must not supply or augment the target's live model ids.

Before production registration, prove the target's core gates from [references/capability-probes.md](references/capability-probes.md):

- picker-visible model discovery with honest metadata and classified failures;
- a true host-native child-agent mechanism rather than a new CLI print/process mode;
- explicit exact-model dispatch and rejection of an invalid model without inheritance or fallback;
- fresh child context, or an explicit and verified way to disable parent-context inheritance;
- stable child identity and observable wait, terminal, cancellation, and release semantics;
- understood concurrency/backpressure and workspace, filesystem, and Git-sharing boundaries;
- a discoverable installation location for the target's Baton runtime skill.

If model discovery works but no qualifying native child-agent mechanism exists, finish `CATALOG_ONLY` without registering the target as executable. If a core capability is intrinsically absent, finish `UNSUPPORTED`. If login, permission, installation, trust, or another external condition prevents a decisive probe, finish `BLOCKED` with the exact next action. Never weaken a gate merely to make the target appear in `baton init`.

## Director/worker routing (completion invariant)

The target runtime skill MUST include the same director/worker routing table as every other host. Same words. Do not invent a host-specific split. Producing a runtime skill without this table, or inventing a host-specific split, means the adapter work is incomplete.

- **Empty labels / undeclared / unclassified → director.** Empty `runner`/`longctx` mechanical actions run on the director and must not block (no ticket). Work that is not `baton spawn`, not `baton apply`, and not an OpenSpec executable task stays on the director. When Baton cannot classify a unit or cannot recommend a model, keep it director-local or skip it; never guess a subagent model or borrow another host.
- **Declared classified work → native subagents.** Non-empty mechanical labels, `baton spawn` with candidates, and OpenSpec executable tasks on an enabled host go through Baton tickets and this host's native child-agent tool. The director MUST NOT implement those units in the parent session.
- **OpenSpec only lightens orchestration.** OpenSpec supplies breakdown and status; it does not change who writes declared classified tasks. With or without OpenSpec, declared classified work still goes to native subagents. Do not rewrite OpenSpec apply skills; intercept execution from this Baton skill.

Hook-capable targets must use the shared ticket-presence guard (no reserved ticket → director mutating tools allowed; reserved/dispatching/running worker tickets → director implementation writes denied; bound workers stay inside the Receipt), not a private invert such as fail-closed-always or allow-always. Missing a hook is not a license to implement declared classified work in the parent.

## Implement complete host parity

Once the core gates pass, implement the adapter instead of stopping at an assessment:

1. Build a capability-closure matrix against the current Codex and Grok adapters, runtime skills, commands, and tests. Every shared capability is required. Evaluate every host-specific capability and implement the target-native equivalent when the target exposes one; record why a non-shared feature is inapplicable rather than silently omitting it.
2. Add the target adapter behind the shared contract. Keep executable resolution, version detection, model discovery, normalization, host metadata, and classified errors inside the adapter boundary.
3. Add the target runtime Baton skill and its correct installation/update location. Include the director/worker routing table above. Translate native tool names and lifecycle instructions; do not copy Codex- or Grok-specific claims that are false for the target. If the target exposes a PreToolUse-compatible hook, wire the shared ticket-presence guard rather than a host-private policy.
4. Extend config, route refresh, matching, spawn, dispatch, lifecycle, status, help, packaging, and documentation through registry-derived behavior. Remove newly exposed hard-coded host lists instead of adding scattered target branches.
5. Preserve host-scoped configuration. `cli.<target>.enabled` controls Baton only in that host; never consult another profile, and never invent a global default CLI. A disabled or missing target profile must fail closed and never borrow another host's profile or model. Runtime commands must pass `--host <target>` (or resolve the host from `BATON_HOST` / a unique runtime signal).
6. Preserve automatic model selection from the enabled target allowlist. Runner and longctx remain labels. Do not add runtime model overrides, human model confirmation, parent-model inheritance, or cross-model fallback.
7. Register the target in the production registry only after its adapter, runtime skill, tests, and core probes are ready. Registration must make the existing `baton init` and `baton config` flows expose the target without a separate target-only wizard.

## Test and converge

Add the focused target tests and shared conformance coverage in [references/acceptance.md](references/acceptance.md). Run focused tests while iterating, then the full static, test, build, package, isolated-install, and live-host gates.

Continue fixing repository-controlled implementation or test failures until all required gates pass. Do not stop at `REVISE`, the first failing test, or a partial adapter. Retry an external probe only when a concrete change can alter the result; do not loop indefinitely on unchanged authentication, quota, permission, trust, or host capability.

Do not modify target login credentials, tokens, or unrelated global settings. Keep raw sensitive output out of fixtures and the repository. Do not commit or push unless the user separately requests it.

## Completion contract

Claim `PASS` only when all of the following are true:

- the target is a registered adapter and installed runtime host;
- interactive `baton init` lists the target;
- selecting it proceeds to the target-owned model catalog and persists its independent profile;
- non-interactive init/config works for the target;
- shared regression tests and target-specific tests pass;
- the package builds and the locally built CLI passes an isolated smoke test;
- an exact picker-visible target model completes a real read-only Baton ticket through native spawn, bind, wait, terminal recording, and release;
- final Baton state has no leaked active ticket, and the repository has no unintended changes.

Report the evidence classes separately: static/conformance tests, build/package, live model discovery, native child-agent proof, and Baton end-to-end proof. Use the user's language and include exact blockers without dumping raw worker logs.

## Handoff to Phase 2

When adapter `PASS` is complete, tell the user to run the end-to-end OpenSpec coding probe:

```text
/verify-cli-baton-e2e
```

Phase 2 uses the fixed template in `samples/probe-e2e/` (not repo-root `openspec/`), a git worktree for isolation, a fresh chat for apply, and `samples/verify-probe.mjs` for machine verification. Do not claim full host acceptance until Phase 2 also passes.
