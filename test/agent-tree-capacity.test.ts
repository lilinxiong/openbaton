import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { getCliAdapter } from "../src/adapters/registry.js";
import { normalizeCliRuntimeCapabilities } from "../src/adapters/shared.js";
import type { CliHostMetadata } from "../src/adapters/contract.js";
import {
  resolveAgentTreeCapacity,
  type AgentTreeCapacitySourceKind,
} from "../src/lib/agent-tree-capacity.js";

function host(id: string, limit: number): CliHostMetadata {
  return {
    id,
    skillPath: ".codex/skills/baton/SKILL.md",
    defaultMaxConcurrent: limit,
    maxConcurrent: () => limit,
    executionHandleKind: "test-handle",
  };
}

function source(result: ReturnType<typeof resolveAgentTreeCapacity>, kind: AgentTreeCapacitySourceKind) {
  return result.capacity_sources.find((item) => item.kind === kind);
}

describe("root agent tree capacity resolver", () => {
  it("applies host, policy, and operation precedence as one effective minimum", () => {
    const result = resolveAgentTreeCapacity({
      host: host("alpha", 3),
      configuredPolicy: 4,
      currentOperationLimit: 2,
      session: "tree-a",
    });

    assert.equal(result.capacity, 2);
    assert.equal(result.host, "alpha");
    assert.equal(result.session_uid, "tree-a");
    assert.deepEqual(result.capacity_sources, [
      { kind: "host_limit", value: 3, applied: false },
      { kind: "configured_policy", value: 4, applied: false },
      { kind: "operation_limit", value: 2, applied: true },
    ]);
    assert.deepEqual(result.unknown_sources, []);
  });

  it("honors a lower tree policy without coupling another tree", () => {
    const treeA = resolveAgentTreeCapacity({ host: host("alpha", 3), configuredPolicy: 2, session: "tree-a" });
    const treeB = resolveAgentTreeCapacity({ host: host("alpha", 3), configuredPolicy: 3, session: "tree-b" });

    assert.equal(treeA.capacity, 2);
    assert.equal(treeB.capacity, 3);
    assert.equal(treeA.host, treeB.host);
    assert.notEqual(treeA.session_uid, treeB.session_uid);
    assert.equal(source(treeA, "configured_policy")?.applied, true);
    assert.equal(source(treeB, "host_limit")?.applied, true);
  });

  it("uses configured policy when the host limit is unknown and stays unknown otherwise", () => {
    const unknownHost = {
      ...host("opaque", 0),
      maxConcurrent: () => Number.NaN,
    };
    const policyOnly = resolveAgentTreeCapacity({ host: unknownHost, configuredPolicy: 2 });
    const noKnownLimit = resolveAgentTreeCapacity({ host: unknownHost });

    assert.equal(policyOnly.capacity, 2);
    assert.equal(source(policyOnly, "host_limit"), undefined);
    assert.equal(source(policyOnly, "configured_policy")?.applied, true);
    assert.equal(noKnownLimit.capacity, null);
    assert.deepEqual(noKnownLimit.unknown_sources, ["host_limit", "configured_policy", "operation_limit"]);
  });

  it("ignores invalid limits instead of treating them as capacity", () => {
    const invalidValues: unknown[] = [null, "", "not-a-number", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, false, {}, []];

    for (const value of invalidValues) {
      const hostInvalid = resolveAgentTreeCapacity({ hostLimit: value, configuredPolicy: 2 });
      assert.equal(hostInvalid.capacity, 2, `invalid host limit ${String(value)} must not widen policy`);
      assert.equal(source(hostInvalid, "host_limit"), undefined);

      const policyInvalid = resolveAgentTreeCapacity({ hostLimit: 3, configuredPolicy: value });
      assert.equal(policyInvalid.capacity, 3, `invalid policy ${String(value)} must not reduce host limit`);
      assert.equal(source(policyInvalid, "configured_policy"), undefined);

      const operationInvalid = resolveAgentTreeCapacity({ hostLimit: 3, currentOperationLimit: value });
      assert.equal(operationInvalid.capacity, 3, `invalid operation limit ${String(value)} must not reduce host limit`);
      assert.equal(source(operationInvalid, "operation_limit"), undefined);
    }
  });

  it("accepts legacy capability spellings while exposing one canonical capacity", () => {
    const spellings = [
      "max_concurrent_subagents",
      "maxConcurrentSubagents",
      "max_concurrent",
      "maxConcurrent",
    ] as const;

    for (const spelling of spellings) {
      const result = resolveAgentTreeCapacity({ capabilities: { [spelling]: 2 } });
      assert.equal(result.capacity, 2, spelling);
      assert.deepEqual(result.capacity_sources, [{ kind: "host_limit", value: 2, applied: true }], spelling);
    }

    assert.deepEqual(
      normalizeCliRuntimeCapabilities({ maxConcurrent: 2, maxDepth: 7 }),
      { max_concurrent_subagents: 2, max_depth: 7 },
    );
  });

  it("falls back to three Codex subagents when a manifest omits its quota", () => {
    const sourceDirectory = path.resolve(import.meta.dir, "../adapters/codex");
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baton-codex-capacity-"));
    const temporaryAdapter = path.join(temporaryRoot, "codex");
    fs.cpSync(sourceDirectory, temporaryAdapter, { recursive: true });

    const manifestPath = path.join(temporaryAdapter, "adapter.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { quota: Record<string, unknown> };
    delete manifest.quota.max_concurrent_subagents;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const env = { ...process.env, BATON_ADAPTER_PATHS: temporaryAdapter };
    const adapter = getCliAdapter("codex", env);
    assert.equal(adapter.host.defaultMaxConcurrent, 3);
    assert.equal(resolveAgentTreeCapacity({ host: adapter.host }).capacity, 3);
  });

  it("keeps max_depth separate from the subagent capacity", () => {
    const withDepth = resolveAgentTreeCapacity({
      capabilities: { max_concurrent_subagents: 2, max_depth: 1 },
    });
    const depthOnly = resolveAgentTreeCapacity({ capabilities: { max_depth: 99 } });

    assert.equal(withDepth.capacity, 2);
    assert.deepEqual(withDepth.capacity_sources.map((item) => item.kind), ["host_limit"]);
    assert.equal(source(withDepth, "host_limit")?.applied, true);
    assert.equal(depthOnly.capacity, null);
    assert.deepEqual(depthOnly.unknown_sources, ["host_limit", "configured_policy", "operation_limit"]);
  });
});
