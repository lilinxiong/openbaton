import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import type { CliAdapterProvider, CliModel, CliModelCatalog } from "../src/adapters/contract.js";
import { saveConfig } from "../src/lib/config.js";
import { fixtureAdapterEnv } from "./home.js";

function model(id: string, options: Partial<CliModel & Record<string, unknown>> = {}): CliModel {
  return {
    id,
    model: id,
    display_name: id,
    description: "",
    hidden: false,
    reasoning_efforts: [{ id: "low", description: "" }, { id: "medium", description: "" }, { id: "high", description: "" }],
    default_reasoning_effort: "medium",
    input_modalities: ["text"],
    additional_speed_tiers: [],
    service_tiers: [{ id: "priority", name: "Priority", description: "" }],
    default_service_tier: null,
    is_default: false,
    ...options,
  };
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-native-"));
  const cwd = path.join(home, "project");
  fs.mkdirSync(cwd);
  const env = fixtureAdapterEnv({ HOME: home, USERPROFILE: home, ALPHA_HOST: "", BETA_HOST: "", BATON_HOST: "" });
  saveConfig(cwd, {
    cli: {
      alpha: {
        enabled: true,
        coding_models: ["small", "large", "hidden"],
        execution_models: ["small", "large"],
        implementation_models: ["large", "small"],
      },
      beta: { enabled: true, coding_models: ["beta-model"] },
    },
  }, { env });
  const catalogs: Record<string, CliModelCatalog> = {
    alpha: {
      cli: "alpha",
      adapter_id: "alpha",
      version: "test",
      models: [
        model("small", { context_tokens: 100, reasoning_efforts: [{ id: "low", description: "" }], default_reasoning_effort: "low", service_tiers: [] }),
        model("large", { context_tokens: 1_000 }),
        model("hidden", { hidden: true }),
      ],
    },
    beta: { cli: "beta", adapter_id: "beta", version: "test", models: [model("beta-model")] },
  };
  const provider: CliAdapterProvider = (host) => ({ discoverModels: async () => structuredClone(catalogs[host]) });
  return { home, cwd, env, provider };
}

