import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { cliPromptChoices } from "../src/commands/config.js";
import { loadConfig } from "../src/lib/config.js";
import { readRouteSnapshot } from "../src/lib/routes.js";
import type { CliModelCatalog } from "../src/lib/cli-models.js";
import { withHome, fakeEnv } from "./home.js";

function capture() {
  const chunks: string[] = [];
  return { write(value: unknown) { chunks.push(String(value)); return true; }, text() { return chunks.join(""); } };
}

/** Shape produced by the Claude adapter from a real `list_models` response. */
const CLAUDE_CATALOG: CliModelCatalog = {
  cli: "claude",
  version: "2.1.241 (Claude Code)",
  models: [
    {
      id: "claude-opus-5[1m]", model: "claude-opus-5[1m]", display_name: "Opus (1M context)",
      description: "Opus 5 with 1M context", hidden: false,
      reasoning_efforts: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, description: "" })),
      default_reasoning_effort: null, input_modalities: [], additional_speed_tiers: [],
      service_tiers: [], default_service_tier: null, is_default: true,
    },
    {
      id: "claude-sonnet-5", model: "claude-sonnet-5", display_name: "Sonnet",
      description: "Sonnet 5", hidden: false,
      reasoning_efforts: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, description: "" })),
      default_reasoning_effort: null, input_modalities: [], additional_speed_tiers: [],
      service_tiers: [], default_service_tier: null, is_default: false,
    },
    {
      id: "claude-haiku-4-5-20251001", model: "claude-haiku-4-5-20251001", display_name: "Haiku",
      description: "Haiku 4.5", hidden: false,
      reasoning_efforts: [], default_reasoning_effort: null, input_modalities: [],
      additional_speed_tiers: [], service_tiers: [], default_service_tier: null, is_default: false,
    },
  ],
};

const GROK_CATALOG: CliModelCatalog = {
  cli: "grok",
  version: "grok test",
  models: [{
    id: "grok-4.5", model: "grok-4.5", display_name: "Grok 4.5", description: "", hidden: false,
    reasoning_efforts: [], default_reasoning_effort: null, input_modalities: [],
    additional_speed_tiers: [], service_tiers: [], default_service_tier: null, is_default: false,
  }],
};

