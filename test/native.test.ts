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
        execution_models: ["small", "large", "hidden"],
        implementation_models: ["large", "small"],
      },
      beta: { enabled: true, execution_models: ["beta-model"] },
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
  it("never falls back to another mode pool or accepts an explicit foreign-pool model", async () => {
    const context = setup();
    saveConfig(context.cwd, { cli: { alpha: {
      enabled: true,
      execution_models: ["small"],
      implementation_models: ["large"],
    } } }, { env: context.env });
    const empty = await invoke(["match", "--host", "alpha", "--work-mode", "investigation"], context);
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /NO_MODE_MODELS.*investigation/);
    const unavailable = await invoke(["match", "--host", "alpha", "--unavailable-model", "small"], context);
    assert.equal(unavailable.code, 1);
    assert.match(unavailable.stderr, /NO_ELIGIBLE_MODEL/);
    const explicit = await invoke(["match", "--host", "alpha", "--model", "large"], context);
    assert.equal(explicit.code, 1);
    assert.match(explicit.stderr, /MODEL_NOT_ALLOWED/);
    const unsupported = await invoke(["match", "--host", "alpha", "--effort", "high"], context);
    assert.equal(unsupported.code, 1);
    assert.match(unsupported.stderr, /NO_ELIGIBLE_MODEL/);
  });

  it("uses caller effort independently of all three work modes", async () => {
    const context = setup();
    saveConfig(context.cwd, { cli: { alpha: {
      enabled: true,
      execution_models: ["large"],
      implementation_models: ["large"],
      investigation_models: ["large"],
    } } }, { env: context.env });
    for (const mode of ["execution", "implementation", "investigation"]) {
      const omitted = await invoke(["match", "--host", "alpha", "--work-mode", mode, "--json"], context);
      assert.equal(omitted.code, 0);
      assert.equal("reasoning_effort" in JSON.parse(omitted.stdout), false);
      for (const effort of ["low", "medium", "high"]) {
        const chosen = await invoke(["match", "--host", "alpha", "--work-mode", mode, "--effort", effort, "--json"], context);
        assert.equal(chosen.code, 0);
        assert.equal(JSON.parse(chosen.stdout).reasoning_effort, effort);
      }
    }
  });

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

  it("prepares batch handoffs with one catalog selection and preserves single-brief payloads", async () => {
    const context = setup();
    const first = { goal: "Implement selection", acceptance: ["Focused tests pass"], scope: ["src/lib/native.ts"], mode: "write" };
    const second = { goal: "Review result", acceptance: ["Return findings"] };
    const singleFile = path.join(context.cwd, "single.json");
    const batchFile = path.join(context.cwd, "batch.json");
    fs.writeFileSync(singleFile, JSON.stringify(first));
    fs.writeFileSync(batchFile, JSON.stringify([first, second]));
    let discoveries = 0;
    const provider = context.provider;
    context.provider = (host) => ({ discoverModels: async (options) => {
      discoveries += 1;
      return provider(host).discoverModels(options);
    } });

    const single = await invoke(["spawn", "--brief", singleFile, "--host", "alpha", "--json"], context);
    assert.equal(single.code, 0, single.stderr);
    const singlePayload = JSON.parse(single.stdout);
    assert.equal("brief_diagnostics" in singlePayload, false);

    discoveries = 0;
    const batch = await invoke(["spawn", "--briefs", batchFile, "--host", "alpha", "--json"], context);
    assert.equal(batch.code, 0, batch.stderr);
    const batchPayload = JSON.parse(batch.stdout);
    assert.deepEqual(Object.keys(batchPayload), ["handoffs"]);
    assert.equal(batchPayload.handoffs.length, 2);
    assert.deepEqual(batchPayload.handoffs[0], singlePayload);
    assert.match(batchPayload.handoffs[1].prompt, /Review result/);
    assert.equal(discoveries, 1);

    const overBudget = await invoke(["spawn", "--brief", singleFile, "--brief-budget-chars", "1", "--host", "alpha", "--json"], context);
    assert.equal(overBudget.code, 0, overBudget.stderr);
    assert.equal(JSON.parse(overBudget.stdout).brief_diagnostics.over_budget, true);
  });

  it("rejects empty and malformed batches before catalog discovery", async () => {
    const context = setup();
    let discoveries = 0;
    const provider = context.provider;
    context.provider = (host) => ({ discoverModels: async (options) => {
      discoveries += 1;
      return provider(host).discoverModels(options);
    } });
    for (const [name, contents, expected] of [
      ["empty", "[]", /non-empty JSON array/],
      ["object", "{}", /non-empty JSON array/],
      ["invalid", JSON.stringify([{ goal: "", acceptance: [] }]), /WORKER_BRIEF_INVALID/],
      ["too-many", JSON.stringify(Array.from({ length: 129 }, () => ({ goal: "Check", acceptance: ["Report"] }))), /at most 128/],
    ] as const) {
      const file = path.join(context.cwd, `${name}.json`);
      fs.writeFileSync(file, contents);
      const result = await invoke(["spawn", "--briefs", file, "--host", "alpha"], context);
      assert.equal(result.code, 1);
      assert.match(result.stderr, expected);
    }
    const singleFile = path.join(context.cwd, "single.json");
    const batchFile = path.join(context.cwd, "valid-batch.json");
    fs.writeFileSync(singleFile, JSON.stringify({ goal: "Check", acceptance: ["Report"] }));
    fs.writeFileSync(batchFile, JSON.stringify([{ goal: "Check", acceptance: ["Report"] }]));
    const exclusive = await invoke(["spawn", "--brief", singleFile, "--briefs", batchFile, "--host", "alpha"], context);
    assert.equal(exclusive.code, 1);
    assert.match(exclusive.stderr, /mutually exclusive/);
    const invalidBudget = await invoke(["spawn", "--brief", singleFile, "--brief-budget-chars", "0", "--host", "alpha"], context);
    assert.equal(invalidBudget.code, 1);
    assert.match(invalidBudget.stderr, /brief-budget-chars must be a positive integer/);
    assert.equal(discoveries, 0);
  });

  it("reads each installed manifest once for a batch using the default provider", async () => {
    const context = setup();
    saveConfig(context.cwd, { cli: { alpha: { enabled: true, execution_models: ["alpha-model"] } } }, { env: context.env });
    const batchFile = path.join(context.cwd, "default-provider-batch.json");
    fs.writeFileSync(batchFile, JSON.stringify([
      { goal: "Check catalog", acceptance: ["Report"] },
      { goal: "Check catalog again", acceptance: ["Report"] },
    ]));
    const output: string[] = [];
    const errors: string[] = [];
    const mutableFs = fs as typeof fs & { readFileSync: (...args: any[]) => any };
    const originalReadFileSync = mutableFs.readFileSync;
    let manifestReads = 0;
    mutableFs.readFileSync = (...args: any[]) => {
      if (String(args[0]).endsWith("adapter.json")) manifestReads += 1;
      return originalReadFileSync(...args);
    };
    try {
      const code = await run(["spawn", "--briefs", batchFile, "--host", "alpha", "--json"], {
        cwd: context.cwd,
        env: context.env,
        stdout: { write: (text) => output.push(text) },
        stderr: { write: (text) => errors.push(text) },
      });
      assert.equal(code, 0, errors.join(""));
      assert.equal(JSON.parse(output.join("")).handoffs.length, 2);
      assert.equal(manifestReads, 2);
    } finally {
      mutableFs.readFileSync = originalReadFileSync;
    }
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

  it("leaves omitted effort to the host even when the catalog advertises a default", async () => {
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
    assert.equal("reasoning_effort" in selected, false);
    assert.ok(selected.disclosures.some((text) => text.includes("effort not specified")));
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
