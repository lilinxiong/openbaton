# Baton 2.0 guide

An explicit user invocation of Baton requests delegation. The root establishes shared contracts, groups work, reviews results and makes authorized commits. Baton prepares model parameters and a compact brief. Only the current host's native subagents execute work.

## Choose the work and model

| Work mode | Remaining decisions |
|---|---|
| execution | Follow settled steps or narrowly check facts |
| implementation | Complete a bounded design |
| investigation | Resolve an uncertain cause or design |

The root chooses effort for the current task independently of work mode. No mode implies an effort preference. Pass `--effort LEVEL` to request a supported level; if omitted, Baton emits no `reasoning_effort`, leaves the host default unchanged, and does not substitute a catalog default. A multi-file migration with settled steps can use execution mode. Delegate a small task to one worker; group work sharing context and parallelize independent scopes. The root does the boundary checks needed for handoff, without first completing the worker task. If native delegation is unavailable or required information is missing, report the blocker.

Run `baton models --host codex` to inspect actual model ids, then configure the selected ids:

```text
baton init --cli codex
baton config --cli codex --execution-model MODEL --enable
baton match --host codex --work-mode execution --model MODEL --effort low --json
```

`MODEL` is a placeholder from the live catalog. Model flags can repeat. Configure `--implementation-model` and `--investigation-model` for their independent ordered candidate pools. Selection stays inside the chosen mode; an explicit model must also belong to that pool. If no candidate is available, Baton reports the reason so the root can decide the next action. There is no cross-mode fallback. Without `--cli`, `baton config` opens the interactive picker in a terminal.

Explicit unsupported effort or service tier is rejected. With automatic model selection, candidates failing explicit constraints are skipped. `--unavailable-model ID` excludes a model known by the host to be unavailable; Baton does not invent quota information. `--context-tokens N` checks known capacity and discloses unknown capacity. No context requirement is inferred from task wording.

## Prepare a worker

Save a JSON brief, for example:

```json
{
  "goal": "Update the known API call sites",
  "decisions": ["Keep the established ownership contract"],
  "scope": ["src/example"],
  "acceptance": ["Report changed files and remaining old calls"],
  "constraints": ["Do not change the public API"],
  "mode": "write",
  "handoff": {
    "existingChanges": "The new API is already implemented",
    "checks": "Static interface checks passed",
    "unresolvedIssues": "The example call sites still need migration"
  }
}
```

```text
baton spawn --host codex --brief brief.json --work-mode execution --json
```

`goal` and nonempty `acceptance` are required. `mode` defaults to `read-only`; write mode requires scope. Decisions, context, constraints and handoff are optional. Scope names relative modules, directories or files. It is a prompt contract, **not a filesystem sandbox**. The root coordinates overlapping writes and checks the integrated diff.

Spawn returns an exact catalog model id, explicitly requested supported effort (when supplied), the formatted prompt, scope and `fork_context:false`, with `spawned:false`. Pass the supported parameters and prompt to the host's native child API using a fresh context. Baton has not started a worker. Native handles and native completion remain authoritative.

## Prepare a batch and control context

For several briefs sharing the same host and selection flags, save a JSON array of 1–128 brief objects and run:

```text
baton spawn --host codex --briefs briefs.json --work-mode implementation --json
```

The result is `{ "handoffs": [...] }`. All briefs are validated before discovery; one catalog query and one selection serve the batch. Each handoff retains its own goal, scope and acceptance. `--brief` and `--briefs` are mutually exclusive. Batch preparation does not start workers or decide concurrency; the root dispatches through the native host within its available capacity.

`--brief-budget-chars N` sets an advisory prompt budget (default 12000 Unicode code points). Only an over-budget handoff includes `brief_diagnostics`, with prompt size and largest content fields. No content is truncated and no token count is inferred. This is separate from `--context-tokens`, which is a caller-supplied model capacity constraint.

Give workers settled decisions, precise file/symbol references and acceptance criteria. Send only changes, completed checks and remaining issues when continuing work. The generated brief asks for a concise status/conclusion, changed locations, check evidence and blockers; keep full logs in referenced files. Recheck when changes, failures or integration warrant it rather than repeating unchanged work.

Measure whole-task cost, including root, workers, retries and integration. Use observed acceptance results to tune each configured model pool; missing information calls for clarification, whereas demonstrated capability limits may justify escalation with an incremental handoff. See [efficiency measurement](efficiency-measurement.md) for the offline comparison and native-task observation format.

## Record an outcome

```text
baton record --host codex --handle HANDLE --model MODEL --status completed --text "Reviewed result"
baton status --host codex --json
```

Records are optional append-only history in `~/.baton/results.jsonl`. Status returns the latest twenty records matching host and working directory; it does not show live state. Use `blocked` or `failed` when appropriate, and put existing work into the next brief's handoff when escalating a task.

## Installation and breaking changes

Run `python3 scripts/update_local_baton.py` from a source checkout to test, build, link and refresh installed skills. `baton update` refreshes installed files. `baton uninstall --clean --dry-run` previews cleanup; omit `--dry-run` to remove Baton config/results and owned integrations. Modified integrations are preserved and conflicts reported. Package-manager command links are separate from runtime uninstall.

Config schema 4 removes `coding_models` and `--coding-model`; configure each needed mode directly. Existing mode lists are retained; the retired total pool is never copied into any mode. Saving writes schema 4 and drops retired fields. Users who configured only the total pool must explicitly configure their mode pools.

V2 removes managed dispatch, apply, activation, tickets, receipts, sessions, queue state and Git audits. The configuration no longer has runner, longctx or director capacity fields. There is no second compatibility runtime. Earlier managed-runtime measurements are not v2 performance evidence.

Adapters supply catalog discovery and a runtime skill for their own host; they do not execute another CLI's tasks. See the [manifest example](../samples/manifest-example/) and the [isolated walkthrough](../samples/getting-started/).
