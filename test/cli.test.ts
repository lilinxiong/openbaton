import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { run } from "../src/cli.js";
import type { CliModelCatalog } from "../src/adapters/contract.js";
import { receiptsDir, selectionsDir, spawnsDir } from "../src/lib/paths.js";
import { recordNativeIdentity, recordPendingReservation } from "../src/lib/host-identity.js";
import { publishRouteSnapshot } from "../src/lib/routes.js";
import { markRouteExhausted } from "../src/lib/model-availability.js";
import { withHome, fakeEnv } from "./home.js";
import { adapterProviderFor, configureCli } from "./configure.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); }, text() { return chunks.join(""); } };
}

async function runInFreshProcess(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  const moduleUrl = new URL("../src/cli.ts", import.meta.url).href;
  const source = `
    (async () => {
      const { run } = await import(process.env.BATON_TEST_CLI_URL);
      const chunks = [];
      const sink = { write(value) { chunks.push(String(value)); } };
      const code = await run(JSON.parse(process.env.BATON_TEST_ARGS), {
        cwd: process.env.BATON_TEST_CWD,
        env: process.env,
        stdout: sink,
        stderr: sink,
      });
      process.stdout.write(JSON.stringify({ code, output: chunks.join("") }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, ["-e", source], {
      cwd: process.cwd(),
      env: {
        ...env,
        BATON_TEST_CLI_URL: moduleUrl,
        BATON_TEST_ARGS: JSON.stringify(args),
        BATON_TEST_CWD: cwd,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    const errors: string[] = [];
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => errors.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(errors.join("") || `child exited ${code}`));
      else resolve(JSON.parse(output.join("")) as { code: number; output: string });
    });
  });
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
    "--coding-model", "gpt-5.3-codex-spark", "--coding-model", "gpt-5.4-mini", "--enable",
  ], { cwd, env, stdout: out, stderr: out, adapterProvider: adapterProviderFor(CATALOG) }), 0, out.text());
}

async function initHostProfiles(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
  publishRouteSnapshot(cwd, { models: [{ id: "codex/model", namespaced: "codex/model", provider: "codex" }] }, new Date(), { cli: "codex", host: "codex", env });
  publishRouteSnapshot(cwd, { models: [{ id: "grok/model", namespaced: "grok/model", provider: "grok" }] }, new Date(), { cli: "grok", host: "grok", env });
  configureCli(cwd, env, "codex", ["codex/model"]);
  configureCli(cwd, env, "grok", ["grok/model"]);
}

function observeCodexDispatch(cwd: string, env: NodeJS.ProcessEnv, id: string, hookAgentId: string): void {
  const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${id}.json`), "utf8"));
  const pending = recordPendingReservation(cwd, {
    schema: 1,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: "codex",
  }, { now: new Date() }, undefined, env);
  recordNativeIdentity(cwd, pending, hookAgentId, "hook", { now: new Date() }, undefined, env);
}

