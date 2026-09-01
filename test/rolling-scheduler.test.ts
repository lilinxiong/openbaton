import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRollingSafeFrontier,
  type RollingRouteFact,
} from "../src/lib/rolling-scheduler.js";
import type { GateVersion, PlanDelta, UnitVersion } from "../src/lib/rolling-plan.js";

const hash = "a".repeat(64);

function unit(key: string, version = 1, overrides: Partial<UnitVersion> = {}): UnitVersion {
  return {
    schema_version: 1,
    unit_key: key,
    version,
    task_keys: [`task-${key}`],
    depends_on: [],
    execution_mode: "patch-only",
    prompt: `change ${key}`,
    write_paths: [`src/${key}.ts`],
    allowed_operations: ["write"],
    input_fingerprints: { head: hash },
    ...overrides,
  };
}

function delta(units: UnitVersion[], gates: GateVersion[] = [], extra: Partial<PlanDelta> = {}): PlanDelta {
  return {
    schema_version: 1,
    delta_id: `delta-${units.map((item) => item.unit_key).join("-") || "gates"}`,
    prepared_from_append_sequence: 0,
    unit_versions: units,
    gate_versions: gates,
    task_coverage: [],
    ...extra,
  };
}

function route(id: string, extra: Partial<RollingRouteFact> = {}): RollingRouteFact {
  return { route_id: id, selectable: true, availability_status: "available", ...extra };
}

