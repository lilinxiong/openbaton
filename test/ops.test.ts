import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { runConfig } from "../src/commands/config.js";
import { loadConfig } from "../src/lib/config.js";
import type { CliModel, CliModelCatalog } from "../src/lib/cli-models.js";
import { inferOpsAction, inferOpsActionFromContext } from "../src/lib/ops-task.js";
import { listOpsRouteChoices } from "../src/lib/ops-routes.js";
import { resolveOpsDispatch } from "../src/lib/ops-dispatch.js";
import { readRouteSnapshot } from "../src/lib/routes.js";
import type { ModelCard } from "../src/types.js";
import { parseToml } from "../src/lib/toml.js";
import { withHome, fakeEnv } from "./home.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

function model(id: string, displayName: string, description: string, efforts = ["low", "medium", "high"]): CliModel {
  return {
    id,
    model: id,
    display_name: displayName,
    description,
    hidden: false,
    reasoning_efforts: efforts.map((effort) => ({ id: effort, description: "" })),
    default_reasoning_effort: efforts.includes("medium") ? "medium" : efforts[0] || null,
    input_modalities: ["text"],
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    is_default: false,
  };
}

const CATALOG: CliModelCatalog = {
  cli: "codex",
  version: "codex-cli test",
  models: [
    model("gpt-5.6-sol", "5.6 Sol", "Most capable coding model", ["low", "medium", "high", "xhigh", "max"]),
    model("gpt-5.6-terra", "5.6 Terra", "Balanced coding model"),
    model("gpt-5.6-luna", "5.6 Luna", "Fast coding model"),
    model("gpt-5.5", "5.5", "Strong general coding model"),
    model("gpt-5.4", "5.4", "General coding model"),
    model("gpt-5.4-mini", "5.4 Mini", "Small, fast and cost-efficient coding model", ["low", "medium"]),
    model("gpt-5.3-codex-spark", "5.3 Codex Spark", "Ultra-fast coding model", ["low", "medium"]),
  ],
};

function cards(cwd: string): ModelCard[] {
  return (readRouteSnapshot(cwd)?.routes || []).flatMap((route) => [
    { id: route.route_id, route_id: route.route_id, strengths: route.description, executable: true },
    ...route.reasoning_efforts.map((effort) => ({
      id: `${route.route_id}@${effort}`,
      route_id: route.route_id,
      reasoning_effort: effort,
      strengths: route.description,
      executable: true,
    })),
  ]);
}

