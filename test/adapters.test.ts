import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CLI_ADAPTERS,
  CLI_IDS,
  getCliAdapter,
  listCliAdapters,
} from "../src/adapters/index.js";
import { discoverCliModels, type CliModelCatalog } from "../src/lib/cli-models.js";
import {
  cliProfileForHost,
  configuredSubagentModelsForHost,
  emptyConfig,
  enabledForHost,
  hostMaxConcurrent,
  normalizeConfig,
} from "../src/lib/config.js";
import { HOST_IDS, HOST_SKILL_REL } from "../src/lib/hosts.js";

describe("CLI adapter contract and registry", () => {
  it("keeps one adapter contract for every registered CLI", () => {
    assert.deepEqual(CLI_IDS, ["codex", "grok", "cursor", "claude"]);
    assert.strictEqual(listCliAdapters(), CLI_ADAPTERS);

    for (const adapter of CLI_ADAPTERS) {
      assert.equal(adapter.id, adapter.host.id);
      assert.ok(adapter.host.skillPath.endsWith("SKILL.md"));
      assert.equal(typeof adapter.resolveCommand, "function");
      assert.equal(typeof adapter.discoverModels, "function");
      assert.strictEqual(getCliAdapter(adapter.id), adapter);
    }
  });

  it("derives host metadata from the same registry", () => {
    assert.deepEqual(HOST_IDS, CLI_ADAPTERS.map((adapter) => adapter.host.id));
    assert.deepEqual(
      HOST_SKILL_REL,
      Object.fromEntries(CLI_ADAPTERS.map((adapter) => [adapter.host.id, adapter.host.skillPath])),
    );
    assert.equal(hostMaxConcurrent("codex"), 4);
    assert.equal(hostMaxConcurrent("grok", { GROK_MAX_CONCURRENT_SUBAGENTS: "5" }), 5);
    assert.equal(hostMaxConcurrent("grok", { GROK_MAX_CONCURRENT_SUBAGENTS: "not-a-number" }), 8);
    assert.equal(hostMaxConcurrent("cursor"), 4);
    assert.equal(hostMaxConcurrent("cursor", { CURSOR_MAX_CONCURRENT_SUBAGENTS: "3" }), 3);
    assert.equal(hostMaxConcurrent("claude", {}), 20);
    assert.equal(hostMaxConcurrent("claude", { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3" }), 3);
    assert.equal(hostMaxConcurrent("claude", { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "0" }), 20);
    assert.equal(hostMaxConcurrent("claude", { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "nope" }), 20);
  });

  it("derives one compatible config profile per registered adapter", () => {
    const empty = emptyConfig();
    assert.deepEqual(Object.keys(empty.cli).sort(), ["active", "claude", "codex", "cursor", "grok"]);
    assert.deepEqual(empty.cli.codex, empty.cli.grok);
    assert.deepEqual(empty.cli.codex, empty.cli.cursor);
    assert.deepEqual(empty.cli.claude, empty.cli.grok);

    const migrated = normalizeConfig({
      ops: {
        runner: { route: "legacy-runner" },
        longctx: { route: "legacy-longctx" },
      },
      cli: {
        active: "grok",
        grok: { enabled: true, runner: "grok-4.5", subagent_models: ["grok-4.5"] },
      },
    });
    assert.equal(migrated.cli.active, "grok");
    assert.equal(migrated.cli.grok.enabled, true);
    assert.equal(migrated.cli.grok.longctx, "");
    assert.equal(migrated.cli.codex.runner, "legacy-runner");
    assert.equal(migrated.cli.codex.longctx, "legacy-longctx");
    // Only the legacy Codex profile migrates the old global ops table.
    assert.equal(migrated.cli.claude.runner, "");
    assert.equal(migrated.cli.claude.longctx, "");
    assert.equal(migrated.cli.claude.enabled, false);
  });

  it("keeps a Claude profile independent of the Codex and Grok profiles", () => {
    const config = normalizeConfig({
      cli: {
        active: "codex",
        codex: { enabled: true, runner: "gpt-5.4", subagent_models: ["gpt-5.4"] },
        grok: { enabled: true, runner: "grok-4.5", subagent_models: ["grok-4.5"] },
        claude: { enabled: false, runner: "", longctx: "", subagent_models: [] },
      },
    });
    // A disabled host must fail closed rather than borrow another profile.
    assert.deepEqual(configuredSubagentModelsForHost(config, "claude"), []);
    assert.equal(enabledForHost(config, "claude"), false);
    assert.deepEqual(cliProfileForHost(config, "claude").subagent_models, []);
    assert.deepEqual(configuredSubagentModelsForHost(config, "codex"), ["gpt-5.4"]);

    const enabled = normalizeConfig({
      cli: {
        active: "codex",
        codex: { enabled: true, runner: "gpt-5.4", subagent_models: ["gpt-5.4"] },
        claude: { enabled: true, runner: "claude-sonnet-5", longctx: "claude-opus-5[1m]", subagent_models: ["claude-sonnet-5", "claude-opus-5[1m]"] },
      },
    });
    assert.deepEqual(configuredSubagentModelsForHost(enabled, "claude"), ["claude-sonnet-5", "claude-opus-5[1m]"]);
    // Enabling Claude must not alter another host's profile.
    assert.deepEqual(configuredSubagentModelsForHost(enabled, "codex"), ["gpt-5.4"]);
  });

  it("retains the legacy discovery call shape through the facade", async () => {
    const expected: CliModelCatalog = { cli: "grok", version: null, models: [{
      id: "grok-4.5",
      model: "grok-4.5",
      display_name: "grok-4.5",
      description: "",
      hidden: false,
      reasoning_efforts: [],
      default_reasoning_effort: null,
      input_modalities: [],
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      is_default: false,
    }] };
    const catalog = await discoverCliModels("grok", {
      command: "/bin/grok",
      spawnImpl: ((_: string, args: string[]) => {
        const events = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          stdin: { end(): void };
          killed: boolean;
          kill(): void;
        };
        events.stdout = new EventEmitter();
        events.stderr = new EventEmitter();
        events.stdin = { end() {} };
        events.killed = false;
        events.kill = () => { events.killed = true; };
        queueMicrotask(() => {
          if (args[0] === "models") events.stdout.emit("data", "Available models:\n  grok-4.5\n");
          events.emit("exit", 0);
        });
        return events;
      }) as typeof import("node:child_process").spawn,
    });
    assert.deepEqual(catalog, expected);
  });
});