describe("rolling scheduler", () => {
  it("derives a dependency-safe known frontier without reading untouched manifest entries", () => {
    const reads = { manifest: 0, semantic: 0 };
    const untouched = new Proxy(Array.from({ length: 10_000 }, (_, index) => ({ task_key: `untouched-${index}` })), {
      get(target, property, receiver) {
        reads.manifest += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const first = unit("first");
    const second = unit("second", 1, { depends_on: ["first@1"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([first, second])],
      runtime_facts: [],
      manifest_entries: untouched,
      instrumentation: {
        on_manifest_read: () => { reads.manifest += 1; },
        on_semantic_read: () => { reads.semantic += 1; },
      },
      capacity: 8,
    });
    assert.deepEqual(result.frontier, ["first@1"]);
    assert.equal(result.blockers["second@1"]?.[0]?.code, "DEPENDENCY_NOT_ACCEPTED");
    assert.equal(reads.manifest, 0);
    assert.equal(reads.semantic, 0);
  });

  it("requires accepted safety-preconditions and excludes superseded or stale versions", () => {
    const safety: GateVersion = {
      schema_version: 1, gate_key: "auth", version: 1, type: "safety-precondition",
      task_keys: ["task-gated"], depends_on: [], acceptance_contract: { required: true },
    };
    const gated = unit("gated", 1, { required_gate_keys: ["auth"] });
    const stale = unit("stale");
    const replaced = unit("replace", 1);
    const successor = unit("replace", 2);
    const pending = deriveRollingSafeFrontier({
      accepted_deltas: [delta([gated, stale, replaced, successor], [safety], {
        supersessions: [{ schema_version: 1, owner: "unit_version", previous: "replace@1", successor: "replace@2", reason: "repair" }],
      })],
      runtime_facts: [
        { unit_key: "stale", unit_version: 1, state: "stale" },
      ],
      capacity: 8,
    });
    assert.deepEqual(pending.frontier, ["replace@2"]);
    assert.equal(pending.blockers["gated@1"]?.[0]?.code, "SAFETY_PRECONDITION_NOT_ACCEPTED");
    assert.equal(pending.blockers["stale@1"]?.[0]?.code, "LOCAL_INPUT_STALE");
    assert.equal(pending.known_unit_versions.includes("replace@1"), false);
    const accepted = deriveRollingSafeFrontier({
      accepted_deltas: [delta([gated], [safety])],
      runtime_facts: [{ gate_key: "auth", gate_version: 1, state: "accepted" }],
      capacity: 8,
    });
    assert.deepEqual(accepted.frontier, ["gated@1"]);
  });

  it("keeps acceptance version-local when a cancelled unit is superseded", () => {
    const original = unit("setup", 1);
    const successor = unit("setup", 2);
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([original, successor], [], {
        supersessions: [{ schema_version: 1, owner: "unit_version", previous: "setup@1", successor: "setup@2", reason: "retry cancelled setup" }],
      })],
      runtime_facts: [
        { kind: "native-attempt", owner_type: "attempt", owner_key: "setup@1:attempt-1", unit_key: "setup", unit_version: 1, state: "cancelled" },
        { kind: "terminal-result", owner_type: "attempt", owner_key: "setup@1:attempt-1", unit_key: "setup", unit_version: 1, status: "cancelled" },
        { kind: "safety-verdict", owner_type: "unit_version", owner_key: "setup@1", unit_key: "setup", unit_version: 1, accepted: true },
        { kind: "release", owner_type: "attempt", owner_key: "setup@1:attempt-1", unit_key: "setup", unit_version: 1, released: true },
      ],
      capacity: 8,
    });
    assert.deepEqual(result.frontier, ["setup@2"]);
    assert.equal(result.blockers["setup@2"], undefined);
  });

  it("does not treat a safety verdict as parent acceptance", () => {
    const candidate = unit("review");
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([candidate])],
      runtime_facts: [
        { kind: "safety-verdict", owner_type: "unit_version", owner_key: "review@1", unit_key: "review", unit_version: 1, accepted: true },
      ],
      capacity: 8,
    });
    assert.deepEqual(result.frontier, ["review@1"]);
    assert.equal(result.blockers["review@1"], undefined);
  });

  it("does not inherit an accepted predecessor through a stable unit key", () => {
    const original = unit("repair", 1);
    const successor = unit("repair", 2);
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([original, successor], [], {
        supersessions: [{ schema_version: 1, owner: "unit_version", previous: "repair@1", successor: "repair@2", reason: "new repair scope" }],
      })],
      runtime_facts: [
        { kind: "parent-acceptance", owner_type: "unit_version", owner_key: "repair@1", unit_key: "repair", unit_version: 1, accepted: true },
      ],
      capacity: 8,
    });
    assert.deepEqual(result.frontier, ["repair@2"]);
    assert.equal(result.blockers["repair@2"], undefined);
  });

  it("keeps route failures local and selects an eligible independent route", () => {
    const blocked = unit("blocked", 1, { required_execution_capabilities: ["native-execution"] } as Partial<UnitVersion>);
    const eligible = unit("eligible", 1, { required_execution_capabilities: ["native-execution"] } as Partial<UnitVersion>);
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([blocked, eligible])],
      routes_by_unit: {
        "blocked@1": [route("alpha/blocked", { current_session_uncallable: true })],
        "eligible@1": [
          route("alpha/other", { execution_capabilities: ["native-execution"] }),
          route("alpha/eligible", { execution_capabilities: ["native-execution"] }),
        ],
      },
      configured_routes: ["alpha/blocked", "alpha/eligible", "alpha/other"],
      capacity: 1,
    });
    assert.deepEqual(result.frontier, ["eligible@1"]);
    assert.equal(result.selected_routes["eligible@1"], "alpha/eligible");
    assert.equal(result.blockers["blocked@1"]?.[0]?.code, "CURRENT_SESSION_UNCALLABLE");
  });

  it("honors terminal-unreleased ownership, shared scopes, and capacity deterministically", () => {
    const held = unit("held");
    const overlap = unit("overlap", 1, { write_paths: ["src/held.ts"] });
    const independent = unit("independent");
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([held, overlap, independent])],
      runtime_facts: [{ unit_key: "held", unit_version: 1, state: "terminal-unreleased" }],
      active_ownership: [{
        key: "held@1", terminal: true, terminal_unreleased: true,
        facts: [{ unit_id: "held@1", path: "src/held.ts", kind: "path" }],
      }],
      capacity: 1,
    });
    assert.deepEqual(result.frontier, ["independent@1"]);
    assert.equal(result.blockers["held@1"]?.[0]?.code, "TERMINAL_UNRELEASED");
    assert.equal(result.blockers["overlap@1"]?.[0]?.code, "WRITE_SCOPE_CONFLICT");
  });

  it("runs independent isolated roots from one immutable base and emits deterministic integration risk", () => {
    const first = unit("first", 1, { worktree_mode: "isolated-worktree", write_paths: ["src/shared.ts"] });
    const second = unit("second", 1, { worktree_mode: "isolated-worktree", write_paths: ["src/shared.ts"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([first, second])],
      execution_roots_by_unit: {
        "first@1": { repository_id: "a".repeat(64), execution_root: "/worktrees/first", base_tree: "1".repeat(40) },
        "second@1": { repository_id: "a".repeat(64), execution_root: "/worktrees/second", base_tree: "1".repeat(40) },
      },
      capacity: 8,
    });

    assert.deepEqual(result.frontier, ["first@1", "second@1"]);
    assert.deepEqual(result.integration_conflict_risks.map((risk) => [risk.from, risk.to]), [["first@1", "second@1"]]);

    const distinctAllowedBase = deriveRollingSafeFrontier({
      accepted_deltas: [delta([first, second])],
      execution_roots_by_unit: {
        "first@1": { repository_id: "a".repeat(64), execution_root: "/worktrees/first", base_tree: "1".repeat(40) },
        "second@1": { repository_id: "a".repeat(64), execution_root: "/worktrees/second", base_tree: "2".repeat(40) },
      },
      capacity: 8,
    });
    assert.deepEqual(distinctAllowedBase.frontier, ["first@1", "second@1"]);
  });

  it("waits for accepted integration and requires the successor root to inherit its result base", () => {
    const integration: GateVersion = {
      schema_version: 1, gate_key: "integrate", version: 1, type: "integration-acceptance",
      task_keys: ["task-successor"], depends_on: [],
    };
    const successor = unit("successor", 1, {
      worktree_mode: "isolated-worktree", integration_gate_keys: ["integrate@1"],
    });
    const acceptedFact = { kind: "integration-acceptance", gate_key: "integrate", gate_version: 1, state: "accepted", after_tree: "2".repeat(40) };
    const pending = deriveRollingSafeFrontier({
      accepted_deltas: [delta([successor], [integration])],
      execution_roots_by_unit: { "successor@1": { repository_id: "a".repeat(64), execution_root: "/worktrees/successor", base_tree: "1".repeat(40) } },
      capacity: 8,
    });
    const mismatched = deriveRollingSafeFrontier({
      accepted_deltas: [delta([successor], [integration])], runtime_facts: [acceptedFact],
      execution_roots_by_unit: { "successor@1": { repository_id: "a".repeat(64), execution_root: "/worktrees/successor", base_tree: "1".repeat(40) } },
      capacity: 8,
    });
    const inherited = deriveRollingSafeFrontier({
      accepted_deltas: [delta([successor], [integration])], runtime_facts: [acceptedFact],
      execution_roots_by_unit: { "successor@1": { repository_id: "a".repeat(64), execution_root: "/worktrees/successor", base_tree: "2".repeat(40) } },
      capacity: 8,
    });
    const oldBaseDisguisedAsResult = deriveRollingSafeFrontier({
      accepted_deltas: [delta([successor], [integration])],
      runtime_facts: [{ ...acceptedFact, after_tree: undefined, base_tree: "2".repeat(40) }],
      execution_roots_by_unit: { "successor@1": { repository_id: "a".repeat(64), execution_root: "/worktrees/successor", base_tree: "2".repeat(40) } },
      capacity: 8,
    });

    assert.equal(pending.blockers["successor@1"]?.[0]?.code, "INTEGRATION_NOT_ACCEPTED");
    assert.equal(mismatched.blockers["successor@1"]?.[0]?.code, "INTEGRATION_RESULT_BASE_MISMATCH");
    assert.deepEqual(inherited.frontier, ["successor@1"]);
    assert.equal(inherited.inherited_base_trees["successor@1"], "2".repeat(40));
    assert.equal(oldBaseDisguisedAsResult.blockers["successor@1"]?.[0]?.code, "INTEGRATION_RESULT_BASE_MISSING");
  });

  it("blocks a unit whose accepted integration gates expose conflicting result bases", () => {
    const gates: GateVersion[] = ["first", "second"].map((key) => ({
      schema_version: 1, gate_key: key, version: 1, type: "integration-acceptance",
      task_keys: ["task-successor"], depends_on: [],
    }));
    const successor = unit("successor", 1, {
      worktree_mode: "isolated-worktree",
      integration_gate_keys: ["first@1", "second@1"],
    });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([successor], gates)],
      runtime_facts: [
        { kind: "integration-acceptance", gate_key: "first", gate_version: 1, state: "accepted", after_tree: "2".repeat(40) },
        { kind: "integration-acceptance", gate_key: "second", gate_version: 1, state: "accepted", after_tree: "3".repeat(40) },
      ],
      capacity: 1,
    });
    assert.deepEqual(result.frontier, []);
    assert.equal(result.blockers["successor@1"]?.[0]?.code, "INTEGRATION_RESULT_BASE_CONFLICT");
    assert.equal(result.inherited_base_trees["successor@1"], "2".repeat(40));
  });

  it("automatically holds reserved and running attempt scopes", () => {
    const reserved = unit("reserved");
    const running = unit("running");
    const overlapReserved = unit("overlap-reserved", 1, { write_paths: ["src/reserved.ts"] });
    const overlapRunning = unit("overlap-running", 1, { write_paths: ["src/running.ts"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([reserved, running, overlapReserved, overlapRunning])],
      runtime_facts: [
        { kind: "reservation", owner_type: "attempt", owner_key: "reserved@1:attempt-1", unit_key: "reserved", unit_version: 1, state: "reserved" },
        { kind: "native-attempt", owner_type: "attempt", owner_key: "running@1:attempt-1", unit_key: "running", unit_version: 1, state: "running" },
      ],
      capacity: 8,
    });
    assert.equal(result.blockers["overlap-reserved@1"]?.[0]?.code, "WRITE_SCOPE_CONFLICT");
    assert.equal(result.blockers["overlap-running@1"]?.[0]?.code, "WRITE_SCOPE_CONFLICT");
  });

  it("does not let an attempt-1 release clear attempt-2 terminal ownership", () => {
    const held = unit("held");
    const overlap = unit("overlap", 1, { write_paths: ["src/held.ts"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([held, overlap])],
      runtime_facts: [
        { kind: "terminal-result", owner_type: "attempt", owner_key: "held@1:attempt-1", unit_key: "held", unit_version: 1, status: "succeeded" },
        { kind: "release", owner_type: "attempt", owner_key: "held@1:attempt-1", unit_key: "held", unit_version: 1, released: true },
        { kind: "terminal-result", owner_type: "attempt", owner_key: "held@1:attempt-2", unit_key: "held", unit_version: 1, status: "failed" },
      ],
      capacity: 8,
    });
    assert.equal(result.blockers["held@1"]?.[0]?.code, "TERMINAL_UNRELEASED");
    assert.equal(result.blockers["overlap@1"]?.[0]?.code, "WRITE_SCOPE_CONFLICT");
  });

  it("retains accepted state while terminal-unreleased ownership remains active", () => {
    const held = unit("held");
    const overlap = unit("overlap", 1, { write_paths: ["src/held.ts"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([held, overlap])],
      runtime_facts: [{ unit_key: "held", unit_version: 1, accepted: true, terminal_unreleased: true }],
      capacity: 8,
    });
    assert.equal(result.blockers["held@1"]?.[0]?.code, "TERMINAL_UNRELEASED");
    assert.equal(result.blockers["overlap@1"]?.[0]?.code, "WRITE_SCOPE_CONFLICT");
    assert.equal(result.frontier.includes("held@1"), false);
  });

  it("clears terminal ownership only for a matching release owner", () => {
    const held = unit("held");
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([held])],
      runtime_facts: [
        { kind: "terminal-result", owner_type: "attempt", owner_key: "held@1:attempt-1", unit_key: "held", unit_version: 1, status: "succeeded" },
        { kind: "release", owner_type: "attempt", owner_key: "held@1:attempt-1", unit_key: "held", unit_version: 1, released: true },
      ],
      capacity: 8,
    });
    assert.equal(Boolean(result.blockers["held@1"]?.some((item) => item.code === "TERMINAL_UNRELEASED")), false);
  });

  it("does not treat a succeeded terminal result and release as acceptance", () => {
    const completed = unit("completed");
    const downstream = unit("downstream", 1, { depends_on: ["completed@1"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([completed, downstream])],
      runtime_facts: [
        { kind: "terminal-result", owner_type: "attempt", owner_key: "completed@1:attempt-1", unit_key: "completed", status: "succeeded" },
        { kind: "release", owner_type: "attempt", owner_key: "completed@1:attempt-1", unit_key: "completed", released: true },
      ],
      capacity: 8,
    });
    assert.equal(result.blockers["downstream@1"]?.[0]?.code, "DEPENDENCY_NOT_ACCEPTED");
  });

  it("keeps accepted dependencies usable while a later attempt owns their scope", () => {
    const accepted = unit("accepted");
    const downstream = unit("downstream", 1, { depends_on: ["accepted@1"] });
    const overlap = unit("overlap", 1, { write_paths: ["src/accepted.ts"] });
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([accepted, downstream, overlap])],
      runtime_facts: [
        { unit_key: "accepted", unit_version: 1, accepted: true },
        { kind: "native-attempt", owner_type: "attempt", owner_key: "accepted@1:attempt-1", unit_key: "accepted", unit_version: 1, state: "running" },
      ],
      capacity: 8,
    });
    assert.equal(result.frontier.includes("downstream@1"), true);
    assert.equal(result.frontier.includes("accepted@1"), false);
    assert.equal(result.blockers["accepted@1"]?.[0]?.code, "UNIT_NOT_DISPATCHABLE");
    assert.equal(result.blockers["overlap@1"]?.[0]?.code, "WRITE_SCOPE_CONFLICT");
  });

  it("matches configured route bases before the final @ suffix", () => {
    const candidate = unit("model");
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([candidate])],
      route_facts: [route("alpha/model@high")],
      configured_routes: ["alpha/model"],
      capacity: 1,
    });
    assert.equal(result.selected_routes["model@1"], "alpha/model@high");
  });

  it("uses stable order for capacity and returns only canonical result fields", () => {
    const later = unit("later");
    const first = unit("first");
    const result = deriveRollingSafeFrontier({
      accepted_deltas: [delta([later, first])],
      stable_order: ["later@1", "first@1"],
      capacity: 1,
    });
    assert.deepEqual(result.known_unit_versions, ["later@1", "first@1"]);
    assert.deepEqual(result.eligible, ["later@1", "first@1"]);
    assert.deepEqual(result.frontier, ["later@1"]);
    for (const key of ["safe_frontier", "selected", "selected_unit_versions", "selected_route_ids", "routes", "unit_blockers"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(result, key), false);
    }
  });
});
