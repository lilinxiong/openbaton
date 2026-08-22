import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeCodexModels, resolveCodexCommand } from "../src/lib/cli-models.js";

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
