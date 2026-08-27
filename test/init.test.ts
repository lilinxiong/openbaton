import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { updateProject } from "../src/commands/update.js";
import { loadConfig } from "../src/lib/config.js";
import { HOST_SKILL_REL } from "../src/lib/hosts.js";
import { parseToml } from "../src/lib/toml.js";
import { withHome, fakeEnv } from "./home.js";
import { adapterProviderFor } from "./configure.js";

/** Shared director/worker table markers every host skill must name. */
const DIRECTOR_WORKER_TABLE_ROWS = [
  "Director-owned classification is authoritative",
  "Declared classified work → native subagents",
  "OpenSpec only lightens orchestration",
] as const;

/** Shared maximal-safe-frontier contract markers every host skill must name. */
const MAXIMAL_SAFE_FRONTIER_MARKERS = [
  /maximal safe ready frontier/i,
  /section order is only a stable tie-breaker/i,
  /MUST NOT impose serialization/i,
  /MUST recompute this maximal safe ready frontier/i,
  /immediately refill every newly available slot/i,
  /concrete blocking dependency or write-scope conflict/i,
  /section order and FIFO position are not reasons/i,
  /Dependencies and write-scope conflicts are the only serialization reasons/i,
] as const;

function assertDirectorWorkerRoutingTable(skill: string, label: string): void {
  for (const row of DIRECTOR_WORKER_TABLE_ROWS) {
    assert.ok(skill.includes(row), `${label} omits routing row: ${row}`);
  }
}

function assertMaximalSafeReadyFrontier(skill: string, label: string): void {
  for (const marker of MAXIMAL_SAFE_FRONTIER_MARKERS) {
    assert.match(skill, marker, `${label} omits maximal-safe-frontier contract: ${marker}`);
  }
  assert.doesNotMatch(skill, /later sections stay serial while an earlier section is pending/i,
    `${label} retains section-order serialization`);
  assert.doesNotMatch(skill, /Pack by section order, director write-set intersection, and host cap/i,
    `${label} retains section-order packing`);
}

