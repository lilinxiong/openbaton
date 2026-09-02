import { strict as assert } from "node:assert";
import { describe, it } from "bun:test";
import {
  RollingInputError,
  captureGateLocalInputs,
  captureUnitLocalInputs,
  fingerprintLocalInputs,
} from "../src/lib/rolling-inputs.ts";

const root = "/virtual/rolling-inputs";

interface FixtureState {
  files: Record<string, string>;
  source: Record<string, unknown>;
  repository: Record<string, unknown>;
  dependencies: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

function fixture(): FixtureState {
  return {
    files: {
      [`${root}/src/a.ts`]: "a-v1\n",
      [`${root}/src/b.ts`]: "b-v1\n",
      [`${root}/openspec/proposal.md`]: "proposal-v1\n",
    },
    source: {
      selected_tasks: ["3.2", "3.3"],
      context_files: { proposal: "proposal-v1", design: "design-v1" },
      append_sequence: 1,
    },
    repository: { head: "head-v1", staged_tree: "tree-v1", append_sequence: 1 },
    dependencies: {
      "unit-a\0result": { fingerprint: "result-a-v1", payload: "not part of the identity" },
      "unit-unrelated\0result": { fingerprint: "result-other-v1" },
    },
    evidence: { build: { fingerprint: "build-v1", append_sequence: 4 }, unrelated: "other-v1" },
  };
}

function request(state: FixtureState, owner: string, inputs: readonly Record<string, unknown>[]) {
  return {
    repoRoot: root,
    ownerKey: owner,
    inputs,
    sourceFacts: state.source,
    repositoryFacts: state.repository,
    dependencyResults: state.dependencies,
    evidenceInputs: state.evidence,
    lstat: async (absolutePath: string) => state.files[absolutePath] === undefined
      ? { kind: "missing" as const, exists: false }
      : { kind: "file" as const, mode: 0o644, size: Buffer.byteLength(state.files[absolutePath]!) },
    readBytes: async (absolutePath: string) => Buffer.from(state.files[absolutePath] || ""),
  };
}

describe("rolling local input capture", () => {
  it("captures only declared paths and exposes stable, auditable components", async () => {
    const state = fixture();
    const reads: string[] = [];
    const value = await captureUnitLocalInputs({
      ...request(state, "unit-a", [
        { label: "source-head", kind: "repository-fact", selector: "head" },
        { label: "input", kind: "repository-path", path: "src/a.ts" },
      ]),
      lstat: async (absolutePath: string) => {
        reads.push(`stat:${absolutePath}`);
        return state.files[absolutePath] === undefined
          ? { kind: "missing" as const, exists: false }
          : { kind: "file" as const, mode: 0o644, size: Buffer.byteLength(state.files[absolutePath]!) };
      },
      readBytes: async (absolutePath: string) => {
        reads.push(`read:${absolutePath}`);
        return Buffer.from(state.files[absolutePath] || "");
      },
    });
    assert.deepEqual(reads, [`stat:${root}/src/a.ts`, `read:${root}/src/a.ts`]);
    assert.equal(value.owner_kind, "unit");
    assert.equal(value.owner_key, "unit-a");
    assert.deepEqual(value.components.map((item) => item.label), ["input", "source-head"]);
    assert.equal(value.components[1]?.value, "head-v1");
    assert.equal(value.components, value.fingerprint_components);
    assert.equal(value.component_fingerprints.input, value.components[0]?.fingerprint);
    assert.match(value.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(value.fingerprint, fingerprintLocalInputs(value));
  });

  it("canonicalizes declaration order and ignores unrelated tasks, context, append, and predecessor output", async () => {
    const state = fixture();
    const first = await captureUnitLocalInputs(request(state, "unit-a", [
      { label: "source-head", kind: "repository-fact", selector: "head" },
      { label: "input", kind: "path", path: "src/a.ts" },
      { label: "predecessor", kind: "dependency-result", unitId: "unit-a", factId: "result" },
    ]));
    state.source.selected_tasks = ["3.2", "3.3", "9.9"];
    state.source.context_files = { proposal: "proposal-v2", design: "design-v2", unrelated: "new" };
    state.source.append_sequence = 99;
    state.dependencies["unit-unrelated\0result"] = { fingerprint: "result-other-v2", payload: "changed" };
    state.dependencies["unit-a\0result"] = { fingerprint: "result-a-v1", payload: "changed" };
    const second = await captureUnitLocalInputs(request(state, "unit-a", [
      { label: "predecessor", kind: "dependency-result", unitId: "unit-a", factId: "result" },
      { label: "input", kind: "path", path: "./src/a.ts" },
      { label: "source-head", kind: "repository-fact", selector: "head" },
    ]));
    assert.equal(second.fingerprint, first.fingerprint);
    assert.deepEqual(second.components, first.components);
  });

  it("changes only the owner that declares a changed input", async () => {
    const state = fixture();
    const unitARequest = request(state, "unit-a", [{ label: "input", kind: "path", path: "src/a.ts" }]);
    const unitBRequest = request(state, "unit-b", [{ label: "input", kind: "path", path: "src/b.ts" }]);
    const beforeA = await captureUnitLocalInputs(unitARequest);
    const beforeB = await captureUnitLocalInputs(unitBRequest);
    state.files[`${root}/src/a.ts`] = "a-v2\n";
    const afterA = await captureUnitLocalInputs(unitARequest);
    const afterB = await captureUnitLocalInputs(unitBRequest);
    assert.notEqual(afterA.fingerprint, beforeA.fingerprint);
    assert.equal(afterB.fingerprint, beforeB.fingerprint);

    state.evidence.build = { fingerprint: "build-v2", append_sequence: 8 };
    const gateBefore = await captureGateLocalInputs({
      ...request(state, "gate-a", [{ label: "build", kind: "evidence", selector: "build" }]),
      owner_kind: "gate",
    });
    state.evidence.build = { fingerprint: "build-v3", append_sequence: 9 };
    const gateAfter = await captureGateLocalInputs({
      ...request(state, "gate-a", [{ label: "build", kind: "evidence", selector: "build" }]),
      owner_kind: "gate",
    });
    assert.notEqual(gateAfter.fingerprint, gateBefore.fingerprint);
    assert.equal(afterB.fingerprint, beforeB.fingerprint);
  });

  it("rejects unsafe paths and duplicate labels or identities", async () => {
    const state = fixture();
    await assert.rejects(
      captureUnitLocalInputs(request(state, "unit-a", [{ label: "escape", kind: "path", path: "../outside" }])),
      (error: unknown) => error instanceof RollingInputError && error.code === "ROLLING_INPUT_PATH_INVALID",
    );
    await assert.rejects(
      captureUnitLocalInputs(request(state, "unit-a", [
        { label: "same", kind: "path", path: "src/a.ts" },
        { label: "same", kind: "path", path: "src/b.ts" },
      ])),
      (error: unknown) => error instanceof RollingInputError && error.code === "ROLLING_INPUT_DUPLICATE",
    );
    await assert.rejects(
      captureUnitLocalInputs(request(state, "unit-a", [
        { label: "one", kind: "path", path: "src/a.ts" },
        { label: "two", kind: "path", path: "./src/a.ts" },
      ])),
      (error: unknown) => error instanceof RollingInputError && error.code === "ROLLING_INPUT_DUPLICATE",
    );
  });

  it("uses predecessor result identities and never reads their output bytes", async () => {
    const state = fixture();
    const calls: string[] = [];
    const result = await captureUnitLocalInputs({
      ...request(state, "unit-b", [{ label: "upstream", kind: "predecessor", unitId: "unit-a", factId: "result" }]),
      readBytes: async (absolutePath: string) => {
        calls.push(absolutePath);
        return Buffer.from("should not be read");
      },
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(result.components[0]?.value, {
      unit_id: "unit-a",
      fact_id: "result",
      fingerprint: "result-a-v1",
    });

    const applySourceStyle = await captureUnitLocalInputs({
      ...request(state, "unit-b", [{
        label: "upstream-again",
        path: "src/generated.ts",
        origin: "predecessor-produced",
        predecessor_unit_id: "unit-a",
        predecessor_fact_id: "result",
        predecessor_fingerprint: "result-a-v1",
      }]),
    });
    assert.equal(applySourceStyle.components[0]?.kind, "dependency-result");
  });

  it("accepts inline source and evidence identities without a broad container", async () => {
    const value = await captureGateLocalInputs({
      repoRoot: root,
      gateKey: "gate-inline",
      inputs: [
        { label: "source", kind: "source-fact", fingerprint: "source-v1" },
        { label: "evidence", kind: "evidence", value: "evidence-v1" },
      ],
    });
    assert.equal(value.components[0]?.value, "evidence-v1");
    assert.equal(value.components[1]?.value, "source-v1");
  });

  it("rejects non-plain object values instead of collapsing them to empty objects", async () => {
    for (const value of [new Date("2026-01-01T00:00:00.000Z"), new Map([["key", "value"]]), new Set(["value"])]) {
      await assert.rejects(
        captureUnitLocalInputs({
          repoRoot: root,
          ownerKey: "unit-non-json",
          inputs: [{ label: "bad", kind: "source-fact", value }],
        }),
        (error: unknown) => error instanceof RollingInputError && error.code === "ROLLING_INPUT_VALUE_INVALID",
      );
    }
  });
});
