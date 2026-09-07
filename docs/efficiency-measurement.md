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
identifier other than its Git `HEAD` is needed. The JSON report also saves the
fully reproducible command, runtime versions, source paths/identifiers and the
warmup/repeat settings. Each scenario creates its own temporary `HOME`, project
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

Before publishing a comparison, the harness verifies behavioral parity for
each handoff: selected host/model/effort/tier, host-owned execution flags,
mode/work mode and scope must agree. It separately verifies that every prompt
still carries the original goal, acceptance criteria and constraints. Prompt
text itself need not be identical because the batch prompt has a concise result
contract. `brief_diagnostics` is not a parity requirement; it is expected only
for an over-budget individual handoff.

## Optional real-task observation format

Offline preparation metrics are not model token measurements. If the host
exposes task usage, store an independent observation JSON record alongside the
benchmark result. Unknown fields stay `null`; do not infer them from prompt
characters, elapsed time, or model name.

```json
{
  "schema_version": 1,
  "kind": "baton-task-observation",
  "observed_at": "2026-09-07T12:00:00.000Z",
  "source": {
    "candidate_identifier": "commit-or-supplied-id",
    "usage_provider": "native-host",
    "usage_available": false
  },
  "run": {
    "accepted": true,
    "elapsed_ms": null,
    "retries": 0,
    "upgrades": 0,
    "total_tokens": null,
    "cached_input_tokens": null,
    "uncached_input_tokens": null
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
      "elapsed_ms": null,
      "retries": 0,
      "upgrades": 0,
      "input_tokens": null,
      "output_tokens": null,
      "total_tokens": null,
      "cached_input_tokens": null,
      "uncached_input_tokens": null
    },
    {
      "task_id": "worker-1",
      "role": "worker",
      "parent_task_id": "root",
      "host": "codex",
      "model": "gpt-5.6-terra",
      "reasoning_effort": "high",
      "accepted": true,
      "elapsed_ms": null,
      "retries": 0,
      "upgrades": 0,
      "input_tokens": null,
      "output_tokens": null,
      "total_tokens": null,
      "cached_input_tokens": null,
      "uncached_input_tokens": null
    }
  ]
}
```

Add one task object for each worker, retry, or upgrade that the host reports;
three `gpt-5.6-terra`/`high` workers therefore produce root plus three worker
objects. `run.total_tokens` is the sum of reported root, worker, retry and
upgrade totals only when every required total is known; otherwise it is `null`.
Cached and uncached fields are recorded independently when the host supplies
them. `accepted`, retry/upgrades counts and elapsed time remain useful even if
the provider does not expose usage.

`accepted` means the recorded task acceptance checks passed, not that the user
has approved publication. Count failed re-executions as retries; ordinary
review follow-ups on an existing worker can be recorded separately. Do not
claim an end-to-end speedup from the offline serial-preparation comparison.
