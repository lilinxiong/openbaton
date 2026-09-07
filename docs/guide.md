# Baton 2.0 guide

The root agent decides what to delegate, establishes shared contracts, reviews results and makes authorized commits. Baton prepares model parameters and a compact brief. Only the current host's native subagents execute work.

## Choose the work and model

| Work mode | Remaining decisions | Default effort preference |
|---|---|---|
| execution | Follow settled steps or narrowly check facts | low |
| implementation | Complete a bounded design | medium |
| investigation | Resolve an uncertain cause or design | high |

Model and effort are independent. A multi-file migration with settled steps can use execution mode. The root can keep a task local; filling all slots is not a goal.

Run `baton models --host codex` to inspect actual model ids, then configure the selected ids:

```text
baton init --cli codex
baton config --cli codex --coding-model MODEL --execution-model MODEL --enable
baton match --host codex --work-mode execution --model MODEL --effort low --json
```

`MODEL` is a placeholder from the live catalog. Model flags can repeat. Configure `--implementation-model` and `--investigation-model` for their preference lists. Without `--cli`, `baton config` opens the interactive picker in a terminal.

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

Spawn returns an exact catalog model id, supported effort, the formatted prompt, scope and `fork_context:false`, with `spawned:false`. Pass the supported parameters and prompt to the host's native child API using a fresh context. Baton has not started a worker. Native handles and native completion remain authoritative.

## Record an outcome

```text
baton record --host codex --handle HANDLE --model MODEL --status completed --text "Reviewed result"
baton status --host codex --json
```

Records are optional append-only history in `~/.baton/results.jsonl`. Status returns the latest twenty records matching host and working directory; it does not show live state. Use `blocked` or `failed` when appropriate, and put existing work into the next brief's handoff when escalating a task.

## Installation and breaking changes

Run `python3 scripts/update_local_baton.py` from a source checkout to test, build, link and refresh installed skills. `baton update` refreshes installed files. `baton uninstall --clean --dry-run` previews cleanup; omit `--dry-run` to remove Baton config/results and owned integrations. Modified integrations are preserved and conflicts reported. Package-manager command links are separate from runtime uninstall.

V2 removes managed dispatch, apply, activation, tickets, receipts, sessions, queue state and Git audits. The configuration no longer has runner, longctx or director capacity fields. There is no second compatibility runtime. Earlier managed-runtime measurements are not v2 performance evidence.

Adapters supply catalog discovery and a runtime skill for their own host; they do not execute another CLI's tasks. See the [manifest example](../samples/manifest-example/) and the [isolated walkthrough](../samples/getting-started/).
