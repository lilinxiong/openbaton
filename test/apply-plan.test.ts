import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPlanFingerprint,
  ApplyPlanValidationError,
  assertValidApplyExecutionPlan,
  buildFrontierConflictGraph,
  deriveDependencyReadyUndispatchedUnits,
  deriveSafeReadyFrontier,
  fingerprintApplyExecutionPlan,
  parseApplyExecutionPlan,
  remainingCriticalPath,
  serializeApplyExecutionPlan,
  selectIndependentSet,
  validateApplyExecutionPlan,
  type ApplyExecutionPlan,
} from "../src/lib/apply-plan.js";

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    identity: { plan_id: "p1", change_id: "demo" },
    source_snapshot: { repo_root: "/repo", revision: "abc" },
    selected_tasks: ["1.1", "1.2"],
    units: [
      { id: "u1", mode: "patch-only", task_ids: ["1.1"], write_paths: ["src/a.ts"], allowed_operations: ["write"], runtime_state: "planned" },
      { id: "u2", mode: "verification-only", task_ids: ["1.2"] },
    ],
    ...overrides,
  } as ApplyExecutionPlan;
}

function frontierPlan(units: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    ...basePlan(),
    units,
    parent_gates: [],
    selected_tasks: units.map((_, index) => `t${index + 1}`),
    ...overrides,
  } as ApplyExecutionPlan;
}