describe("per-CLI configuration and ops labels", () => {
  it("classifies mechanical units without treating mixed implementation as ops", () => {
    assert.equal(inferOpsAction("bun test"), "test");
    assert.equal(inferOpsAction("bun run build"), "build");
    assert.equal(inferOpsAction("write a commit message from staged files"), "git-summarize");
    assert.equal(inferOpsAction("git commit staged changes"), "git-commit");
    assert.equal(inferOpsAction("implement the parser and run its tests"), null);
    assert.equal(inferOpsActionFromContext("run the tests", "Android target"), "test");
    assert.equal(inferOpsActionFromContext("run the tests", "bun run build"), null);
  });

  it("configures Codex from its returned picker surface, including Mini and Spark", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const answers = [
        "1", // codex
        "6", // runner = Mini
        "4", // longctx = 5.5 (label only)
        "3,6,7", // Luna, Mini, Spark
        "yes",
      ];
      const out = capture();
      let prompts = 0;
      const code = await runConfig([], {
        cwd,
        env,
        stdout: out,
        discover: async () => structuredClone(CATALOG),
        readLine: async () => {
          prompts += 1;
          return answers.shift() || "";
        },
      });
      assert.equal(code, 0, out.text());
      assert.equal(prompts, 5);
      assert.match(out.text(), /5\.4 Mini \(gpt-5\.4-mini\)/);
      assert.match(out.text(), /5\.3 Codex Spark \(gpt-5\.3-codex-spark\)/);
      assert.match(out.text(), /no model confirmation UI/);

      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.active, "codex");
      assert.deepEqual(config.cli.codex, {
        enabled: true,
        runner: "gpt-5.4-mini",
        longctx: "gpt-5.5",
        subagent_models: ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.5"],
      });
      const parsed = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal((parsed.director as Record<string, unknown>).model_selection, undefined);
      assert.equal(((parsed.ops as { longctx: Record<string, unknown> }).longctx).min_context_tokens, undefined);
      assert.equal(readRouteSnapshot(cwd)?.routes.length, 7);
    });
  });

  it("supports non-interactive configuration and rejects the removed selector toggle", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-flags-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const out = capture();
      assert.equal(await runConfig([
        "--cli", "codex",
        "--runner", "gpt-5.4-mini",
        "--longctx", "-",
        "--subagent-model", "gpt-5.3-codex-spark",
        "--enable",
      ], { cwd, env, stdout: out, discover: async () => structuredClone(CATALOG) }), 0);
      assert.deepEqual(loadConfig(cwd, { env }).cli.codex.subagent_models, [
        "gpt-5.3-codex-spark",
        "gpt-5.4-mini",
      ]);
      const removed = capture();
      assert.equal(await run(["config", "model-selection", "on"], { cwd, env, stdout: removed, stderr: removed }), 1);
      assert.match(removed.text(), /MODEL_SELECTION_REMOVED/);
    });
  });

  it("writes Grok's host concurrent cap when the Grok CLI is selected", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-grok-cap-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(loadConfig(cwd, { env }).director.max_concurrent, 4);
      const grokCatalog: CliModelCatalog = {
        cli: "grok",
        version: "grok 1.0.8",
        models: [model("grok-4.5", "Grok 4.5", "Fast"), model("grok-4.6", "Grok 4.6", "Flagship")],
      };
      const out = capture();
      assert.equal(await runConfig([
        "--cli", "grok",
        "--runner", "grok-4.5",
        "--longctx", "-",
        "--subagent-model", "grok-4.5",
        "--enable",
      ], { cwd, env, stdout: out, discover: async () => structuredClone(grokCatalog) }), 0);
      assert.match(out.text(), /max_concurrent: 8/);
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.active, "grok");
      assert.equal(config.director.max_concurrent, 8);
    });
  });

  it("treats runner and longctx as labels over the same allowlist", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-labels-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex",
        "--runner", "gpt-5.4-mini",
        "--longctx", "gpt-5.3-codex-spark",
        "--subagent-model", "gpt-5.6-luna",
        "--enable",
      ], { cwd, env, stdout: capture(), discover: async () => structuredClone(CATALOG) }), 0);
      const available = cards(cwd);
      const runner = listOpsRouteChoices(cwd, "runner", available).map((choice) => choice.route_id).sort();
      const longctx = listOpsRouteChoices(cwd, "longctx", available).map((choice) => choice.route_id).sort();
      assert.deepEqual(runner, ["gpt-5.3-codex-spark", "gpt-5.4-mini", "gpt-5.6-luna"]);
      assert.deepEqual(longctx, runner);
      assert.ok(listOpsRouteChoices(cwd, "longctx", available).every((choice) => choice.context_window === null));

      const testRoute = resolveOpsDispatch(cwd, "bun test", available, { env });
      const searchRoute = resolveOpsDispatch(cwd, "rg parser", available, { env });
      assert.equal(testRoute.kind, "dispatch");
      assert.equal(testRoute.kind === "dispatch" ? testRoute.route : null, "gpt-5.4-mini");
      assert.equal(searchRoute.kind, "dispatch");
      assert.equal(searchRoute.kind === "dispatch" ? searchRoute.route : null, "gpt-5.3-codex-spark");
    });
  });

  it("returns no candidates when the CLI profile is disabled", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-disabled-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex", "--runner", "gpt-5.4-mini", "--longctx", "-",
        "--subagent-model", "all", "--disable",
      ], { cwd, env, stdout: capture(), discover: async () => structuredClone(CATALOG) }), 0);
      assert.deepEqual(listOpsRouteChoices(cwd, "runner", cards(cwd)), []);
      assert.equal(resolveOpsDispatch(cwd, "bun test", cards(cwd), { env }).kind, "director");
    });
  });
});
