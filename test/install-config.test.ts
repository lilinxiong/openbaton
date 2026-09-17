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
import type {
  SelectPrompt,
  SelectPromptOptions,
  MultiSelectPromptOptions,
} from "../src/lib/prompt.js";
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
          max_concurrent_subagents: 3,
          implementation_models: ["one"],
          execution_models: ["two"],
        },
      },
    });
    const text = fs.readFileSync(configPath(cwd, { env }), "utf8");
    assert.doesNotMatch(
      text,
      /coding_models|runner|longctx|max_depth|director/,
    );
    assert.equal(JSON.parse(output.join("")).execution_models[0], "two");
    await runConfig(["--cli", "alpha", "--execution-model", "none"], {
      cwd, env, stdout: { write() {} },
      adapterProvider: () => ({ discoverModels: async () => catalog }),
    });
    assert.deepEqual(loadConfig(cwd, { env }).cli.alpha, {
      enabled: true,
      max_concurrent_subagents: 3,
      implementation_models: ["one"],
    });
  });

  it("retains a noninteractive max-subagents value on later config runs", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env, cli: "alpha" });
    await runConfig(
      ["--cli", "alpha", "--implementation-model", "one", "--max-subagents", "7", "--test-subagents", "--enable"],
      {
        cwd,
        env,
        stdout: { write: () => undefined },
        adapterProvider: () => ({
          discoverModels: async () => catalog,
          testSubagents: async () => ({ capacity: 12, ceiling_reached: false }),
        }),
      },
    );
    assert.equal(
      loadConfig(cwd, { env }).cli.alpha.max_concurrent_subagents,
      7,
    );
    // A later noninteractive run without capacity flags must not reset it.
    await runConfig(
      ["--cli", "alpha", "--execution-model", "two"],
      {
        cwd,
        env,
        stdout: { write: () => undefined },
        adapterProvider: () => ({ discoverModels: async () => catalog }),
      },
    );
    assert.deepEqual(loadConfig(cwd, { env }).cli.alpha, {
      enabled: true,
      max_concurrent_subagents: 7,
      implementation_models: ["one"],
      execution_models: ["two"],
    });
  });

  it("interactive capacity question offers test and skip, and skip keeps the default 3", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env, cli: "alpha" });
    const output: string[] = [];
    let askedCapacity = false;
    const prompt: SelectPrompt = {
      select: async <T>(options: SelectPromptOptions<T>): Promise<T> => {
        if (options.message.includes("Test subagent capacity")) {
          askedCapacity = true;
          const values = options.choices.map((choice) => choice.value);
          assert.ok(values.includes(true), "choices must offer the test");
          assert.ok(values.includes(false), "choices must offer skip");
          return false as T;
        }
        return (options.initial ?? options.choices[0].value) as T;
      },
      multiSelect: async <T>(options: MultiSelectPromptOptions<T>): Promise<T[]> =>
        (options.message === "Select CLI"
          ? ["alpha"]
          : options.initial || []) as T[],
    };
    let probed = 0;
    await runConfig(["--enable", "--json"], {
      cwd,
      env,
      stdout: { write: (chunk) => output.push(chunk) },
      prompt,
      adapterProvider: () => ({
        discoverModels: async () => catalog,
        testSubagents: async () => {
          probed += 1;
          return { capacity: 6, ceiling_reached: false };
        },
      }),
    });
    assert.equal(askedCapacity, true);
    assert.equal(probed, 0, "skip must not run the probe");
    assert.equal(JSON.parse(output.join("")).max_concurrent_subagents, 3);
    assert.equal(
      loadConfig(cwd, { env }).cli.alpha.max_concurrent_subagents,
      3,
    );
  });

  it("defaults to 3 and reports it on test failure or cancellation", async () => {
    const scenarios: Array<{
      name: string;
      testSubagents: () => Promise<{ capacity: number; ceiling_reached: boolean }>;
      cancelNumberStep: boolean;
      pattern: RegExp;
    }> = [
      {
        name: "test failure",
        testSubagents: async () => {
          throw new Error("SUBAGENT_TEST_FAILED: probe exited");
        },
        cancelNumberStep: false,
        pattern: /fail|default/i,
      },
      {
        name: "probe cancellation",
        testSubagents: async () => {
          throw new Error("SUBAGENT_TEST_CANCELLED");
        },
        cancelNumberStep: false,
        pattern: /cancel|default/i,
      },
      {
        name: "capacity-step cancellation",
        testSubagents: async () => ({ capacity: 6, ceiling_reached: false }),
        cancelNumberStep: true,
        pattern: /cancel|default/i,
      },
    ];
    for (const scenario of scenarios) {
      const { cwd, env } = isolated();
      await initProject(cwd, { env, cli: "alpha" });
      const output: string[] = [];
      const prompt: SelectPrompt = {
        select: async <T>(options: SelectPromptOptions<T>): Promise<T> => {
          if (options.message.includes("Test subagent capacity"))
            return true as T;
          if (options.message.includes("concurrent subagents")) {
            if (scenario.cancelNumberStep) throw new Error("cancelled");
            return 4 as T;
          }
          return (options.initial ?? options.choices[0].value) as T;
        },
        multiSelect: async <T>(options: MultiSelectPromptOptions<T>): Promise<T[]> =>
          (options.message === "Select CLI"
            ? ["alpha"]
            : options.initial || []) as T[],
      };
      await runConfig(["--enable", "--json"], {
        cwd,
        env,
        stdout: { write: (chunk) => output.push(chunk) },
        stderr: { write: (chunk) => output.push(chunk) },
        prompt,
        adapterProvider: () => ({
          discoverModels: async () => catalog,
          testSubagents: scenario.testSubagents,
        }),
      });
      const text = output.join("");
      assert.equal(
        loadConfig(cwd, { env }).cli.alpha.max_concurrent_subagents,
        3,
        `scenario ${scenario.name} must persist the default`,
      );
      assert.match(
        text,
        scenario.pattern,
        `scenario ${scenario.name} must report the fallback`,
      );
    }
  });

  it("rejects out-of-range max-subagents CLI values", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env, cli: "alpha" });
    const cases = [
      ["--cli", "alpha", "--max-subagents", "0"],
      ["--cli", "alpha", "--max-subagents", "21"],
      ["--cli", "alpha", "--max-subagents", "two"],
      ["--cli", "alpha", "--max-subagents", "1.5"],
      // Above the default without a test in the same invocation.
      ["--cli", "alpha", "--max-subagents", "4"],
      // Tested capacity is 6; 7 exceeds the measured ceiling.
      ["--cli", "alpha", "--max-subagents", "7", "--test-subagents"],
    ];
    for (const args of cases) {
      const output: string[] = [];
      await assert.rejects(
        runConfig([...args, "--enable"], {
          cwd,
          env,
          stdout: { write: (chunk) => output.push(chunk) },
          adapterProvider: () => ({
            discoverModels: async () => catalog,
            testSubagents: async () => ({ capacity: 6, ceiling_reached: false }),
          }),
        }),
        /subagents/i,
        `${args.join(" ")} must be rejected`,
      );
    }
    assert.equal(
      loadConfig(cwd, { env }).cli.alpha.max_concurrent_subagents,
      undefined,
      "rejected runs must not write a capacity",
    );
  });

  it("measures capacity 6 and lets the selector pick within 1..6", async () => {
    const { cwd, env } = isolated();
    await initProject(cwd, { env, cli: "alpha" });
    const output: string[] = [];
    const prompt: SelectPrompt = {
      select: async <T>(options: SelectPromptOptions<T>): Promise<T> => {
        if (options.message.includes("Test subagent capacity")) {
          // Choices must offer a skip path that keeps the default.
          assert.deepEqual(
            options.choices.map((choice) => choice.value),
            [false, true],
          );
          return true as T;
        }
        if (options.message.includes("concurrent subagents")) {
          const values = options.choices.map((choice) => Number(choice.value));
          assert.deepEqual(
            values,
            [1, 2, 3, 4, 5, 6],
            "selector choices must be capped at the measured capacity",
          );
          return 5 as T;
        }
        return (options.initial ?? options.choices[0].value) as T;
      },
      multiSelect: async <T>(options: MultiSelectPromptOptions<T>): Promise<T[]> =>
        (options.message === "Select CLI"
          ? ["alpha"]
          : options.initial || []) as T[],
    };
    let probed = 0;
    await runConfig(["--test-subagents", "--enable", "--json"], {
      cwd,
      env,
      stdout: { write: (chunk) => output.push(chunk) },
      prompt,
      adapterProvider: () => ({
        discoverModels: async () => catalog,
        testSubagents: async ({ cwd: probeCwd, env: probeEnv }) => {
          probed += 1;
          assert.equal(probeCwd, cwd);
          assert.equal(probeEnv, env);
          return { capacity: 6, ceiling_reached: false };
        },
      }),
    });
    assert.equal(probed, 1);
    const payload = JSON.parse(output.join(""));
    assert.equal(payload.max_concurrent_subagents, 5);
    assert.equal(
      loadConfig(cwd, { env }).cli.alpha.max_concurrent_subagents,
      5,
    );
    const text = fs.readFileSync(configPath(cwd, { env }), "utf8");
    assert.match(text, /max_concurrent_subagents = 5/);
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
      max_concurrent_subagents: 3,
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
