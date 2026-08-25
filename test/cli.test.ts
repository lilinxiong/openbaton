import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import type { CliModelCatalog } from "../src/lib/cli-models.js";
import { receiptsDir, selectionsDir, spawnsDir } from "../src/lib/paths.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { withHome, fakeEnv } from "./home.js";
import { configureCli } from "./configure.js";

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

async function initHostProfiles(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
  publishRouteSnapshot(cwd, { models: [{ id: "codex/model", namespaced: "codex/model", provider: "codex" }] }, new Date(), { cli: "codex", host: "codex", env });
  publishRouteSnapshot(cwd, { models: [{ id: "grok/model", namespaced: "grok/model", provider: "grok" }] }, new Date(), { cli: "grok", host: "grok", env });
  configureCli(cwd, env, "codex", ["codex/model"]);
  configureCli(cwd, env, "grok", ["grok/model"]);
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
      assert.equal(await run(["match", "implement a migration", "--host", "codex"], { cwd, env, stdout: out, stderr: out }), 1);
      assert.match(out.text(), /no automatic configured candidate|no enabled CLI subagent models|run baton config/i);
    });
  });

  it("config, match, spawn and dispatch use only the configured Codex surface", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-flow-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);

      const match = capture();
      assert.equal(await run(["match", "implement a quick small coding fix", "--host", "codex", "--json"], {
        cwd, env, stdout: match, stderr: match,
      }), 0, match.text());
      const preview = JSON.parse(match.text());
      assert.equal(preview.recommended_model_id, "gpt-5.4-mini@low");
      assert.ok(preview.candidates.some((candidate: { model_id: string }) => candidate.model_id === "gpt-5.3-codex-spark@low"));

      const spawn = capture();
      assert.equal(await run(["spawn", "implement a quick small coding fix", "--host", "codex", "--json"], {
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
        "spawn", "handle housekeeping", "--host", "codex", "--unit", "status=status current state", "--unit", "typo=typo in summary", "--json",
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
      assert.equal(await run(["spawn", "implement change", "--host", "codex", "--model", "gpt-5.3-codex-spark"], {
        cwd, env, stdout: out, stderr: out,
      }), 1);
      assert.match(out.text(), /MODEL_SELECTION_REMOVED/);
    });
  });

  it("captures the resolved host and never relabels tickets across Codex and Grok", async () => {
    await withHome(async (home) => {
      const explicitCodex = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-e2e-codex-"));
      const codexEnv = fakeEnv(home);
      await initHostProfiles(explicitCodex, codexEnv);
      const codexOut = capture();
      assert.equal(await run(["spawn", "implement the Codex host unit", "--host", "codex", "--json"], { cwd: explicitCodex, env: codexEnv, stdout: codexOut, stderr: codexOut }), 0, codexOut.text());
      const codexTicket = JSON.parse(fs.readFileSync(path.join(spawnsDir(explicitCodex), "spn-0001.json"), "utf8"));
      const codexReceipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(explicitCodex), `${codexTicket.receipt_id}.json`), "utf8"));
      const codexProposal = JSON.parse(fs.readFileSync(path.join(selectionsDir(explicitCodex), "sel-0001.json"), "utf8"));
      assert.equal(codexProposal.host, "codex");
      assert.equal(codexProposal.approvals[0].host, "codex");
      assert.equal(codexTicket.target_host, "codex");
      assert.equal(codexTicket.model_id, "codex/model");
      assert.equal(codexReceipt.host, "codex");

      const disabledCodex = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-e2e-disabled-"));
      const disabledEnv = fakeEnv(home);
      await initHostProfiles(disabledCodex, disabledEnv);
      configureCli(disabledCodex, disabledEnv, "codex", ["codex/model"], { enabled: false });
      configureCli(disabledCodex, disabledEnv, "grok", ["grok/model"]);
      const disabledOut = capture();
      assert.equal(await run(["spawn", "implement the disabled Codex unit", "--host", "codex", "--json"], { cwd: disabledCodex, env: disabledEnv, stdout: disabledOut, stderr: disabledOut }), 1);
      assert.match(disabledOut.text(), /MODEL_RECOMMENDATION_UNAVAILABLE|no automatic configured candidate/i);
      assert.equal(fs.existsSync(path.join(spawnsDir(disabledCodex), "spn-0001.json")), false);

      const explicitGrok = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-e2e-grok-"));
      const grokEnv = fakeEnv(home);
      await initHostProfiles(explicitGrok, grokEnv);
      const grokOut = capture();
      assert.equal(await run(["spawn", "implement the Grok host unit", "--host", "grok", "--json"], { cwd: explicitGrok, env: grokEnv, stdout: grokOut, stderr: grokOut }), 0, grokOut.text());
      const grokTicket = JSON.parse(fs.readFileSync(path.join(spawnsDir(explicitGrok), "spn-0001.json"), "utf8"));
      const grokReceipt = JSON.parse(fs.readFileSync(path.join(receiptsDir(explicitGrok), `${grokTicket.receipt_id}.json`), "utf8"));
      assert.equal(grokTicket.target_host, "grok");
      assert.equal(grokTicket.model_id, "grok/model");
      assert.equal(grokReceipt.host, "grok");

      const omitted = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-e2e-omitted-"));
      const omittedEnv = fakeEnv(home);
      await initHostProfiles(omitted, omittedEnv);
      const omittedOut = capture();
      assert.equal(await run(["spawn", "implement the legacy-default unit", "--json"], { cwd: omitted, env: omittedEnv, stdout: omittedOut, stderr: omittedOut }), 1);
      assert.match(omittedOut.text(), /HOST_REQUIRED/);
      assert.match(omittedOut.text(), /--host|BATON_HOST/);
      assert.equal(fs.existsSync(path.join(spawnsDir(omitted), "spn-0001.json")), false);

      const releaseMismatch = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-e2e-release-"));
      const releaseEnv = fakeEnv(home);
      await initHostProfiles(releaseMismatch, releaseEnv);
      const releaseSpawn = capture();
      assert.equal(await run(["spawn", "implement the release unit", "--host", "grok", "--json"], { cwd: releaseMismatch, env: releaseEnv, stdout: releaseSpawn, stderr: releaseSpawn }), 0, releaseSpawn.text());
      for (const argv of [
        ["dispatch", "next", "--host", "grok", "--capacity", "1", "--json"],
        ["dispatch", "bind", "spn-0001", "--host", "grok", "--agent-id", "agent-grok", "--json"],
        ["dispatch", "complete", "spn-0001", "--host", "grok", "--text", "done", "--json"],
      ]) {
        const output = capture();
        assert.equal(await run(argv, { cwd: releaseMismatch, env: releaseEnv, stdout: output, stderr: output }), 0, output.text());
      }
      const wrongRelease = capture();
      assert.equal(await run(["dispatch", "release", "spn-0001", "--host", "codex", "--agent-id", "agent-grok", "--json"], { cwd: releaseMismatch, env: releaseEnv, stdout: wrongRelease, stderr: wrongRelease }), 1);
      assert.match(wrongRelease.text(), /HOST_MISMATCH|targets grok/i);
    });
  });
});