describe("apply execution plan schema", () => {
  it("round trips with stable canonical order and fingerprint", () => {
    const value = basePlan();
    const encoded = serializeApplyExecutionPlan(value);
    assert.deepEqual(parseApplyExecutionPlan(encoded), value);
    assert.equal(fingerprintApplyExecutionPlan(value), applyPlanFingerprint(JSON.parse(encoded)));
  });

  it("supports merged and split task mappings and gate-only tasks", () => {
    const value = basePlan({
      selected_tasks: ["1.1", "1.2", "1.3"],
      units: [
        { id: "u1", mode: "patch-only", task_ids: ["1.1", "1.2"], write_paths: ["src/a.ts"], allowed_operations: ["write"] },
        { id: "u2", mode: "verification-only", task_ids: ["1.1"], verification: ["npm test"] },
      ],
      parent_gates: [{ id: "g1", task_ids: ["1.3"], unit_ids: ["u1", "u2"] }],
    });
    assert.equal(validateApplyExecutionPlan(value).valid, true);
  });

    it("reports schema, references, cycles, coverage, scopes, and operations", () => {
    const value = basePlan({
      schema_version: 2,
      selected_tasks: ["missing"],
      units: [
        { id: "u1", mode: "patch-only", task_ids: ["1.1"], write_paths: [".git"], allowed_operations: ["bad"], depends_on: ["u1"] },
      ],
    });
    const result = validateApplyExecutionPlan(value);
    assert.equal(result.valid, false);
    for (const code of ["UNKNOWN_SCHEMA", "FORBIDDEN_PATH", "INVALID_OPERATION", "DEPENDENCY_CYCLE", "TASK_COVERAGE_INCOMPLETE"]) {
      assert.ok(result.diagnostics.some((item) => item.code === code), code);
    }
  });

  it("computes deterministic critical path values", () => {
    const value = basePlan();
    assert.deepEqual(remainingCriticalPath(value), { u1: 1, u2: 1 });
    assert.deepEqual(remainingCriticalPath({ ...value, units: value.units.slice().reverse() }), { u1: 1, u2: 1 });
  });

  it("reports malformed unit entries through validation instead of throwing a TypeError", () => {
    const malformed = { ...basePlan(), units: [null] };
    assert.throws(
      () => parseApplyExecutionPlan(JSON.stringify(malformed)),
      (error: unknown) => error instanceof ApplyPlanValidationError
        && error.diagnostics.some((item) => item.code === "INVALID_UNIT"),
    );
  });

  it("retains normalized write scope overlaps as scheduling edges without invalidating unordered units", () => {
    const value = basePlan({
      selected_tasks: ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"],
      units: [
        { id: "u1", mode: "patch-only", task_ids: ["1.1"], write_paths: ["./src/../src/app.ts"], allowed_operations: ["write"] },
        { id: "u2", mode: "patch-only", task_ids: ["1.2"], write_paths: ["src/app.ts"], allowed_operations: ["write"] },
        { id: "u3", mode: "patch-only", task_ids: ["1.3"], write_paths: ["docs/*/README.md"], allowed_operations: ["write"] },
        { id: "u4", mode: "patch-only", task_ids: ["1.4"], write_paths: ["docs/guide/README.md"], allowed_operations: ["write"] },
        { id: "u5", mode: "patch-only", task_ids: ["1.5"], write_paths: ["old.ts -> new.ts"], allowed_operations: ["rename"] },
        { id: "u6", mode: "patch-only", task_ids: ["1.6"], write_paths: ["new.ts"], allowed_operations: ["write"] },
      ],
    });

    const result = validateApplyExecutionPlan(value);
    const conflicts = new Set(result.overlap_edges.map((edge) => [edge.from, edge.to].sort().join("|")));
    assert.equal(result.valid, true);
    assert.equal(result.diagnostics.some((item) => item.code === "WRITE_SCOPE_CONFLICT"), false);
    assert.ok(conflicts.has("u1|u2"));
    assert.ok(conflicts.has("u3|u4"));
    assert.ok(conflicts.has("u5|u6"));
  });

  it("computes remaining critical path toward downstream dependents", () => {
    const plan = basePlan({
      selected_tasks: ["1.1", "1.2", "1.3", "1.4"],
      units: [
        { id: "u1", mode: "patch-only", task_ids: ["1.1"], write_paths: ["src/u1.ts"], allowed_operations: ["write"] },
        { id: "u2", mode: "verification-only", task_ids: ["1.2"], depends_on: ["u1"] },
        { id: "u3", mode: "verification-only", task_ids: ["1.3"], depends_on: ["u2"] },
        { id: "u4", mode: "verification-only", task_ids: ["1.4"], depends_on: ["u1"] },
      ],
    });

    assert.deepEqual(remainingCriticalPath(plan), { u1: 3, u2: 2, u3: 1, u4: 1 });
  });

  it("accepts gate-only explicit task mappings", () => {
    const plan = basePlan({
      selected_tasks: ["gate-task"],
      units: [],
      parent_gates: [{ id: "g1", task_ids: ["gate-task"] }],
      task_mappings: [{ task_id: "gate-task", unit_ids: [], gate_ids: ["g1"] }],
    });

    assert.equal(validateApplyExecutionPlan(plan).valid, true);
  });

  it("rejects explicit mappings that disagree with referenced task ids", () => {
    const plan = basePlan({
      task_mappings: [
        { task_id: "1.1", unit_ids: ["u2"] },
        { task_id: "1.2", unit_ids: ["u1"] },
      ],
    });

    const result = validateApplyExecutionPlan(plan);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => item.code === "MAPPING_TASK_MISMATCH"));
  });

  it("rejects incomplete explicit mappings", () => {
    const plan = basePlan({ task_mappings: [{ task_id: "1.1", unit_ids: ["u1"] }] });

    const result = validateApplyExecutionPlan(plan);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => item.code === "TASK_COVERAGE_INCOMPLETE"));
  });

  it("rejects unknown fields and forbidden verification writes", () => {
    const bad = basePlan({
      units: [
        { id: "u", mode: "verification-only", task_ids: ["1.1"], write_paths: ["x"] },
        { id: "v", mode: "verification-only", task_ids: ["1.2"], verification: [] },
      ],
    });
    assert.throws(() => assertValidApplyExecutionPlan(bad), /FORBIDDEN_FIELD/);
    assert.throws(() => parseApplyExecutionPlan(JSON.stringify({ ...basePlan(), extra: true })), /UNKNOWN_FIELD/);
  });
});

