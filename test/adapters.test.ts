import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLI_ADAPTERS,
  CLI_IDS,
  getCliAdapter,
  listCliAdapters,
} from "../src/adapters/index.js";
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
      assert.equal(typeof adapter.host.guard, "boolean");
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
    assert.equal(getCliAdapter("codex").host.guard, true);
    assert.equal(getCliAdapter("claude").host.guard, true);
    assert.equal(getCliAdapter("grok").host.guard, true);
    assert.equal(getCliAdapter("cursor").host.guard, false);
  });

  it("keeps unconfigured adapters absent and resolves missing profiles as disabled", () => {
    const empty = emptyConfig();
    assert.deepEqual(Object.keys(empty.cli), []);
    assert.deepEqual(cliProfileForHost(empty, "codex"), {
      enabled: false,
      runner: "",
      longctx: "",
      subagent_models: [],
    });

    const unselected = normalizeConfig({
      ops: {
        runner: { route: "legacy-runner" },
        longctx: { route: "legacy-longctx" },
      },
      cli: {
        active: "grok",
        grok: { enabled: true, runner: "grok-4.5", subagent_models: ["grok-4.5"] },
      },
    });
    assert.equal(Object.hasOwn(unselected.cli, "active"), false);
    assert.equal(unselected.cli.grok.enabled, true);
    assert.equal(unselected.cli.grok.longctx, "");
    assert.equal(unselected.cli.codex, undefined);
    assert.equal(unselected.cli.claude, undefined);
    assert.equal(cliProfileForHost(unselected, "claude").enabled, false);
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
    assert.equal(Object.hasOwn(config.cli, "active"), false);
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
    assert.equal(Object.hasOwn(enabled.cli, "active"), false);
    assert.deepEqual(configuredSubagentModelsForHost(enabled, "claude"), ["claude-sonnet-5", "claude-opus-5[1m]"]);
    // Enabling Claude must not alter another host's profile.
    assert.deepEqual(configuredSubagentModelsForHost(enabled, "codex"), ["gpt-5.4"]);
  });
});
