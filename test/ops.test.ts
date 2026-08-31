import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { runConfig } from "../src/commands/config.js";
import { cliProfileForHost, loadConfig, saveConfig } from "../src/lib/config.js";
import type { CliModelCatalog } from "../src/adapters/contract.js";
import { getCliAdapter } from "../src/adapters/registry.js";
import {
  isCommitOnlyClassification,
  normalizeAgentTaskClassification,
} from "../src/lib/ops-task.js";
import { listOpsRouteChoices } from "../src/lib/ops-routes.js";
import { resolveOpsDispatch } from "../src/lib/ops-dispatch.js";
import { configuredRouteForClassification, normalizeOpsConfig } from "../src/lib/ops-config.js";
import { readReceipt } from "../src/lib/receipt.js";
import { publishRouteSnapshot, readRouteSnapshot } from "../src/lib/routes.js";
import { spawnsDir } from "../src/lib/paths.js";
import type { ModelCard } from "../src/types.js";
import { parseToml } from "../src/lib/toml.js";
import { withHome, fakeEnv } from "./home.js";
import { adapterProviderFor } from "./configure.js";

type FixtureHost = "alpha" | "beta";

const ALPHA: FixtureHost = "alpha";
const BETA: FixtureHost = "beta";

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

async function manifestCatalog(host: FixtureHost, env: NodeJS.ProcessEnv): Promise<CliModelCatalog> {
  return getCliAdapter(host, env).discoverModels({ env });
}

function modelId(catalog: CliModelCatalog): string {
  const id = catalog.models[0]?.id;
  assert.ok(id, `${catalog.cli} manifest catalog must expose a model`);
  return id;
}

function publishManifestCatalog(cwd: string, host: FixtureHost, catalog: CliModelCatalog): void {
  publishRouteSnapshot(cwd, { models: catalog.models }, new Date(), { cli: host, host });
}

