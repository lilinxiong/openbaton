import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { runConfig } from "../src/commands/config.js";
import { reserveNext } from "../src/lib/dispatch.js";
import { inferOpsAction, inferOpsActionFromContext } from "../src/lib/ops-task.js";
import { emptyConfig, loadConfig, saveConfig } from "../src/lib/config.js";
import type { OpsConfig } from "../src/lib/ops-config.js";
import { listOpsRouteChoices } from "../src/lib/ops-routes.js";
import { resolveOpsDispatch } from "../src/lib/ops-dispatch.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { normalizeProviderQuotas } from "../src/lib/provider-quotas.js";
import { configPath } from "../src/lib/paths.js";
import { readReceipt } from "../src/lib/receipt.js";
import { listSpawns } from "../src/lib/spawn.js";
import { listSelectionProposals } from "../src/lib/selection.js";
import { withHome, fakeEnv } from "./home.js";
import { parseToml } from "../src/lib/toml.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

const OPS_MODELS = [
  { id: "k3", provider: "kimi", namespaced: "kimi/k3", contextWindow: 262_144 },
  { id: "k3[1m]", provider: "kimi", namespaced: "kimi/k3[1m]", contextWindow: 1_048_576 },
  { id: "mimo-v2.5-pro", provider: "mimo", namespaced: "mimo/mimo-v2.5-pro", contextWindow: 262_144 },
  { id: "glm-5.2", provider: "alibaba-token-plan", namespaced: "alibaba-token-plan/glm-5.2", contextWindow: 1_000_000 },
  { id: "mimo-v2.5-tts", provider: "mimo", namespaced: "mimo/mimo-v2.5-tts", contextWindow: 262_144 },
  { id: "gpt-5.6-sol", provider: "openai", namespaced: "gpt-5.6-sol", native: true, contextWindow: 256_000 },
];

function setupOpsCatalog(withQuota = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-ops-"));
  publishRouteSnapshot(cwd, { models: OPS_MODELS }, new Date(), withQuota ? {
    providerQuotas: normalizeProviderQuotas({ reports: [
      { provider: "kimi", quota: { weeklyPercent: 16 } },
      { provider: "mimo", quota: { weeklyPercent: 4 } },
      { provider: "alibaba-token-plan", quota: { weeklyPercent: 1 } },
    ] }),
  } : {});
  return cwd;
}

