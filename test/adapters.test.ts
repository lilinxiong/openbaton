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
import { emptyConfig, hostMaxConcurrent, normalizeConfig } from "../src/lib/config.js";
import { HOST_IDS, HOST_SKILL_REL } from "../src/lib/hosts.js";

describe("CLI adapter contract and registry", () => {
  it("keeps one adapter contract for every registered CLI", () => {
    assert.deepEqual(CLI_IDS, ["codex", "grok", "cursor"]);
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
  });

  it("derives one compatible config profile per registered adapter", () => {
    const empty = emptyConfig();
    assert.deepEqual(Object.keys(empty.cli).sort(), ["active", "codex", "cursor", "grok"]);
    assert.deepEqual(empty.cli.codex, empty.cli.grok);
    assert.deepEqual(empty.cli.codex, empty.cli.cursor);

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
