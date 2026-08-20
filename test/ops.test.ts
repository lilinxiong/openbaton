import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { reserveNext } from "../src/lib/dispatch.js";
import { inferOpsAction } from "../src/lib/ops-task.js";
import { loadProjectOpsConfig, saveProjectOpsConfig } from "../src/lib/ops-config.js";
import { listOpsRouteChoices } from "../src/lib/ops-routes.js";
import { resolveOpsDispatch } from "../src/lib/ops-dispatch.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { writeHostCapabilitySnapshot } from "../src/lib/host-capabilities.js";
import { projectOpsConfigPath } from "../src/lib/paths.js";
import { withHome, fakeEnv } from "./home.js";
import { parseToml } from "../src/lib/toml.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

function setupOpsWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ops-"));
  publishRouteSnapshot(cwd, { models: [
    { id: "k3", provider: "kimi", namespaced: "kimi/k3", contextWindow: 262_144 },
    { id: "k3[1m]", provider: "kimi", namespaced: "kimi/k3[1m]", contextWindow: 1_048_576 },
    { id: "mimo-v2.5-pro", provider: "mimo", namespaced: "mimo/mimo-v2.5-pro", contextWindow: 262_144 },
    { id: "glm-5.2", provider: "alibaba-token-plan", namespaced: "alibaba-token-plan/glm-5.2", contextWindow: 1_000_000 },
    { id: "mimo-v2.5-tts", provider: "mimo", namespaced: "mimo/mimo-v2.5-tts", contextWindow: 262_144 },
    { id: "gpt-5.6-sol", provider: "openai", namespaced: "gpt-5.6-sol", native: true, contextWindow: 256_000 },
  ] });
  writeHostCapabilitySnapshot(cwd, {
    advertisedModels: [
      "kimi/k3", "kimi/k3[1m]", "mimo/mimo-v2.5-pro", "alibaba-token-plan/glm-5.2",
      "mimo/mimo-v2.5-tts", "gpt-5.6-sol",
    ],
    quotaCatalog: { reports: [
      { provider: "kimi", quota: { weeklyPercent: 16 } },
      { provider: "mimo", quota: { weeklyPercent: 4 } },
      { provider: "alibaba-token-plan", quota: { weeklyPercent: 1 } },
    ] },
  });
  return cwd;
}