async function invoke(argv: string[], context: ReturnType<typeof setup>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: context.cwd,
    env: context.env,
    adapterProvider: context.provider,
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("native Baton CLI", () => {
  it("uses mode priority and skips candidates that fail explicit constraints", async () => {
    const context = setup();
    const byMode = await invoke(["match", "--host", "alpha", "--work-mode", "implementation", "--json"], context);
    assert.equal(byMode.code, 0);
    assert.equal(JSON.parse(byMode.stdout).model_id, "large");

    const byContext = await invoke(["match", "--host", "alpha", "--context-tokens", "200", "--json"], context);
    assert.equal(JSON.parse(byContext.stdout).model_id, "large");
    const byEffort = await invoke(["match", "--host", "alpha", "--effort", "high", "--json"], context);
    assert.equal(JSON.parse(byEffort.stdout).model_id, "large");
    const byTier = await invoke(["match", "--host", "alpha", "--service-tier", "priority", "--json"], context);
    assert.equal(JSON.parse(byTier.stdout).model_id, "large");
    const unavailable = await invoke(["match", "--host", "alpha", "--unavailable-model", "small", "--json"], context);
    assert.equal(JSON.parse(unavailable.stdout).model_id, "large");
    const fallback = await invoke(["match", "--host", "alpha", "--model", "small", "--work-mode", "investigation", "--json"], context);
    assert.equal(JSON.parse(fallback.stdout).reasoning_effort, "low");
    assert.match(JSON.parse(fallback.stdout).disclosures[0], /catalog default low/);

    const mismatch = await invoke(["match", "--host", "alpha", "--model", "small", "--effort", "high"], context);
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.stderr, /EFFORT_UNSUPPORTED/);
  });

  it("prevents cross-host execution when native invocation evidence exists", async () => {
    const context = setup();
    context.env.ALPHA_HOST = "native-alpha";
    const result = await invoke(["models", "--host", "beta", "--json"], context);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /HOST_MISMATCH/);

    context.env.BATON_HOST = "beta";
    const conflicting = await invoke(["match", "--json"], context);
    assert.equal(conflicting.code, 1);
    assert.match(conflicting.stderr, /invocation signals disagree/);
  });

  it("emits native spawn arguments with the exact catalog model id and no ticket", async () => {
    const context = setup();
    const brief = path.join(context.cwd, "brief.json");
    fs.writeFileSync(brief, JSON.stringify({
      goal: "Implement selection",
      acceptance: ["Focused tests pass"],
      scope: ["src/lib/native.ts"],
      mode: "write",
    }));
    const result = await invoke(["spawn", "--brief", brief, "--host", "alpha", "--model", "large", "--effort", "high", "--json"], context);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.model_id, "large");
    assert.equal(payload.reasoning_effort, "high");
    assert.equal(payload.fork_context, false);
    assert.equal(payload.spawned, false);
    assert.equal(payload.mode, "write");
    assert.match(payload.prompt, /Implement selection/);
    assert.equal("ticket" in payload || "ticket_id" in payload || "reservation" in payload, false);
    assert.equal(fs.existsSync(path.join(context.home, ".baton", "spawns")), false);
  });

  it("records append-only terminal results and status returns the latest 20 for cwd and host", async () => {
    const context = setup();
    for (let index = 0; index < 22; index += 1) {
      const result = await invoke([
        "record", "--host", "alpha", "--handle", `task-${index}`, "--model", "large",
        "--status", "completed", "--text", `result ${index}`, "--json",
      ], context);
      assert.equal(result.code, 0);
    }
    const status = await invoke(["status", "--host", "alpha", "--json"], context);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.results.length, 20);
    assert.equal(payload.results[0].native_handle, "task-21");
    assert.equal(payload.results.at(-1).native_handle, "task-2");
    assert.deepEqual(Object.keys(payload.results[0]).sort(), ["cwd", "host", "model", "native_handle", "result", "status", "timestamp"]);
  });
  it("rejects unavailable or hidden explicit models and retired commands without creating runtime state", async () => {
    const context = setup();
    for (const args of [
      ["--model", "hidden"],
      ["--model", "foreign"],
      ["--model", "small", "--unavailable-model", "small"],
      ["--model", "small", "--service-tier", "fast"],
    ]) {
      assert.equal((await invoke(["match", "--host", "alpha", ...args], context)).code, 1);
    }
    assert.equal((await invoke(["dispatch", "next", "--host", "alpha"], context)).code, 2);
    assert.deepEqual(fs.readdirSync(path.join(context.home, ".baton")), ["config.toml"]);
  });

  it("discloses unknown context and catalog-default effort without inferring requirements", async () => {
    const context = setup();
    const provider = context.provider;
    context.provider = (host) => ({ discoverModels: async () => {
      const catalog = await provider(host).discoverModels();
      catalog.models = [model("small", { reasoning_efforts: [{ id: "medium", description: "" }] })];
      return catalog;
    } });
    const result = await invoke(["match", "--host", "alpha", "--context-tokens", "1000000", "--json"], context);
    assert.equal(result.code, 0, result.stderr);
    const selected = JSON.parse(result.stdout);
    assert.equal(selected.context_capacity, "unknown");
    assert.equal(selected.reasoning_effort, "medium");
    assert.ok(selected.disclosures.some((text) => text.includes("catalog default")));
    assert.ok(selected.disclosures.some((text) => text.includes("capacity unknown")));
    const brief = path.join(context.cwd, "brief.json");
    fs.writeFileSync(brief, JSON.stringify({ goal: "Check facts", acceptance: ["Report findings"] }));
    const spawned = await invoke(["spawn", "--brief", brief, "--host", "alpha", "--context-tokens", "1000000", "--json"], context);
    assert.equal(spawned.code, 0, spawned.stderr);
    const payload = JSON.parse(spawned.stdout);
    assert.equal(payload.context_capacity, "unknown");
    assert.deepEqual(payload.disclosures, selected.disclosures);

  });

});
