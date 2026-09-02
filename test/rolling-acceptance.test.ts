import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROLLING_ACCEPTANCE_SCHEMA_VERSION,
  RollingAcceptanceError,
  deriveRollingAcceptance,
  evaluateRollingGateVersion,
  fingerprintRollingExecutionFact,
  normalizeRollingExecutionFact,
  reduceRollingUnitVersion,
  type RollingExecutionFact,
} from "../src/lib/rolling/acceptance.js";
import { fingerprintGateVersion, fingerprintUnitVersion, type GateVersion, type UnitVersion } from "../src/lib/rolling-plan.js";

const stamp = "2026-01-01T00:00:00.000Z";
function unit(key: string, version = 1): UnitVersion { return { schema_version: 1, unit_key: key, version, task_keys: [`task-${key}`], depends_on: [], execution_mode: "patch-only", write_paths: [`src/${key}.ts`], allowed_operations: ["write"], completion_criteria: ["done"], permitted_validation: ["test"] }; }
function gate(key: string, type: GateVersion["type"], depends_on: string[] = []): GateVersion { return { schema_version: 1, gate_key: key, version: 1, type, task_keys: [`task-${key}`], depends_on, acceptance_contract: { required: true } }; }
function raw(kind: string, extra: Record<string, unknown>, u?: UnitVersion, g?: GateVersion): Record<string, unknown> {
  if (g) return { schema_version: 1, kind, gate_key: g.gate_key, gate_version: g.version, gate_fingerprint: fingerprintGateVersion(g), owner_type: "gate_version", owner_key: `${g.gate_key}@${g.version}`, recorded_at: stamp, ...extra };
  const version = u || unit("u"); return { schema_version: 1, kind, unit_key: version.unit_key, unit_version: version.version, unit_fingerprint: fingerprintUnitVersion(version), owner_type: kind === "safety-verdict" || kind === "parent-acceptance" || kind === "plan-insufficient" ? "unit_version" : "attempt", owner_key: kind === "safety-verdict" || kind === "parent-acceptance" || kind === "plan-insufficient" ? `${version.unit_key}@${version.version}` : `${version.unit_key}@${version.version}:attempt-1`, recorded_at: stamp, ...extra };
}
function attemptRaw(kind: string, extra: Record<string, unknown>, u: UnitVersion, attempt: number): Record<string, unknown> {
  return raw(kind, { attempt, owner_key: `${u.unit_key}@${u.version}:attempt-${attempt}`, ...extra }, u);
}
function facts(items: Record<string, unknown>[]): RollingExecutionFact[] { return items.map(normalizeRollingExecutionFact); }
function success(u = unit("u")): RollingExecutionFact[] { return facts([
  raw("reservation", { reservation_id: "r1", state: "reserved" }, u),
  raw("native-attempt", { state: "running" }, u),
  raw("terminal-result", { status: "completed", result: "ok" }, u),
  raw("safety-verdict", { accepted: true, violations: [] }, u),
  raw("parent-acceptance", { accepted: true, evidence: "reviewed" }, u),
  raw("release", { released: true }, u),
]); }

