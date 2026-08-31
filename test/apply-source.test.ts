import { strict as assert } from "node:assert";
import { describe, it } from "bun:test";
import {
  APPLY_PLAN_STALE,
  GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
  acceptCompiledApplySource,
  captureCompiledApplySourceFacts,
  type ApplySourceAcceptanceOptions,
  type ApplySourceOpenSpecIdentity,
} from "../src/lib/apply-source.ts";

const root = "/virtual/apply-source";

function openSpec(overrides: Partial<ApplySourceOpenSpecIdentity> = {}): ApplySourceOpenSpecIdentity {
  return {
    contextFiles: [{ artifact: "proposal", path: `${root}/openspec/proposal.md`, sha256: "proposal-v1" }],
    contextFileHashes: { [`${root}/openspec/proposal.md`]: "proposal-v1" },
    selectedTaskSnapshotFingerprint: "tasks-v1",
    selectedTaskNumbers: ["2.3", "2.4"],
    taskLedger: { path: `${root}/openspec/tasks.md`, identity: "tasks-ledger", sha256: "tasks-v1" },
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  const files: Record<string, Buffer> = {
    [`${root}/src/input.ts`]: Buffer.from("input-v1\n"),
    [`${root}/src/output.ts`]: Buffer.from("output-before\n"),
  };
  let head = "head-v1";
  let indexChecksum = "index-v1";
  let unrelated = "unrelated-v1";
  const base = {
    repoRoot: root,
    openSpec: openSpec(),
    units: [
      { id: "unit-a", readPaths: ["src/input.ts"], writePaths: ["src/output.ts"] },
    ],
    captureGitFacts: () => ({
      head,
      branchRef: "refs/heads/main",
      stagedTree: "tree-v1",
      indexControl: {
        algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
        checksum: indexChecksum,
        entryCount: 2,
      },
    }),
    readOpenSpec: () => openSpec(),
    lstat: async (absolutePath: string) => files[absolutePath]
      ? { kind: "file", mode: 0o644, size: files[absolutePath].byteLength }
      : { kind: "missing", exists: false },
    readBytes: async (absolutePath: string) => files[absolutePath] || Buffer.from(""),
    // This value deliberately changes outside the declared input set.
    get unrelated() { return unrelated; },
    mutateUnrelated(value: string) { unrelated = value; },
    mutateHead(value: string) { head = value; },
    mutateIndex(value: string) { indexChecksum = value; },
    ...overrides,
  } as ApplySourceAcceptanceOptions<unknown> & {
    mutateUnrelated: (value: string) => void;
    mutateHead: (value: string) => void;
    mutateIndex: (value: string) => void;
  };
  return base;
}

describe("compiled apply source observations", () => {
  it("captures a stable clean source with only declared input facts", async () => {
    const source = await captureCompiledApplySourceFacts(request());
    assert.equal(source.schema_version, 1);
    assert.equal(source.repository.head, "head-v1");
    assert.equal(source.repository.index_control.algorithm, GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM);
    assert.equal(source.repository.index_control.entryCount, 2);
    assert.equal(source.units.length, 1);
    assert.equal(source.units[0]?.inputs.length, 2);
    assert.match(source.units[0]?.inputs[0]?.origin || "", /existing/);
    assert.match(source.fingerprint, /^[0-9a-f]{64}$/);
  });

  it("retains the kind role alias instead of replacing it with the default role", async () => {
    const source = await captureCompiledApplySourceFacts(request({
      units: [{ id: "unit-kind", inputs: [{ path: "src/input.ts", kind: "write" }] }],
    }));
    assert.deepEqual(source.units[0]?.inputs[0]?.roles, ["write"]);
  });

  it("captures task-ledger bytes when only tasks_path declares the ledger", async () => {
    const ledgerPath = `${root}/openspec/tasks.md`;
    const ledger = "## Work\n\n- [ ] 2.3 Capture ledger\n";
    const source = await captureCompiledApplySourceFacts(request({
      openSpec: {
        contextFiles: [],
        contextFileHashes: {},
        selectedTaskNumbers: ["2.3"],
        tasks_path: ledgerPath,
      },
      readOpenSpec: undefined,
      readBytes: async (absolutePath: string) => absolutePath === ledgerPath ? Buffer.from(ledger) : Buffer.from("input-v1\n"),
    }));
    assert.equal(source.open_spec.task_ledger?.path, ledgerPath);
    assert.equal(source.open_spec.task_ledger?.sha256, "32488cbfc645fa331156f5958529b472cc580f1236e74fb64f1d56f51a3d16ed");
    assert.deepEqual(source.open_spec.selected_task_numbers, ["2.3"]);
    assert.equal(source.open_spec.selected_task_snapshot_fingerprint, "eee22449757cfcfd046d63901dcc15895c4d4b6598dbf7661fdea7e9fb637e7b");
  });

  it("detects OpenSpec context and selected-task identity changes", async () => {
    const state = request();
    const baseline = await captureCompiledApplySourceFacts(state);
    let changed = false;
    state.readOpenSpec = () => changed
      ? openSpec({ contextFileHashes: { [`${root}/openspec/proposal.md`]: "proposal-v2" } })
      : openSpec();
    changed = true;
    await assert.rejects(
      acceptCompiledApplySource({ ...state, expected: baseline, validate: () => undefined, persist: () => undefined }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === APPLY_PLAN_STALE,
    );

    const taskState = request();
    const taskBaseline = await captureCompiledApplySourceFacts(taskState);
    let taskChanged = false;
    taskState.readOpenSpec = () => taskChanged ? openSpec({ selectedTaskNumbers: ["2.3"] }) : openSpec();
    taskChanged = true;
    await assert.rejects(
      acceptCompiledApplySource({ ...taskState, expected: taskBaseline, validate: () => undefined, persist: () => undefined }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === APPLY_PLAN_STALE,
    );
  });

  it("ignores unrelated worktree changes", async () => {
    const state = request();
    const before = await captureCompiledApplySourceFacts(state);
    state.mutateUnrelated("unrelated-v2");
    const after = await captureCompiledApplySourceFacts(state);
    assert.deepEqual(after, before);
  });

  it("detects a relevant declared input byte or metadata change", async () => {
    const state = request();
    const baseline = await captureCompiledApplySourceFacts(state);
    (state.readBytes as NonNullable<typeof state.readBytes>) = async (absolutePath: string) =>
      absolutePath.endsWith("input.ts") ? Buffer.from("input-v2\n") : Buffer.from("output-before\n");
    await assert.rejects(
      acceptCompiledApplySource({ ...state, expected: baseline, validate: () => undefined, persist: () => undefined }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === APPLY_PLAN_STALE,
    );
  });

  it("keeps predecessor-produced inputs explicit and validates accepted predecessor facts", async () => {
    const state = request({
      units: [{
        id: "unit-b",
        inputs: [{
          path: "src/generated.ts",
          origin: "predecessor-produced",
          predecessor_unit_id: "unit-a",
          predecessor_fact_id: "output",
          predecessor_fingerprint: "accepted-v1",
        }],
      }],
      acceptedPredecessorFacts: [{ unit_id: "unit-a", fact_id: "output", fingerprint: "accepted-v1" }],
    });
    const source = await captureCompiledApplySourceFacts(state);
    const input = source.units[0]?.inputs[0];
    assert.equal(input?.origin, "predecessor-produced");
    assert.equal("sha256" in (input || {}), false);
    assert.equal((input as any)?.predecessor?.fingerprint, "accepted-v1");
    // Changing bytes at the eventual output path is irrelevant: it is not read.
    state.readBytes = async () => Buffer.from("a different file");
    const same = await captureCompiledApplySourceFacts(state);
    assert.deepEqual(same, source);

    const changed = request({
      units: [{
        id: "unit-b",
        inputs: [{ path: "src/generated.ts", origin: "predecessor-produced", predecessor_unit_id: "unit-a", predecessor_fact_id: "output", predecessor_fingerprint: "accepted-v1" }],
      }],
      acceptedPredecessorFacts: [{ unit_id: "unit-a", fact_id: "output", fingerprint: "accepted-v2" }],
    });
    const predecessorBaseline = await captureCompiledApplySourceFacts({
      ...changed,
      acceptedPredecessorFacts: [{ unit_id: "unit-a", fact_id: "output", fingerprint: "accepted-v1" }],
    });
    await assert.rejects(
      acceptCompiledApplySource({ ...changed, expected: predecessorBaseline, validate: () => undefined, persist: () => undefined }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === APPLY_PLAN_STALE,
    );
  });

  it("rejects HEAD and index-control changes", async () => {
    const state = request();
    const baseline = await captureCompiledApplySourceFacts(state);
    state.mutateHead("head-v2");
    await assert.rejects(
      acceptCompiledApplySource({ ...state, expected: baseline, validate: () => undefined, persist: () => undefined }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === APPLY_PLAN_STALE,
    );

    const indexState = request();
    const indexBaseline = await captureCompiledApplySourceFacts(indexState);
    indexState.mutateIndex("index-v2");
    await assert.rejects(
      acceptCompiledApplySource({ ...indexState, expected: indexBaseline, validate: () => undefined, persist: () => undefined }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === APPLY_PLAN_STALE,
    );
  });

  it("observes immediately after validation and never persists a stale source", async () => {
    const state = request();
    const baseline = await captureCompiledApplySourceFacts(state);
    let persistenceCalls = 0;
    await assert.rejects(
      acceptCompiledApplySource({
        ...state,
        expected: baseline,
        validate: () => { state.mutateHead("head-after-validation"); },
        persist: () => { persistenceCalls += 1; },
      }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === APPLY_PLAN_STALE,
    );
    assert.equal(persistenceCalls, 0);
  });

  it("retains large streamed index metadata without buffering Git output", async () => {
    const state = request({
      captureGitFacts: () => ({
        head: "large-head",
        stagedTree: "large-tree",
        indexControl: {
          algorithm: GIT_INDEX_CONTROL_FINGERPRINT_ALGORITHM,
          checksum: "a".repeat(64),
          entryCount: 212843,
        },
      }),
    });
    const source = await captureCompiledApplySourceFacts(state);
    assert.equal(source.repository.index_control.entryCount, 212843);
    assert.equal(source.repository.index_control.checksum, "a".repeat(64));
  });
});
