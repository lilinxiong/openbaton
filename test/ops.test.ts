import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { runConfig } from "../src/commands/config.js";
import { reserveNext } from "../src/lib/dispatch.js";
import { inferOpsAction } from "../src/lib/ops-task.js";
import { emptyConfig, loadConfig, saveConfig } from "../src/lib/config.js";
import type { OpsConfig } from "../src/lib/ops-config.js";
import { listOpsRouteChoices } from "../src/lib/ops-routes.js";
import { resolveOpsDispatch } from "../src/lib/ops-dispatch.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { writeHostCapabilitySnapshot } from "../src/lib/host-capabilities.js";
import { configPath } from "../src/lib/paths.js";
import { withHome, fakeEnv } from "./home.js";
import { parseToml } from "../src/lib/toml.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

function setupOpsCatalog() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ops-"));
  publishRouteSnapshot(cwd, { models: [
    { id: "k3", provider: "kimi", namespaced: "kimi/k3", contextWindow: 262_144 },
    { id: "k3[1m]", provider: "kimi", namespaced: "kimi/k3[1m]", contextWindow: 1_048_576 },
    { id: "mimo-v2.5-pro", provider: "mimo", namespaced: "mimo/mimo-v2.5-pro", contextWindow: 262_144 },
    { id: "glm-5.2", provider: "alibaba-token-plan", namespaced: "alibaba-token-plan/glm-5.2", contextWindow: 1_000_000 },
    { id: "mimo-v2.5-tts", provider: "mimo", namespaced: "mimo/mimo-v2.5-tts", contextWindow: 262_144 },
    { id: "gpt-5.6-sol", provider: "openai", namespaced: "gpt-5.6-sol", native: true, contextWindow: 256_000 },
  ] });
  return cwd;
}

