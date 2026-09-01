import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { run } from "../src/cli.js";
import { deriveTaskKey, type PlanDelta, type TaskSourceDescriptor } from "../src/lib/rolling-plan.js";
import { fakeEnv } from "./home.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); return true; }, text() { return chunks.join(""); } };
}

async function command(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; rollingRunHandler?: (input: unknown) => unknown | Promise<unknown> }) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(argv, { ...options, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const source: TaskSourceDescriptor = {
  schema_version: 1,
  source_kind: "director",
  adapter: "director",
  selection: { tasks: [{ id: "task-1", description: "implement rolling run" }] },
};

function delta(sequence = 0): PlanDelta {
  const taskKey = deriveTaskKey("director", "task-1");
  return {
    schema_version: 1,
    delta_id: "delta-cli",
    prepared_from_append_sequence: sequence,
    unit_versions: [{
      schema_version: 1,
      unit_key: "unit-cli",
      version: 1,
      task_keys: [taskKey],
      depends_on: [],
      execution_mode: "verification-only",
      prompt: "verify rolling run",
      completion_criteria: ["rolling run is verified"],
      permitted_validation: ["read"],
    }],
    gate_versions: [],
    task_coverage: [{ schema_version: 1, task_key: taskKey, kind: "unit", unit_versions: ["unit-cli@1"] }],
  };
}

describe("rolling run CLI grammar", () => {
  it("loads source and plan documents behind one injectable handler", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-cli-"));
    const env = fakeEnv(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-cli-home-")));
    const sourceFile = path.join(cwd, "source.json");
    fs.writeFileSync(sourceFile, JSON.stringify(source));
    let received: any;
    const result = await command([
      "run", "start", "--host", "alpha", "--run-id", "run-cli", "--source-file", sourceFile,
      "--plan-delta-file", "-", "--dispatch", "--json",
    ], {
      cwd,
      env,
      stdin: JSON.stringify(delta()),
      rollingRunHandler: async (input) => { received = input; return { injected: true }; },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { injected: true });
    assert.equal(received.operation, "start");
    assert.equal(received.run_id, "run-cli");
    assert.equal(received.host, "alpha");
    assert.equal(received.source.source_kind, "director");
    assert.equal(received.delta.delta_id, "delta-cli");
    assert.equal(received.dispatch, true);
  });

  it("keeps operations mutually exclusive and stdin single-owner", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-cli-invalid-"));
    const env = fakeEnv(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-cli-invalid-home-")));
    const cases = [
      ["run", "run-1", "--status", "--reconcile"],
      ["run", "run-1", "--status", "--status"],
      ["run", "start", "--host", "alpha", "--source-file", "-", "--plan-delta-file", "-"],
      ["run", "run-1", "--accept-gate", "gate@1"],
      ["run", "run-1", "--seal-task", "task"],
      ["run", "run-1", "--status", "--host", "alpha"],
    ];
    for (const argv of cases) {
      const result = await command(argv, { cwd, env, stdin: "{}", rollingRunHandler: async () => ({ unreachable: true }) });
      assert.equal(result.code, 1, `${argv.join(" ")}\n${result.stderr}`);
      assert.ok(result.stderr.trim().length > 0);
    }
  });
});
