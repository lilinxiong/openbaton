import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  discoverCliModels,
  discoverGrokModels,
  normalizeCodexModels,
  normalizeGrokModels,
  parseGrokModelText,
  resolveCodexCommand,
  resolveGrokCommand,
} from "../src/lib/cli-models.js";
import type { CodedError } from "../src/types.js";

describe("Codex CLI model adapter", () => {
  it("keeps the exact picker-visible surface, including Mini and Spark", () => {
    const models = normalizeCodexModels({ data: [
      {
        id: "gpt-5.4-mini",
        model: "gpt-5.4-mini",
        displayName: "5.4 Mini",
        description: "Small, fast coding model",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "high", description: "More reasoning" },
        ],
        defaultReasoningEffort: "low",
        additionalSpeedTiers: ["fast"],
        serviceTiers: [{ id: "priority", name: "Priority", description: "Low latency" }],
      },
      {
        id: "gpt-5.3-codex-spark",
        displayName: "5.3 Codex Spark",
        description: "Ultra-fast coding model",
        supportedReasoningEfforts: [{ id: "medium", description: "Balanced" }],
      },
      { id: "hidden-model", displayName: "Hidden", hidden: true },
    ] });

    assert.deepEqual(models.map((model) => model.id), ["gpt-5.4-mini", "gpt-5.3-codex-spark"]);
    assert.deepEqual(models[0].reasoning_efforts.map((effort) => effort.id), ["low", "high"]);
    assert.equal(models[0].default_reasoning_effort, "low");
    assert.deepEqual(models[0].additional_speed_tiers, ["fast"]);
    assert.deepEqual(models[0].service_tiers.map((tier) => tier.id), ["priority"]);
    assert.deepEqual(models[1].reasoning_efforts.map((effort) => effort.id), ["medium"]);
  });

  it("deduplicates by exact id without inventing a model", () => {
    const models = normalizeCodexModels({ data: [
      { id: "gpt-5.4", displayName: "old" },
      { id: "gpt-5.4", displayName: "5.4", isDefault: true },
    ] });
    assert.deepEqual(models.map((model) => model.id), ["gpt-5.4"]);
    assert.equal(models[0].display_name, "5.4");
    assert.equal(models[0].is_default, true);
  });

  it("rejects a malformed app-server payload", () => {
    assert.throws(() => normalizeCodexModels({ nope: true }), /data array/);
  });

  it("honors an explicit Codex binary override before PATH", () => {
    const command = resolveCodexCommand({ ...process.env, BATON_CODEX_PATH: process.execPath, PATH: "" });
    assert.equal(command, process.execPath);
  });

  it("uses the Codex CLI on PATH before a desktop-bundle fallback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-codex-path-"));
    const executable = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
    assert.equal(resolveCodexCommand({ PATH: dir, HOME: "" }), executable);
  });
});

function fakeSpawn(handler: (args: string[]) => { code: number; stdout?: string; stderr?: string; hang?: boolean }) {
  return ((command: string, args: string[]) => {
    void command;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void };
      killed: boolean;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.killed = false;
    child.kill = () => { child.killed = true; };
    const result = handler(args);
    queueMicrotask(() => {
      if (result.hang) return;
      if (result.stdout) child.stdout.emit("data", result.stdout);
      if (result.stderr) child.stderr.emit("data", result.stderr);
      child.emit("exit", result.code);
    });
    return child;
  }) as typeof import("node:child_process").spawn;
}

const GROK_MODELS_TEXT = `You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`;

