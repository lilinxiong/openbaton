import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertDisjointWriteScopes,
  parseApplyUnitScopes,
  scopesFromRecord,
  writePathsOverlap,
} from "../src/lib/apply-scope.js";

describe("write scope hard gate", () => {
  it("treats exact and parent-child declarations as conflicts", () => {
    assert.equal(writePathsOverlap("src/config.ts", "src/config.ts"), true);
    assert.equal(writePathsOverlap("src", "src/config.ts"), true);
    assert.equal(writePathsOverlap("src/config.ts", "src/config.test.ts"), false);
    assert.throws(
      () => assertDisjointWriteScopes([
        { key: "one", write_paths: ["src"] },
        { key: "two", write_paths: ["src/lib/config.ts"] },
      ]),
      /WRITE_SCOPE_CONFLICT/,
    );
  });

  it("namespaces overlapping paths by exact repository and execution root", () => {
    assert.doesNotThrow(() => assertDisjointWriteScopes([
      { key: "one", repository_id: "repo", execution_root: "/isolated/one", write_paths: ["src/shared.ts"] },
      { key: "two", repository_id: "repo", execution_root: "/isolated/two", write_paths: ["src/shared.ts"] },
    ]));
    assert.throws(() => assertDisjointWriteScopes([
      { key: "one", repository_id: "repo", execution_root: "/isolated/one", write_paths: ["src"] },
      { key: "two", repository_id: "repo", execution_root: "/isolated/one", write_paths: ["src/shared.ts"] },
    ]), /WRITE_SCOPE_CONFLICT/);
    assert.throws(() => assertDisjointWriteScopes([
      { key: "isolated", repository_id: "repo", execution_root: "/isolated/one", write_paths: ["src/shared.ts"] },
      { key: "legacy", write_paths: ["src/shared.ts"] },
    ]), /WRITE_SCOPE_CONFLICT/);
  });

  it("keeps operations per apply unit and preserves the default", () => {
    const scopes = parseApplyUnitScopes([
      "--unit", "1.1", "--write-path", "src/a.ts", "--write-ops", "write,delete",
      "--unit", "1.2", "--write-path", "src/b.ts",
    ]);
    assert.deepEqual(scopes.get("1.1")?.allowed_operations, ["write", "delete"]);
    assert.deepEqual(scopes.get("1.2")?.allowed_operations, ["write", "create"]);
    assert.deepEqual(scopesFromRecord({
      "1.3": { mode: "write", write_paths: ["src/c.ts"], allowed_operations: ["chmod"] },
    }).get("1.3")?.allowed_operations, ["chmod"]);
  });
});
