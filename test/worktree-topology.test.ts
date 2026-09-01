import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WorktreeTopologyError,
  assertRepositoryLocalDecomposition,
  resolveOwningRepository,
  resolveWorktreeTopology,
  validateRepositoryLocalDecomposition,
} from "../src/lib/worktree-topology.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(prefix: string, file = "tracked.txt"): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "baton@example.invalid"]);
  git(cwd, ["config", "user.name", "Baton Test"]);
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-qm", "initial"]);
  return cwd;
}

function controlState(cwd: string): { head: string; status: string; index: Buffer } {
  const index = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  return {
    head: git(cwd, ["rev-parse", "HEAD"]),
    status: git(cwd, ["status", "--porcelain=v2", "--branch"]),
    index: fs.readFileSync(index),
  };
}

describe("worktree repository topology", () => {
  it("resolves normal and linked worktrees through one canonical common-dir identity without caller mutation", () => {
    const repo = repository("baton-topology-normal-");
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), "baton-topology-linked-parent-"));
    fs.rmdirSync(linked);
    git(repo, ["worktree", "add", "--detach", "-q", linked, "HEAD"]);
    const before = controlState(repo);
    const linkedBefore = controlState(linked);

    const normal = resolveOwningRepository(repo, "tracked.txt");
    const future = resolveOwningRepository(repo, "src/future.ts");
    const linkedOwner = resolveOwningRepository(linked, "tracked.txt");

    assert.equal(normal.repository.topology_kind, "repository");
    assert.equal(normal.repository_relative_path, "tracked.txt");
    assert.equal(future.repository.repository_id, normal.repository.repository_id);
    assert.equal(linkedOwner.repository.topology_kind, "linked-worktree");
    assert.equal(linkedOwner.repository.is_linked_worktree, true);
    assert.equal(linkedOwner.repository.repository_id, normal.repository.repository_id);
    assert.equal(linkedOwner.repository.git_common_dir_identity, normal.repository.git_common_dir_identity);
    assert.deepEqual(controlState(repo), before);
    assert.deepEqual(controlState(linked), linkedBefore);
  });

  it("treats nested repositories as literal independent owners", () => {
    const parent = repository("baton-topology-nested-parent-", "root.txt");
    const nested = path.join(parent, "nested");
    fs.mkdirSync(nested);
    git(nested, ["init", "-q"]);
    git(nested, ["config", "user.email", "baton@example.invalid"]);
    git(nested, ["config", "user.name", "Baton Test"]);
    fs.writeFileSync(path.join(nested, "nested.txt"), "nested\n");
    git(nested, ["add", "nested.txt"]);
    git(nested, ["commit", "-qm", "nested"]);
    const before = git(parent, ["status", "--porcelain=v2", "--branch"]);

    const outer = resolveOwningRepository(parent, "root.txt");
    const inner = resolveOwningRepository(parent, "nested/nested.txt");
    assert.equal(inner.repository.topology_kind, "nested-repository");
    assert.notEqual(inner.repository.repository_id, outer.repository.repository_id);
    assert.equal(inner.repository_relative_path, "nested.txt");
    assert.equal(git(parent, ["status", "--porcelain=v2", "--branch"]), before);
  });

  it("resolves an initialized submodule to its own object/common-dir identity", () => {
    const child = repository("baton-topology-submodule-source-", "child.txt");
    const parent = repository("baton-topology-superproject-", "root.txt");
    git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "modules/child"]);
    git(parent, ["commit", "-qam", "add submodule"]);
    const before = controlState(parent);

    const outer = resolveOwningRepository(parent, "root.txt");
    const inner = resolveOwningRepository(parent, "modules/child/child.txt");
    assert.equal(inner.repository.topology_kind, "submodule");
    assert.equal(inner.repository.superproject_root, fs.realpathSync(parent));
    assert.notEqual(inner.repository.repository_id, outer.repository.repository_id);
    assert.notEqual(inner.repository.git_common_dir_identity, outer.repository.git_common_dir_identity);
    assert.deepEqual(controlState(parent), before);
  });

  it("fails closed for multi-repository units until exact parts, dependencies, and gates are supplied", () => {
    const parent = repository("baton-topology-decompose-parent-", "root.txt");
    const nested = path.join(parent, "nested");
    fs.mkdirSync(nested);
    git(nested, ["init", "-q"]);
    git(nested, ["config", "user.email", "baton@example.invalid"]);
    git(nested, ["config", "user.name", "Baton Test"]);
    fs.writeFileSync(path.join(nested, "nested.txt"), "nested\n");
    git(nested, ["add", "nested.txt"]);
    git(nested, ["commit", "-qm", "nested"]);
    const paths = ["root.txt", "nested/nested.txt"];
    const decomposition = resolveWorktreeTopology(parent, paths);
    assert.equal(decomposition.requires_repository_decomposition, true);
    assert.equal(decomposition.requires_parent_integration_gate, true);
    assert.equal(decomposition.repository_parts.length, 2);
    const missing = validateRepositoryLocalDecomposition(parent, { write_paths: paths });
    assert.equal(missing.valid, false);
    assert.ok(missing.diagnostics.some((item) => item.code === "REPOSITORY_LOCAL_PARTS_REQUIRED"));
    assert.throws(
      () => assertRepositoryLocalDecomposition(parent, { write_paths: paths }),
      (error: unknown) => error instanceof WorktreeTopologyError && error.code === "REPOSITORY_LOCAL_PARTS_REQUIRED",
    );

    const [first, second] = decomposition.repository_parts;
    const accepted = validateRepositoryLocalDecomposition(parent, {
      write_paths: paths,
      repository_parts: [
        { part_key: "part-first", repository_id: first!.repository_id, write_paths: first!.write_paths, depends_on: [], integration_order: 0 },
        { part_key: "part-second", repository_id: second!.repository_id, write_paths: second!.write_paths, depends_on: ["part-first"], integration_order: 1 },
      ],
      integration_gate_keys: ["gate-parent-integration"],
    });
    assert.equal(accepted.valid, true);
    assert.deepEqual(accepted.topology?.repository_parts.map((part) => part.part_key), ["part-first", "part-second"]);
    assert.deepEqual(accepted.topology?.repository_parts[1]?.depends_on, ["part-first"]);
    assert.deepEqual(accepted.topology?.integration_gate_keys, ["gate-parent-integration"]);

    const noGate = validateRepositoryLocalDecomposition(parent, {
        write_paths: paths,
        repository_parts: [
          { part_key: "part-first", repository_id: first!.repository_id, write_paths: first!.write_paths, depends_on: [], integration_order: 0 },
          { part_key: "part-second", repository_id: second!.repository_id, write_paths: second!.write_paths, depends_on: ["part-first"], integration_order: 1 },
        ],
    });
    assert.equal(noGate.valid, false);
    assert.ok(noGate.diagnostics.some((item) => item.code === "INTEGRATION_GATE_REQUIRED"));
    assert.throws(
      () => resolveWorktreeTopology(parent, ["root.txt -> nested/nested.txt"]),
      (error: unknown) => error instanceof WorktreeTopologyError && error.code === "CROSS_REPOSITORY_RENAME",
    );
  });

  it("rejects unsafe, ambiguous, control, and symlink-escape paths", () => {
    const repo = repository("baton-topology-unsafe-");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "baton-topology-outside-"));
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");
    fs.symlinkSync(outside, path.join(repo, "escape"), "dir");
    for (const value of ["", "../outside", "/tmp/outside", ".git/config", "bad\u0000path", "escape/outside.txt"]) {
      assert.throws(() => resolveOwningRepository(repo, value), WorktreeTopologyError);
    }
  });
});