describe("Grok CLI model adapter", () => {
  it("normalizes array, data, and models envelopes without inventing ids", () => {
    const sample = [
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        description: "Flagship",
        efforts: [{ id: "low" }, { id: "high", description: "Deep" }],
        tiers: [{ id: "fast", name: "Fast" }],
      },
      { model: "my-custom", displayName: "Custom", hidden: false },
      { id: "hidden-x", hidden: true },
      { id: "grok-4.6", name: "Grok 4.6 newer", is_default: true, efforts: [{ id: "low" }, { id: "high", description: "Deep" }], tiers: [{ id: "fast", name: "Fast" }] },
    ];
    const fromArray = normalizeGrokModels(sample);
    const fromData = normalizeGrokModels({ data: sample });
    const fromModels = normalizeGrokModels({ models: sample });
    for (const models of [fromArray, fromData, fromModels]) {
      assert.deepEqual(models.map((model) => model.id), ["grok-4.6", "my-custom"]);
      assert.equal(models[0].display_name, "Grok 4.6 newer");
      assert.equal(models[0].is_default, true);
      assert.deepEqual(models[0].reasoning_efforts.map((effort) => effort.id), ["low", "high"]);
      assert.deepEqual(models[0].service_tiers.map((tier) => tier.id), ["fast"]);
      assert.equal(models[1].display_name, "Custom");
    }
  });

  it("rejects a payload without models", () => {
    assert.throws(() => normalizeGrokModels({ nope: true }), /envelope/);
  });

  it("honors BATON_GROK_PATH when executable and otherwise PATH", () => {
    assert.equal(resolveGrokCommand({ ...process.env, BATON_GROK_PATH: process.execPath, PATH: "" }), process.execPath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-grok-path-"));
    const executable = path.join(dir, process.platform === "win32" ? "grok.cmd" : "grok");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
    assert.equal(resolveGrokCommand({ PATH: dir, HOME: "", BATON_GROK_PATH: "" }), executable);
    assert.equal(resolveGrokCommand({ PATH: "", HOME: "", BATON_GROK_PATH: "/missing/grok" }), null);
  });

  it("parses official grok models text and does not invent ids from login prose", () => {
    const models = parseGrokModelText(GROK_MODELS_TEXT);
    assert.deepEqual(models.map((model) => model.id), ["grok-4.6", "grok-4.5"]);
    assert.equal(models[0].is_default, true);
    assert.equal(models[1].is_default, false);
    assert.throws(() => parseGrokModelText("You are logged in with grok.com.\n"), /no model ids/);
  });

  it("parses unmarked ids only inside the Available models section", () => {
    const models = parseGrokModelText("You are logged in with grok.com.\n\nAvailable models:\n  grok-4.6 (default)\n  my-custom\n");
    assert.deepEqual(models.map((model) => model.id), ["grok-4.6", "my-custom"]);
    assert.equal(models[0].is_default, true);
  });

  it("accepts JSON stdout from grok models when the CLI emits it", () => {
    const models = parseGrokModelText(JSON.stringify({ models: [{ id: "grok-4.6", name: "Grok 4.6" }] }));
    assert.deepEqual(models.map((model) => model.id), ["grok-4.6"]);
    assert.equal(models[0].display_name, "Grok 4.6");
  });

  it("discovers models from grok models without passing --json", async () => {
    const calls: string[] = [];
    const catalog = await discoverGrokModels({
      command: "/bin/grok",
      spawnImpl: fakeSpawn((args) => {
        calls.push(args.join(" "));
        if (args[0] === "models") return { code: 0, stdout: GROK_MODELS_TEXT };
        if (args[0] === "version") return { code: 0, stdout: "grok 1.0.8 (95f4d452703b)\n" };
        return { code: 1, stderr: "unexpected" };
      }),
    });
    assert.equal(catalog.cli, "grok");
    assert.equal(catalog.version, "grok 1.0.8 (95f4d452703b)");
    assert.deepEqual(catalog.models.map((model) => model.id), ["grok-4.6", "grok-4.5"]);
    assert.deepEqual(calls.filter((call) => call.startsWith("models")), ["models"]);
  });

  it("routes discoverCliModels(grok) through discoverGrokModels", async () => {
    const catalog = await discoverCliModels("grok", {
      command: "/bin/grok",
      spawnImpl: fakeSpawn((args) => {
        if (args[0] === "models") return { code: 0, stdout: JSON.stringify([{ id: "grok-4.5" }]) };
        if (args[0] === "version") return { code: 1, stderr: "no" };
        return { code: 1 };
      }),
    });
    assert.equal(catalog.cli, "grok");
    assert.deepEqual(catalog.models.map((model) => model.id), ["grok-4.5"]);
  });

  it("codes missing binary and failed discovery", async () => {
    await assert.rejects(
      () => discoverGrokModels({ env: { PATH: "", HOME: "" } }),
      (error: unknown) => (error as CodedError).code === "CLI_NOT_AVAILABLE",
    );
    await assert.rejects(
      () => discoverGrokModels({
        command: "/bin/grok",
        spawnImpl: fakeSpawn(() => ({ code: 1, stderr: "boom" })),
      }),
      (error: unknown) => (error as CodedError).code === "GROK_MODEL_DISCOVERY_FAILED",
    );
  });

  it("times out hung grok models", async () => {
    await assert.rejects(
      () => discoverGrokModels({
        command: "/bin/grok",
        timeoutMs: 20,
        spawnImpl: fakeSpawn(() => ({ code: 0, hang: true })),
      }),
      (error: unknown) => (error as CodedError).code === "GROK_MODEL_DISCOVERY_TIMEOUT",
    );
  });
});