describe("frontier readiness and dependency handling", () => {
  it("derives readiness from accepted predecessor units and parent gates", () => {
    const plan = basePlan({
      units: [
      { id: "u1", mode: "patch-only", task_ids: ["1.1"], write_paths: ["src/u1.ts"], allowed_operations: ["write"], runtime_state: "planned" },
        { id: "u2", mode: "verification-only", task_ids: ["1.2"], depends_on: ["u1"] },
        { id: "u3", mode: "verification-only", task_ids: ["1.3"], depends_on: ["uX"] },
        { id: "u4", mode: "verification-only", task_ids: ["1.4"], parent_gate_ids: ["g1"] },
        { id: "u5", mode: "verification-only", task_ids: ["1.5"], parent_gate_ids: ["g2"] },
      ],
      parent_gates: [
        { id: "g1", depends_on: ["u1"], runtime_state: "succeeded" },
        { id: "g2", depends_on: ["u2"], runtime_state: "blocked" },
      ],
    });

    const readyWhenPlanned = deriveDependencyReadyUndispatchedUnits(plan, {
      acceptedUnitStates: ["planned", "succeeded"],
      acceptedGateStates: ["planned", "succeeded"],
    });

    assert.deepEqual(readyWhenPlanned, ["u1", "u2", "u4"]);

    assert.deepEqual(deriveDependencyReadyUndispatchedUnits(plan), ["u1"]);
  });

  it("omits ineligible units from excluded runtime states", () => {
    const plan = basePlan({
      units: [
        { id: "u1", mode: "patch-only", task_ids: ["1.1"], write_paths: ["src/u1.ts"], allowed_operations: ["write"], runtime_state: "planned" },
        { id: "u2", mode: "verification-only", task_ids: ["1.2"], depends_on: ["u1"], runtime_state: "running" },
        { id: "u3", mode: "verification-only", task_ids: ["1.3"], depends_on: ["u1"], runtime_state: "blocked" },
        { id: "u4", mode: "verification-only", task_ids: ["1.4"], depends_on: ["u1"], runtime_state: "succeeded" },
        { id: "u5", mode: "verification-only", task_ids: ["1.5"], depends_on: ["u1"], runtime_state: "stale" },
      ],
    });

    assert.deepEqual(deriveDependencyReadyUndispatchedUnits(plan), ["u1"]);
  });
});