describe("Claude Code appears in the shared init/config flow", () => {
  it("offers the host in the CLI picker alongside the existing hosts", () => {
    const choices = cliPromptChoices().map((choice) => choice.value);
    assert.deepEqual(choices, ["codex", "grok", "cursor", "claude"]);
  });

  it("selects the host interactively and proceeds through its own returned catalog", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-init-select-"));
      const env = fakeEnv(home);
      const stdout = capture();
      const discovered: string[] = [];
      // Model choices offered at each prompt, in order.
      const offered: string[][] = [];
      const selects: unknown[] = ["claude-sonnet-5", "claude-opus-5[1m]", true];
      const multiSelects: unknown[][] = [["claude"], ["claude-sonnet-5"]];

      assert.equal(await run(["init"], {
        cwd,
        env,
        stdout,
        stderr: stdout,
        discover: async (cli) => {
          discovered.push(cli);
          assert.equal(cli, "claude");
          return structuredClone(CLAUDE_CATALOG);
        },
        prompt: {
          async select(options: { choices: Array<{ value: unknown }> }) {
            offered.push(options.choices.map((choice) => String(choice.value)));
            const value = selects.shift();
            if (value === undefined) throw new Error("unexpected select");
            return value as never;
          },
          async multiSelect(options: { choices: Array<{ value: unknown }> }) {
            offered.push(options.choices.map((choice) => String(choice.value)));
            const value = multiSelects.shift();
            if (!value) throw new Error("unexpected multiSelect");
            return value as never[];
          },
        },
      }), 0, stdout.text());

      assert.equal(selects.length, 0);
      assert.equal(multiSelects.length, 0);
      // The host itself was asked for its catalog.
      assert.deepEqual(discovered, ["claude"]);
      // The CLI picker listed the host, then every model prompt offered only
      // models the host returned.
      assert.deepEqual(offered[0], ["codex", "grok", "cursor", "claude"]);
      for (const choices of offered.slice(1, 4)) {
        for (const value of choices) {
          if (!value) continue;
          assert.ok(
            CLAUDE_CATALOG.models.some((model) => model.id === value),
            `${value} is not in the Claude catalog`,
          );
        }
      }

      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.active, "claude");
      assert.deepEqual(config.cli.claude, {
        enabled: true,
        runner: "claude-sonnet-5",
        longctx: "claude-opus-5[1m]",
        // Configured labels must be truthfully present in the allowlist.
        subagent_models: ["claude-sonnet-5", "claude-opus-5[1m]"],
      });
      assert.equal(config.director.max_concurrent, 20);
      // Other host profiles are untouched.
      assert.equal(config.cli.codex.enabled, false);
      assert.equal(config.cli.grok.enabled, false);
      assert.match(stdout.text(), /cli: claude/);

      const snapshot = readRouteSnapshot(cwd, { host: "claude", env });
      assert.equal(snapshot?.cli, "claude");
    });
  });

  it("supports the non-interactive init and config path", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-noninteractive-"));
      const env = fakeEnv(home);
      const init = capture();
      assert.equal(await run(["init", "--cli", "claude"], { cwd, env, stdout: init, stderr: init }), 0, init.text());
      assert.equal(loadConfig(cwd, { env }).cli.active, "claude");

      const out = capture();
      assert.equal(await run([
        "config", "--cli", "claude",
        "--runner", "claude-sonnet-5",
        "--longctx", "-",
        "--subagent-model", "claude-sonnet-5,claude-haiku-4-5-20251001",
        "--enable", "--json",
      ], {
        cwd, env, stdout: out, stderr: out,
        discover: async () => structuredClone(CLAUDE_CATALOG),
      }), 0, out.text());
      const payload = JSON.parse(out.text());
      assert.equal(payload.cli, "claude");
      assert.equal(payload.enabled, true);
      assert.equal(payload.runner, "claude-sonnet-5");
      assert.equal(payload.longctx, null);
      assert.equal(payload.max_concurrent, 20);
      assert.equal(payload.model_source, "claude catalog");
      assert.deepEqual(payload.subagent_models, ["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    });
  });

  it("rejects a model that is not in the host's own returned catalog", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-stale-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);
      const out = capture();
      // A Grok model must never validate against the Claude catalog.
      assert.equal(await run([
        "config", "--cli", "claude", "--runner", "grok-4.5", "--enable",
      ], {
        cwd, env, stdout: out, stderr: out,
        discover: async () => structuredClone(CLAUDE_CATALOG),
      }), 1, out.text());
      assert.match(out.text(), /runner model grok-4\.5 is not in the 3-model CLI response/);
    });
  });

  it("keeps each host profile independent when both are configured", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-claude-isolation-"));
      const env = fakeEnv(home);
      assert.equal(await run(["init"], { cwd, env, stdout: capture(), stderr: capture() }), 0);

      const grok = capture();
      assert.equal(await run([
        "config", "--cli", "grok", "--runner", "grok-4.5", "--longctx", "-",
        "--subagent-model", "grok-4.5", "--enable",
      ], { cwd, env, stdout: grok, stderr: grok, discover: async () => structuredClone(GROK_CATALOG) }), 0, grok.text());

      const claude = capture();
      assert.equal(await run([
        "config", "--cli", "claude", "--runner", "claude-sonnet-5", "--longctx", "-",
        "--subagent-model", "claude-sonnet-5", "--disable",
      ], { cwd, env, stdout: claude, stderr: claude, discover: async () => structuredClone(CLAUDE_CATALOG) }), 0, claude.text());

      const config = loadConfig(cwd, { env });
      // Configuring Claude must not disturb the Grok profile.
      assert.equal(config.cli.grok.enabled, true);
      assert.deepEqual(config.cli.grok.subagent_models, ["grok-4.5"]);
      // A disabled Claude profile fails closed rather than borrowing Grok's.
      assert.equal(config.cli.claude.enabled, false);

      const cards = capture();
      assert.equal(await run(["cards", "--host", "claude"], { cwd, env, stdout: cards, stderr: cards }), 0, cards.text());
      assert.match(cards.text(), /no enabled subagent models/);
      assert.doesNotMatch(cards.text(), /grok-4\.5/);

      // Matching for the disabled host discloses no candidate and never reaches
      // into the enabled Grok profile.
      const match = capture();
      await run(["match", "implement a small fix", "--host", "claude"], { cwd, env, stdout: match, stderr: match });
      assert.match(match.text(), /preferred: none/);
      assert.doesNotMatch(match.text(), /grok-4\.5/);

      // The enabled host still resolves its own candidate normally.
      const grokMatch = capture();
      await run(["match", "implement a small fix", "--host", "grok"], { cwd, env, stdout: grokMatch, stderr: grokMatch });
      assert.match(grokMatch.text(), /grok-4\.5/);
    });
  });
});