function setupOpsWorkspace() {
  return setupOpsCatalog(true);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function setupCommitWorkspace() {
  const cwd = setupOpsWorkspace();
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "validation@example.invalid");
  git(cwd, "config", "user.name", "Validation");
  fs.writeFileSync(path.join(cwd, "change.txt"), "base\n");
  git(cwd, "add", "change.txt");
  git(cwd, "commit", "-q", "-m", "baseline");
  fs.appendFileSync(path.join(cwd, "change.txt"), "staged\n");
  git(cwd, "add", "change.txt");
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
    assert.equal(inferOpsAction("[$build-app](/repo/.skills/build-app/SKILL.md) kmp android"), "build");
    assert.equal(inferOpsAction("$build-bazel android"), "build");
    assert.equal(inferOpsAction("/build-cmake"), "build");
    assert.equal(inferOpsAction("write a commit message from staged files"), "git-summarize");
    assert.equal(inferOpsAction("git commit staged changes"), "git-commit");
    assert.equal(inferOpsAction("提交吧"), "git-commit");
    assert.equal(inferOpsAction("不要提交"), null);
    assert.equal(inferOpsAction("implement the parser and run its unit tests"), null);
    assert.equal(inferOpsAction("fix $build-app classification"), null);
    assert.equal(inferOpsAction("fix the failing tests"), null);
    assert.equal(inferOpsAction("why is CI red"), null);
    assert.equal(inferOpsActionFromContext("run the tests", "Android target"), "test");
    assert.equal(inferOpsActionFromContext("Collect release evidence", "bun test"), "test");
    assert.equal(inferOpsActionFromContext("run the tests", "bun run build"), null);
    assert.equal(inferOpsActionFromContext("不要提交", "git commit staged changes"), null);
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
      assert.equal(loadConfig(otherCwd, { env }).director.model_selection, false);
      assert.ok(!fs.existsSync(path.join(cwd, ".baton.toml")));
      assert.ok(!fs.existsSync(path.join(otherCwd, ".baton.toml")));
    });
  });

  it("toggles free model selection globally without changing configured ops routes", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-model-selection-config-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "kimi/k3[1m]", min_context_tokens: 1_048_576, actions: ["search", "digest", "git-summarize", "git-commit"] },
      });

      assert.equal(await run(["config", "model-selection", "on"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(loadConfig(cwd, { env }).director.model_selection, true);
      assert.equal(await run(["config", "model-selection", "off"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const config = loadConfig(cwd, { env });
      assert.equal(config.director.model_selection, false);
      assert.equal(config.ops.runner.route, "mimo/mimo-v2.5-pro");
      assert.equal(config.ops.longctx.route, "kimi/k3[1m]");
    });
  });

  it("filters runner vs longctx from the synced OpenCodex snapshot", () => {
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

  it("does not require a session host surface for dispatch choices", () => {
    withHome(() => {
      const cwd = setupOpsCatalog();
      assert.deepEqual(listOpsRouteChoices(cwd, "runner", []).map((item) => item.route_id).sort(), ["kimi/k3", "mimo/mimo-v2.5-pro"]);
      assert.deepEqual(listOpsRouteChoices(cwd, "longctx", []).map((item) => item.route_id).sort(), ["alibaba-token-plan/glm-5.2", "kimi/k3[1m]"]);
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
            stdout: args.join(" ") === "--version"
              ? "opencodex 2.26.0\n"
              : args.join(" ") === "models live --json"
                ? JSON.stringify({ models: OPS_MODELS.slice(0, 4) })
                : JSON.stringify({ reports: [] }),
            stderr: "",
            error: null,
          };
        },
        readLine: async () => {
          promptCount += 1;
          return answers.shift() || "0";
        },
        codexBarResolve: () => null,
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

  it("uses the same OpenCodex choices without a per-session sync step", () => {
    withHome(() => {
      const cwd = setupOpsCatalog();
      const runner = listOpsRouteChoices(cwd, "runner", []);
      const longctx = listOpsRouteChoices(cwd, "longctx", []);
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

  it("inherits a request-level ops action across structured standalone units", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run([
        "spawn", "run the tests",
        "--unit", "android=Android target",
        "--unit", "ios=iOS target",
        "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.proposal, null);
      assert.deepEqual(result.dispatched.map((item: { key: string }) => item.key), ["android", "ios"]);
      assert.ok(result.dispatched.every((item: { ticket: { route_id: string } }) => item.ticket.route_id === "mimo/mimo-v2.5-pro"));
      assert.match(result.dispatched[0].ticket.prompt, /run the tests/);
      assert.match(result.dispatched[0].ticket.prompt, /Work unit android: Android target/);
      assert.equal(listSelectionProposals(cwd).length, 0);
    });
  });

  it("routes mechanical structured units and keeps the remaining units in one proposal", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await run(["config", "model-selection", "on"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run([
        "spawn", "Collect release evidence",
        "--unit", "test=bun test",
        "--unit", "report=Produce the final evidence-backed report",
        "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.deepEqual(result.dispatched.map((item: { key: string }) => item.key), ["test"]);
      assert.deepEqual(result.proposal.units.map((unit: { key: string }) => unit.key), ["report"]);
      assert.equal(result.proposal.payload.source_shape, "multi-unit-v1");
      assert.equal(listSpawns(cwd).length, 1);
      assert.equal(listSelectionProposals(cwd).length, 1);
    });
  });

  it("keeps conflicting request and unit actions behind ordinary model selection", async () => {
    await withHome(async (home) => {
      const cwd = setupOpsWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await run(["config", "model-selection", "on"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "mimo/mimo-v2.5-pro", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run([
        "spawn", "run the tests",
        "--unit", "build=bun run build",
        "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const proposal = JSON.parse(out.text());
      assert.equal(proposal.status, "pending_confirmation");
      assert.deepEqual(proposal.units.map((unit: { key: string }) => unit.key), ["build"]);
      assert.equal(listSpawns(cwd).length, 0);
    });
  });

  it("fails closed when a configured ops route is absent from the synced OpenCodex snapshot", async () => {
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
          stdout: args.join(" ") === "--version"
            ? "opencodex 2.26.0\n"
            : args.join(" ") === "models live --json"
              ? JSON.stringify({ models: OPS_MODELS.slice(0, 4) })
              : JSON.stringify({ reports: [] }),
          stderr: "",
          error: null,
        }),
        codexBarResolve: () => null,
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
      const resolution = resolveOpsDispatch(cwd, "git commit staged changes", [
        { id: "kimi/k3[1m]", route_id: "kimi/k3[1m]", strengths: "", executable: true, provider: "kimi" },
      ]);
      assert.equal(resolution.kind, "empty-index");
    });
  });

  it("creates a commit-only Receipt from the exact parent-staged tree", async () => {
    await withHome(async (home) => {
      const cwd = setupCommitWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "kimi/k3[1m]", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run(["spawn", "git commit staged changes", "--json"], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      assert.match(out.text(), /git-commit \(commit-only\)/);
      const ticket = JSON.parse(out.text().slice(out.text().indexOf("{")));
      const receipt = readReceipt(cwd, ticket.receipt_id);
      assert.equal(ticket.mode, "commit-only");
      assert.equal(ticket.read_only, false);
      assert.equal(receipt.execution.mode, "commit-only");
      assert.equal(receipt.git_policy.worker_may_stage, false);
      assert.equal(receipt.git_policy.worker_may_commit, true);
      assert.deepEqual(receipt.scope.allowed_operations, ["commit"]);
      assert.deepEqual(receipt.scope.write_allowlist, ["change.txt"]);
      assert.match(ticket.prompt, /run exactly one git commit/);
      assert.match(ticket.prompt, /Do not run reset.*push/);

      const reserved = reserveNext(cwd, { host: "codex", capacity: 4 });
      assert.equal(reserved.reserved.length, 1);
      assert.equal(reserved.reserved[0].mode, "commit-only");
      assert.equal(reserved.reserved[0].commit_authorization.expected_head, receipt.commit_baseline.head);
      assert.equal(reserved.reserved[0].commit_authorization.expected_tree, receipt.commit_baseline.staged_tree);
    });
  });

  it("routes a structured commit unit through configured longctx without a selector", async () => {
    await withHome(async (home) => {
      const cwd = setupCommitWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "kimi/k3[1m]", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run([
        "spawn", "提交吧。",
        "--unit", "COMMIT_PLAN=仅提交已精确暂存的方案文件并生成中文提交信息",
        "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.proposal, null);
      assert.equal(result.dispatched.length, 1);
      assert.equal(result.dispatched[0].key, "COMMIT_PLAN");
      assert.equal(result.dispatched[0].ticket.route_id, "kimi/k3[1m]");
      assert.equal(result.dispatched[0].ticket.mode, "commit-only");
      assert.equal(result.dispatched[0].ticket.selection.confirmed_by, "ops-config");
      assert.equal(listSelectionProposals(cwd).length, 0);
    });
  });

  it("rejects multiple structured commit-only units before creating tickets", async () => {
    await withHome(async (home) => {
      const cwd = setupCommitWorkspace();
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      saveOpsConfig(cwd, env, {
        runner: { route: "", actions: ["test", "build", "lint", "typecheck"] },
        longctx: { route: "kimi/k3[1m]", actions: ["search", "digest", "git-summarize", "git-commit"] },
      });
      const out = capture();
      assert.equal(await run([
        "spawn", "提交吧",
        "--unit", "first=提交第一部分",
        "--unit", "second=提交第二部分",
      ], { cwd, env, stdout: out, stderr: out }), 1);
      assert.match(out.text(), /MULTIPLE_COMMIT_UNITS/);
      assert.equal(listSpawns(cwd).length, 0);
      assert.equal(listSelectionProposals(cwd).length, 0);
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