describe("frontier conflict graph", () => {
  it("reports exact, parent-child, wildcard-prefix, normalized, and rename endpoint conflicts", () => {
    const plan = frontierPlan([
      { id: "uExact", mode: "patch-only", task_ids: ["t1"], write_paths: ["src/index.ts"], allowed_operations: ["write"] },
      { id: "uNormalized", mode: "patch-only", task_ids: ["t2"], write_paths: ["./src/../src/index.ts"], allowed_operations: ["write"] },
      { id: "uParent", mode: "patch-only", task_ids: ["t3"], write_paths: ["src/components"], allowed_operations: ["write"] },
      { id: "uChild", mode: "patch-only", task_ids: ["t4"], write_paths: ["src/components/one.ts"], allowed_operations: ["write"] },
      { id: "uWildcard", mode: "patch-only", task_ids: ["t5"], write_paths: ["docs/*/README.md"], allowed_operations: ["write"] },
      { id: "uWildcardHit", mode: "patch-only", task_ids: ["t6"], write_paths: ["docs/guide/README.md"], allowed_operations: ["write"] },
      { id: "uRename", mode: "patch-only", task_ids: ["t7"], write_paths: ["old.ts -> new.ts"], allowed_operations: ["rename"] },
      { id: "uRenameSource", mode: "patch-only", task_ids: ["t8"], write_paths: ["old.ts"], allowed_operations: ["write"] },
      { id: "uRenameTarget", mode: "patch-only", task_ids: ["t9"], write_paths: ["new.ts"], allowed_operations: ["write"] },
      { id: "uUnrelated", mode: "patch-only", task_ids: ["t10"], write_paths: ["assets/readme.md"], allowed_operations: ["write"] },
    ]);

    const frontier = ["uExact", "uNormalized", "uParent", "uChild", "uWildcard", "uWildcardHit", "uRename", "uRenameSource", "uRenameTarget", "uUnrelated"];
    const graph = buildFrontierConflictGraph(plan, frontier);

    assert.deepEqual(graph.conflicts.get("uExact"), ["uNormalized"]);
    assert.deepEqual(graph.conflicts.get("uNormalized"), ["uExact"]);
    assert.deepEqual(graph.conflicts.get("uParent"), ["uChild"]);
    assert.deepEqual(graph.conflicts.get("uChild"), ["uParent"]);
    assert.deepEqual(graph.conflicts.get("uWildcard"), ["uWildcardHit"]);
    assert.deepEqual(graph.conflicts.get("uWildcardHit"), ["uWildcard"]);
    assert.deepEqual(graph.conflicts.get("uRename"), ["uRenameSource", "uRenameTarget"]);
    assert.deepEqual(graph.conflicts.get("uRenameSource"), ["uRename"]);
    assert.deepEqual(graph.conflicts.get("uRenameTarget"), ["uRename"]);
    assert.equal(graph.conflicts.get("uUnrelated")?.length ?? 0, 0);
  });

  it("only evaluates overlaps inside the provided frontier", () => {
    const plan = frontierPlan([
      { id: "u1", mode: "patch-only", task_ids: ["t1"], write_paths: ["same.ts"], allowed_operations: ["write"] },
      { id: "u2", mode: "patch-only", task_ids: ["t2"], write_paths: ["same.ts"], allowed_operations: ["write"] },
      { id: "u3", mode: "patch-only", task_ids: ["t3"], write_paths: ["same.ts"], allowed_operations: ["write"] },
    ]);
    const graph = buildFrontierConflictGraph(plan, ["u1"]);

    assert.deepEqual(graph.conflicts.get("u1"), []);
  });

  it("normalizes wildcard paths before deriving their conflict prefix", () => {
    const plan = frontierPlan([
      { id: "dot", mode: "patch-only", task_ids: ["t1"], write_paths: ["./src/*.ts"], allowed_operations: ["write"] },
      { id: "dotHit", mode: "patch-only", task_ids: ["t2"], write_paths: ["src/file.ts"], allowed_operations: ["write"] },
      { id: "slashes", mode: "patch-only", task_ids: ["t3"], write_paths: ["src//nested/*.ts"], allowed_operations: ["write"] },
      { id: "slashesHit", mode: "patch-only", task_ids: ["t4"], write_paths: ["src/nested/file.ts"], allowed_operations: ["write"] },
      { id: "parent", mode: "patch-only", task_ids: ["t5"], write_paths: ["src/area/../*.ts"], allowed_operations: ["write"] },
      { id: "parentHit", mode: "patch-only", task_ids: ["t6"], write_paths: ["src/another.ts"], allowed_operations: ["write"] },
    ]);
    const graph = buildFrontierConflictGraph(plan, plan.units.map((unit) => unit.id));
    assert.ok(graph.conflicts.get("dot")?.includes("dotHit"));
    assert.ok(graph.conflicts.get("slashes")?.includes("slashesHit"));
    assert.ok(graph.conflicts.get("parent")?.includes("parentHit"));
  });

  it("tracks active ownership conflicts and ignores inactive ownership", () => {
    const plan = frontierPlan([
      { id: "u1", mode: "patch-only", task_ids: ["t1"], write_paths: ["src/locked.ts"], allowed_operations: ["write"] },
      { id: "u2", mode: "patch-only", task_ids: ["t2"], write_paths: ["src/freely.ts"], allowed_operations: ["write"] },
    ]);
    const frontier = ["u1", "u2"];

    const blocked = buildFrontierConflictGraph(plan, frontier, {
      activeOwnership: [{
        key: "other-root",
        terminal_unreleased: true,
        facts: [{ unit_id: "other", path: "src/locked.ts", kind: "path" }],
      }],
    });
    const released = buildFrontierConflictGraph(plan, frontier, {
      activeOwnership: [{
        key: "other-root",
        terminal_unreleased: false,
        facts: [{ unit_id: "other", path: "src/locked.ts", kind: "path" }],
      }],
    });

    assert.ok(blocked.blockedByActiveOwnership.has("u1"));
    assert.ok(!blocked.blockedByActiveOwnership.has("u2"));
    assert.equal(released.blockedByActiveOwnership.size, 0);
  });

  it("retains terminal-unreleased ownership as blocking", () => {
    const plan = frontierPlan([
      { id: "u1", mode: "patch-only", task_ids: ["t1"], write_paths: ["src/terminal.ts"], allowed_operations: ["write"] },
    ]);
    const graph = buildFrontierConflictGraph(plan, ["u1"], {
      activeOwnership: [{
        key: "other-root",
        terminal_unreleased: true,
        facts: [{ unit_id: "other", path: "src/terminal.ts", kind: "path" }],
      }],
    });

    assert.ok(graph.blockedByActiveOwnership.has("u1"));
  });

  it("namespaces overlaps by repository and execution root while reporting cross-root integration risk", () => {
    const plan = frontierPlan([
      { id: "same", mode: "patch-only", task_ids: ["t1"], write_paths: ["src/shared.ts"], allowed_operations: ["write"] },
      { id: "otherRoot", mode: "patch-only", task_ids: ["t2"], write_paths: ["src/shared.ts"], allowed_operations: ["write"] },
      { id: "otherRepo", mode: "patch-only", task_ids: ["t3"], write_paths: ["src/shared.ts"], allowed_operations: ["write"] },
    ]);
    const graph = buildFrontierConflictGraph(plan, ["same", "otherRoot", "otherRepo"], {
      ownershipByUnit: {
        same: { repository_id: "a".repeat(64), execution_root: "/worktrees/root-a", base_tree: "1".repeat(40) },
        otherRoot: { repository_id: "a".repeat(64), execution_root: "/worktrees/root-b", base_tree: "1".repeat(40) },
        otherRepo: { repository_id: "b".repeat(64), execution_root: "/worktrees/root-a", base_tree: "1".repeat(40) },
      },
      activeOwnership: [{
        key: "running-same-root", repository_id: "a".repeat(64), execution_root: "/worktrees/root-a",
        facts: [{ unit_id: "running-same-root", path: "src/shared.ts", kind: "path" }],
      }],
    });

    assert.deepEqual(graph.conflicts.get("same"), []);
    assert.equal(graph.blockedByActiveOwnership.has("same"), true);
    assert.equal(graph.blockedByActiveOwnership.has("otherRoot"), false);
    assert.equal(graph.blockedByActiveOwnership.has("otherRepo"), false);
    assert.deepEqual(graph.integration_conflict_risks.map((risk) => [risk.from, risk.to]), [
      ["otherRoot", "running-same-root"],
      ["same", "otherRoot"],
    ]);
  });
});