describe("rolling execution acceptance", () => {
  it("rejects unknown fields and malformed owner combinations", () => {
    assert.throws(() => normalizeRollingExecutionFact(raw("release", { released: true, extra: true })), RollingAcceptanceError);
    const g = gate("g", "evidence");
    assert.throws(() => normalizeRollingExecutionFact({ ...raw("gate-acceptance", { accepted: true }, undefined, g), owner_type: "attempt" }), RollingAcceptanceError);
  });

  it("normalizes the exact discriminated shape and fingerprints deterministically", () => {
    const u = unit("u"); const normalized = normalizeRollingExecutionFact(raw("release", { released: true }, u));
    assert.equal(normalized.schema_version, ROLLING_ACCEPTANCE_SCHEMA_VERSION);
    assert.equal(normalized.kind, "release"); assert.equal(normalized.owner_type, "attempt");
    assert.equal(normalized.fingerprint, fingerprintRollingExecutionFact(normalized));
    const reordered = normalizeRollingExecutionFact(Object.fromEntries(Object.entries(raw("release", { released: true }, u)).reverse()));
    assert.equal(normalized.fingerprint, reordered.fingerprint);
  });

  it("derives queued, reserved, running, terminal-unreleased, failed, accepted, and released projections", () => {
    const u = unit("u");
    assert.equal(reduceRollingUnitVersion(u, []).state, "queued");
    assert.equal(reduceRollingUnitVersion(u, [facts([raw("reservation", { reservation_id: "r", state: "reserved" }, u)])[0]!]).state, "reserved");
    assert.equal(reduceRollingUnitVersion(u, [facts([raw("native-attempt", { state: "running" }, u)])[0]!]).state, "running");
    const terminal = facts([raw("terminal-result", { status: "completed" }, u)]);
    assert.equal(reduceRollingUnitVersion(u, terminal).state, "terminal-unreleased");
    assert.equal(reduceRollingUnitVersion(u, facts([raw("terminal-result", { status: "errored" }, u)])).state, "failed");
    const accepted = reduceRollingUnitVersion(u, success(u)); assert.equal(accepted.state, "accepted"); assert.equal(accepted.accepted, true); assert.equal(accepted.released, true);
    const releasedOnly = reduceRollingUnitVersion(u, facts([raw("release", { released: true }, u)])); assert.equal(releasedOnly.state, "released"); assert.equal(releasedOnly.accepted, false);
  });

  it("keeps route and native retries on one unit version and signals plan insufficiency", () => {
    const u = unit("u"); const retry = facts([raw("retry", { retry_kind: "route", retry_of: "u@1:attempt-1" }, u), raw("native-attempt", { state: "running" }, u)]);
    const state = reduceRollingUnitVersion(u, retry); assert.equal(state.version, 1); assert.equal(state.running, true);
    const insufficient = reduceRollingUnitVersion(u, facts([raw("plan-insufficient", { file: "a.ts", symbol: "compile", missing_decision: "choose owner" }, u)]));
    assert.equal(insufficient.failed, true); assert.equal(insufficient.requires_successor_version, true);
  });

  it("requires accepted dependencies and explicit parent gate acceptance for each gate type", () => {
    for (const type of ["safety-precondition", "integration-acceptance", "evidence"] as const) {
      const u = unit(`${type}-u`); const g = gate(`${type}-g`, type, ["dep@1"]);
      const pending = evaluateRollingGateVersion(g, { units: [u], gates: [g], facts: [] }); assert.equal(pending.accepted, false); assert.equal(pending.blockers[0]?.code, "UNKNOWN_DEPENDENCY");
      const dep = unit("dep"); const accepted = evaluateRollingGateVersion(g, { units: [dep], gates: [g], facts: success(dep) }); assert.equal(accepted.state, "ready");
      const final = evaluateRollingGateVersion(g, { units: [dep], gates: [g], facts: [...success(dep), ...facts([raw("gate-acceptance", { accepted: true }, undefined, g)])] }); assert.equal(final.state, "accepted");
    }
  });

  it("isolates explicit dependencies and unrelated evidence", () => {
    const dep = unit("dep"); const other = gate("other", "evidence"); const target = gate("target", "integration-acceptance", ["dep@1"]);
    const report = deriveRollingAcceptance({ units: [dep], gates: [other, target], facts: [...success(dep), ...facts([raw("gate-acceptance", { accepted: true }, undefined, other)])] });
    assert.equal(report.units["dep@1"]?.accepted, true); assert.equal(report.gates["target@1"]?.state, "ready"); assert.equal(report.implicit_run_wide_barrier, false);
  });

  it("resolves a stable dependency to its highest unit version without inheriting predecessor acceptance", () => {
    const predecessor = unit("dep", 1); const current = unit("dep", 2); const target = gate("target", "integration-acceptance", ["dep"]);
    const predecessorOnly = evaluateRollingGateVersion(target, { units: [predecessor, current], gates: [target], facts: success(predecessor) });
    assert.equal(predecessorOnly.state, "pending");
    assert.equal(predecessorOnly.dependency_states.dep, "queued");
    assert.ok(predecessorOnly.blockers.some((item) => item.code === "DEPENDENCY_NOT_ACCEPTED" && item.refs?.includes("dep@2")));
    const currentAccepted = evaluateRollingGateVersion(target, { units: [predecessor, current], gates: [target], facts: [...success(predecessor), ...success(current)] });
    assert.equal(currentAccepted.state, "ready");
  });

  it("keeps accepted state monotonic after a later failed retry and sorts maps/blockers", () => {
    const u = unit("u"); const later = facts([raw("retry", { retry_kind: "native", retry_of: "u@1:attempt-1" }, u), raw("terminal-result", { status: "errored" }, u)]);
    const state = reduceRollingUnitVersion(u, [...success(u), ...later]); assert.equal(state.accepted, true); assert.equal(state.state, "accepted");
    const report = deriveRollingAcceptance({ units: [unit("z"), unit("a")], facts: [] }); assert.deepEqual(Object.keys(report.units), ["a@1", "z@1"]);
  });

  it("orders facts by timestamp instant before fact identity", () => {
    const u = unit("u");
    const earlier = attemptRaw("terminal-result", { status: "errored", recorded_at: "2026-01-01T01:00:00+02:00" }, u, 1);
    const later = attemptRaw("terminal-result", { status: "errored", recorded_at: "2026-01-01T00:30:00Z" }, u, 2);
    const state = reduceRollingUnitVersion(u, facts([later, earlier]));
    assert.ok(state.blockers.some((item) => item.code === "TERMINAL_RESULT_FAILED" && item.owner_key === "u@1:attempt-2"));
  });

  it("terminates self-referential gate evaluation with a cycle blocker", () => {
    const cyclic = gate("cycle", "integration-acceptance", ["cycle@1"]);
    const state = evaluateRollingGateVersion(cyclic, { gates: [cyclic], facts: [] });
    assert.equal(state.state, "pending");
    assert.ok(state.blockers.some((item) => item.code === "DEPENDENCY_CYCLE"));
  });

  it("keeps terminal and release ownership local to each attempt", () => {
    const u = unit("u");
    const attemptOne = facts([
      attemptRaw("terminal-result", { status: "errored" }, u, 1),
      attemptRaw("release", { released: true }, u, 1),
    ]);
    const attemptTwo = facts([attemptRaw("terminal-result", { status: "completed", result: "ok" }, u, 2)]);
    const safetyAndParent = facts([
      raw("safety-verdict", { accepted: true, violations: [] }, u),
      raw("parent-acceptance", { accepted: true, evidence: "reviewed" }, u),
    ]);
    const held = reduceRollingUnitVersion(u, [...attemptOne, ...attemptTwo, ...safetyAndParent]);
    assert.equal(held.accepted, false);
    assert.equal(held.released, true);
    assert.equal(held.terminal_unreleased, true);
    assert.equal(held.state, "terminal-unreleased");
    assert.ok(held.blockers.some((item) => item.code === "TERMINAL_UNRELEASED" && item.owner_key === "u@1:attempt-2"));

    const released = reduceRollingUnitVersion(u, [...attemptOne, ...attemptTwo, ...safetyAndParent, ...facts([attemptRaw("release", { released: true }, u, 2)])]);
    assert.equal(released.accepted, true);
    assert.equal(released.terminal_unreleased, false);
  });

  it("rejects retry lineage from another unit even when its version matches", () => {
    const u = unit("u");
    const state = reduceRollingUnitVersion(u, facts([raw("retry", { retry_kind: "native", retry_of: "other@1:attempt-1" }, u)]));
    assert.ok(state.blockers.some((item) => item.code === "RETRY_UNIT_VERSION_MISMATCH"));
  });

  it("preserves accepted state while a later attempt retains ownership", () => {
    const u = unit("u");
    const later = facts([attemptRaw("terminal-result", { status: "errored" }, u, 2)]);
    const state = reduceRollingUnitVersion(u, [...success(u), ...later]);
    assert.equal(state.accepted, true);
    assert.equal(state.state, "accepted");
    assert.equal(state.terminal_unreleased, true);
    assert.ok(state.blockers.some((item) => item.code === "TERMINAL_UNRELEASED" && item.owner_key === "u@1:attempt-2"));
  });
});