describe("Codex init and update", () => {
  it("names the shared director/worker routing table in repo and installed skills", async () => {
    const root = process.cwd();
    assertDirectorWorkerRoutingTable(
      fs.readFileSync(path.join(root, "SKILL.md"), "utf8"),
      "root SKILL.md",
    );
    for (const host of ["codex", "grok", "cursor", "claude"] as const) {
      const skill = fs.readFileSync(path.join(root, "templates", "hosts", host, "SKILL.md"), "utf8");
      assertDirectorWorkerRoutingTable(skill, `templates/hosts/${host}/SKILL.md`);
      assertMaximalSafeReadyFrontier(skill, `templates/hosts/${host}/SKILL.md`);
    }
    assertMaximalSafeReadyFrontier(fs.readFileSync(path.join(root, "SKILL.md"), "utf8"), "SKILL.md");

    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-routing-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      assertDirectorWorkerRoutingTable(
        fs.readFileSync(path.join(home, ".baton", "SKILL.md"), "utf8"),
        "installed ~/.baton/SKILL.md",
      );
      for (const host of ["codex", "grok", "cursor", "claude"] as const) {
        const skill = fs.readFileSync(path.join(home, HOST_SKILL_REL[host]), "utf8");
        assertDirectorWorkerRoutingTable(skill, `installed ${HOST_SKILL_REL[host]}`);
        assertMaximalSafeReadyFrontier(skill, `installed ${HOST_SKILL_REL[host]}`);
      }
      assertMaximalSafeReadyFrontier(
        fs.readFileSync(path.join(home, ".baton", "SKILL.md"), "utf8"),
        "installed ~/.baton/SKILL.md",
      );
    });
  });

  it("keeps add-cli contract fixtures naming the director/worker invariant", () => {
    const root = process.cwd();
    const addCli = path.join(root, ".agents", "skills", "add-cli-to-baton");
    const contract = fs.readFileSync(path.join(addCli, "references", "openbaton-contract.md"), "utf8");
    assert.match(contract, /Director\/worker routing invariant/);
    assert.match(contract, /All hosts are hookless/);
    assert.match(contract, /explicit director orchestration/);

    assertDirectorWorkerRoutingTable(
      fs.readFileSync(path.join(addCli, "SKILL.md"), "utf8"),
      "add-cli-to-baton/SKILL.md",
    );

    const acceptance = fs.readFileSync(path.join(addCli, "references", "acceptance.md"), "utf8");
    assert.match(acceptance, /Director\/worker routing acceptance/);
    assert.match(acceptance, /All hosts are hookless/);
  });

  it("installs the CLI-owned automatic-routing policy without placeholder profiles", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-"));
      const env = fakeEnv(home);
      const result = await initProject(cwd, { env });
      assert.deepEqual(result.tools, ["codex", "grok", "cursor", "claude"]);
      const initialConfig = fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8");
      assert.doesNotMatch(initialConfig, /^\[ops\./m);
      assert.doesNotMatch(initialConfig, /^actions\s*=/m);

      const directorSkill = fs.readFileSync(path.join(home, ".baton", "SKILL.md"), "utf8");
      const hostSkill = fs.readFileSync(path.join(home, HOST_SKILL_REL.codex), "utf8");
      const grokSkill = fs.readFileSync(path.join(home, HOST_SKILL_REL.grok), "utf8");
      const cursorSkill = fs.readFileSync(path.join(home, HOST_SKILL_REL.cursor), "utf8");
      const claudeSkill = fs.readFileSync(path.join(home, HOST_SKILL_REL.claude), "utf8");
      for (const skill of [directorSkill, hostSkill]) {
        assert.match(skill, /model\/list/);
        assert.match(skill, /gpt-5\.4-mini/);
        assert.match(skill, /gpt-5\.3-codex-spark/);
        assert.match(skill, /No human model selector|Never expose human model selection/);
        assert.match(skill, /OpenCodex/);
      }
      assert.match(grokSkill, /grok models/);
      assert.match(grokSkill, /spawn_subagent/);
      assert.match(grokSkill, /--host grok/);
      assert.match(grokSkill, /grok -p/);
      assert.doesNotMatch(grokSkill, /models --json/);
      assert.match(grokSkill, /Director-owned classification is authoritative/);
      assert.match(grokSkill, /Never `git commit` from this director session for a classified unit/);
      assert.match(grokSkill, /Compact dispatch is the same for runner ops, longctx ops, and ordinary `[^`]+` tickets/);
      assert.match(grokSkill, /--dispatch --json/);
      assert.match(grokSkill, /order-ready frontier/);
      assert.match(grokSkill, /host cap/);
      assert.match(grokSkill, /--unit ID --write-path PATH --unit ID/);
      assert.match(hostSkill, /order-ready frontier/);
      assert.match(hostSkill, /host cap/);
      assertMaximalSafeReadyFrontier(grokSkill, `installed ${HOST_SKILL_REL.grok}`);
      assertMaximalSafeReadyFrontier(hostSkill, `installed ${HOST_SKILL_REL.codex}`);
      assert.match(grokSkill, /When `cli.grok.enabled` is true and the user applies an OpenSpec change/);
      assert.match(grokSkill, /Do not edit OpenSpec apply skills/);
      assert.match(hostSkill, /When `cli.codex.enabled` is true and the user applies an OpenSpec change/);
      assert.match(cursorSkill, /When `cli.cursor.enabled` is true and the user applies an OpenSpec change/);
      assert.match(claudeSkill, /When `cli.claude.enabled` is true and the user applies an OpenSpec change/);
      assertDirectorWorkerRoutingTable(directorSkill, "installed ~/.baton/SKILL.md");
      assert.match(cursorSkill, /cursor-agent models/);
      assert.match(cursorSkill, /native `Task`/);
      assert.match(cursorSkill, /--host cursor/);
      assert.match(cursorSkill, /cursor-agent -p/);
      assert.match(cursorSkill, /Director-owned classification is authoritative/);
      assert.match(directorSkill, /classified mechanical unit/i);
      assert.match(directorSkill, /Compact dispatch applies to every reserved ticket/);
      assert.match(directorSkill, /\[--dispatch\]/);
      assert.match(directorSkill, /\[--release\]/);
      // The director skill must name every registered adapter and its native
      // dispatch mechanism, so a new host cannot ship without documentation.
      assert.match(directorSkill, /registered CLI adapters are Codex, Grok, Cursor, and Claude Code/i);
      assert.match(directorSkill, /spawn_subagent/);
      assert.match(directorSkill, /Task/);
      assert.match(directorSkill, /agent definition's `model:` frontmatter/);
      assert.match(directorSkill, /list_models/);
      for (const host of ["codex", "grok", "cursor", "claude"]) {
        assert.match(directorSkill, new RegExp(`--host codex\\|grok\\|cursor\\|claude`));
        assert.ok(directorSkill.includes(host), `director skill omits ${host}`);
      }

      const config = loadConfig(cwd, { env });
      assert.equal(Object.hasOwn(config.cli, "active"), false);
      assert.deepEqual(config.cli, {});
      assert.equal(config.director.max_concurrent, 4);
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(raw.cli, undefined);
      assert.doesNotMatch(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"), /^\[cli\./m);
      assert.equal((raw.director as Record<string, unknown>).model_selection, undefined);
      assert.equal(raw.ops, undefined);
      assert.ok(!fs.existsSync(path.join(cwd, ".baton")));
    });
  });

  it("selects CLIs from an interactive picker and configures each in order", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-select-"));
      const env = fakeEnv(home);
      const chunks: string[] = [];
      const stdout = { write(value: unknown) { chunks.push(String(value)); return true; } };
      const grokModels = [{
        id: "grok-4.5", model: "grok-4.5", display_name: "Grok 4.5", description: "Fast",
        hidden: false, reasoning_efforts: [{ id: "low", description: "" }], default_reasoning_effort: "low",
        input_modalities: ["text"], additional_speed_tiers: [], service_tiers: [],
        default_service_tier: null, is_default: false,
      }];
      const selects: unknown[] = ["", "", true];
      const multiSelects: unknown[][] = [["grok"], ["grok-4.5"]];
      assert.equal(await run(["init"], {
        cwd,
        env,
        stdout,
        stderr: stdout,
        adapterProvider: adapterProviderFor({ cli: "grok", version: "test", models: grokModels }),
        prompt: {
          async select() {
            const value = selects.shift();
            if (value === undefined) throw new Error("unexpected select");
            return value as never;
          },
          async multiSelect() {
            const value = multiSelects.shift();
            if (!value) throw new Error("unexpected multiSelect");
            return value as never[];
          },
        },
      }), 0);
      assert.equal(selects.length, 0);
      assert.equal(multiSelects.length, 0);
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.grok.enabled, true);
      assert.equal(Object.hasOwn(config.cli, "active"), false);
      assert.equal(config.director.max_concurrent, 4);
      assert.deepEqual(config.cli.grok, {
        enabled: true,
        runner: "",
        longctx: "",
        coding_models: ["grok-4.5"],
      });
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((raw.cli as Record<string, unknown>), "active"), false);
      assert.deepEqual(Object.keys(raw.cli as Record<string, unknown>), ["grok"]);
      assert.match(chunks.join(""), /cli: grok/);
      assert.doesNotMatch(chunks.join(""), /\bactive:/);
    });
  });

  it("installs a Claude Code runtime skill that names its own native mechanism", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-claude-skill-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const skill = fs.readFileSync(path.join(home, HOST_SKILL_REL.claude), "utf8");
      // Its own catalog source and exact-model mechanism, not Codex's or Grok's.
      assert.match(skill, /list_models/);
      assert.match(skill, /resolvedModel/);
      assert.match(skill, /--host claude/);
      assert.match(skill, /agent definition/i);
      assert.match(skill, /claude -p/);
      assert.match(skill, /CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS/);
      assert.match(skill, /~\/\.claude\/skills\/baton\/SKILL\.md/);
      // Shared contract clauses every host skill must carry.
      assert.match(skill, /Never expose human model selection/);
      assert.match(skill, /Director-owned classification is authoritative/);
      assert.match(skill, /Compact dispatch is the same for runner ops, longctx ops, and ordinary `[^`]+` tickets/);
      assert.match(skill, /--dispatch --json/);
      assert.match(skill, /When `cli.claude.enabled` is true and the user applies an OpenSpec change/);
      assert.match(skill, /Do not edit OpenSpec apply skills/);
      assert.match(skill, /OpenCodex/);
      // It must not copy claims that are false for this host.
      assert.doesNotMatch(skill, /spawn_subagent/);
      assert.doesNotMatch(skill, /grok models/);
      assert.doesNotMatch(skill, /model\/list/);
    });
  });

  it("enables Claude Code for a non-interactive --cli claude init without writing active", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-claude-cap-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env, cli: "claude" });
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.claude.enabled, true);
      assert.equal(Object.hasOwn(config.cli, "active"), false);
      assert.equal(config.director.max_concurrent, 4);
      // Opting one host in must not enable another.
      assert.equal(config.cli.codex, undefined);
      assert.equal(config.cli.grok, undefined);
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((raw.cli as Record<string, unknown>), "active"), false);
      assert.deepEqual(Object.keys(raw.cli as Record<string, unknown>), ["claude"]);
    });
  });

  it("adds a selected host without migrating another profile's legacy Coding field", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-legacy-profile-"));
      const env = fakeEnv(home);
      const file = path.join(home, ".baton", "config.toml");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        "[director]",
        "max_concurrent = 4",
        "max_depth = 1",
        "",
        "[cli.codex]",
        "enabled = true",
        'runner = "gpt-5.6-luna"',
        'longctx = "gpt-5.6-luna"',
        'subagent_models = ["gpt-5.3-codex-spark", "gpt-5.6-luna"]',
      ].join("\n"), "utf8");

      await initProject(cwd, { env, cli: "grok" });
      const saved = fs.readFileSync(file, "utf8");
      assert.match(saved, /subagent_models = \["gpt-5\.3-codex-spark", "gpt-5\.6-luna"\]/);
      assert.match(saved, /\[cli\.grok\]/);
      assert.match(saved, /coding_models = \[\]/);
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.grok.enabled, true);
      assert.deepEqual(config.cli.codex.coding_models, ["gpt-5.3-codex-spark", "gpt-5.6-luna"]);
    });
  });

  it("keeps the template director cap when CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is set during init", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-claude-env-"));
      const env = { ...fakeEnv(home), CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "7" };
      await initProject(cwd, { env, cli: "claude" });
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.claude.enabled, true);
      assert.equal(config.cli.claude.max_concurrent, undefined);
      assert.equal(config.director.max_concurrent, 4);
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((raw.cli as Record<string, unknown>), "active"), false);
    });
  });

  it("enables Grok for --cli grok without writing active or rewriting the director cap", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-grok-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env, cli: "grok" });
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.grok.enabled, true);
      assert.equal(Object.hasOwn(config.cli, "active"), false);
      assert.equal(config.director.max_concurrent, 4);
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((raw.cli as Record<string, unknown>), "active"), false);
    });
  });

  it("keeps the template director cap when GROK_MAX_CONCURRENT_SUBAGENTS is set during init", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-grok-cap-"));
      const env = { ...fakeEnv(home), GROK_MAX_CONCURRENT_SUBAGENTS: "6" };
      await initProject(cwd, { env, cli: "grok" });
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.grok.enabled, true);
      assert.equal(config.cli.grok.max_concurrent, undefined);
      assert.equal(config.director.max_concurrent, 4);
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((raw.cli as Record<string, unknown>), "active"), false);
    });
  });

  it("enables Cursor for --cli cursor without writing active", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-cursor-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env, cli: "cursor" });
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.cursor.enabled, true);
      assert.equal(Object.hasOwn(config.cli, "active"), false);
      assert.equal(config.director.max_concurrent, 4);
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((raw.cli as Record<string, unknown>), "active"), false);
    });
  });

  it("keeps the template director cap when CURSOR_MAX_CONCURRENT_SUBAGENTS is set during init", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-cursor-cap-"));
      const env = { ...fakeEnv(home), CURSOR_MAX_CONCURRENT_SUBAGENTS: "6" };
      await initProject(cwd, { env, cli: "cursor" });
      const config = loadConfig(cwd, { env });
      assert.equal(config.cli.cursor.enabled, true);
      assert.equal(config.cli.cursor.max_concurrent, undefined);
      assert.equal(config.director.max_concurrent, 4);
      const raw = parseToml(fs.readFileSync(path.join(home, ".baton", "config.toml"), "utf8"));
      assert.equal(Object.hasOwn((raw.cli as Record<string, unknown>), "active"), false);
    });
  });

  it("keeps installed files without force and replaces them with force", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-init-force-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const skill = path.join(home, HOST_SKILL_REL.codex);
      fs.writeFileSync(skill, "CUSTOM\n");
      await initProject(cwd, { env });
      assert.equal(fs.readFileSync(skill, "utf8"), "CUSTOM\n");
      await initProject(cwd, { env, force: true });
      assert.match(fs.readFileSync(skill, "utf8"), /CLI-owned|model\/list/);
    });
  });

  it("drops legacy ops fields without migrating them into a selected profile", async () => {
    await withHome(async (home) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "baton-update-"));
      const env = fakeEnv(home);
      await initProject(cwd, { env });
      const file = path.join(home, ".baton", "config.toml");
      fs.writeFileSync(file, [
        "[director]",
        "max_concurrent = 2",
        "max_depth = 1",
        "model_selection = true",
        "",
        "[ops.runner]",
        "route = \"gpt-5.4-mini\"",
        "",
        "[ops.longctx]",
        "route = \"gpt-5.5\"",
        "min_context_tokens = 1048576",
      ].join("\n"));

      const result = updateProject(cwd, { env });
      assert.ok(result.actions.some((action) => /director\/CLI defaults/.test(action)));
      const config = loadConfig(cwd, { env });
      assert.equal(config.director.max_concurrent, 2);
      assert.deepEqual(config.cli, {});
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(text, /model_selection|min_context_tokens|route\s*=/);
      assert.doesNotMatch(text, /^\[ops\./m);
      assert.doesNotMatch(text, /^\[cli\./m);
    });
  });
});