describe("independent-set selection", () => {
  it("resolves greedy-suboptimal frontiers using branch-and-bound maximum cardinality", () => {
    const frontier = ["a", "b", "c", "d", "e"];
    const graph = new Map<string, string[]>([
      ["a", ["b", "c", "d"]],
      ["b", ["a", "e"]],
      ["c", ["a", "e"]],
      ["d", ["a", "e"]],
      ["e", ["b", "c", "d"]],
    ]);
    assert.deepEqual(selectIndependentSet(frontier, graph, {
      capacity: 10,
      criticalPathByUnit: { a: 1, b: 1, c: 1, d: 1, e: 1 },
    }), ["b", "c", "d"]);
  });

  it("prefers larger summed remaining critical-path after cardinality, then stable order", () => {
    const frontier = ["a", "b", "c", "d"];
    const graph = new Map<string, string[]>([
      ["a", ["c", "d"]],
      ["b", ["c", "d"]],
      ["c", ["a", "b"]],
      ["d", ["a", "b"]],
    ]);

    assert.deepEqual(selectIndependentSet(frontier, graph, {
      capacity: 2,
      criticalPathByUnit: { a: 10, b: 2, c: 5, d: 1 },
    }), ["a", "b"]);

    assert.deepEqual(selectIndependentSet(frontier, graph, {
      capacity: 2,
      criticalPathByUnit: { a: 10, b: 10, c: 10, d: 10 },
    }), ["a", "b"]);
  });

  it("respects capacity below and above frontier size", () => {
    const frontier = ["u1", "u2", "u3", "u4"];
    const noConflicts = new Map(frontier.map((unitId) => [unitId, [] as string[]]));

    assert.deepEqual(selectIndependentSet(frontier, noConflicts, {
      capacity: 2,
      criticalPathByUnit: { u1: 100, u2: 90, u3: 50, u4: 1 },
    }), ["u1", "u2"]);

    assert.deepEqual(selectIndependentSet(frontier, noConflicts, {
      capacity: 10,
      criticalPathByUnit: { u1: 100, u2: 90, u3: 50, u4: 1 },
    }), ["u1", "u2", "u3", "u4"]);
  });

  it("stays deterministic across repeated selection and is stable by frontier order", () => {
    const frontier = ["f1", "f2", "f3", "f4", "f5", "f6"];
    const graph = new Map<string, string[]>([
      ["f1", ["f2"]],
      ["f2", ["f1", "f4"]],
      ["f3", ["f5"]],
      ["f4", ["f2"]],
      ["f5", ["f3", "f6"]],
      ["f6", ["f5"]],
    ]);

    const first = selectIndependentSet(frontier, graph, {
      capacity: 4,
      criticalPathByUnit: { f1: 2, f2: 2, f3: 4, f4: 4, f5: 1, f6: 1 },
    });
    const second = selectIndependentSet(frontier, graph, {
      capacity: 4,
      criticalPathByUnit: { f1: 2, f2: 2, f3: 4, f4: 4, f5: 1, f6: 1 },
    });

    assert.deepEqual(first, second);
    assert.deepEqual(first, ["f1", "f3", "f4", "f6"]);
  });

  it("handles a large bounded frontier efficiently and deterministically", () => {
    const frontier = Array.from({ length: 30 }, (_, index) => `node-${index}`);
    const graph = new Map(frontier.map((unitId, index) => {
      const links: string[] = [];
      if (index > 0) links.push(`node-${index - 1}`);
      if (index + 1 < frontier.length) links.push(`node-${index + 1}`);
      return [unitId, links] as const;
    }));

    const result = selectIndependentSet(frontier, graph, {
      capacity: 8,
    });

    assert.deepEqual(result, ["node-0", "node-2", "node-4", "node-6", "node-8", "node-10", "node-12", "node-14"]);
  });

  it("fails closed when the exact-search safety bound is exhausted", () => {
    const frontier = ["a", "b", "c", "d", "e"];
    const graph = new Map<string, string[]>([
      ["a", ["b", "c", "d"]], ["b", ["a", "e"]], ["c", ["a", "e"]],
      ["d", ["a", "e"]], ["e", ["b", "c", "d"]],
    ]);
    assert.throws(
      () => selectIndependentSet(frontier, graph, { capacity: 5, maxSearchNodes: 1 }),
      (error: unknown) => (error as { code?: string }).code === "APPLY_FRONTIER_SEARCH_LIMIT",
    );
  });
});

