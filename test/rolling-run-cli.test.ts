import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { run } from "../src/cli.js";
import { defaultRollingRunHandler } from "../src/commands/run.js";
import { startRollingControl } from "../src/lib/rolling-control.js";
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
      "--worktree-mode", "isolated-worktree", "--plan-delta-file", "-", "--dispatch", "--json",
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
    assert.equal(received.worktree_mode, "isolated-worktree");
    assert.equal(received.source.source_kind, "director");
    assert.equal(received.delta.delta_id, "delta-cli");
    assert.equal(received.dispatch, true);

    const cleanup = await command([
      "run", "run-cli", "--cleanup-unit", "unit-cli", "--attempt", "attempt-2",
      "--release-downstream-base", "--release-user-retention", "--json",
    ], { cwd, env, rollingRunHandler: async (input) => { received = input; return { cleanup: true }; } });
    assert.equal(cleanup.code, 0, cleanup.stderr);
    assert.equal(received.operation, "cleanup");
    assert.equal(received.cleanup_unit, "unit-cli");
    assert.equal(received.attempt, "attempt-2");
    assert.equal(received.release_downstream_base, true);
    assert.equal(received.release_user_retention, true);

    const freeze = await command([
      "run", "run-cli", "--freeze-unit", "unit-cli", "--attempt", "attempt-2",
      "--text", "audited terminal result", "--validation", "focused tests passed", "--allow-noop", "--json",
    ], { cwd, env, rollingRunHandler: async (input) => { received = input; return { frozen: true }; } });
    assert.equal(freeze.code, 0, freeze.stderr);
    assert.equal(received.operation, "freeze");
    assert.equal(received.freeze_unit, "unit-cli");
    assert.equal(received.validation, "focused tests passed");
    assert.equal(received.allow_noop, true);
  });

  it("keeps operations mutually exclusive and stdin single-owner", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-cli-invalid-"));
    const env = fakeEnv(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-cli-invalid-home-")));
    const cases = [
      ["run", "run-1", "--status", "--reconcile"],
      ["run", "run-1", "--status", "--status"],
      ["run", "start", "--host", "alpha", "--source-file", "-", "--plan-delta-file", "-"],
      ["run", "run-1", "--accept-gate", "gate@1"],
      ["run", "run-1", "--accept-gate", "gate@1", "--text", "   "],
      ["run", "run-1", "--seal-task", "task"],
      ["run", "run-1", "--status", "--host", "alpha"],
      ["run", "run-1", "--status", "--worktree-mode", "isolated-worktree"],
      ["run", "run-1", "--cleanup-unit", "unit-cli"],
      ["run", "run-1", "--freeze-unit", "unit-cli", "--attempt", "attempt-1"],
      ["run", "run-1", "--status", "--allow-noop"],
      ["run", "run-1", "--status", "--validation", "tests passed"],
      ["run", "run-1", "--status", "--release-downstream-base"],
      ["run", "start", "--host", "alpha", "--source-file", "-", "--worktree-mode", "unknown"],
    ];
    for (const argv of cases) {
      const result = await command(argv, { cwd, env, stdin: "{}", rollingRunHandler: async () => ({ unreachable: true }) });
      assert.equal(result.code, 1, `${argv.join(" ")}\n${result.stderr}`);
      assert.ok(result.stderr.trim().length > 0);
    }
  });

  it("keeps an omitted accept-gate dispatch flag false through the default handler", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-cli-no-dispatch-"));
    const env = fakeEnv(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-cli-no-dispatch-home-")));
    const guarded = delta();
    guarded.unit_versions[0]!.required_gate_keys = ["gate-cli"];
    guarded.unit_versions[0]!.input_fingerprints = { baseline: "a".repeat(64) };
    guarded.gate_versions = [{
      schema_version: 1,
      gate_key: "gate-cli",
      version: 1,
      type: "safety-precondition",
      task_keys: [...guarded.unit_versions[0]!.task_keys],
      depends_on: [],
      acceptance_contract: { required: true },
    }];
    guarded.task_coverage[0]!.gate_versions = ["gate-cli@1"];
    await startRollingControl({ cwd, env, run_id: "run-no-dispatch", host: "alpha", source, delta: guarded, dispatch: false });
    const accepted = await defaultRollingRunHandler({
      operation: "accept-gate",
      cwd,
      env,
      run_id: "run-no-dispatch",
      accept_gate: "gate-cli@1",
      text: "parent accepted",
      dispatch: false,
    } as any) as any;
    assert.equal(accepted.dispatch, null);
  });
});
