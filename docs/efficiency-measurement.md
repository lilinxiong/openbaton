# Efficiency measurement

`scripts/measure_efficiency.mjs` is an offline comparison of the old repeated
`spawn --brief` path and the batched `spawn --briefs` path. It measures local
preparation only. Neither path starts a host-native worker, changes the real
home directory, invokes a paid model, estimates tokens, or enables automatic
routing.

Create an immutable baseline before applying the batching change, then run the
script with both checkout paths:

```sh
bun scripts/measure_efficiency.mjs \
  --baseline /absolute/path/to/baseline \
  --candidate /absolute/path/to/candidate \
  --repeats 5 --warmups 1 \
  --brief-budget-chars 1200 \
  --json /tmp/baton-efficiency.json \
  --markdown /tmp/baton-efficiency.md
```

The supplied `--baseline-id` and `--candidate-id` are recorded when a source
identifier other than its Git `HEAD` is needed. The local JSON report saves `original_command`, runtime versions, source
paths/identifiers and warmup/repeat settings. This command records the actual
local invocation; it is not a promise that temporary inputs remain available. Each scenario creates its own temporary `HOME`, project
directory, and copied Alpha fixture adapter. The temporary directory is removed
after the scenario.

For one and four distinct brief files, the baseline launches one Bun source
process per brief. The candidate launches one Bun source process with a JSON
array supplied to `--briefs` and the same shared selection flags. The fixture
catalog writes an append-only local counter; no external catalog is contacted.

The report contains median elapsed milliseconds after warmups, manifest reads,
catalog invocations, CLI JSON output code points, and generated prompt code
points. Character counts use Unicode code points, not UTF-16 units. The report
has `token_estimate: null`; it deliberately contains no character-to-token
conversion and may honestly show increases for any metric. It also records the
code-point count of `SKILL.md`, `adapters/codex/runtime/SKILL.md`, and
`adapters/grok/runtime/SKILL.md` separately for baseline and candidate. Those
files are not summed or treated as simultaneously loaded. This makes added
runtime instructions visible alongside any shorter handoff payload. The
optional Markdown report is a readable rendering of the same measurements.

For every warmup and measured pair, the harness verifies behavioral parity for
each handoff before including that pair in statistics: selected host/model/effort/tier, host-owned execution flags,
mode/work mode and scope must agree. It separately verifies that every prompt
still carries the original goal, acceptance criteria and constraints. Prompt
text itself need not be identical because the batch prompt has a concise result
contract. `brief_diagnostics` is not a parity requirement; it is expected only
for an over-budget individual handoff.

## Reproducing and publishing a report

`--bun` (or `BUN_EXE`) selects the executable for both source invocations and
fixture catalogs. The script resolves it once and records its version and
absolute path in the private local command. Catalogs do not select another Bun
from `PATH`.

Keep generated local reports private: they contain absolute paths and may
identify the local user. Before committing or sharing a report:

- Record immutable baseline, candidate, and harness Git revisions. When the
  measured source is an archive, supply its exact revision via `--baseline-id`
  or `--candidate-id`; verify the archive corresponds to that revision. A
  working-tree hash alone is insufficient to locate the input later.
- Remove `sources.*.path` and `original_command` from the published JSON and
  Markdown. Retain revisions and runtime versions. Use repository-relative
  locators and a `reproduction_command` with replaceable directory placeholders.
- Export the recorded baseline and candidate revisions to fresh directories,
  run the harness from its recorded revision, and replace `BASELINE_DIR` and
  `CANDIDATE_DIR` in that command with the export locations. Use the recorded
  Bun version; timing will still depend on the machine.
- If repositories have different histories, record corresponding revisions
  only after verifying their Git trees match. The published report must let
  readers recover both inputs without relying on a developer's temporary HOME.

## Optional real-task observation format

Offline preparation metrics are not model token measurements. If the host
exposes task usage, store an independent observation JSON record alongside the
benchmark result. Unknown fields stay `null`; do not infer them from prompt
characters, elapsed time, or model name.

Summarize one or more records with repeated `--file`; JSON output keeps the
per-run results as well as workload groups:

```text
baton observe --file observation-a.json --file observation-b.json --json
```

Use `source.workload_id` to group equivalent workloads and `run.id` to make an
observation unique. A complete observation requires a nonempty stable `run.id`:
reuse it when exporting another snapshot of the same execution. The host or
caller must supply a truthful native-task inventory and stable identities; Baton
does not infer them or deduplicate records by task content. Set
`run.tasks_complete: true` only after every native task for the run is present,
and `source.usage_available: true` only when the host reported usage. A usage
aggregate is known only when both flags are true and every task has reported the
corresponding metric; a missing value remains unknown rather than zero.

Legacy incomplete records without `run.id` remain readable, but their timestamp
identity cannot deduplicate re-exports for run-count or elapsed statistics. Use
a stable `run.id` for every new record.

The following numeric record is a synthetic illustration of the format, not a
measured usage report:

```json
{
  "schema_version": 1,
  "kind": "baton-task-observation",
  "observed_at": "2026-09-07T12:00:00.000Z",
  "source": {
    "candidate_identifier": "commit-or-supplied-id",
    "workload_id": "api-migration-v1",
    "usage_provider": "native-host",
    "usage_available": true
  },
  "run": {
    "id": "native-run-2026-09-07-1",
    "accepted": true,
    "tasks_complete": true,
    "elapsed_ms": 1200,
    "retries": 0,
    "upgrades": 0,
    "input_tokens": 100,
    "output_tokens": 40,
    "total_tokens": 140,
    "cached_input_tokens": 30,
    "uncached_input_tokens": 70
  },
  "tasks": [
    {
      "task_id": "root",
      "role": "root",
      "parent_task_id": null,
      "host": "codex",
      "model": null,
      "reasoning_effort": null,
      "accepted": true,
      "elapsed_ms": 400,
      "retries": 0,
      "upgrades": 0,
      "input_tokens": 40,
      "output_tokens": 20,
      "total_tokens": 60,
      "cached_input_tokens": 10,
      "uncached_input_tokens": 30
    },
    {
      "task_id": "worker-1",
      "role": "worker",
      "parent_task_id": "root",
      "host": "codex",
      "model": "gpt-5.6-terra",
      "reasoning_effort": "high",
      "accepted": true,
      "elapsed_ms": 800,
      "retries": 0,
      "upgrades": 0,
      "input_tokens": 60,
      "output_tokens": 20,
      "total_tokens": 80,
      "cached_input_tokens": 20,
      "uncached_input_tokens": 40
    }
  ]
}
```

Add one task object for every native root, worker, retry, or upgrade that the
host reports; three `gpt-5.6-terra`/`high` workers therefore produce root plus
three worker objects. Record each task's cumulative usage once, including any
ordinary follow-up on that same native task. A retry or upgrade that creates a
new native task needs its own unique id and task object. `run` metrics may be
supplied as a cross-check, but Baton derives a metric from task records only
when every task reported it; otherwise the aggregate is `null`. Cached and
uncached fields are recorded independently when the host supplies them.

Groups include every run's tokens, including failed runs, and divide by accepted
runs only for `tokens_per_accepted_run`; failures must not make a candidate look
cheaper. `accepted`, retry/upgrades counts and elapsed time remain useful even
when usage is unavailable. Do not claim an end-to-end speedup from the offline
serial-preparation comparison.

`accepted` means the recorded task acceptance checks passed, not that the user
has approved publication. Count failed re-executions as retries.