describe("project ops config", () => {
  it("classifies mechanical units fail-closed", () => {
    assert.equal(inferOpsAction("bun test"), "test");
    assert.equal(inferOpsAction("run the unit tests"), "test");
    assert.equal(inferOpsAction("跑一下测试"), "test");
    assert.equal(inferOpsAction("bun run build"), "build");
    assert.equal(inferOpsAction("write a commit message from staged files"), "git-commit");
    assert.equal(inferOpsAction("implement the parser and run its unit tests"), null);
    assert.equal(inferOpsAction("fix the failing tests"), null);
    assert.equal(inferOpsAction("why is CI red"), null);
  });

  it("writes a hidden .baton.toml with empty routes and no defaults", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ops-file-"));
    const empty = loadProjectOpsConfig(cwd);
    assert.equal(empty.runner.route, "");
    assert.equal(empty.longctx.route, "");
    const file = saveProjectOpsConfig(cwd, empty);
    assert.equal(path.basename(file), ".baton.toml");
    assert.equal(file, projectOpsConfigPath(cwd));
    const parsed = parseToml(fs.readFileSync(file, "utf8"));
    assert.equal((parsed.ops as { runner: { route: string } }).runner.route, "");
    assert.equal((parsed.ops as { longctx: { route: string } }).longctx.route, "");
  });

  it("filters runner vs longctx from the current host intersection", () => {
    const cwd = setupOpsWorkspace();
    const runner = listOpsRouteChoices(cwd, "runner", []);
    const longctx = listOpsRouteChoices(cwd, "longctx", []);
    assert.deepEqual(runner.map((item) => item.route_id).sort(), ["kimi/k3", "mimo/mimo-v2.5-pro"]);
    assert.ok(runner.every((item) => item.route_id !== "kimi/k3[1m]"));
    assert.ok(!runner.some((item) => item.route_id.includes("tts") || item.route_id.includes("sol")));
    assert.deepEqual(longctx.map((item) => item.route_id).sort(), ["alibaba-token-plan/glm-5.2", "kimi/k3[1m]"]);
  });

  it("keeps mechanical work on the director when ops routes are empty", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      const out = capture();
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await run(["spawn", "bun test"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      assert.match(out.text(), /director-local: ops route is empty/);
      assert.ok(!fs.existsSync(path.join(cwd, ".baton.toml")));
    });
  });

  it("dispatches a configured runner route without a selection proposal", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      saveProjectOpsConfig(cwd, {
        runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await run(["spawn", "bun test", "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      assert.match(out.text(), /ops-dispatch: runner test/);
      const ticket = JSON.parse(out.text().slice(out.text().indexOf("{")));
      assert.equal(ticket.selection.confirmed_by, "ops-config");
      assert.equal(ticket.route_id, "mimo/mimo-v2.5-pro");
      assert.equal(ticket.selection.ops_action, "test");
    });
  });

  it("fails closed when a configured ops route is not currently callable", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      saveProjectOpsConfig(cwd, {
        runner: { route: "xai/grok-4.6", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const out = capture();
      assert.equal(await run(["spawn", "bun test"], { cwd, env, stdout: out, stderr: out }), 1);
      assert.match(out.text(), /OPS_ROUTE_UNAVAILABLE/);
    });
  });

  it("writes filtered choices through baton config flags without inventing a default", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const out = capture();
      assert.equal(await run([
        "config", "--runner", "mimo/mimo-v2.5-pro", "--longctx", "-",
      ], {
        cwd, env, stdout: out, stderr: out,
        resolve: () => ({ source: "path" as const, command: "ocx", prefixArgs: [] }),
        runner: ({ args }) => ({
          status: 0,
          stdout: args[0] === "--version"
            ? "opencodex 2.26.0\n"
            : JSON.stringify({ models: [
              { id: "k3", provider: "kimi", namespaced: "kimi/k3", contextWindow: 262_144 },
              { id: "k3[1m]", provider: "kimi", namespaced: "kimi/k3[1m]", contextWindow: 1_048_576 },
              { id: "mimo-v2.5-pro", provider: "mimo", namespaced: "mimo/mimo-v2.5-pro", contextWindow: 262_144 },
              { id: "glm-5.2", provider: "alibaba-token-plan", namespaced: "alibaba-token-plan/glm-5.2", contextWindow: 1_000_000 },
            ] }),
          stderr: "",
          error: null,
        }),
      }), 0, out.text());
      assert.match(out.text(), /0\. （空：由主 agent 执行）/);
      assert.match(out.text(), /runner: mimo\/mimo-v2\.5-pro/);
      assert.match(out.text(), /longctx: \(empty; director\)/);
      const cfg = loadProjectOpsConfig(cwd);
      assert.equal(cfg.runner.route, "mimo/mimo-v2.5-pro");
      assert.equal(cfg.longctx.route, "");
      assert.equal(path.basename(projectOpsConfigPath(cwd)), ".baton.toml");
    });
  });

  it("resolves git-commit with no staged diff as an empty-index skip", () => {
    const cwd = setupOpsWorkspace();
    saveProjectOpsConfig(cwd, {
      runner: { route: "", actions: ["test", "build", "lint", "typecheck"] },
      longctx: { route: "kimi/k3[1m]", actions: ["search", "digest", "git-summarize", "git-commit"] },
    });
    const resolution = resolveOpsDispatch(cwd, "write a commit message from staged files", [
      { id: "kimi/k3[1m]", route_id: "kimi/k3[1m]", strengths: "", executable: true, provider: "kimi" },
    ]);
    assert.equal(resolution.kind, "empty-index");
  });

  it("lets dispatch reserve an ops-config confirmed ticket", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      saveProjectOpsConfig(cwd, {
        runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const out = capture();
      assert.equal(await run(["spawn", "bun test", "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const reserved = reserveNext(cwd, { host: "codex", capacity: 2 });
      assert.equal(reserved.reserved.length, 1);
      assert.equal(reserved.reserved[0].selection.confirmed_by, "ops-config");
    });
  });
});