describe("deriveSafeReadyFrontier", () => {
  it("integrates dependency acceptance, ownership exclusions, and conflict selection", () => {
    const plan = {
      schema_version: 1,
      identity: { plan_id: "p1", change_id: "demo" },
      source_snapshot: { repo_root: "/repo", revision: "abc" },
      selected_tasks: ["t1", "t2", "t3", "t4", "t5"],
      units: [
        { id: "u1", mode: "patch-only", task_ids: ["t1"], write_paths: ["src/u1.ts"], allowed_operations: ["write"], runtime_state: "succeeded" },
        { id: "u2", mode: "patch-only", task_ids: ["t2"], write_paths: ["src/u2.ts"], allowed_operations: ["write"], runtime_state: "running" },
        { id: "u3", mode: "verification-only", task_ids: ["t3"], runtime_state: "planned", depends_on: ["u1"] },
        { id: "u4", mode: "verification-only", task_ids: ["t4"], parent_gate_ids: ["g1"], runtime_state: "planned" },
        { id: "u5", mode: "patch-only", task_ids: ["t5"], write_paths: ["src/u5.ts"], allowed_operations: ["write"], runtime_state: "planned", parent_gate_ids: ["g2"] },
      ],
      parent_gates: [
        { id: "g1", depends_on: ["u1"], runtime_state: "succeeded" },
        { id: "g2", depends_on: ["u1"], runtime_state: "terminal" },
      ],
      runtime_state: "ready",
    } as ApplyExecutionPlan;

    const frontier = deriveSafeReadyFrontier(plan, {
      capacity: 3,
      activeOwnership: [{
        key: "other-root",
        terminal_unreleased: true,
        facts: [{ unit_id: "other", path: "src/u5.ts", kind: "path" }],
      }],
      criticalPathByUnit: { u1: 1, u2: 1, u3: 1, u4: 1, u5: 10 },
    });

    assert.deepEqual(frontier, ["u3", "u4"]);
  });
});
