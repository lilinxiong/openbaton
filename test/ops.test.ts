import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { runConfig } from "../src/commands/config.js";
import { cliProfileForHost, loadConfig, saveConfig } from "../src/lib/config.js";
import type { CliModel, CliModelCatalog } from "../src/adapters/contract.js";
import {
  isCommitOnlyClassification,
  normalizeAgentTaskClassification,
} from "../src/lib/ops-task.js";
import { listOpsRouteChoices } from "../src/lib/ops-routes.js";
import { resolveOpsDispatch } from "../src/lib/ops-dispatch.js";
import { configuredRouteForClassification, normalizeOpsConfig } from "../src/lib/ops-config.js";
import { readReceipt } from "../src/lib/receipt.js";
import { readRouteSnapshot } from "../src/lib/routes.js";
import { spawnsDir } from "../src/lib/paths.js";
import type { ModelCard } from "../src/types.js";
import { parseToml } from "../src/lib/toml.js";
import { withHome, fakeEnv } from "./home.js";
import { adapterProviderFor } from "./configure.js";

function spawnTicketFiles(cwd: string): string[] {
  const dir = spawnsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^spn-.*\.json$/.test(name));
}

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

function initializeGitFixture(cwd: string): void {
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd });
  execFileSync("git", ["config", "user.email", "validation@example.invalid"], { cwd });
  execFileSync("git", ["config", "user.name", "Validation"], { cwd });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "baseline"], { cwd });
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
  it("keeps only route labels and resolves them from structured class", () => {
    const config = normalizeOpsConfig({
      runner: { route: "" },
      longctx: { route: "" },
    });
    assert.deepEqual(config, { runner: { route: "" }, longctx: { route: "" } });
    const configured = normalizeOpsConfig({
      runner: { route: "gpt-5.4-mini" },
      longctx: { route: "gpt-5.5" },
    });
    assert.deepEqual(configuredRouteForClassification(configured, "mechanical"), { profile: "runner", route: "gpt-5.4-mini" });
    assert.deepEqual(configuredRouteForClassification(configured, "long-context"), { profile: "longctx", route: "gpt-5.5" });
    assert.equal(configuredRouteForClassification(configured, "git-commit"), null);
  });

  it("requires an explicit capability for commit-only authority", () => {
    const operationOnly = normalizeAgentTaskClassification({ kind: "mechanical", operation: "git-commit" });
    assert.equal(isCommitOnlyClassification(operationOnly), false);
    assert.equal(isCommitOnlyClassification({ kind: "mechanical", operation: "git-commit", capabilities: ["commit"] }), true);
    assert.equal(isCommitOnlyClassification({ kind: "mechanical", operation: "git-commit", capabilities: { commit_only: true } }), false);
    assert.equal(isCommitOnlyClassification({ kind: "mechanical", operation: "git-commit", mode: "commit-only" }), false);
  });

  it("configures Codex from its returned picker surface, including Mini and Spark", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const out = capture();
      const selects: unknown[] = [
        "gpt-5.4-mini",
        "gpt-5.5",
        true,
      ];
      const multiSelects: unknown[][] = [
        ["codex"],
        ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
      ];
      const code = await runConfig([], {
        cwd,
        env,
        stdout: out,
        adapterProvider: adapterProviderFor(CATALOG),
        prompt: {
          async select() {
            const value = selects.shift();
            if (value === undefined) throw new Error("unexpected select");
            return value as never;
          },
          async multiSelect() {
            const value = multiSelects.shift();
            if (!value) throw new Error("unexpected multiSelect");
            return value as never[];
          },
        },
      });
      assert.equal(code, 0, out.text());
      assert.equal(selects.length, 0);
      assert.equal(multiSelects.length, 0);
      assert.match(out.text(), /gpt-5\.4-mini/);
      assert.match(out.text(), /gpt-5\.3-codex-spark/);
      assert.match(out.text(), /no model confirmation UI/);

      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.codex.enabled, true);
      assert.deepEqual(config.cli.codex, {
        enabled: true,
        runner: "gpt-5.4-mini",
        longctx: "gpt-5.5",
        coding_models: ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
        guard_mode: "off",
      });
      const parsed = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((parsed.cli as Record<string, unknown>), "active"), false);
      assert.equal((parsed.director as Record<string, unknown>).model_selection, undefined);
      assert.equal(parsed.ops, undefined);
      assert.equal(readRouteSnapshot(cwd, { host: "codex" })?.routes.length, 7);
    });
  });

  it("configures each selected CLI in order", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-multi-cli-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const grokCatalog: CliModelCatalog = {
        cli: "grok",
        version: "grok 1.0.8",
        models: [model("grok-4.5", "Grok 4.5", "Fast"), model("grok-4.6", "Grok 4.6", "Flagship")],
      };
      const selects: unknown[] = [
        "gpt-5.4-mini",
        "gpt-5.5",
        true,
        "grok-4.5",
        "",
        true,
      ];
      const multiSelects: unknown[][] = [
        ["codex", "grok"],
        ["gpt-5.6-luna", "gpt-5.4-mini"],
        ["grok-4.5", "grok-4.6"],
      ];
      const out = capture();
      assert.equal(await runConfig([], {
        cwd,
        env,
        stdout: out,
        adapterProvider: adapterProviderFor((cli) => cli === "grok" ? grokCatalog : CATALOG),
        prompt: {
          async select() {
            const value = selects.shift();
            if (value === undefined) throw new Error("unexpected select");
            return value as never;
          },
          async multiSelect() {
            const value = multiSelects.shift();
            if (!value) throw new Error("unexpected multiSelect");
            return value as never[];
          },
        },
      }), 0, out.text());
      assert.equal(selects.length, 0);
      assert.equal(multiSelects.length, 0);
      assert.match(out.text(), /── codex \(1\/2\) ──/);
      assert.match(out.text(), /── grok \(2\/2\) ──/);
      assert.match(out.text(), /cli: codex/);
      assert.doesNotMatch(out.text(), /\bactive:/);

      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.codex.enabled, true);
      assert.equal(config.cli.grok.enabled, true);
      assert.equal(config.director.max_concurrent, 4);
      assert.deepEqual(config.cli.codex, {
        enabled: true,
        runner: "gpt-5.4-mini",
        longctx: "gpt-5.5",
        coding_models: ["gpt-5.6-luna", "gpt-5.4-mini"],
        guard_mode: "off",
      });
      assert.deepEqual(config.cli.grok, {
        enabled: true,
        runner: "grok-4.5",
        longctx: "",
        coding_models: ["grok-4.5", "grok-4.6"],
        guard_mode: "enforce",
      });
      const parsed = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((parsed.cli as Record<string, unknown>), "active"), false);
      assert.equal(readRouteSnapshot(cwd, { host: "codex" })?.cli, "codex");
      assert.equal(readRouteSnapshot(cwd, { host: "codex" })?.routes.length, 7);
    });
  });

  it("refuses interactive config without a TTY or flags", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-tty-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const out = capture();
      assert.equal(await run(["config"], {
        cwd, env, stdout: out, stderr: out, adapterProvider: adapterProviderFor(CATALOG),
      }), 1);
      assert.match(out.text(), /interactive config requires a TTY/);
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
        "--coding-model", "gpt-5.3-codex-spark",
        "--enable",
      ], { cwd, env, stdout: out, adapterProvider: adapterProviderFor(CATALOG) }), 0);
      assert.deepEqual(loadConfig(cwd, { env }).cli.codex.coding_models, [
        "gpt-5.3-codex-spark",
      ]);
      const removed = capture();
      assert.equal(await run(["config", "model-selection", "on"], { cwd, env, stdout: removed, stderr: removed }), 1);
      assert.match(removed.text(), /MODEL_SELECTION_REMOVED/);
    });
  });

  it("enables the Grok profile without writing a global active CLI", async () => {
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
        "--coding-model", "grok-4.5",
        "--enable",
      ], { cwd, env, stdout: out, adapterProvider: adapterProviderFor(grokCatalog) }), 0);
      assert.match(out.text(), /cli: grok \(enabled\)/);
      assert.doesNotMatch(out.text(), /\bactive:/);
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.grok.enabled, true);
      assert.equal(config.director.max_concurrent, 4);
      const parsed = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((parsed.cli as Record<string, unknown>), "active"), false);
    });
  });

  it("treats runner and longctx as labels over the same candidates", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-labels-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex",
        "--runner", "gpt-5.4-mini",
        "--longctx", "gpt-5.3-codex-spark",
        "--coding-model", "gpt-5.6-luna",
        "--enable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CATALOG) }), 0);
      const available = cards(cwd);
      const runner = listOpsRouteChoices(cwd, "runner", available, { env, host: "codex" }).map((choice) => choice.route_id).sort();
      const longctx = listOpsRouteChoices(cwd, "longctx", available, { env, host: "codex" }).map((choice) => choice.route_id).sort();
      assert.deepEqual(runner, ["gpt-5.3-codex-spark", "gpt-5.4-mini", "gpt-5.6-luna"]);
      assert.deepEqual(longctx, runner);
      assert.ok(listOpsRouteChoices(cwd, "longctx", available, { env, host: "codex" }).every((choice) => choice.context_window === null));

      const testRoute = resolveOpsDispatch(cwd, "bun test", available, {
        env,
        host: "codex",
        classification: { kind: "mechanical", operation: "test" },
      });
      const searchRoute = resolveOpsDispatch(cwd, "rg parser", available, {
        env,
        host: "codex",
        classification: { kind: "long-context", operation: "search" },
      });
      assert.equal(testRoute.kind, "dispatch");
      assert.equal(testRoute.kind === "dispatch" ? testRoute.route : null, "gpt-5.4-mini");
      assert.equal(searchRoute.kind, "dispatch");
      assert.equal(searchRoute.kind === "dispatch" ? searchRoute.route : null, "gpt-5.3-codex-spark");

      // Without a director classification, the active resolver never
      // converts request prose into a mechanical route.
      assert.equal(resolveOpsDispatch(cwd, "bun test", available, { env, host: "codex" }).kind, "blocked");
    });
  });

  it("routes the director's structured class directly and keeps operation labels as audit data", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-structured-classification-"));
      initializeGitFixture(cwd);
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex",
        "--runner", "gpt-5.4-mini",
        "--longctx", "gpt-5.3-codex-spark",
        "--coding-model", "all",
        "--enable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CATALOG) }), 0);
      const available = cards(cwd);

      const mechanical = resolveOpsDispatch(cwd, "search this repository", available, {
        env,
        host: "codex",
        classification: { kind: "mechanical", operation: "custom-audit-label" },
      });
      assert.equal(mechanical.kind, "dispatch");
      assert.equal(mechanical.kind === "dispatch" ? mechanical.profile : null, "runner");
      assert.equal(mechanical.kind === "dispatch" ? mechanical.route : null, "gpt-5.4-mini");
      assert.equal(mechanical.kind === "dispatch" ? mechanical.approval.ops_operation : null, "custom-audit-label");

      const longContext = resolveOpsDispatch(cwd, "run tests", available, {
        env,
        host: "codex",
        classification: { kind: "long-context", operation: "custom-long-audit" },
      });
      assert.equal(longContext.kind, "dispatch");
      assert.equal(longContext.kind === "dispatch" ? longContext.profile : null, "longctx");
      assert.equal(longContext.kind === "dispatch" ? longContext.route : null, "gpt-5.3-codex-spark");

      const cliOut = capture();
      assert.equal(await run([
        "spawn", "rename note", "--host", "codex",
        "--classification", "mechanical", "--operation", "custom-cli-label",
        "--json",
      ], { cwd, env, stdout: cliOut, stderr: cliOut }), 0, cliOut.text());
      const cliBody = JSON.parse(cliOut.text());
      assert.equal(cliBody.dispatched[0].operation, "custom-cli-label");
      assert.equal(cliBody.dispatched[0].profile, "runner");

      const operationOnlyOut = capture();
      assert.equal(await run([
        "spawn", "git commit staged changes", "--host", "codex",
        "--classification", "mechanical", "--operation", "git-commit",
        "--json",
      ], { cwd, env, stdout: operationOnlyOut, stderr: operationOnlyOut }), 0, operationOnlyOut.text());
      const operationOnlyBody = JSON.parse(operationOnlyOut.text());
      assert.notEqual(operationOnlyBody.dispatched[0].ticket.mode, "commit-only");

      // A non-ops structured class stays outside mechanical dispatch even
      // when its opaque operation label resembles a commit operation.
      assert.equal(resolveOpsDispatch(cwd, "bun test", available, {
        env,
        host: "codex",
        classification: { kind: "general", operation: "git-commit" },
      }).kind, "not-ops");
    });
  });

  it("materializes an explicit standalone write scope for direct mechanical dispatch", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-structured-write-scope-"));
      initializeGitFixture(cwd);
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex",
        "--runner", "gpt-5.4-mini",
        "--longctx", "gpt-5.3-codex-spark",
        "--coding-model", "all",
        "--enable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CATALOG) }), 0);

      const out = capture();
      assert.equal(await run([
        "spawn", "refresh dist artifacts", "--host", "codex",
        "--classification", "mechanical", "--operation", "git-commit",
        "--write-path", "dist/**", "--write-ops", "write,create,delete",
        "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const body = JSON.parse(out.text());
      const ticketId = String(body.dispatched[0].ticket.id);
      const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${ticketId}.json`), "utf8"));
      assert.equal(ticket.mode, "write");
      assert.equal(ticket.read_only, false);
      const receipt = readReceipt(cwd, String(ticket.receipt_id));
      assert.equal(receipt.execution.mode, "write");
      assert.deepEqual(receipt.scope.write_allowlist, ["dist/**"]);
      assert.deepEqual(receipt.scope.allowed_operations, ["write", "create", "delete"]);
      assert.equal(receipt.baseline.index_control_algorithm, "git-index-control-framed-sha256-v2");
      assert.equal(typeof receipt.baseline.index_control_entry_count, "number");
    });
  });

  it("blocks classified work when runner and longctx labels are empty", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-empty-labels-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.codex, undefined);
      assert.equal(cliProfileForHost(config, "codex").runner, "");
      assert.equal(cliProfileForHost(config, "codex").longctx, "");
      config.cli.codex = { enabled: true, runner: "", longctx: "", coding_models: [], guard_mode: "off" };
      saveConfig(cwd, config, { env });
      const testOps = resolveOpsDispatch(cwd, "bun test", cards(cwd), {
        env, host: "codex", classification: { kind: "mechanical", operation: "test" },
      });
      assert.equal(testOps.kind, "blocked");
      const commitOps = resolveOpsDispatch(cwd, "git commit staged changes", cards(cwd), {
        env, host: "codex", classification: { kind: "mechanical", operation: "git-commit" },
      });
      assert.equal(commitOps.kind, "blocked");
      const summarizeOps = resolveOpsDispatch(cwd, "write a commit message from staged files", cards(cwd), {
        env, host: "codex", classification: { kind: "long-context", operation: "git-summarize" },
      });
      assert.equal(summarizeOps.kind, "blocked");
      const searchOps = resolveOpsDispatch(cwd, "rg parser", cards(cwd), {
        env, host: "codex", classification: { kind: "long-context", operation: "search" },
      });
      assert.equal(searchOps.kind, "blocked");

      for (const text of [
        "bun test",
        "write a commit message from staged files",
        "rg parser",
      ]) {
        const out = capture();
        assert.equal(await run(["spawn", text, "--host", "codex"], { cwd, env, stdout: out, stderr: out }), 1, out.text());
        assert.match(out.text(), /CLASSIFICATION_REQUIRED|OPS_ROUTE_UNAVAILABLE/);
        assert.deepEqual(spawnTicketFiles(cwd), []);

        const dispatchOut = capture();
        assert.equal(await run(["spawn", text, "--host", "codex", "--dispatch"], {
          cwd, env, stdout: dispatchOut, stderr: dispatchOut,
        }), 1, dispatchOut.text());
        assert.match(dispatchOut.text(), /CLASSIFICATION_REQUIRED|OPS_ROUTE_UNAVAILABLE/);
        assert.deepEqual(spawnTicketFiles(cwd), []);
      }
    });
  });

  it("does not invent a model when unclassified spawn has no automatic candidate", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-unclassified-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex", "--runner", "gpt-5.4-mini", "--longctx", "-",
        "--coding-model", "all", "--disable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CATALOG) }), 0);
      assert.equal(loadConfig(cwd, { env }).cli.codex.enabled, false);

      const out = capture();
      const code = await run(["spawn", "implement the parser module", "--host", "codex"], {
        cwd, env, stdout: out, stderr: out,
      });
      const text = out.text();
      assert.ok(
        code === 0 && /bypassed|ACTIVATION_DISABLED/i.test(text)
          || code === 1 && /MODEL_RECOMMENDATION_UNAVAILABLE|no automatic configured candidate/i.test(text),
        text,
      );
      assert.doesNotMatch(text, /\b(?:gpt|grok)-[^\s]*/i);
      assert.deepEqual(spawnTicketFiles(cwd), []);
    });
  });

  it("returns no candidates when the CLI profile is disabled", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-disabled-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      assert.equal(await runConfig([
        "--cli", "codex", "--runner", "gpt-5.4-mini", "--longctx", "-",
        "--coding-model", "all", "--disable",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(CATALOG) }), 0);
      assert.deepEqual(listOpsRouteChoices(cwd, "runner", cards(cwd), { env, host: "codex" }), []);
      assert.equal(resolveOpsDispatch(cwd, "bun test", cards(cwd), {
        env, host: "codex", classification: { kind: "mechanical", operation: "test" },
      }).kind, "blocked");
    });
  });
});
