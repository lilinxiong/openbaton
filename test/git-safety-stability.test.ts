import { strict as assert } from "node:assert";
import { describe, it } from "bun:test";
import {
  captureStableSafetyFacts,
  deriveGitSafetyStabilityToken,
  type GitSafetyFacts,
  type GitSafetyStabilityToken,
} from "../src/lib/git-safety-facts.ts";
import { GitSafetyError } from "../src/lib/git-safety-process.ts";

function facts(): GitSafetyFacts {
  return {
    head: "a".repeat(40), branch: "main", branchRef: "refs/heads/main",
    refs: ["refs/heads/main\0" + "a".repeat(40)],
    reflog: { count: 2, checksum: "b".repeat(64) }, stagedTree: "c".repeat(40),
    stagedPaths: ["file"], dirtyEntries: [], untrackedExists: false,
    modeChangedPaths: new Set(),
    indexControl: { algorithm: "git-index-control-framed-sha256-v2", checksum: "d".repeat(64), entryCount: 1 },
  };
}

describe("stable Git safety observations", () => {
  it("accepts a complete pass whose fresh token is equal", async () => {
    const input = facts();
    let factsCalls = 0;
    let tokenCalls = 0;
    const result = await captureStableSafetyFacts("/repo", {
      collectFacts: async () => { factsCalls += 1; return input; },
      collectToken: async () => { tokenCalls += 1; return deriveGitSafetyStabilityToken(input); },
    });
    assert.deepEqual(result, { ...input, stabilityToken: deriveGitSafetyStabilityToken(input) });
    assert.deepEqual(result.stabilityToken, deriveGitSafetyStabilityToken(input));
    assert.equal(factsCalls, 1);
    assert.equal(tokenCalls, 1);
  });

  it("retries with a second complete facts pass after the first race", async () => {
    const first = facts();
    const second = facts();
    second.head = "e".repeat(40);
    const secondToken = deriveGitSafetyStabilityToken(second);
    let factsCalls = 0;
    let tokenCalls = 0;
    const result = await captureStableSafetyFacts("/repo", {
      collectFacts: async () => (++factsCalls === 1 ? first : second),
      collectToken: async () => (++tokenCalls === 1
        ? { ...deriveGitSafetyStabilityToken(first), stagedTree: "f".repeat(40) }
        : secondToken),
    });
    assert.equal(factsCalls, 2);
    assert.equal(tokenCalls, 2);
    assert.equal(result.head, second.head);
    assert.deepEqual(result.stabilityToken, secondToken);
  });

  for (const field of [
    "head", "branchRef", "refsDigest", "reflog.count", "reflog.checksum", "stagedTree",
    "indexControl.algorithm", "indexControl.checksum", "indexControl.entryCount",
  ] as const) {
    it(`detects a changed ${field} token field`, async () => {
      const input = facts();
      const token = deriveGitSafetyStabilityToken(input);
      const raced = structuredClone(token) as GitSafetyStabilityToken;
      switch (field) {
        case "head": raced.head = "f".repeat(40); break;
        case "branchRef": raced.branchRef = "refs/heads/other"; break;
        case "refsDigest": raced.refsDigest = "f".repeat(64); break;
        case "reflog.count": raced.reflog.count += 1; break;
        case "reflog.checksum": raced.reflog.checksum = "f".repeat(64); break;
        case "stagedTree": raced.stagedTree = "f".repeat(40); break;
        case "indexControl.algorithm": raced.indexControl.algorithm = "legacy-json-sorted-v1"; break;
        case "indexControl.checksum": raced.indexControl.checksum = "f".repeat(64); break;
        case "indexControl.entryCount": raced.indexControl.entryCount += 1; break;
      }
      await assert.rejects(
        captureStableSafetyFacts("/repo", { purpose: "audit", collectFacts: async () => input, collectToken: async () => raced }),
        (error: unknown) => error instanceof GitSafetyError && error.code === "GIT_AUDIT_RACED",
      );
    });
  }

  for (const purpose of ["baseline", "audit"] as const) {
    it(`reports a persistent ${purpose} race after exactly two complete passes`, async () => {
      const input = facts();
      const raced = deriveGitSafetyStabilityToken(input);
      raced.refsDigest = "f".repeat(64);
      let factsCalls = 0;
      let tokenCalls = 0;
      await assert.rejects(
        captureStableSafetyFacts("/repo", {
          purpose,
          collectFacts: async () => { factsCalls += 1; return input; },
          collectToken: async () => { tokenCalls += 1; return raced; },
        }),
        (error: unknown) => error instanceof GitSafetyError && error.code === (purpose === "baseline" ? "GIT_BASELINE_RACED" : "GIT_AUDIT_RACED"),
      );
      assert.equal(factsCalls, 2);
      assert.equal(tokenCalls, 2);
    });
  }

  it("passes through a collectFacts failure without retry", async () => {
    let factsCalls = 0;
    const failure = new GitSafetyError({ command: "git rev-parse HEAD", message: "failed" });
    await assert.rejects(
      captureStableSafetyFacts("/repo", {
        collectFacts: async () => { factsCalls += 1; throw failure; },
        collectToken: async () => deriveGitSafetyStabilityToken(facts()),
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(factsCalls, 1);
  });

  it("passes through a collectToken failure without retry", async () => {
    let factsCalls = 0;
    let tokenCalls = 0;
    const failure = new GitSafetyError({ command: "git ls-files --debug -z", message: "failed" });
    await assert.rejects(
      captureStableSafetyFacts("/repo", {
        collectFacts: async () => { factsCalls += 1; return facts(); },
        collectToken: async () => { tokenCalls += 1; throw failure; },
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(factsCalls, 1);
    assert.equal(tokenCalls, 1);
  });
});