function observeGrokDispatch(cwd: string, env: NodeJS.ProcessEnv, id: string, agentId: string, sessionId: string): void {
  const ticket = JSON.parse(fs.readFileSync(path.join(spawnsDir(cwd), `${id}.json`), "utf8"));
  const pending = recordPendingReservation(cwd, {
    schema: 1,
    reservation_id: ticket.reservation_id,
    ticket_id: ticket.id,
    attempt: ticket.attempt,
    host: "grok",
  }, { session_id: sessionId }, undefined, env);
  recordNativeIdentity(cwd, pending, agentId, "lifecycle", { session_id: sessionId }, undefined, env);
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
      assert.match(out.text(), /no automatic configured candidate|no enabled Coding models|run baton config/i);
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
      assert.equal(preview.recommended_model_id, "gpt-5.3-codex-spark@low");
      assert.ok(preview.candidates.some((candidate: { model_id: string }) => candidate.model_id === "gpt-5.3-codex-spark@low"));

      const spawn = capture();
      assert.equal(await run(["spawn", "implement a quick small coding fix", "--host", "codex", "--classification", "implementation", "--json"], {
        cwd, env, stdout: spawn, stderr: spawn,
      }), 0, spawn.text());
      const approved = JSON.parse(spawn.text());
      assert.equal(approved.status, "approved");
      assert.equal(approved.approvals[0].selected_model_id, "gpt-5.3-codex-spark@low");
      assert.equal(approved.approvals[0].confirmed_by, "baton-recommendation");
      assert.equal(approved.approvals[0].service_tier, null);
      assert.ok(fs.existsSync(path.join(spawnsDir(cwd), "spn-0001.json")));

      const dispatch = capture();
      assert.equal(await run(["dispatch", "next", "--host", "codex", "--capacity", "1", "--json"], {
        cwd, env, stdout: dispatch, stderr: dispatch,
      }), 0, dispatch.text());
      const reserved = JSON.parse(dispatch.text()).reserved[0];
      assert.equal(reserved.model, "gpt-5.3-codex-spark");
      assert.equal(reserved.reasoning_effort, "low");
      assert.equal(reserved.service_tier, null);
      assert.equal(reserved.fork_context, false);
    });
  });

  it("reports Coding routes in configured order with explicit eligibility and recovery reasons", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-status-coding-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      markRouteExhausted(cwd, { host: "codex", routeId: "gpt-5.3-codex-spark" }, {
        reason: "MODEL_QUOTA_EXHAUSTED",
        resetAt: "2099-01-01T00:00:00.000Z",
        env,
      });

      const output = capture();
      assert.equal(await run(["status", "--host", "codex", "--json"], {
        cwd, env, stdout: output, stderr: output,
      }), 0, output.text());
      const status = JSON.parse(output.text());
      assert.equal(status.coding_dispatch_ready, true);
      assert.equal(status.coding_dispatch_reason, "READY");
      assert.equal(status.core_dispatch_ready, true);
      assert.equal(status.hook_posture.hook_configured, false);
      assert.equal(status.hook_posture.audit_only, true);
      assert.equal(status.hook_posture.core_dispatch_ready, true);
      assert.deepEqual(status.coding_models.map((route: { route_id: string }) => route.route_id), [
        "gpt-5.3-codex-spark",
        "gpt-5.4-mini",
      ]);
      assert.deepEqual(status.coding_models.map((route: { eligibility_code: string }) => route.eligibility_code), [
        "DURABLE_QUOTA_EXHAUSTED",
        "AVAILABLE",
      ]);
      assert.equal(status.coding_models[0].eligible, false);
      assert.equal(status.coding_models[1].eligible, true);
      assert.match(status.coding_models[0].eligibility_reason, /MODEL_QUOTA_EXHAUSTED/);
    });
  });

  it("returns CODING_MODELS_EXHAUSTED with ordered route reasons when no Coding route remains", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-all-exhausted-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      for (const routeId of ["gpt-5.3-codex-spark", "gpt-5.4-mini"]) {
        markRouteExhausted(cwd, { host: "codex", routeId }, {
          reason: "MODEL_QUOTA_EXHAUSTED",
          resetAt: "2099-01-01T00:00:00.000Z",
          env,
        });
      }

      for (const args of [
        ["match", "implement a quick small coding fix", "--host", "codex", "--json"],
        ["spawn", "implement a quick small coding fix", "--host", "codex", "--classification", "implementation", "--json"],
      ]) {
        const output = capture();
        assert.equal(await run(args, { cwd, env, stdout: output, stderr: output }), 1);
        assert.match(output.text(), /CODING_MODELS_EXHAUSTED/);
        assert.ok(output.text().indexOf("gpt-5.3-codex-spark") < output.text().indexOf("gpt-5.4-mini"));
      }
      const statusOutput = capture();
      assert.equal(await run(["status", "--host", "codex", "--json"], {
        cwd, env, stdout: statusOutput, stderr: statusOutput,
      }), 0, statusOutput.text());
      const status = JSON.parse(statusOutput.text());
      assert.equal(status.coding_dispatch_ready, false);
      assert.equal(status.coding_dispatch_reason, "CODING_MODELS_EXHAUSTED");
      assert.deepEqual(fs.existsSync(spawnsDir(cwd, env)) ? fs.readdirSync(spawnsDir(cwd, env)) : [], []);
    });
  });

  it("persists explicit quota across a fresh process/project and restores priority after reset", async () => {
    await withHome(async (home) => {
      const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-quota-project-a-"));
      const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-quota-project-b-"));
      const env = fakeEnv(home);
      await initAndConfigure(projectA, env);

      const spawnOutput = capture();
      assert.equal(await run([
        "spawn", "implement a quick small coding fix", "--host", "codex",
        "--classification", "implementation", "--dispatch", "--capacity", "1", "--json",
      ], { cwd: projectA, env, stdout: spawnOutput, stderr: spawnOutput }), 0, spawnOutput.text());
      assert.equal(JSON.parse(spawnOutput.text()).reserved[0].model, "gpt-5.3-codex-spark");

      const failed = await runInFreshProcess([
        "dispatch", "fail", "spn-0001", "--host", "codex",
        "--code", "MODEL_QUOTA_EXHAUSTED", "--remaining-percent", "0",
        "--message", "model quota exhausted", "--json",
      ], projectA, env);
      assert.equal(failed.code, 0, failed.output);

      const fallback = await runInFreshProcess([
        "match", "implement a quick small coding fix", "--host", "codex", "--json",
      ], projectB, env);
      assert.equal(fallback.code, 0, fallback.output);
      assert.equal(JSON.parse(fallback.output).recommended_model_id, "gpt-5.4-mini@low");

      const reset = await runInFreshProcess([
        "models", "reset", "gpt-5.3-codex-spark", "--host", "codex", "--json",
      ], projectB, env);
      assert.equal(reset.code, 0, reset.output);
      const restored = await runInFreshProcess([
        "match", "implement a quick small coding fix", "--host", "codex", "--json",
      ], projectB, env);
      assert.equal(restored.code, 0, restored.output);
      assert.match(JSON.parse(restored.output).recommended_model_id, /^gpt-5\.3-codex-spark@/);
    });
  });

  it("accepts Codex dispatch bind --task-name without letting it replace the hook UUID", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-bind-task-name-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);

      const spawn = capture();
      assert.equal(await run(["spawn", "implement a quick small coding fix", "--host", "codex", "--classification", "implementation", "--dispatch", "--capacity", "1", "--json"], {
        cwd, env, stdout: spawn, stderr: spawn,
      }), 0, spawn.text());
      observeCodexDispatch(cwd, env, "spn-0001", "codex-hook-uuid");

      const bind = capture();
      assert.equal(await run(["dispatch", "bind", "spn-0001", "--host", "codex", "--task-name", "codex-task-name", "--json"], {
        cwd, env, stdout: bind, stderr: bind,
      }), 0, bind.text());
      assert.equal(JSON.parse(bind.text()).ticket.agent_id, "codex-hook-uuid");
      const status = capture();
      assert.equal(await run(["status", "--host", "codex", "--json"], {
        cwd, env, stdout: status, stderr: status,
      }), 0, status.text());
      assert.equal(JSON.parse(status.text()).spawns.tickets[0].execution_handle, "task_name:codex-task-name");
    });
  });

  it("delegates tiny implementation units when the Baton host is enabled", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-local-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      const out = capture();
      assert.equal(await run([
        "spawn", "handle housekeeping", "--host", "codex", "--classification", "implementation", "--unit", "status=status current state", "--unit", "typo=typo in summary", "--json",
      ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
      const result = JSON.parse(out.text());
      assert.equal(result.status, "approved");
      assert.equal(result.tickets.length, 2);
      assert.deepEqual(result.director_local, []);
    });
  });

  it("keeps director-only analysis and discussion out of worker tickets", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-director-only-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      for (const classification of ["analysis", "discussion"]) {
        const out = capture();
        assert.equal(await run([
          "spawn", "review the current lifecycle", "--host", "codex", "--classification", classification, "--json",
        ], { cwd, env, stdout: out, stderr: out }), 0, out.text());
        const result = JSON.parse(out.text());
        assert.equal(result.proposal, null);
        assert.deepEqual(result.dispatched, []);
        assert.equal(result.director_local[0].kind, "director-local");
        assert.deepEqual(fs.existsSync(spawnsDir(cwd)) ? fs.readdirSync(spawnsDir(cwd)) : [], []);
      }
    });
  });

  it("fails closed before ticket creation when an enabled host has no classification", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-classification-required-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      const out = capture();
      assert.equal(await run(["spawn", "implement an unclassified change", "--host", "codex", "--json"], {
        cwd, env, stdout: out, stderr: out,
      }), 1);
      assert.match(out.text(), /CLASSIFICATION_REQUIRED/);
      assert.deepEqual(fs.existsSync(spawnsDir(cwd)) ? fs.readdirSync(spawnsDir(cwd)) : [], []);
    });
  });

  it("fails closed on conflicting request and unit classifications", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-classification-conflict-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      const out = capture();
      assert.equal(await run([
        "spawn", "split work", "--host", "codex", "--classification", "implementation",
        "--unit", "ops=run checks", "--unit-classification", "ops=mechanical", "--json",
      ], { cwd, env, stdout: out, stderr: out }), 1);
      assert.match(out.text(), /CLASSIFICATION_CONFLICT/);
      assert.deepEqual(fs.existsSync(spawnsDir(cwd)) ? fs.readdirSync(spawnsDir(cwd)) : [], []);
    });
  });

  it("rejects every runtime model override", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-cli-override-"));
      const env = fakeEnv(home);
      await initAndConfigure(cwd, env);
      const out = capture();
      assert.equal(await run(["spawn", "implement change", "--host", "codex", "--classification", "implementation", "--model", "gpt-5.3-codex-spark"], {
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
      assert.equal(await run(["spawn", "implement the Codex host unit", "--host", "codex", "--classification", "implementation", "--json"], { cwd: explicitCodex, env: codexEnv, stdout: codexOut, stderr: codexOut }), 0, codexOut.text());
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
      assert.equal(await run(["spawn", "implement the disabled Codex unit", "--host", "codex", "--json"], { cwd: disabledCodex, env: disabledEnv, stdout: disabledOut, stderr: disabledOut }), 0);
      assert.match(disabledOut.text(), /bypassed|ACTIVATION_DISABLED|tickets=\[\]/i);
      assert.equal(fs.existsSync(path.join(spawnsDir(disabledCodex), "spn-0001.json")), false);

      const explicitGrok = fs.mkdtempSync(path.join(os.tmpdir(), "baton-host-e2e-grok-"));
      const grokEnv = fakeEnv(home);
      await initHostProfiles(explicitGrok, grokEnv);
      const grokOut = capture();
      assert.equal(await run(["spawn", "implement the Grok host unit", "--host", "grok", "--classification", "implementation", "--json"], { cwd: explicitGrok, env: grokEnv, stdout: grokOut, stderr: grokOut }), 0, grokOut.text());
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
      assert.equal(await run(["spawn", "implement the release unit", "--host", "grok", "--classification", "implementation", "--json"], { cwd: releaseMismatch, env: releaseEnv, stdout: releaseSpawn, stderr: releaseSpawn }), 0, releaseSpawn.text());
      const nextGrok = capture();
      assert.equal(await run(["dispatch", "next", "--host", "grok", "--capacity", "1", "--json"], {
        cwd: releaseMismatch,
        env: releaseEnv,
        stdout: nextGrok,
        stderr: nextGrok,
      }), 0, nextGrok.text());
      observeGrokDispatch(releaseMismatch, releaseEnv, "spn-0001", "agent-grok", "grok-session");
      for (const argv of [
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
