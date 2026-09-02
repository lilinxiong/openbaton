import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { getCliAdapter } from "../src/adapters/registry.js";
import {
  bindAgent,
  finishAgent,
  releaseAgent,
  reportAgentProbe,
  reportAgentProgress,
  reserveNext,
} from "../src/lib/dispatch.js";
import {
  freezeRollingUnitBundle,
  startRollingControl,
  statusRollingControl,
} from "../src/lib/rolling-control.js";
import { deriveTaskKey, type PlanDelta, type TaskSourceDescriptor } from "../src/lib/rolling-plan.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { listSpawns, type NativeExecutionHandle, type SpawnTicket } from "../src/lib/spawn.js";
import {
  acceptWorktreeIntegration,
  applyWorktreeIntegration,
  beginWorktreeIntegration,
  resolveWorktreeIntegration,
} from "../src/lib/worktree-integration.js";
import { configureCli } from "./configure.js";
import { fakeEnv } from "./home.js";

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function visibleTree(cwd: string): string {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-e2e-visible-index-"));
  const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
  try {
    git(cwd, ["read-tree", "HEAD^{tree}"], env);
    git(cwd, ["add", "-A", "--", "."], env);
    return git(cwd, ["write-tree"], env);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function parentResolutionTree(cwd: string, content: string): string {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "baton-e2e-resolution-index-"));
  const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
  const original = fs.readFileSync(path.join(cwd, "file.txt"));
  try {
    git(cwd, ["read-tree", visibleTree(cwd)], env);
    fs.writeFileSync(path.join(cwd, "file.txt"), content);
    git(cwd, ["add", "--", "file.txt"], env);
    return git(cwd, ["write-tree"], env);
  } finally {
    fs.writeFileSync(path.join(cwd, "file.txt"), original);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function exactHandle(ticket: SpawnTicket): NativeExecutionHandle {
  const lineage = ticket.rolling_unit_lineage!;
  return {
    kind: "alpha-task",
    value: `native-${lineage.unit_key}`,
    source: "native-return",
    repository_id: lineage.repository_id!,
    git_common_dir_identity: lineage.git_common_dir_identity!,
    execution_root: lineage.execution_root!,
    base_tree: lineage.base_tree!,
    worktree_record_id: lineage.worktree_record_id!,
  };
}

describe("rolling isolated worktree end to end", () => {
  it("runs two native roots, exposes progress, and keeps parent-only clean and resolved integration", async () => {
    const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rolling-e2e-")));
    const cwd = path.join(outer, "repository");
    const env = fakeEnv(path.join(outer, "home"), { BATON_SESSION_ID: "rolling-native-e2e" });
    fs.mkdirSync(cwd);
    git(cwd, ["init", "-q"]);
    git(cwd, ["config", "user.email", "baton@test.invalid"]);
    git(cwd, ["config", "user.name", "Baton Test"]);
    fs.writeFileSync(path.join(cwd, "file.txt"), "base\n");
    fs.writeFileSync(path.join(cwd, "stable.txt"), "stable\n");
    git(cwd, ["add", "file.txt", "stable.txt"]);
    git(cwd, ["commit", "-qm", "baseline"]);

    const catalog = await getCliAdapter("alpha", env).discoverModels({ env });
    const model = catalog.models[0]?.id;
    assert.ok(model);
    configureCli(cwd, env, "alpha", [model], { runner: model });
    publishRouteSnapshot(cwd, { models: catalog.models }, new Date("2026-09-01T00:00:00.000Z"), {
      cli: "alpha",
      host: "alpha",
      env,
    });

    const runId = "run-native-e2e";
    const taskKey = deriveTaskKey("director", "native-e2e");
    const source: TaskSourceDescriptor = {
      schema_version: 1,
      source_kind: "director",
      adapter: "director",
      selection: { tasks: [{ id: "native-e2e", description: "exercise two isolated workers" }] },
    };
    const unitKeys = ["unit-a", "unit-b"];
    const delta: PlanDelta = {
      schema_version: 1,
      delta_id: "delta-native-e2e",
      prepared_from_append_sequence: 0,
      unit_versions: unitKeys.map((unitKey, index) => ({
        schema_version: 1,
        unit_key: unitKey,
        version: 1,
        task_keys: [taskKey],
        depends_on: [],
        execution_mode: "patch-only" as const,
        route_profile: "runner" as const,
        prompt: `write speculative result ${index + 1}`,
        write_paths: ["file.txt"],
        allowed_operations: ["write" as const],
        completion_criteria: [`${unitKey} result ready`],
        permitted_validation: ["read file.txt"],
        input_fingerprints: { baseline: String(index + 1).repeat(64) },
      })),
      gate_versions: [],
      task_coverage: [{
        schema_version: 1,
        task_key: taskKey,
        kind: "unit",
        unit_versions: unitKeys.map((unitKey) => `${unitKey}@1`),
      }],
    };

    const initialHead = git(cwd, ["rev-parse", "HEAD"]);
    const initialIndex = fs.readFileSync(path.join(cwd, ".git", "index"));
    try {
      const started = await startRollingControl({
        cwd,
        env,
        run_id: runId,
        host: "alpha",
        source,
        delta,
        dispatch: true,
        now: "2026-09-01T00:00:01.000Z",
      });
      assert.equal(started.dispatch?.materialized.length, 2);
      assert.ok(started.dispatch?.selection.integration_conflict_risks.length);

      const tickets = new Map(listSpawns(cwd, env).map((ticket) => [ticket.rolling_unit_lineage!.unit_key, ticket]));
      const handles = new Map<string, NativeExecutionHandle>();
      const firstReservation = await reserveNext(cwd, { capacity: 2, limit: 2, host: "alpha", env });
      assert.equal(firstReservation.reserved.length, 1);
      assert.equal(firstReservation.blocked[0]?.code, "ROUTE_PROBE_PENDING");
      const firstTicket = [...tickets.values()].find((ticket) => ticket.id === firstReservation.reserved[0]!.ticket_id)!;
      const firstHandle = exactHandle(firstTicket);
      handles.set(firstTicket.rolling_unit_lineage!.unit_key, firstHandle);
      bindAgent(cwd, firstTicket.id, { executionHandle: firstHandle, host: "alpha", env });
      reportAgentProbe(cwd, firstTicket.id, {
        executionHandle: firstHandle,
        state: "running",
        activity: "heartbeat",
        host: "alpha",
        env,
      });
      const secondReservation = await reserveNext(cwd, { capacity: 2, limit: 2, host: "alpha", env });
      assert.equal(secondReservation.reserved.length, 1);
      const secondTicket = [...tickets.values()].find((ticket) => ticket.id === secondReservation.reserved[0]!.ticket_id)!;
      const secondHandle = exactHandle(secondTicket);
      handles.set(secondTicket.rolling_unit_lineage!.unit_key, secondHandle);
      bindAgent(cwd, secondTicket.id, { executionHandle: secondHandle, host: "alpha", env });
      reportAgentProbe(cwd, secondTicket.id, {
        executionHandle: secondHandle,
        state: "running",
        activity: "heartbeat",
        host: "alpha",
        env,
      });

      for (const [index, unitKey] of unitKeys.entries()) {
        const ticket = tickets.get(unitKey)!;
        fs.writeFileSync(ticket.rolling_unit_lineage!.execution_root! + "/file.txt", `worker ${index + 1}\n`);
        reportAgentProgress(cwd, ticket.id, {
          phase: "working",
          summary: `${unitKey} changed its isolated file`,
          nextStep: "finish focused validation",
          host: "alpha",
          env,
        });
      }

      const live = await statusRollingControl({ cwd, env, run_id: runId });
      assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "base\n");
      assert.equal(git(cwd, ["status", "--porcelain=v1"]), "");
      assert.deepEqual(live.isolation.units.map((unit) => unit.native_liveness), ["running", "running"]);
      assert.deepEqual(live.isolation.units.map((unit) => unit.diff.changed_paths), [["file.txt"], ["file.txt"]]);
      assert.deepEqual(live.tickets.map((ticket) => ticket.progress?.phase), ["working", "working"]);
      assert.ok(live.tickets.every((ticket) => ticket.liveness?.state === "running" && ticket.execution_root));

      for (const unitKey of unitKeys) {
        const ticket = tickets.get(unitKey)!;
        await finishAgent(cwd, ticket.id, {
          status: "completed",
          conclusion: `${unitKey} completed in its isolated root`,
          host: "alpha",
          env,
        });
        releaseAgent(cwd, ticket.id, { executionHandle: handles.get(unitKey), host: "alpha", env });
      }

      const frozen = [];
      for (const unitKey of unitKeys) {
        const result = await freezeRollingUnitBundle({
          cwd,
          env,
          run_id: runId,
          unit_key: unitKey,
          attempt_id: "attempt-1",
          conclusion: `${unitKey} terminal result audited by parent`,
          validation_summaries: [`${unitKey} focused validation passed`],
        });
        assert.ok(result.bundle);
        frozen.push(result.bundle!);
      }
      assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "base\n");

      const [first, second] = frozen;
      await beginWorktreeIntegration({
        repository_root: cwd,
        run_id: runId,
        repository_id: first!.repository_id,
        bundle_id: first!.bundle_id,
        expected_before_tree: visibleTree(cwd),
        env,
      });
      const firstApplied = await applyWorktreeIntegration({
        repository_root: cwd,
        run_id: runId,
        repository_id: first!.repository_id,
        bundle_id: first!.bundle_id,
        env,
      });
      assert.equal(firstApplied.record.state, "integrated");
      assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "base\n", "apply must not publish");
      await acceptWorktreeIntegration({
        repository_root: cwd,
        run_id: runId,
        repository_id: first!.repository_id,
        bundle_id: first!.bundle_id,
        conclusion: "accepted first clean worker bundle",
        env,
      });
      assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "worker 1\n");

      await beginWorktreeIntegration({
        repository_root: cwd,
        run_id: runId,
        repository_id: second!.repository_id,
        bundle_id: second!.bundle_id,
        expected_before_tree: visibleTree(cwd),
        env,
      });
      const conflicted = await applyWorktreeIntegration({
        repository_root: cwd,
        run_id: runId,
        repository_id: second!.repository_id,
        bundle_id: second!.bundle_id,
        env,
      });
      assert.equal(conflicted.record.state, "awaiting_parent_resolution");
      assert.equal(conflicted.record.conflicts[0]?.kind, "content");
      assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "worker 1\n");

      const resolvedTree = parentResolutionTree(cwd, "parent resolved worker 1 and worker 2\n");
      const resolved = await resolveWorktreeIntegration({
        repository_root: cwd,
        run_id: runId,
        repository_id: second!.repository_id,
        bundle_id: second!.bundle_id,
        resolved_tree: resolvedTree,
        conclusion: "parent combined both isolated worker semantics",
        env,
      });
      assert.equal(resolved.record.state, "integrated");
      assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "worker 1\n", "resolve must not publish");
      await acceptWorktreeIntegration({
        repository_root: cwd,
        run_id: runId,
        repository_id: second!.repository_id,
        bundle_id: second!.bundle_id,
        conclusion: "accepted parent-resolved second bundle",
        env,
      });

      assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "parent resolved worker 1 and worker 2\n");
      assert.equal(fs.readFileSync(path.join(cwd, "stable.txt"), "utf8"), "stable\n");
      assert.equal(git(cwd, ["rev-parse", "HEAD"]), initialHead);
      assert.deepEqual(fs.readFileSync(path.join(cwd, ".git", "index")), initialIndex);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });
});
