import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import type { CliModelCatalog } from "../src/lib/cli-models.js";
import { spawnsDir } from "../src/lib/paths.js";
import { withHome, fakeEnv } from "./home.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

const CATALOG: CliModelCatalog = {
  cli: "codex",
  version: "codex-cli test",
  models: [
    {
      id: "gpt-5.6-sol", model: "gpt-5.6-sol", display_name: "5.6 Sol",
      description: "Most capable model for complex repository architecture migration", hidden: false,
      reasoning_efforts: ["low", "medium", "high", "max"].map((id) => ({ id, description: "" })),
      default_reasoning_effort: "high", input_modalities: ["text"], additional_speed_tiers: [],
      service_tiers: [], default_service_tier: null, is_default: true,
    },
    {
      id: "gpt-5.4-mini", model: "gpt-5.4-mini", display_name: "5.4 Mini",
      description: "Small fast cost-efficient coding model for simpler fixes", hidden: false,
      reasoning_efforts: ["low", "medium"].map((id) => ({ id, description: "" })),
      default_reasoning_effort: "low", input_modalities: ["text"], additional_speed_tiers: ["fast"],
      service_tiers: [], default_service_tier: null, is_default: false,
    },
    {
      id: "gpt-5.3-codex-spark", model: "gpt-5.3-codex-spark", display_name: "5.3 Codex Spark",
      description: "Ultra-fast coding model", hidden: false,
      reasoning_efforts: ["low", "medium"].map((id) => ({ id, description: "" })),
      default_reasoning_effort: "low", input_modalities: ["text"], additional_speed_tiers: [],
      service_tiers: [], default_service_tier: null, is_default: false,
    },
  ],
};

async function initAndConfigure(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
  const out = capture();
  assert.equal(await run([
    "config", "--cli", "codex", "--runner", "gpt-5.4-mini", "--longctx", "-",
    "--subagent-model", "all", "--enable",
  ], { cwd, env, stdout: out, stderr: out, discover: async () => structuredClone(CATALOG) }), 0, out.text());
}

describe("CLI automatic model routing", () => {
  it("uses process.exitCode in the entrypoint so disclosures can flush", () => {
    const entry = fs.readFileSync(path.join(process.cwd(), "bin", "baton.ts"), "utf8");
    assert.match(entry, /process\.exitCode = code/);
    assert.doesNotMatch(entry, /process\.exit\(code\)/);
  });

  it("requires config before model matching", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-empty-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const out = capture();
      assert.equal(await run(["match", "implement a migration"], { cwd, env, stdout: out, stderr: out }), 1);
      assert.match(out.text(), /no automatic configured candidate|no enabled CLI subagent models|run baton config/i);
    });
  });

  it("config, match, spawn and dispatch use only the configured Codex surface", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-flow-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);

      const match = capture();
      assert.equal(await run(["match", "implement a quick small coding fix", "--json"], {
        cwd, env, stdout: match, stderr: match,
      }), 0, match.text());
      const preview = JSON.parse(match.text());
      assert.equal(preview.recommended_model_id, "gpt-5.4-mini@low");
      assert.ok(preview.candidates.some((candidate: { model_id: string }) => candidate.model_id === "gpt-5.3-codex-spark@low"));

      const spawn = capture();
      assert.equal(await run(["spawn", "implement a quick small coding fix", "--json"], {
        cwd, env, stdout: spawn, stderr: spawn,
      }), 0, spawn.text());
      const approved = JSON.parse(spawn.text());
      assert.equal(approved.status, "approved");
      assert.equal(approved.approvals[0].selected_model_id, "gpt-5.4-mini@low");
      assert.equal(approved.approvals[0].confirmed_by, "baton-recommendation");
      assert.equal(approved.approvals[0].service_tier, "fast");
      assert.ok(fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")));

      const dispatch = capture();
      assert.equal(await run(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], {
        cwd, env, stdout: dispatch, stderr: dispatch,
      }), 0, dispatch.text());
      const reserved = JSON.parse(dispatch.text()).reserved[0];
      assert.equal(reserved.model, "gpt-5.4-mini");
      assert.equal(reserved.reasoning_effort, "low");
      assert.equal(reserved.service_tier, "fast");
      assert.equal(reserved.fork_context, false);
    });
  });

  it("keeps tiny structured units on the director", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-local-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      const out = capture();
      assert.equal(await run([
        "spawn", "handle housekeeping", "--unit", "status=status current state", "--unit", "typo=typo in summary", "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.proposal, null);
      assert.deepEqual(result.director_local.map((item: { key: string }) => item.key), ["status", "typo"]);
    });
  });

  it("rejects every runtime model override", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-override-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      const out = capture();
      assert.equal(await run(["spawn", "implement change", "--model", "gpt-5.3-codex-spark"], {
        cwd, env, stdout: out, stderr: out,
      }), 1);
      assert.match(out.text(), /MODEL_SELECTION_REMOVED/);
    });
  });
});