function setupOpsWorkspace() {
  const cwd = setupOpsCatalog();
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

function saveOpsConfig(cwd: string, env: NodeJS.ProcessEnv, ops: OpsConfig) {
  let current = emptyConfig();
  if (fs.existsSync(configPath(cwd, { env }))) current = loadConfig(cwd, { env });
  saveConfig(cwd, { ...current, ops }, { env });
}

describe("global ops config", () => {
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

  it("stores empty routes in the shared ~/.baton/config.toml", () => {
    withHome((home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ops-file-"));
      const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ops-other-"));
      const env = fakeEnv(home);
      const empty = emptyConfig();
      const file = saveConfig(cwd, empty, { env });
      assert.equal(file, path.join(home, ".baton", "config.toml"));
      const parsed = parseToml(fs.readFileSync(file, "utf8"));
      assert.equal((parsed.ops as { runner: { route: string } }).runner.route, "");
      assert.equal((parsed.ops as { longctx: { route: string } }).longctx.route, "");
      assert.deepEqual(loadConfig(otherCwd, { env }).ops, empty.ops);
      assert.ok(!fs.existsSync(path.join(cwd, ".baton.toml")));
      assert.ok(!fs.existsSync(path.join(otherCwd, ".baton.toml")));
    });
  });

  it("filters runner vs longctx from the current host intersection", () => {
    withHome(() => {
      const cwd = setupOpsWorkspace();
      const runner = listOpsRouteChoices(cwd, "runner", []);
      const longctx = listOpsRouteChoices(cwd, "longctx", []);
      assert.deepEqual(runner.map((item) => item.route_id).sort(), ["kimi/k3", "mimo/mimo-v2.5-pro"]);
      assert.ok(runner.every((item) => item.route_id !== "kimi/k3[1m]"));
      assert.ok(!runner.some((item) => item.route_id.includes("tts") || item.route_id.includes("sol")));
      assert.deepEqual(longctx.map((item) => item.route_id).sort(), ["alibaba-token-plan/glm-5.2", "kimi/k3[1m]"]);
    });
  });

  it("keeps dispatch filtering fail-closed when the host surface is absent", () => {
    withHome(() => {
      const cwd = setupOpsCatalog();
      assert.deepEqual(listOpsRouteChoices(cwd, "runner", []), []);
      assert.deepEqual(listOpsRouteChoices(cwd, "longctx", []), []);
    });
  });

  it("keeps bare baton config interactive from OpenCodex alone", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsCatalog();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const answers = ["1", "0"];
      let promptCount = 0;
      const opencodexCalls: string[][] = [];
      const out = capture();
      assert.equal(await runConfig([], {
        cwd,
        env,
        stdout: out,
        resolve: () => ({ source: "path" as const, command: "ocx", prefixArgs: [] }),
        runner: ({ args }) => {
          opencodexCalls.push(args);
          return {
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
          };
        },
        readLine: async () => {
          promptCount += 1;
          return answers.shift() || "0";
        },
      }), 0, out.text());
      assert.equal(promptCount, 2);
      assert.ok(opencodexCalls.some((args) => args.join(" ") === "models live --json"));
      assert.match(out.text(), /models: OpenCodex live snapshot/);
      assert.doesNotMatch(out.text(), /host/);
      assert.match(out.text(), /wrote .*\.baton\/config\.toml/);
      const cfg = loadConfig(cwd, { env });
      assert.equal(cfg.ops.runner.route, "kimi/k3");
      assert.equal(cfg.ops.longctx.route, "");
      assert.ok(!fs.existsSync(path.join(cwd, ".baton.toml")));
    });
  });

  it("does not let a narrower host snapshot filter OpenCodex config choices", () => {
    withHome(() => {
      const cwd = setupOpsCatalog();
      writeHostCapabilitySnapshot(cwd, { advertisedModels: ["kimi/k3"] });
      const runner = listOpsRouteChoices(cwd, "runner", [], { scope: "catalog" });
      const longctx = listOpsRouteChoices(cwd, "longctx", [], { scope: "catalog" });
      assert.deepEqual(runner.map((item) => item.route_id).sort(), ["kimi/k3", "mimo/mimo-v2.5-pro"]);
      assert.deepEqual(longctx.map((item) => item.route_id).sort(), ["alibaba-token-plan/glm-5.2", "kimi/k3[1m]"]);
    });
  });

  it("ignores a legacy project .baton.toml", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      fs.writeFileSync(path.join(cwd, ".baton.toml"), "[ops.runner]\nroute = \"mimo/mimo-v2.5-pro\"\n", "utf8");
      const out = capture();
      assert.equal(await run(["spawn", "bun test"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      assert.match(out.text(), /director-local: ops route is empty/);
      assert.equal(loadConfig(cwd, { env }).ops.runner.route, "");
    });
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
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
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
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "xai/grok-4.6", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run(["spawn", "bun test"], { cwd, env, stdout: out, stderr: out }), 1);
      assert.match(out.text(), /OPS_ROUTE_UNAVAILABLE/);
    });
  });

  it("writes OpenCodex choices through baton config flags without inventing a default", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const before = loadConfig(cwd, { env });
      before.director.max_concurrent = 2;
      saveConfig(cwd, before, { env });
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
      const cfg = loadConfig(cwd, { env });
      assert.equal(cfg.director.max_concurrent, 2);
      assert.equal(cfg.ops.runner.route, "mimo/mimo-v2.5-pro");
      assert.equal(cfg.ops.longctx.route, "");
      assert.equal(configPath(cwd, { env }), path.join(home, ".baton", "config.toml"));
      const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ops-shared-"));
      assert.equal(loadConfig(otherCwd, { env }).ops.runner.route, "mimo/mimo-v2.5-pro");
      assert.ok(!fs.existsSync(path.join(cwd, ".baton.toml")));
    });
  });

  it("reports OpenCodex discovery failure through the CLI error boundary", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ops-config-error-"));
      const env = fakeEnv(home);
      const stderr = capture();
      assert.equal(await run(["config"], {
        cwd,
        env,
        stdout: capture(),
        stderr,
        resolve: () => ({ source: "path" as const, command: "ocx", prefixArgs: [] }),
        runner: () => ({ status: 1, stdout: "", stderr: "offline", error: null }),
      }), 1);
      assert.match(stderr.text(), /OpenCodex model discovery failed/);
      assert.doesNotMatch(stderr.text(), /at runConfig|Node\.js/);
    });
  });

  it("resolves git-commit with no staged diff as an empty-index skip", () => {
    withHome((home) => {
      const cwd = setupOpsWorkspace();
      saveOpsConfig(cwd, fakeEnv(home), {
        runner: { route: "", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "kimi/k3[1m]", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const resolution = resolveOpsDispatch(cwd, "write a commit message from staged files", [
        { id: "kimi/k3[1m]", route_id: "kimi/k3[1m]", strengths: "", executable: true, provider: "kimi" },
      ]);
      assert.equal(resolution.kind, "empty-index");
    });
  });

  it("lets dispatch reserve an ops-config confirmed ticket", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run(["spawn", "bun test", "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const reserved = reserveNext(cwd, { host: "codex", capacity: 2 });
      assert.equal(reserved.reserved.length, 1);
      assert.equal(reserved.reserved[0].selection.confirmed_by, "ops-config");
    });
  });
});