function cards(cwd: string, host: FixtureHost): ModelCard[] {
  return (readRouteSnapshot(cwd, { host })?.routes || []).flatMap((route) => [
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

describe("configured mechanical operations", () => {
  it("keeps only route labels and resolves them from structured class", () => {
    const config = normalizeOpsConfig({
      runner: { route: "" },
      longctx: { route: "" },
    });
    assert.deepEqual(config, { runner: { route: "" }, longctx: { route: "" } });
    const configured = normalizeOpsConfig({
      runner: { route: "alpha-model" },
      longctx: { route: "beta-model" },
    });
    assert.deepEqual(configuredRouteForClassification(configured, "mechanical"), { profile: "runner", route: "alpha-model" });
    assert.deepEqual(configuredRouteForClassification(configured, "long-context"), { profile: "longctx", route: "beta-model" });
    assert.equal(configuredRouteForClassification(configured, "audit-label"), null);
  });

  it("requires an explicit capability for commit-only authority", () => {
    const operationOnly = normalizeAgentTaskClassification({ kind: "mechanical", operation: "commit-audit" });
    assert.equal(isCommitOnlyClassification(operationOnly), false);
    assert.equal(isCommitOnlyClassification({ kind: "mechanical", operation: "commit-audit", capabilities: ["commit"] }), true);
    assert.equal(isCommitOnlyClassification({ kind: "mechanical", operation: "commit-audit", capabilities: { commit_only: true } }), false);
    assert.equal(isCommitOnlyClassification({ kind: "mechanical", operation: "commit-audit", mode: "commit-only" }), false);
  });

  it("configures Alpha from its manifest catalog", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-alpha-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const catalog = await manifestCatalog(ALPHA, env);
      const model = modelId(catalog);
      const out = capture();
      const selects: unknown[] = [model, model];
      const multiSelects: unknown[][] = [[ALPHA], [model]];
      const code = await runConfig([], {
        cwd,
        env,
        stdout: out,
        adapterProvider: adapterProviderFor(catalog),
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
      assert.match(out.text(), new RegExp(model));
      assert.match(out.text(), /no model confirmation UI/);
      assert.match(out.text(), /max_concurrent_subagents: .*root-agent tree, root excluded/);
      assert.doesNotMatch(out.text(), /\bmax_concurrent=/);

      const config = loadConfig(cwd, { env });
      assert.deepEqual(config.cli[ALPHA], {
        runner: model,
        longctx: model,
        coding_models: [model],
        max_concurrent: 2,
        max_depth: 3,
      });
      const parsed = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((parsed.cli as Record<string, unknown>), "active"), false);
      assert.equal((parsed.director as Record<string, unknown>).model_selection, undefined);
      assert.equal(parsed.ops, undefined);
      assert.equal(readRouteSnapshot(cwd, { host: ALPHA })?.routes.length, catalog.models.length);
    });
  });

  it("configures each selected manifest adapter in order", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-multi-adapter-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const alphaCatalog = await manifestCatalog(ALPHA, env);
      const betaCatalog = await manifestCatalog(BETA, env);
      const alphaModel = modelId(alphaCatalog);
      const betaModel = modelId(betaCatalog);
      const selects: unknown[] = [alphaModel, alphaModel, betaModel, ""];
      const multiSelects: unknown[][] = [[ALPHA, BETA], [alphaModel], [betaModel]];
      const out = capture();
      assert.equal(await runConfig([], {
        cwd,
        env,
        stdout: out,
        adapterProvider: adapterProviderFor((cli) => cli === BETA ? betaCatalog : alphaCatalog),
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
      assert.match(out.text(), /── alpha \(1\/2\) ──/);
      assert.match(out.text(), /── beta \(2\/2\) ──/);
      assert.match(out.text(), /cli: alpha/);
      assert.doesNotMatch(out.text(), /\bactive:/);

      const config = loadConfig(cwd, { env });
      assert.equal(config.director.max_concurrent, 4);
      assert.deepEqual(config.cli[ALPHA], {
        runner: alphaModel,
        longctx: alphaModel,
        coding_models: [alphaModel],
        max_concurrent: 2,
        max_depth: 3,
      });
      assert.deepEqual(config.cli[BETA], {
        runner: betaModel,
        longctx: "",
        coding_models: [betaModel],
        max_concurrent: 5,
      });
      const parsed = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((parsed.cli as Record<string, unknown>), "active"), false);
      assert.equal(readRouteSnapshot(cwd, { host: ALPHA })?.cli, ALPHA);
      assert.equal(readRouteSnapshot(cwd, { host: BETA })?.cli, BETA);
    });
  });

  it("refuses interactive config without a TTY or flags", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-tty-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const catalog = await manifestCatalog(ALPHA, env);
      const out = capture();
      assert.equal(await run(["config"], {
        cwd, env, stdout: out, stderr: out, adapterProvider: adapterProviderFor(catalog),
      }), 1);
      assert.match(out.text(), /interactive config requires a TTY/);
    });
  });

  it("supports non-interactive configuration and keeps automatic selection", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-flags-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const catalog = await manifestCatalog(ALPHA, env);
      const model = modelId(catalog);
      const out = capture();
      assert.equal(await runConfig([
        "--cli", ALPHA,
        "--runner", model,
        "--longctx", "-",
        "--coding-model", model,
      ], { cwd, env, stdout: out, adapterProvider: adapterProviderFor(catalog) }), 0);
      assert.deepEqual(loadConfig(cwd, { env }).cli[ALPHA]?.coding_models, [model]);
      const removed = capture();
      assert.equal(await run(["config", "unsupported-subcommand", "on"], { cwd, env, stdout: removed, stderr: removed }), 1);
      assert.match(removed.text(), /unknown config argument/);
    });
  });

  it("configures the Beta profile without a global active selection", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-config-beta-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const catalog = await manifestCatalog(BETA, env);
      const model = modelId(catalog);
      const out = capture();
      assert.equal(await runConfig([
        "--cli", BETA,
        "--runner", model,
        "--longctx", "-",
        "--coding-model", model,
      ], { cwd, env, stdout: out, adapterProvider: adapterProviderFor(catalog) }), 0);
      assert.match(out.text(), /cli: beta/);
      assert.doesNotMatch(out.text(), /\bactive:/);
      const config = loadConfig(cwd, { env });
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
      const catalog = await manifestCatalog(ALPHA, env);
      const model = modelId(catalog);
      assert.equal(await runConfig([
        "--cli", ALPHA,
        "--runner", model,
        "--longctx", model,
        "--coding-model", model,
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(catalog) }), 0);
      const available = cards(cwd, ALPHA);
      const runner = listOpsRouteChoices(cwd, "runner", available, { env, host: ALPHA }).map((choice) => choice.route_id);
      const longctx = listOpsRouteChoices(cwd, "longctx", available, { env, host: ALPHA }).map((choice) => choice.route_id);
      assert.deepEqual(runner, [model]);
      assert.deepEqual(longctx, runner);
      assert.ok(listOpsRouteChoices(cwd, "longctx", available, { env, host: ALPHA }).every((choice) => choice.context_window === null));

      const testRoute = resolveOpsDispatch(cwd, "run checks", available, {
        env,
        host: ALPHA,
        classification: { kind: "mechanical", operation: "verification" },
      });
      const searchRoute = resolveOpsDispatch(cwd, "inspect source", available, {
        env,
        host: ALPHA,
        classification: { kind: "long-context", operation: "inspection" },
      });
      assert.equal(testRoute.kind, "dispatch");
      assert.equal(testRoute.kind === "dispatch" ? testRoute.route : null, model);
      assert.equal(searchRoute.kind, "dispatch");
      assert.equal(searchRoute.kind === "dispatch" ? searchRoute.route : null, model);
      assert.equal(resolveOpsDispatch(cwd, "run checks", available, { env, host: ALPHA }).kind, "blocked");
    });
  });

  it("routes the director class and keeps operation labels as audit data", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-structured-classification-"));
      initializeGitFixture(cwd);
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const catalog = await manifestCatalog(ALPHA, env);
      const model = modelId(catalog);
      assert.equal(await runConfig([
        "--cli", ALPHA,
        "--runner", model,
        "--longctx", model,
        "--coding-model", "all",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(catalog) }), 0);
      const available = cards(cwd, ALPHA);

      const mechanical = resolveOpsDispatch(cwd, "inspect source", available, {
        env,
        host: ALPHA,
        classification: { kind: "mechanical", operation: "audit-label" },
      });
      assert.equal(mechanical.kind, "dispatch");
      assert.equal(mechanical.kind === "dispatch" ? mechanical.profile : null, "runner");
      assert.equal(mechanical.kind === "dispatch" ? mechanical.route : null, model);
      assert.equal(mechanical.kind === "dispatch" ? mechanical.approval.ops_operation : null, "audit-label");

      const longContext = resolveOpsDispatch(cwd, "inspect source", available, {
        env,
        host: ALPHA,
        classification: { kind: "long-context", operation: "long-audit" },
      });
      assert.equal(longContext.kind, "dispatch");
      assert.equal(longContext.kind === "dispatch" ? longContext.profile : null, "longctx");
      assert.equal(longContext.kind === "dispatch" ? longContext.route : null, model);

      const cliOut = capture();
      assert.equal(await run([
        "spawn", "rename note", "--host", ALPHA,
        "--classification", "mechanical", "--operation", "cli-audit",
        "--json",
      ], { cwd, env, stdout: cliOut, stderr: cliOut }), 0, cliOut.text());
      const cliBody = JSON.parse(cliOut.text());
      assert.equal(cliBody.dispatched[0].operation, "cli-audit");
      assert.equal(cliBody.dispatched[0].profile, "runner");

      const operationOnlyOut = capture();
      assert.equal(await run([
        "spawn", "record an audit", "--host", ALPHA,
        "--classification", "mechanical", "--operation", "commit-audit",
        "--json",
      ], { cwd, env, stdout: operationOnlyOut, stderr: operationOnlyOut }), 0, operationOnlyOut.text());
      const operationOnlyBody = JSON.parse(operationOnlyOut.text());
      assert.notEqual(operationOnlyBody.dispatched[0].ticket.mode, "commit-only");

      assert.equal(resolveOpsDispatch(cwd, "run checks", available, {
        env,
        host: ALPHA,
        classification: { kind: "general", operation: "commit-audit" },
      }).kind, "not-ops");
    });
  });

  it("materializes an explicit write scope for mechanical dispatch", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-structured-write-scope-"));
      initializeGitFixture(cwd);
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const catalog = await manifestCatalog(ALPHA, env);
      const model = modelId(catalog);
      assert.equal(await runConfig([
        "--cli", ALPHA,
        "--runner", model,
        "--longctx", model,
        "--coding-model", "all",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(catalog) }), 0);

      const out = capture();
      assert.equal(await run([
        "spawn", "refresh generated artifacts", "--host", ALPHA,
        "--classification", "mechanical", "--operation", "write-audit",
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

  it("blocks classified work when route labels are empty", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-empty-labels-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli[ALPHA], undefined);
      assert.equal(cliProfileForHost(config, ALPHA).runner, "");
      assert.equal(cliProfileForHost(config, ALPHA).longctx, "");
      config.cli[ALPHA] = { runner: "", longctx: "", coding_models: [] };
      saveConfig(cwd, config, { env });
      const available = cards(cwd, ALPHA);
      for (const classification of ["mechanical", "long-context"] as const) {
        const result = resolveOpsDispatch(cwd, "inspect source", available, {
          env, host: ALPHA, classification: { kind: classification, operation: "audit" },
        });
        assert.equal(result.kind, "blocked");
      }

      for (const text of ["run checks", "inspect source"]) {
        const out = capture();
        assert.equal(await run(["spawn", text, "--host", ALPHA], { cwd, env, stdout: out, stderr: out }), 1, out.text());
        assert.match(out.text(), /CLASSIFICATION_REQUIRED|OPS_ROUTE_UNAVAILABLE/);
        assert.deepEqual(spawnTicketFiles(cwd), []);

        const dispatchOut = capture();
        assert.equal(await run(["spawn", text, "--host", ALPHA, "--dispatch"], {
          cwd, env, stdout: dispatchOut, stderr: dispatchOut,
        }), 1, dispatchOut.text());
        assert.match(dispatchOut.text(), /CLASSIFICATION_REQUIRED|OPS_ROUTE_UNAVAILABLE/);
        assert.deepEqual(spawnTicketFiles(cwd), []);
      }
    });
  });

  it("does not invent a model without a director classification", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-unclassified-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const catalog = await manifestCatalog(ALPHA, env);
      const model = modelId(catalog);
      assert.equal(await runConfig([
        "--cli", ALPHA, "--runner", model, "--longctx", "-",
        "--coding-model", "all",
      ], { cwd, env, stdout: capture(), adapterProvider: adapterProviderFor(catalog) }), 0);

      const out = capture();
      assert.equal(await run(["spawn", "implement the parser module", "--host", ALPHA], {
        cwd, env, stdout: out, stderr: out,
      }), 1, out.text());
      assert.match(out.text(), /CLASSIFICATION_REQUIRED/);
      assert.doesNotMatch(out.text(), /alpha-model|beta-model/);
      assert.deepEqual(spawnTicketFiles(cwd), []);
    });
  });
});
