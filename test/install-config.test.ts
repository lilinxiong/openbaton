import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "bun:test";
import { runConfig } from "../src/commands/config.js";
import { initProject } from "../src/commands/init.js";
import { runUninstall } from "../src/commands/uninstall.js";
import { updateProject } from "../src/commands/update.js";
import { loadConfig } from "../src/lib/config.js";
import { configPath, skillPath } from "../src/lib/paths.js";
import { hostSkillDest } from "../src/lib/hosts.js";
import { fixtureAdapterEnv } from "./home.js";

function isolated() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-install-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-install-cwd-"));
  return { cwd, env: fixtureAdapterEnv({ HOME: home }) };
}

const catalog = {
  cli: "alpha",
  adapter_id: "alpha",
  version: "test",
  models: ["one", "two"].map((id) => ({
    id,
    model: id,
    display_name: id,
    description: "",
    hidden: false,
    reasoning_efforts: [],
    default_reasoning_effort: null,
    input_modalities: [],
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    is_default: false,
  })),
};

describe("installation config", () => {
  it("drops the retired total pool and rejects its CLI flag", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env });
    fs.writeFileSync(configPath(cwd, { env }), 'schema_version = 3\n[cli.alpha]\nenabled = true\ncoding_models = ["one"]\nexecution_models = ["two"]\n');
    updateProject(cwd, { env });
    assert.deepEqual(loadConfig(cwd, { env }), {
      schema_version: 4,
      cli: { alpha: { enabled: true, execution_models: ["two"] } },
    });
    assert.doesNotMatch(fs.readFileSync(configPath(cwd, { env }), "utf8"), /coding_models/);
    await assert.rejects(runConfig(["--cli", "alpha", "--coding-model", "one"], {
      cwd, env, stdout: { write() {} },
    }), /unknown option: --coding-model/);
  });

  it("writes schema 4 profiles and drops legacy policy fields", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env, cli: "alpha" });
    const output: string[] = [];
    await runConfig(
      [
        "--cli",
        "alpha",
        "--implementation-model",
        "one",
        "--execution-model",
        "two",
        "--enable",
        "--json",
      ],
      {
        cwd,
        env,
        stdout: { write: (chunk) => output.push(chunk) },
        adapterProvider: () => ({ discoverModels: async () => catalog }),
      },
    );
    const config = loadConfig(cwd, { env });
    assert.deepEqual(config, {
      schema_version: 4,
      cli: {
        alpha: {
          enabled: true,
          implementation_models: ["one"],
          execution_models: ["two"],
        },
      },
    });
    const text = fs.readFileSync(configPath(cwd, { env }), "utf8");
    assert.doesNotMatch(
      text,
      /coding_models|runner|longctx|max_concurrent|max_depth|director/,
    );
    assert.equal(JSON.parse(output.join("")).execution_models[0], "two");
    await runConfig(["--cli", "alpha", "--execution-model", "none"], {
      cwd, env, stdout: { write() {} },
      adapterProvider: () => ({ discoverModels: async () => catalog }),
    });
    assert.deepEqual(loadConfig(cwd, { env }).cli.alpha, {
      enabled: true, implementation_models: ["one"],
    });
  });

  it("update keeps selected profiles", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env, cli: "alpha" });
    await runConfig(["--cli", "alpha", "--implementation-model", "one", "--enable"], {
      cwd,
      env,
      stdout: { write: () => undefined },
      adapterProvider: () => ({ discoverModels: async () => catalog }),
    });
    updateProject(cwd, { env });
    assert.deepEqual(loadConfig(cwd, { env }).cli.alpha, {
      enabled: true,
      implementation_models: ["one"],
    });
  });

  it("clean removes Baton config but preserves a modified external skill and its manifest", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env, cli: "alpha" });
    const externalSkill = hostSkillDest("alpha", { cwd, env });
    fs.appendFileSync(externalSkill, "\nuser change\n");
    const output: string[] = [];
    const code = await runUninstall(["--clean"], {
      cwd,
      env,
      stdout: { write: (chunk) => output.push(chunk) },
    });
    assert.equal(code, 1);
    assert.equal(fs.existsSync(externalSkill), true);
    assert.equal(fs.existsSync(configPath(cwd, { env })), true);
    assert.match(output.join(""), /conflict/);
    assert.equal(fs.existsSync(skillPath(cwd, { env })), true);
  });

  it("clean removes the known Baton files after an unmodified installation", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env, cli: "alpha" });
    const code = await runUninstall(["--clean"], {
      cwd,
      env,
      stdout: { write: () => undefined },
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(configPath(cwd, { env })), false);
    assert.equal(fs.existsSync(skillPath(cwd, { env })), false);
  });
});
