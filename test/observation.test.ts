import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inspectObservation, summarizeObservations } from "../src/lib/observation.js";
import { run } from "../src/cli.js";

function fixture(id = "run-1") {
  return {
    schema_version: 1, kind: "baton-task-observation", observed_at: "2026-09-07T00:00:00Z",
    source: { candidate_identifier: "revision", workload_id: "parser-fix", usage_available: true },
    run: { id, accepted: true, tasks_complete: true, elapsed_ms: 100, retries: 0, upgrades: 0 },
    tasks: [
      { task_id: "root", role: "root", parent_task_id: null, total_tokens: 100, input_tokens: 80, output_tokens: 20 },
      { task_id: "worker", role: "worker", parent_task_id: "root", total_tokens: 200, input_tokens: 150, output_tokens: 50 },
    ],
  };
}

describe("host task observation accounting", () => {
  it("sums complete reported usage including failures and keeps independent missing metrics unknown", () => {
    const first = fixture();
    const second = fixture("run-2");
    second.run.accepted = false;
    second.run.elapsed_ms = 200;
    second.run.retries = 1;
    const report = summarizeObservations([first, second]);
    assert.equal(report.runs[0].total_tokens, 300);
    assert.equal(report.runs[0].input_tokens, 230);
    assert.equal(report.runs[0].cached_input_tokens, null);
    assert.equal(report.groups[0].total_tokens, 600);
    assert.equal(report.groups[0].tokens_per_accepted_run, 600);
    assert.equal(report.groups[0].acceptance_rate, 0.5);
    assert.equal(report.groups[0].median_elapsed_ms, 150);
    assert.equal(report.groups[0].retries, 1);
  });

  it("never treats partial task usage, incomplete inventory or unavailable usage as zero", () => {
    for (const mutate of [
      (value: any) => { value.tasks[1].total_tokens = null; },
      (value: any) => { delete value.run.tasks_complete; },
      (value: any) => { value.source.usage_available = false; },
    ]) {
      const value = fixture(); mutate(value);
      const result = summarizeObservations([value]);
      assert.equal(result.groups[0].total_tokens, null);
      assert.equal(result.groups[0].tokens_per_accepted_run, null);
    }
    const unknown: any = fixture("unknown");
    unknown.tasks[1].total_tokens = null; unknown.run.elapsed_ms = null;
    const mixed = summarizeObservations([fixture(), unknown]);
    assert.equal(mixed.groups[0].runs_with_total_tokens, 1);
    assert.equal(mixed.groups[0].elapsed_samples, 1);
    assert.equal(mixed.groups[0].total_tokens, null);
    const zero = fixture(); zero.tasks.forEach((task) => { task.total_tokens = 0; });
    assert.equal(inspectObservation(zero).total_tokens, 0);
  });

  it("requires stable ids for complete usage while retaining incomplete legacy snapshots", () => {
    const missingId: any = fixture();
    delete missingId.run.id;
    assert.throws(() => inspectObservation(missingId), /run\.id is required/);

    const first = fixture("stable-run");
    const laterExport = fixture("stable-run");
    laterExport.observed_at = "2026-09-07T01:00:00Z";
    assert.throws(() => summarizeObservations([first, laterExport]), /duplicate run id/);

    const legacy: any = fixture();
    delete legacy.run.id;
    delete legacy.run.tasks_complete;
    const result = summarizeObservations([legacy]);
    assert.equal(result.runs[0].total_tokens, null);
    assert.equal(result.groups[0].total_tokens, null);
  });

  it("rejects duplicates, invalid metrics, inconsistent totals and broken task lineage", () => {
    assert.throws(() => summarizeObservations([fixture(), fixture()]), /duplicate run id/);
    for (const mutate of [
      (value: any) => { value.tasks.push(value.tasks[1]); },
      (value: any) => { value.tasks[1].parent_task_id = "missing"; },
      (value: any) => { value.tasks[1].parent_task_id = "worker"; },
      (value: any) => { value.run.total_tokens = 999; },
      (value: any) => { value.tasks[1].total_tokens = -1; },
      (value: any) => { value.run.tasks_complete = "true"; },
      (value: any) => { value.tasks[1].total_tokens = Number.MAX_SAFE_INTEGER; },
    ]) {
      const value = fixture(); mutate(value);
      assert.throws(() => inspectObservation(value), /OBSERVATION_INVALID/);
    }
  });

  it("keeps workloads separate and reads historical observations without inventing usage", async () => {
    const second = fixture("run-2"); second.source.workload_id = "different";
    assert.equal(summarizeObservations([fixture(), second]).groups.length, 2);
    const file = new URL("../docs/reports/2026-09-07-task-observation.json", import.meta.url);
    assert.equal(inspectObservation(JSON.parse(fs.readFileSync(file, "utf8"))).total_tokens, null);
    const output: string[] = [];
    const exit = await run(["observe", "--file", file.pathname, "--json"], {
      stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => assert.fail(text) },
    });
    assert.equal(exit, 0);
    assert.equal(JSON.parse(output.join("")).groups[0].total_tokens, null);
  });
});
